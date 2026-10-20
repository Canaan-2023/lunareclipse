/**
 * 编辑文件工具：为什么存在——AI 改文件最怕整文件重写丢上下文；基于精确替换 + 模糊匹配
 * 的小改动既省 token 又容错。
 * 作用：edit 调用 fuzzy-match 九层匹配定位 old_string，经原子写回文件并返回行变更统计。
 */
import { readFileSync } from 'fs'
import type { Tool, ToolResult, ToolContext } from './base-tool'
import { resolveToolPath } from './base-tool'
import { applyEditToFile, writeFileSafe, countLineDiff } from './edit-engine/file-operations'
import { fuzzyMatch, normalizeLineEndings } from './edit-engine/fuzzy-match'
import { recordFileEdit, sha256Of } from './file-history'

export interface EditParams {
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

/** 匹配失败报错时展示的 old_string 预览长度（足够定位，避免刷屏） */
const ERROR_PREVIEW_CHARS = 50

export class EditTool implements Tool<EditParams> {
  name = 'Edit'
  description = '字符串替换编辑（安全修改文件首选，内置模糊匹配引擎）。参数：file_path（必填，绝对路径）/ old_string（必填，要替换的字符串，需在文件中唯一除非 replace_all）/ new_string（必填，替换为）/ replace_all（选填，替换全部匹配，默认 false）。返回 { path, replacements, addedLines, removedLines }。old_string 在文件中不唯一且未设 replace_all 时会报错，需提供更长上下文。支持 CRLF/BOM 文件（自动保持行尾与 BOM），匹配失败时给出相近行提示。'
  parameters = [
    { name: 'file_path', type: 'string' as const, description: '绝对路径', required: true },
    { name: 'old_string', type: 'string' as const, description: '要替换的字符串', required: true },
    { name: 'new_string', type: 'string' as const, description: '替换为的字符串', required: true },
    { name: 'replace_all', type: 'boolean' as const, description: '是否全部替换', required: false, default: false }
  ]

  // 行为声明：原地改写属破坏性操作；写同一文件需串行，防并发编辑竞态
  behavior = {
    destructive: true,
    concurrencySafe: false
  }

  async execute(params: EditParams, ctx?: ToolContext): Promise<ToolResult> {
    // 输入形式校验（runtime guard）：防止空串/非字符串路径被 resolveToolPath 拼接成错误目标
    if (typeof params.file_path !== 'string' || params.file_path.trim() === '') {
      return { ok: false, error: 'file_path 必填（非空字符串绝对路径）' }
    }
    if (typeof params.old_string !== 'string' || params.old_string.length === 0) {
      return { ok: false, error: 'old_string 必填（非空字符串）' }
    }
    if (typeof params.new_string !== 'string') {
      return { ok: false, error: 'new_string 必填（字符串）' }
    }

    const filePath = resolveToolPath(params.file_path, ctx)
    try {
      const { old_string, new_string, replace_all } = params

      if (old_string === new_string) {
        return { ok: false, error: 'old_string 与 new_string 相同' }
      }

      if (replace_all) {
        return this.replaceAll(filePath, old_string, new_string, ctx)
      }

      // 改前读旧内容（供行 diff）
      const oldContent = readFileSync(filePath, 'utf-8')

      const res = applyEditToFile(filePath, old_string, new_string)

      if (res.alreadyApplied) {
        return {
          ok: true,
          data: {
            path: filePath,
            replacements: 0,
            note: '编辑已应用（old 已被替换或 old==new），无需修改'
          }
        }
      }
      if (!res.ok) {
        return { ok: false, error: res.error ?? '编辑失败' }
      }

      const newContent = readFileSync(filePath, 'utf-8')
      const diff = countLineDiff(oldContent, newContent)

      // 落盘成功后记录会话级编辑审计（内存写入，无需 await；记录失败不影响主流程）
      recordFileEdit({
        sessionId: ctx?.sessionId,
        op: 'Edit',
        filePath,
        bytes: Buffer.byteLength(newContent, 'utf8'),
        addedLines: diff.added,
        removedLines: diff.removed,
        sha256: sha256Of(newContent)
      })

      ctx?.handleAccessed?.(filePath)

      return {
        ok: true,
        data: {
          path: filePath,
          replacements: 1,
          strategy: res.strategy,
          verified: res.verified,
          addedLines: diff.added,
          removedLines: diff.removed
        }
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e?.code === 'ENOENT') {
        return { ok: false, error: `文件不存在：${filePath}（编辑前请先确认路径）` }
      }
      return { ok: false, error: (err as Error).message }
    }
  }

