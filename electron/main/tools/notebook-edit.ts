/**
 * Notebook 编辑工具：为什么存在——Jupyter .ipynb 是结构化 JSON，AI 若用整文件 Write 改
 * notebook 极易破坏 cells 结构；按单元格编辑（replace/insert/delete）既精确又保结构。
 * 作用：读取 notebook JSON → 按 cell_id / cell_index 定位单元格 → 执行编辑 → 原子写回，
 * 保持 nbformat 结构完整（id/元数据/outputs 保留；插入的新单元格结构与相邻单元格一致）。
 *
 * 安全语义：原地改写属破坏性操作；写同一文件需串行，防并发编辑竞态（与 Edit/Write 同）。
 * 纯 JSON 操作、零外部依赖：nbformat>=4 的 cells 数组定位与改写，其余字段原样保留。
 */
import { readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import type { Tool, ToolResult, ToolContext } from './base-tool'
import { resolveToolPath } from './base-tool'
import { writeFileSafe, countLineDiff } from './edit-engine/file-operations'
import { recordFileEdit, sha256Of } from './file-history'

export type NotebookEditMode = 'replace' | 'insert' | 'delete'

export interface NotebookEditParams {
  notebook_path: string
  edit_mode?: NotebookEditMode
  cell_id?: string
  cell_index?: number
  cell_type?: 'code' | 'markdown'
  new_source?: string
}

/** notebook 单元格的松耦合形状（只取需要的字段，未知字段原样带到写回） */
interface NotebookCellLike {
  id?: string
  cell_type?: string
  source?: string | string[]
  [key: string]: unknown
}

interface NotebookLike {
  cells?: NotebookCellLike[]
  nbformat?: number
  [key: string]: unknown
}

/** 把单元格 source 归一为字符串（数组按行拼接） */
function sourceToString(source: unknown): string {
  if (typeof source === 'string') return source
  if (Array.isArray(source)) return source.join('')
  return ''
}

/** 写回 source：保持原形态（原 string 写 string；原数组按行拆分写数组，末段不加换行） */
function sourceToNotation(source: string, prev: unknown): string | string[] {
  if (Array.isArray(prev)) {
    const lines = source.split('\n')
    const arr: string[] = []
    for (let i = 0; i < lines.length; i++) {
      arr.push(i === lines.length - 1 ? lines[i] : lines[i] + '\n')
    }
    return arr
  }
  return source
}

/** 定位目标单元格下标：cell_id 优先，其次 cell_index；insert 无定位 → 开头 */
function locateCell(
  notebook: NotebookLike,
  cellId: string | undefined,
  cellIndex: number | undefined,
  editMode: NotebookEditMode,
  cellLen: number
): { index: number; cell?: NotebookCellLike; error?: string } {
  if (cellId !== undefined && cellId !== '') {
    const idx = notebook.cells?.findIndex((c) => c.id === cellId)
    if (idx !== undefined && idx >= 0) return { index: idx, cell: notebook.cells![idx] }
    return { index: 0, error: `未找到 cell_id "${cellId}"（notebook 无此 id；可改用 cell_index 按位置定位）` }
  }
  if (cellIndex !== undefined) {
    const idx = Number(cellIndex)
    if (Number.isInteger(idx) && idx >= 0 && idx < cellLen) {
      return { index: idx, cell: notebook.cells![idx] }
    }
    return { index: 0, error: `cell_index ${cellIndex} 越界（当前 ${cellLen} 个单元格，有效范围 0-${Math.max(cellLen - 1, 0)}）` }
  }
  if (editMode === 'insert') return { index: 0 } // 未指定插入位置 → 开头插入
  return { index: 0, error: 'replace/delete 需要定位：传入 cell_id（首选）或 cell_index' }
}

/** 序列化 notebook 写回内容：nbformat 惯例 2 空格缩进 + 末尾换行 */
export function serializeNotebook(notebook: NotebookLike): string {
  return JSON.stringify(notebook, null, 2) + '\n'
}

/** 写回 notebook：原子写入并验证（复用 edit 引擎的 writeFileSafe） */
export function writeNotebook(filePath: string, notebook: NotebookLike): { ok: boolean; error?: string } {
  const content = serializeNotebook(notebook)
  try {
    const res = writeFileSafe(filePath, content)
    return res.verified ? { ok: true } : { ok: false, error: '写入后验证失败' }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export class NotebookEditTool implements Tool<NotebookEditParams> {
  name = 'NotebookEdit'
  description =
    '按单元格编辑 Jupyter notebook（.ipynb）：edit_mode=replace 重写定位单元格的源码（保留 outputs/metadata）；edit_mode=insert 在定位单元格之后插入新单元格（未定位则插入到开头，cell_type 必填 code/markdown、new_source 必填）；edit_mode=delete 删除定位单元格。定位：cell_id（nbformat>=4 标配）优先，cell_index（0 起）次之；insert 可不定位。参数：notebook_path（必填，绝对路径）/ edit_mode（默认 replace）/ cell_id / cell_index / cell_type / new_source。返回 { notebook_path, edit_mode, cell_id, cell_index?, total_cells, changed, message }。'
  parameters = [
    { name: 'notebook_path', type: 'string' as const, description: '.ipynb 绝对路径', required: true },
    { name: 'edit_mode', type: 'string' as const, description: 'replace（默认）/ insert / delete', required: false },
    { name: 'cell_id', type: 'string' as const, description: '目标单元格 id（nbformat>=4 标配）', required: false },
    { name: 'cell_index', type: 'number' as const, description: '目标单元格下标（0 起，cell_id 缺失时用）', required: false },
    { name: 'cell_type', type: 'string' as const, description: 'code / markdown（insert 必填；replace 可改类型）', required: false },
    { name: 'new_source', type: 'string' as const, description: '新源码（replace/insert 必填）', required: false }
  ]

  behavior = {
    destructive: true,
    concurrencySafe: false
  }

  async execute(params: NotebookEditParams, ctx?: ToolContext): Promise<ToolResult> {
    const filePath = resolveToolPath(params.notebook_path, ctx)
    const mode: NotebookEditMode = params.edit_mode ?? 'replace'
    try {
      if (!['replace', 'insert', 'delete'].includes(mode)) {
        return { ok: false, error: `edit_mode 无效: ${mode}（应为 replace/insert/delete）` }
      }

      let text: string
      try {
        text = readFileSync(filePath, 'utf-8')
      } catch (err) {
        return { ok: false, error: `无法读取 notebook: ${(err as Error).message}` }
      }

      let notebook: NotebookLike
      try {
        notebook = JSON.parse(text) as NotebookLike
      } catch (err) {
        return { ok: false, error: `notebook 不是合法 JSON: ${(err as Error).message}` }
      }

      if (!Array.isArray(notebook.cells)) {
        return { ok: false, error: '文件不是合法 Jupyter notebook（缺少 cells 数组）' }
      }
      if (typeof notebook.nbformat === 'number' && notebook.nbformat < 4) {
        return { ok: false, error: `不支持的 notebook 版本: nbformat=${notebook.nbformat}（需要 >=4）` }
      }

      const cells = notebook.cells as NotebookCellLike[]
      const locate = locateCell(notebook, params.cell_id, params.cell_index, mode, cells.length)
      if (locate.error) return { ok: false, error: locate.error }

      let resultData: Record<string, unknown>
      if (mode === 'delete') {
        const removed = cells.splice(locate.index, 1)[0]
        resultData = {
          edit_mode: mode,
          cell_id: (params.cell_id ?? removed?.id) ?? undefined,
          cell_index: params.cell_index,
          cell_type: removed?.cell_type,
          total_cells: cells.length,
          changed: true,
          message: `已删除第 ${locate.index} 个单元格（${removed?.cell_type ?? 'unknown'}）`
        }
      } else {
        // replace / insert 都需要新源码
        if (typeof params.new_source !== 'string') {
          return { ok: false, error: 'replace/insert 必须提供 new_source' }
        }
        if (params.cell_type && params.cell_type !== 'code' && params.cell_type !== 'markdown') {
          return { ok: false, error: `cell_type 无效: ${params.cell_type}（应为 code/markdown）` }
        }

        if (mode === 'replace') {
          const target = locate.cell!
          target.source = sourceToNotation(params.new_source, target.source)
          if (params.cell_type && params.cell_type !== target.cell_type) {
            target.cell_type = params.cell_type
          }
          resultData = {
            edit_mode: mode,
            cell_id: target.id,
            cell_index: locate.index,
            cell_type: target.cell_type,
            new_source: params.new_source,
            total_cells: cells.length,
            changed: true,
            message: `已重写第 ${locate.index} 个单元格源码（${target.cell_type ?? 'unknown'}）`
          }
        } else {
          // insert：定位后插入（cell_id/cell_index 定位 → 其后；未定位 → 开头）
          const located = params.cell_id !== undefined || params.cell_index !== undefined
          const insertAt = Math.min(locate.index + (located ? 1 : 0), cells.length)
          const hasIds = cells.some((c) => typeof c.id === 'string' && c.id !== '')
          const cellType: 'code' | 'markdown' = params.cell_type ?? 'code'
          // new_source 形态与相邻单元格一致（相邻是数组则按行拆数组，保持 notebook 惯例）
          const neighborPrev = cells[Math.max(insertAt - 1, 0)]?.source
          const newCell: NotebookCellLike = {
            cell_type: cellType,
            source: sourceToNotation(params.new_source, neighborPrev ?? ''),
            metadata: {},
            outputs: [],
            execution_count: cellType === 'code' ? null : undefined,
            ...(hasIds ? { id: `cell-${randomUUID()}` } : {})
          }
          cells.splice(insertAt, 0, newCell)
          resultData = {
            edit_mode: mode,
            cell_id: newCell.id,
            cell_index: insertAt,
            cell_type: cellType,
            new_source: params.new_source,
            total_cells: cells.length,
            changed: true,
            message: `已在第 ${insertAt} 位插入 ${cellType} 单元格`
          }
        }
      }

      // 统一写回：编辑已改内存对象，写盘失败返回错误（不返回"成功但未持久化"的假象）
      const write = writeNotebook(filePath, notebook)
      if (!write.ok) {
        return { ok: false, error: `写回 notebook 失败: ${write.error ?? '未知错误'}` }
      }

      // 落盘成功后记录会话级编辑审计（内存写入，无需 await；记录失败不影响主流程）
      const newText = serializeNotebook(notebook)
      const diff = countLineDiff(text, newText)
      recordFileEdit({
        sessionId: ctx?.sessionId,
        op: 'NotebookEdit',
        filePath,
        bytes: Buffer.byteLength(newText, 'utf8'),
        addedLines: diff.added,
        removedLines: diff.removed,
        sha256: sha256Of(newText)
      })

      ctx?.handleAccessed?.(filePath)
      return {
        ok: true,
        data: {
          notebook_path: filePath,
          ...resultData
        }
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }
}

/** 仅供测试/外部复用：解析 notebook 文本为对象 */
export function parseNotebook(text: string): { ok: true; notebook: NotebookLike } | { ok: false; error: string } {
  try {
    const notebook = JSON.parse(text) as NotebookLike
    if (!Array.isArray(notebook.cells)) return { ok: false, error: '缺少 cells 数组' }
    return { ok: true, notebook }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** 仅供测试断言：把 source 还原为字符串 */
export { sourceToString }