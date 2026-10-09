/**
 * 历史会话检索工具：为什么存在——"我之前说过/处理过什么"这类问题需要跨会话原文证据，
 * 当前上下文没有；本工具检索历史会话原文，与记忆库（read_md/nng_graph 读精华）互补。
 * 作用：session_search 按关键词匹配历史会话消息与工具调用参数，返回命中会话摘要/时间线，
 * 可用 sessionId 限定单会话或 scanRecent 限定扫描范围。
 * 不删掉的理由：记忆库存"提炼精华"，历史会话是唯一原始证据层；溯源原话/时间线时必须回到这里，
 * 本工具纯本地全文匹配（无 LLM 成本），与按语义检索的记忆工具定位不同、不可替代。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import type { AnyTool, ToolResult, ToolContext } from './base-tool'

interface SessionHit {
  sessionId: string
  sessionTitle: string
  /** 命中消息的角色 */
  role: string
  /** 命中消息的摘要（截断 300 字符） */
  snippet: string
  /** 消息时间戳（若有） */
  time?: number
}

interface SearchMessage {
  role?: string
  content?: unknown
  toolCalls?: unknown
  createdAt?: number
}

interface LoadedSession {
  id: string
  title: string
  messages: SearchMessage[]
}

/** 分片目录形态加载：{dir}/{id}/user/meta.json（提交点）+ user/{1..N}.json 分片，按 meta.shardCount 合并；返回 null 表示不可用 */
function loadDirSession(dir: string, id: string): { session: LoadedSession; bytes: number } | null {
  const udir = join(dir, id, 'user')
  const metaPath = join(udir, 'meta.json')
  if (!existsSync(metaPath)) return null
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as { id?: string; title?: string; shardCount?: number }
    const sessionId = meta.id ?? id
    const messages: SearchMessage[] = []
    let bytes = statSync(metaPath).size
    const shardCount = typeof meta.shardCount === 'number' && meta.shardCount >= 0 ? meta.shardCount : 0
    for (let n = 1; n <= shardCount; n++) {
      const p = join(udir, `${n}.json`)
      try {
        bytes += statSync(p).size
        const shard = JSON.parse(readFileSync(p, 'utf-8')) as SearchMessage[]
        messages.push(...shard)
      } catch {
        /* 损坏/缺失分片跳过（与 SessionStore 读取语义一致：缺号片跳过不隔离） */
      }
    }
    return { session: { id: sessionId, title: meta.title ?? sessionId, messages }, bytes }
  } catch {
    return null
  }
}

/** 旧单文件形态加载：{dir}/{id}.json（遗留兼容） */
function loadLegacySession(dir: string, id: string): { session: LoadedSession; bytes: number } | null {
  const p = join(dir, `${id}.json`)
  if (!existsSync(p)) return null
  try {
    const st = statSync(p)
    const s = JSON.parse(readFileSync(p, 'utf-8')) as { id?: string; title?: string; messages?: SearchMessage[] }
    return { session: { id: s.id ?? id, title: s.title ?? s.id ?? id, messages: s.messages ?? [] }, bytes: st.size }
  } catch {
    return null
  }
}

const SNIPPET_LEN = 300
/** 最大扫描会话文件数（性能保护：会话文件可能很大，只扫最近的） */
const MAX_SCAN_FILES = 30
/** 单个会话文件大小上限（超过跳过，防止几百 MB 文件拖垮扫描） */
const MAX_FILE_SIZE = 50 * 1024 * 1024

interface SessionSearchParams {
  /** 搜索关键词（必填，大小写不敏感子串匹配） */
  query: string
  /** 最多返回条数（默认 10，上限 30） */
  limit?: number
  /** 限定单个会话 ID（可选） */
  sessionId?: string
  /** 扫描最近多少个会话文件（默认 30，上限 100） */
  scanRecent?: number
}

/** 从会话 JSON 里提取可搜索文本（消息 content + 工具参数） */
function messageToSearchableText(content: unknown, toolCalls?: unknown): string {
  const parts: string[] = []
  if (typeof content === 'string') parts.push(content)
  else if (content && typeof content === 'object') {
    // ChatMessage.content 可能含 attachments 等结构
    try {
      parts.push(JSON.stringify(content))
    } catch {
      /* ignore */
    }
  }
  if (toolCalls) {
    try {
      const calls = Array.isArray(toolCalls) ? toolCalls : [toolCalls]
      for (const tc of calls) {
        if (tc && typeof tc === 'object') {
          const args = (tc as Record<string, unknown>).arguments ?? (tc as Record<string, unknown>).args
          if (typeof args === 'string') parts.push(args)
          else if (args) {
            try {
              parts.push(typeof args === 'string' ? args : JSON.stringify(args))
            } catch {
              /* ignore */
            }
          }
          const name = (tc as Record<string, unknown>).name
          if (typeof name === 'string') parts.push(name)
        }
      }
    } catch {
      /* ignore */
    }
  }
  return parts.join('\n')
}

/** 截断中段保留头尾 */
function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.6)
  return text.slice(0, head) + `...[截断，全长 ${text.length} 字符]...` + text.slice(text.length - (max - head))
}