  /** replace_all：fuzzyMatch 拿归一化 old/new → 全文替换 → 保持行尾/BOM 原子写 */
  private replaceAll(filePath: string, old_string: string, new_string: string, ctx?: ToolContext): ToolResult {
    try {
      const oldContent = readFileSync(filePath, 'utf-8')
      const result = fuzzyMatch(oldContent, old_string, new_string)

      if (result.alreadyApplied) {
        return {
          ok: true,
          data: {
            path: filePath,
            replacements: 0,
            note: '编辑已应用（old 已被替换或 old==new），无需修改'
          }
        }
      }
      if (!result.matched) {
        return { ok: false, error: `未找到匹配: ${old_string.slice(0, ERROR_PREVIEW_CHARS)}...` }
      }

      // 归一化空间全文替换，再经 writeFileSafe 保持原行尾/BOM
      const normContent = normalizeLineEndings(oldContent, '\n')
      // 假成功防线（MAJOR 修复）：模糊策略（trimmed/whitespace/indentation/escapes/unicode/
      // block-anchor/context-aware）返回的 normalizedOld 是 old 的归一化版本，通常不再以原样
      // 出现在 normContent 里——此时 split/join 会 0 命中，把「没改」当作 ok:true 返回，编辑意图
      // 丢失。检测到 0 命中时回退到按匹配偏移替换一次（与 applyEdit 同语义），保证至少真实改动。
      const splitParts = normContent.split(result.normalizedOld)
      const replaceAllCount = splitParts.length - 1
      let newContentNorm: string
      let replacements: number
      let degradedToFirst = false
      if (replaceAllCount > 0) {
        newContentNorm = splitParts.join(result.normalizedNew)
        replacements = replaceAllCount
      } else {
        degradedToFirst = true
        newContentNorm =
          normContent.slice(0, result.startOffset) +
          result.normalizedNew +
          normContent.slice(result.endOffset)
        replacements = 1
      }

      const wres = writeFileSafe(filePath, newContentNorm)
      if (!wres.verified) {
        return { ok: false, error: '写入后验证失败' }
      }

      const newContent = readFileSync(filePath, 'utf-8')
      const diff = countLineDiff(oldContent, newContent)

      // 落盘成功后记录会话级编辑审计（内存写入，无需 await；记录失败不影响主流程）
      recordFileEdit({
        sessionId: ctx?.sessionId,
        op: 'Edit',
        filePath,
        bytes: Buffer.byteLength(newContent, 'utf8'),
        addedLines: diff.added,
        removedLines: diff.removed,
        sha256: sha256Of(newContent)
      })

      ctx?.handleAccessed?.(filePath)

      return {
        ok: true,
        data: {
          path: filePath,
          replacements,
          strategy: result.strategy,
          verified: true,
          addedLines: diff.added,
          removedLines: diff.removed,
          ...(degradedToFirst
            ? { note: '模糊策略下 replace_all 退化为替换首个匹配（old_string 与原文存在空白/缩进等差异，无法全文精确拆分）' }
            : {})
        }
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e?.code === 'ENOENT') {
        return { ok: false, error: `文件不存在：${filePath}（编辑前请先确认路径）` }
      }
      return { ok: false, error: (err as Error).message }
    }
  }
}