/**
 * 原始记忆重命名工具：为什么存在——raw_memory 按日期 + 序号命名，AI 需要按序号定位并
 * 重命名某个原始记忆后才能流转为正式记忆。
 * 作用：rename_raw_memory 解析 raw 文件序号/身份并 rename，附序号解析辅助函数。
 * 不删掉的理由：带标题名的 RAW（{序号}_{关键词}.md）是"AI 自行按标题检索历史会话"的载体，
 * 关键节点不加标题就无法从文件名定位，检索链路会断；本工具是标题名的唯一生产入口。
 */
import { existsSync, readdirSync, renameSync } from 'fs'
import { join, resolve, basename, dirname } from 'path'
import type { Tool, ToolResult, ToolContext } from './base-tool'
import { resolveToolPath } from './base-tool'

export interface RenameRawMemoryParams {
  /** raw_memory 文件绝对路径（如 raw_memory/2026/08/06/20.md） */
  路径: string
  /** 文件名关键词（如 记忆已整理_重点回顾；不含序号，序号从原文件名解析；只允许 汉字/字母/数字/下划线） */
  关键词: string
}

/**
 * RAW 记忆文件重命名工具（记忆工作流筛选阶段专用）。

 * 用途：记忆工作流预筛时 AI 通读了批次全部 raw_memory，顺手按内容给文件加关键词。
 * 序号不变，文件名从 `20.md` → `20_记忆已整理_重点回顾.md`。
 * 后续流程（记忆工作流 / NNG 归档 / AI 按时间检索）从文件名即可知主题。

 * 安全设计（为什么不用通用 MoveFile）：
 * - 只允许 rawMemory 根目录下的文件（路径前缀校验，防越界）
 * - 只允许 .md 且序号格式合法（`{seq}.md` 或 `{seq}_关键词.md`）
 * - 关键词清洗：只保留 汉字/字母/数字/下划线，防路径注入
 * - 防覆盖：目标文件已存在则报错，不覆盖
 * - DMN 专属（agents: ['dmn']），前端 AI 不可见
 */
export class RenameRawMemoryTool implements Tool<RenameRawMemoryParams> {
  name = 'rename_raw_memory'
  description =
    'RAW 记忆文件重命名（记忆工作流筛选专用）。参数：路径（必填，raw_memory 文件绝对路径）/ 关键词（必填，文件名关键词如 记忆已整理_重点回顾，不含序号；只允许 汉字/字母/数字/下划线，20 字内）。序号不变，文件名从 20.md 变为 20_关键词.md。返回 { 新路径 }。只允许 rawMemory 目录下 .md 文件，目标已存在会报错。'
  parameters = [
    { name: '路径', type: 'string' as const, description: 'raw_memory 文件绝对路径（如 raw_memory/2026/08/06/20.md）', required: true },
    { name: '关键词', type: 'string' as const, description: '文件名关键词（如 记忆已整理_重点回顾；不含序号；只允许 汉字/字母/数字/下划线，20 字内）', required: true }
  ]

  execute(params: RenameRawMemoryParams, ctx?: ToolContext): Promise<ToolResult> {
    if (!ctx?.paths?.rawMemory) {
      return Promise.resolve({ ok: false, error: 'ToolContext.paths.rawMemory 未初始化' })
    }
    const src = resolveToolPath(params.路径, ctx)
    const rawRoot = resolve(ctx.paths.rawMemory).replace(/\\/g, '/')

    // 1. 路径必须在 rawMemory 根目录下
    const srcNorm = src.replace(/\\/g, '/')
    if (!srcNorm.startsWith(rawRoot + '/')) {
      return Promise.resolve({ ok: false, error: `路径不在 rawMemory 目录下，拒绝重命名: ${src}` })
    }

    // 2. 文件名必须合法（纯序号 或 序号_关键词）
    const name = basename(src)
    const seqMatch = name.match(/^(\d+)(?:_[\u4e00-\u9fa5A-Za-z0-9_]+)?\.md$/)
    if (!seqMatch) {
      return Promise.resolve({ ok: false, error: `文件名不是合法 RAW 格式（{序号}.md 或 {序号}_关键词.md）: ${name}` })
    }
    const seq = seqMatch[1]
    if (!existsSync(src)) {
      return Promise.resolve({ ok: false, error: `RAW 文件不存在: ${src}` })
    }

    // 3. 关键词清洗：只保留 汉字/字母/数字/下划线，合并连续下划线，限 20 字
    const cleaned = String(params.关键词 ?? '')
      .replace(/[^\u4e00-\u9fa5A-Za-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 20)
    if (!cleaned) {
      return Promise.resolve({ ok: false, error: '关键词清洗后为空（只允许 汉字/字母/数字/下划线）' })
    }

    // 4. 防覆盖：目标已存在（且不是自己）则报错
    const dst = join(dirname(src), `${seq}_${cleaned}.md`)
    if (existsSync(dst) && srcNorm !== dst.replace(/\\/g, '/')) {
      return Promise.resolve({ ok: false, error: `目标文件已存在，不覆盖: ${dst}` })
    }

    try {
      renameSync(src, dst)
      ctx?.handleAccessed?.(src)
      ctx?.handleAccessed?.(dst)
      return Promise.resolve({ ok: true, data: { 新路径: dst, 序号: Number(seq), 关键词: cleaned } })
    } catch (err) {
      return Promise.resolve({ ok: false, error: (err as Error).message })
    }
  }
}

/** 供测试/进度读取复用：从文件名解析序号（兼容 序号.md 和 序号_关键词.md） */
export function parseRawSeqFromName(name: string): number | null {
  const m = name.match(/^(\d+)(?:_[\u4e00-\u9fa5A-Za-z0-9_]+)?\.md$/)
  if (!m) return null
  const seq = parseInt(m[1], 10)
  return Number.isNaN(seq) ? null : seq
}

/** 供测试复用：在 rawMemory 日期目录下按序号找文件（兼容 序号.md 和 序号_关键词.md） */
export function findRawMemoryFileBySeq(rawRoot: string, datePath: string, seq: number): string | null {
  const dir = join(rawRoot, datePath)
  if (!existsSync(dir)) return null
  const candidates = readdirSync(dir)
  const exact = candidates.find((n) => n === `${seq}.md`)
  if (exact) return join(dir, exact)
  const prefixed = candidates.find((n) => n.startsWith(`${seq}_`) && n.endsWith('.md'))
  return prefixed ? join(dir, prefixed) : null
}