export class SessionSearchTool implements AnyTool {
  name = 'session_search'
  description = `检索历史会话原文（证据层）。与记忆库互补：记忆库（read_md/nng_graph 读精华），本工具查会话原文（原始对话记录，可溯源原话/时间线/历史决策）。按关键词匹配消息内容和工具调用参数，返回命中会话 ID、标题、消息摘要。参数：query（必填，关键词）、limit（默认 10）、sessionId（可选，限定单个会话）、scanRecent（可选，扫描最近 N 个会话文件，默认 30）。`
  parameters = [
    { name: 'query', type: 'string' as const, description: '搜索关键词（必填）', required: true },
    { name: 'limit', type: 'number' as const, description: '最多返回条数（默认 10，上限 30）', required: false },
    { name: 'sessionId', type: 'string' as const, description: '限定单个会话 ID（可选）', required: false },
    { name: 'scanRecent', type: 'number' as const, description: '扫描最近多少个会话文件（默认 30，上限 100）', required: false }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const p = params as unknown as SessionSearchParams
    const query = (p.query ?? '').trim()
    if (!query) {
      return { ok: false, error: 'query 参数必填（搜索关键词）' }
    }
    if (!ctx?.paths?.sessions) {
      return { ok: false, error: '会话目录不可用（paths.sessions 未初始化）' }
    }
    const sessionsDir = ctx.paths.sessions
    if (!existsSync(sessionsDir)) {
      return { ok: false, error: `会话目录不存在: ${sessionsDir}` }
    }

    const limit = Math.min(Math.max(p.limit ?? 10, 1), 30)
    const scanRecent = Math.min(Math.max(p.scanRecent ?? MAX_SCAN_FILES, 1), 100)
    const needle = query.toLowerCase()

    // 会话源枚举（两种存储形态统一）：
    // ① 分片目录形态（当前 SessionStore）：{sid}/user/meta.json + user/{1..N}.json
    // ② 旧单文件形态（遗留兼容）：{sid}.json
    interface SessionSource {
      id: string
      mtimeMs: number
      load: () => { session: LoadedSession; bytes: number } | null
    }
    const sources: SessionSource[] = []
    try {
      const entries = readdirSync(sessionsDir, { withFileTypes: true })
      for (const e of entries) {
        if (e.isDirectory()) {
          // 目录形态：只认含 user/meta.json 的会话目录（忽略 ai/ 等其他目录）
          const metaPath = join(sessionsDir, e.name, 'user', 'meta.json')
          if (!existsSync(metaPath)) continue
          let mtime = 0
          try {
            mtime = statSync(metaPath).mtimeMs
          } catch {
            /* ignore */
          }
          sources.push({ id: e.name, mtimeMs: mtime, load: () => loadDirSession(sessionsDir, e.name) })
        } else if (
          e.isFile() &&
          e.name.endsWith('.json') &&
          !e.name.startsWith('.corrupt-') &&
          !e.name.endsWith('.blocks.json')
        ) {
          const id = e.name.slice(0, -'.json'.length)
          let mtime = 0
          try {
            mtime = statSync(join(sessionsDir, e.name)).mtimeMs
          } catch {
            /* ignore */
          }
          sources.push({ id, mtimeMs: mtime, load: () => loadLegacySession(sessionsDir, id) })
        }
      }
    } catch (err) {
      return { ok: false, error: `扫描会话目录失败: ${(err as Error).message}` }
    }
    sources.sort((a, b) => b.mtimeMs - a.mtimeMs)
    let files = sources.slice(0, scanRecent)

    // 限定单会话（目录形态或旧单文件形态均可）
    if (p.sessionId) {
      const match = sources.find((s) => s.id === p.sessionId)
      if (!match) {
        return { ok: false, error: `会话不存在: ${p.sessionId}` }
      }
      files = [match]
    }

    const hits: SessionHit[] = []
    let scanned = 0
    let skippedLarge = 0

    for (const src of files) {
      const loaded = src.load()
      if (!loaded) continue
      if (loaded.bytes > MAX_FILE_SIZE) {
        skippedLarge++
        continue
      }
      const session = loaded.session
      scanned++
      const sessionId = session.id
      const sessionTitle = session.title
      const msgs = session.messages
      try {
        // 从后往前找（最近的命中优先）
        for (let i = msgs.length - 1; i >= 0 && hits.length < limit; i--) {
          const m = msgs[i]
          if (!m) continue
          const text = messageToSearchableText(m.content, m.toolCalls)
          if (!text) continue
          const idx = text.toLowerCase().indexOf(needle)
          if (idx >= 0) {
            // 摘要：以命中点为中心截取
            const start = Math.max(0, idx - 60)
            const rawSnippet = text.slice(start, start + SNIPPET_LEN)
            hits.push({
              sessionId,
              sessionTitle,
              role: m.role ?? 'unknown',
              snippet: truncateMiddle(rawSnippet, SNIPPET_LEN),
              time: m.createdAt
            })
          }
        }
      } catch {
        // 单个会话解析失败跳过（可能是损坏文件，SessionStore 已隔离 .corrupt-）
        continue
      }
    }

    if (hits.length === 0) {
      const note = skippedLarge > 0 ? `（跳过 ${skippedLarge} 个超大会话文件）` : ''
      return {
        ok: true,
        data: {
          hits: [],
          scanned,
          message: `未命中"${query}"${note}。可尝试：① 换关键词 ② 增大 scanRecent ③ 用 read_md 直读记忆库文件（精华层）`
        }
      }
    }

    return {
      ok: true,
      data: {
        hits,
        scanned,
        skippedLarge,
        query,
        message: `命中 ${hits.length} 条（扫描 ${scanned} 个会话文件${skippedLarge ? `，跳过 ${skippedLarge} 个超大文件` : ''}）`
      }
    }
  }
}
