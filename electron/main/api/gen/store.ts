/**
 * 多模态生成产物存储（GenStore）

 * 为什么存在：文生图/视频/音频等产物是有用户价值的资产，需要持久化
 * 并按用户×AI、分类、日期组织，供后续检索与 UI 展示——

 * 落盘结构（沿用记忆的「uid×aiId 隔离 + 年/月/日」约定，见 models/paths.ts）：
 * {root}/generated/U{uid}/AI{aiId}/{category}/{YYYY}/{MM}/{DD}/{filename}

 * category 白名单：image（图片）/ video（视频）/ audio（音频）/ document（文稿）。
 * 产物是用户数据，不属于缓存——启动时**不**清理（与 cache/sandbox 缓存语义不同）。
 * 文件名由本模块统一生成（时间戳 + 随机串），调用方禁止拼路径，防止路径遍历越界。
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { DEFAULT_AI_ID } from '@shared/types'
import type { DataPaths } from '../../models/paths'
import type { ToolContext } from '../../tools/base-tool'
import { normalizePath } from '../../models/paths'

/** 生成产物分类白名单（新分类需显式加入，防止路径越界） */
export const GEN_CATEGORIES = ['image', 'video', 'audio', 'document'] as const
export type GenCategory = (typeof GEN_CATEGORIES)[number]

/** 分类默认文件扩展名（openAICompatGeneration 未推断出更精确 mime 时兜底） */
export const CATEGORY_EXT: Record<GenCategory, string> = {
  image: 'png',
  video: 'mp4',
  audio: 'mp3',
  document: 'md'
}

/** 生成产物的定位信息（全绝对路径用正斜杠，对齐 normalizePath 约定） */
export interface GeneratedAsset {
  /** 绝对路径（正斜杠） */
  path: string
  /** 相对数据根路径（正斜杠，generated/... 开头），用于入库/检索镜像 */
  relativePath: string
  /** file:// URL（AI 可交给浏览器面板/系统打开） */
  url: string
  /** lune-media:// URL（渲染进程 <img>/<video>/<audio> 直接加载，协议只放行 generated/ 白名单扩展） */
  mediaUrl: string
  /** 分类 */
  category: GenCategory
  /** 日期目录 {YYYY}/{MM}/{DD} */
  date: string
}

/**
 * 从工具上下文解析生成作用域 {uid, aiId}。
 * 优先取 ctx.paths.memoryScope（memory/U{uid}/AI{aiId}，权威作用域）；
 * 缺失（未登录态 / 全局路径）时回退 ctx.user.UID 与默认 aiId=1。
 */
export function resolveGenScope(ctx?: ToolContext): { uid: number; aiId: number } {
  const memoryScope = ctx?.paths?.memoryScope
  if (memoryScope) {
    const m = /U(\d+)\/AI(\d+)/.exec(memoryScope.replace(/\\/g, '/'))
    if (m) {
      return { uid: Number(m[1]), aiId: Number(m[2]) }
    }
  }
  return { uid: ctx?.user?.UID ?? 0, aiId: DEFAULT_AI_ID }
}

/** 作用域生成根：{root}/generated/U{uid}/AI{aiId} */
export function genScopeRoot(base: DataPaths, uid: number, aiId: number): string {
  return join(base.root, 'generated', `U${uid}`, `AI${aiId}`)
}

/** 某分类 + 日期目录：{scopeRoot}/{category}/{YYYY}/{MM}/{DD} */
export function genCategoryDir(base: DataPaths, uid: number, aiId: number, category: GenCategory, date = new Date()): string {
  const yyyy = String(date.getFullYear())
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return join(genScopeRoot(base, uid, aiId), category, yyyy, mm, dd)
}

/** 生成唯一文件名：{slug}_{yyyymmdd_HHmmss}_{rand}.{ext}（时间+随机，避免覆盖） */
export function uniqueGenFilename(slug: string, ext: string, date = new Date()): string {
  const safe = (slug || 'asset').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 48)
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    '_',
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0')
  ].join('')
  const rand = Math.random().toString(36).slice(2, 6)
  return `${safe}_${stamp}_${rand}.${ext}`
}

/**
 * 保存一个生成产物到分类 + 年/月/日目录。
 * @param ctx 工具上下文（解析 uid/aiId，取 paths.root）
 * @param category 分类白名单
 * @param data 内容（文本用 string，二进制用 Buffer）
 * @param opts.slug 文件名主体（会净化）；opts.ext 扩展名（不带点，缺省按分类）
 * @returns GeneratedAsset 定位信息
 */
export function saveGeneratedAsset(
  ctx: ToolContext | undefined,
  category: GenCategory,
  data: string | Buffer,
  opts: { slug?: string; ext?: string; date?: Date } = {}
): GeneratedAsset {
  if (!ctx?.paths) {
    throw new Error('缺少 paths 上下文，无法定位生成存储根目录')
  }
  if (!GEN_CATEGORIES.includes(category)) {
    throw new Error(`非法生成分类: ${category}（允许 ${GEN_CATEGORIES.join('/')}）`)
  }
  const { uid, aiId } = resolveGenScope(ctx)
  const base = ctx.paths
  const date = opts.date ?? new Date()
  const dir = genCategoryDir(base, uid, aiId, category, date)
  mkdirSync(dir, { recursive: true })
  const ext = (opts.ext ?? CATEGORY_EXT[category]).replace(/^\./, '')
  const filename = uniqueGenFilename(opts.slug ?? category, ext, date)
  const abs = join(dir, filename)
  writeFileSync(abs, data)
  const path = normalizePath(abs)
  const dateStr = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('/')
  const relativePath = normalizePath(join('generated', `U${uid}`, `AI${aiId}`, category, dateStr, filename))
  return {
    path,
    relativePath,
    url: `file://${path}`,
    mediaUrl: `lune-media:///${relativePath}`,
    category,
    date: dateStr
  }
}

/** 列出某分类下最近的生成产物（相对 -> 绝对，按 mtime 降序，limit 内） */
export function listGeneratedAssets(ctx: ToolContext | undefined, category: GenCategory, limit = 20): GeneratedAsset[] {
  if (!ctx?.paths) return []
  if (!GEN_CATEGORIES.includes(category)) return []
  const { uid, aiId } = resolveGenScope(ctx)
  const root = genScopeRoot(ctx.paths, uid, aiId)
  const catRoot = join(root, category)
  if (!existsSync(catRoot)) return []
  const out: GeneratedAsset[] = []
  // 遍历 {category}/{Y}/{M}/{D}/*，收集文件
  const walk = (dir: string, rel: string) => {
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e)
      let s: ReturnType<typeof statSync> | null = null
      try {
        s = statSync(p)
      } catch {
        continue
      }
      if (s.isDirectory()) {
        walk(p, `${rel}/${e}`)
      } else if (s.isFile()) {
        const np = normalizePath(p)
        const relativePath = normalizePath(join('generated', `U${uid}`, `AI${aiId}`, category, rel, e))
        out.push({
          path: np,
          relativePath,
          url: `file://${np}`,
          mediaUrl: `lune-media:///${relativePath}`,
          category,
          date: rel.replace(/^\//, '')
        })
      }
    }
  }
  walk(catRoot, '')
  out.sort((a, b) => (a.path < b.path ? 1 : -1))
  return out.slice(0, limit)
}