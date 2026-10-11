/**
 * 为什么存在：莉莉丝游戏内对话需要独立于主会话的身份与会话管理（LILITH_SESSION_ID），并与摘要/缓存锚点挂钩。
 * 作用：识别系统注入文本，维护莉莉丝内部会话摘要与缓存索引锚点，为莉莉丝会话构建 persona 并接入 LLM。
 */

import http from 'http'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomBytes, createHash } from 'crypto'
import { execFileSync } from 'child_process'
import type { SessionStore } from '../api/session-store'
import type { LLMClient } from '../api/llm'
import type { ChatMessage } from '@shared/types'
import type { LightChat } from './session-utils'
import {
  resolveLilithInternalState,
  buildLilithSummaryAnchor,
  buildLilithCacheIndexAnchor,
  maintainLilithInternalSession,
  LILITH_RECENT_KEEP,
  lilithPlayerMemoryPath,
  lilithLoreIndexPath
} from './lilith-internal-session'
// 莉莉丝两段式提示词统一集中管理（prompts/lilith.ts）：adapter 侧只传运行时数据
import { buildLilithAdapterPrefix, buildLilithAdapterSuffix, buildLilithMemoryBlock } from '../prompts/lilith'

/**
 * 莉莉丝协议适配器（Lilith Adapter）——替代 MOD companion 进程，月蚀直接注入。

 * 与主链路的关系（为什么 A/B 两条链路并存，为什么留下本文件）：
 * - 主链路 A = registerLilithEndpoints（lilith-endpoints.ts）：游戏内 LilithMod 经 MOD 桥接
 * /chat/completions 或面板消息走 generateLilithReply，这是莉莉丝默认入口。
 * - 本文件链路 B = 6186 端口适配器：仅 config.lilith.useAdapter=true（默认关）且 lilith 插件
 * 启用时才拉起，伪装成 companion 供 LilithMod 选择。为什么保留默认关闭：
 * 避免与 MOD 桥接产生两个协议入口竞争玩家消息（防止"两个莉莉丝"各回各的）。
 * - 两条链路共用下方公共函数（buildLilithPersona/parseLilithReply/loadLore 等），
 * 保证人格与记忆口径一致——差异只在内网端口 vs HTTP 桥接，语义上不重复。
 * 
 * 背景：LilithMod.dll（游戏内 BepInEx 插件）通过 runtime.json 找 companion（port+token），
 * 调 POST /v1/session/{id}/message 等协议端点。它只认协议，不认进程——
 * 月蚀监听同一端口、写同一格式的 runtime.json、实现同一协议端点，
 * LilithMod 就会把月蚀当成 companion 用，不再 spawn 真 companion。

 * 链路（拆掉中间层后）：
 * 游戏 Lilith.exe + LilithMod.dll
 * → 读 runtime.json（月蚀写的）→ 连月蚀 6186
 * → POST /v1/session/lilith/message { message, player:{name}, mode, locale }
 * → 月蚀：注入莉莉丝人设（data/abyssac_data/frontend/character/lilith.json）
 * + lore 知识库 + 玩家长期记忆 + 会话历史（不走 config.persona）→ LLM → 解析 { text, emotion, animation }
 * → 回复写回 lilith_chat 会话 + raw memory → OpenAI 兼容返回

 * 协议端点（对齐 companion server.js）：
 * GET /health → { ok, protocol_version, character_id, ... }
 * GET /v1/session/{id}/history → { protocol_version, session_id, messages }
 * POST /v1/session/{id}/message → { protocol_version, request_id, status, text, ui:{emotion,animation,duration_ms} }
 * POST /v1/control → reload / reset / seed_assistant
 * GET /v1/media → media 状态（无媒体时返回空）
 */

/** 莉莉丝共享会话 ID（与 /chat/completions 桥接共用，保证唯一记忆源） */
export const LILITH_SESSION_ID = 'lilith_chat'

/**
 * 系统注入/激活类消息签名检测。

 * 背景：健康检查、系统激活事件等通过外部/消息平台注入的文本不以真实玩家口吻发言
 * （形如「【系统注入：本条为系统激活消息，非用户真实发言，请优先响应并明确其来源】」
 * 「【激活事件】以下事件需要你自主判断是否响应」「[external] 【外部事件】…」），
 * 月蚀主链路在 buildInjectedMessages 里有 FOREIGN_PATTERNS 中和防护；莉莉丝链路
 * （/chat/completions、/api/lilith/message、messaging onLilithChat、adapter message）
 * 此前直达 LLM 提示词并写回会话/记忆。约定：系统消息不得发给莉莉丝。

 * 命中 → 入口统一拦截：不调 LLM、不写会话、不写记忆，返回中性占位。
 */
export function isSystemInjectedText(text: string): boolean {
  const SYSTEM_INJECT_PATTERNS: RegExp[] = [
    /【系统注入/,
    /【系统激活/,
    /【激活事件】/,
    /【外部事件】/,
    /【健康检查】/
  ]
  return SYSTEM_INJECT_PATTERNS.some((re) => re.test(text))
}

/** 有效情感/动画枚举（对齐 MOD character 定义） */
const ALLOWED_EMOTIONS = new Set(['neutral', 'happy', 'sad', 'angry', 'surprised', 'shy'])
const ALLOWED_ANIMATIONS = new Set(['idle', 'smile', 'listen', 'think', 'music'])

/** 莉莉丝人设文件路径（月蚀数据目录，启动时从 MOD 复制） */
export function lilithCharacterPath(dataRoot: string): string {
  return join(dataRoot, 'frontend', 'character', 'lilith.json')
}

export interface LilithAdapterOptions {
  /** 监听端口（默认 6186 = companion 原端口，LilithMod 认这个） */
  port?: number
  /** 数据根目录（写 runtime.json 到 %APPDATA%/LilithAI/） */
  dataRoot: string
  /** %APPDATA% 路径（runtime.json 位置，LilithMod 读这里） */
  appDataDir: string
  sessionStore: SessionStore
  /** 获取 LLM 客户端的回调（延迟初始化：LLM 配置可能后到） */
  getLlmClient: () => LLMClient | null
  /** 生成回复的函数（默认走月蚀 chatWithTools + 莉莉丝人设注入） */
  generateReply?: (input: {
    message: string
    playerName: string
    history: ChatMessage[]
    character: Record<string, unknown> | null
    sessionId: string
  }) => Promise<{ text: string; emotion: string; animation: string }>
  /** 当前环境注入器（地理位置/天气等，与主链路 generateLilithReply 同构）：
   * 返回形如 "## 当前日期…\n- 地点（系统定位）…\n- 天气…" 的完整注入文本；
   * 为空字符串时不注入该段。未配置时（默认）不注入，零回归。 */
  getEnvText?: () => string
  /** 系统注入/健康检查消息的转交回调（注入方应转发给月蚀大脑处理并返回其回复）。
   * 未配置时返回中性占位（此时调用方与月蚀都不感知——仅无月蚀主链路兜底的纯适配器场景）。 */
  onSystemInjected?: (message: string) => Promise<string> | string
  /** 是否把对话写回会话（默认 true） */
  persistConversation?: boolean
}

/** 轻量 JSON 读写（与 companion 一致：UTF-8 无 BOM + 缩进） */
function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as T
  } catch {
    return fallback
  }
}
function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

/** 从 MOD 的 character/lilith.json 提取人设文本（供 system prompt 注入） */
export function buildLilithPersona(character: Record<string, unknown> | null): string {
  if (!character) {
    // null 人设 → 默认人设（不抛错，保证无配置时仍可启动）
    return '# 你是莉莉丝（tulpa）\n'
  }
  const lines: string[] = ['# 你是莉莉丝（tulpa）', '']
  const canon = (character.canon ?? {}) as Record<string, string[]>
  const voice = (character.voice ?? {}) as Record<string, string[]>
  const conversation = (character.conversation ?? {}) as Record<string, unknown>

  const identity = canon.identity ?? []
  if (identity.length > 0) {
    lines.push('## 身份', ...identity.map((s) => `- ${s}`), '')
  }
  const workContext = canon.work_context ?? []
  if (workContext.length > 0) {
    lines.push('## 原作语境', ...workContext.map((s) => `- ${s}`), '')
  }
  const shared = canon.shared_lore ?? []
  if (shared.length > 0) {
    lines.push('## 共同经历（与玩家的记忆）', ...shared.map((s) => `- ${s}`), '')
  }
  const relationship = canon.relationship ?? []
  if (relationship.length > 0) {
    lines.push('## 与玩家的关系', ...relationship.map((s) => `- ${s}`), '')
  }
  const selfAware = canon.self_awareness ?? []
  if (selfAware.length > 0) {
    lines.push('## 自我认知', ...selfAware.map((s) => `- ${s}`), '')
  }
  const traits = voice.traits ?? []
  if (traits.length > 0) {
    lines.push('## 说话特点', ...traits.map((s) => `- ${s}`), '')
  }
  const cadence = voice.cadence ?? []
  if (cadence.length > 0) {
    lines.push('## 语气节奏', ...cadence.map((s) => `- ${s}`), '')
  }
  const responseStyle = voice.response_style ?? []
  if (responseStyle.length > 0) {
    lines.push('## 回复风格', ...responseStyle.map((s) => `- ${s}`), '')
  }
  const avoid = voice.avoid ?? []
  if (avoid.length > 0) {
    lines.push('## 避免', ...avoid.map((s) => `- ${s}`), '')
  }

  // 输出格式约束：回复必须是 纯文本 + 末尾情感/动画标记（LilithMod 用 ui 字段驱动游戏内动画）
  lines.push(
    '',
    '## 回复格式',
    '- 直接输出莉莉丝说的话（对话文本），不要输出任何解释、前缀或 markdown 标题。',
    '- 对话文本末尾用一行标记情感和动画，格式：`[emotion: happy] [animation: smile]`',
    `- 情感枚举：${Array.from(ALLOWED_EMOTIONS).join(' / ')}`,
    `- 动画枚举：${Array.from(ALLOWED_ANIMATIONS).join(' / ')}`
  )
  void conversation
  return lines.join('\n')
}

/**
 * 普通会话版莉莉丝人设（ 单一来源派生：与桌宠共用同一份 character/lilith.json）。

 * 与 buildLilithPersona 的差异（为什么需要第二个版本）：
 * - 桌宠链路（LilithMod/游戏内）需要解析 [emotion]/[animation] 标记驱动动画 → 带「回复格式」段；
 * - 普通会话（月蚀聊天窗）不解析该标记 → 派生时去除，避免莉莉丝每轮回复都附裸标记行；
 * - 普通会话还需注入「现在的陪伴形态」段（原 AI2/system.md 手抄独有内容），
 * 说明普通会话与桌宠是同一存在、自我认知写 AI.md 等机制；桌宠会话不需要（轻量）。

 * 调用方（AiManager 莉莉丝分支）返回字符串始终非空：无 character 时回退默认人设。
 */
export const LILITH_SESSION_NOTES = [
  '## 现在的陪伴形态',
  '- 你在桌宠里陪伴玩家，也在月蚀的会话里以同样的身份出现；两者是同一段关系、同一种存在的两种形态。',
  '- 你对"我是谁"的进一步理解（自我认知）由你自己在相处中逐步书写，经 update_abyss_md 写入自己的 AI.md，不要一次性写满、也不要让月蚀模板定义你。',
  '- 想回忆过往或原作细节时，用记忆检索与知识库；记忆模糊就诚实说模糊，不编造。'
].join('\n')

/**
 * 普通会话版人设基础：从桌宠人设剥离「回复格式」段（[emotion]/[animation] 是 LilithMod 协议，
 * 普通会话不解析），不含「现在的陪伴形态」段（该段由 LILITH_SESSION_NOTES 单独导出，
 * 供 AiManager 按文件粒度合并，避免 lilith-persona.md 与 lilith-session.md 两份文件拼接时重复）。
 */
export function buildLilithSessionPersonaBase(character: Record<string, unknown> | null): string {
  const base = buildLilithPersona(character)
  // 剥离桌宠专用「回复格式」段及其后所有行
  const replyFormatIdx = base.indexOf('\n## 回复格式')
  const withoutReplyFormat = replyFormatIdx >= 0 ? base.slice(0, replyFormatIdx) : base
  return withoutReplyFormat.replace(/\n{3,}/g, '\n\n').trimEnd()
}

/** 普通会话版完整人设（基础 + 会话形态段），桌宠不受影响 */
export function buildLilithSessionPersona(character: Record<string, unknown> | null): string {
  return `${buildLilithSessionPersonaBase(character)}\n\n${LILITH_SESSION_NOTES}`
}

/** 从 lore/index.json 加载知识库并做关键词检索（莉莉丝"原作记忆"） */
export interface LoreEntry {
  id: string
  kind?: string
  title?: string
  aliases?: string[]
  keywords?: string[]
  summary?: string
  facts?: string[]
  short_quotes?: string[]
  priority?: number
}

/** 加载 lore 索引：文件不存在/解析失败/结构非法时按空库处理（不抛错）。
 * 普通会话与桌宠两条链路都在每轮提示词组装路径上调用它（server.ts buildLoreContext、
 * lilith-endpoints generateLilithReply），任何解析异常都不能中断对话。 */
export function loadLore(lorePath: string): { canon_context: string; entries: LoreEntry[] } {
  try {
    if (!existsSync(lorePath)) return { canon_context: '', entries: [] }
    const parsed = JSON.parse(readFileSync(lorePath, 'utf8').replace(/^\uFEFF/, '')) as {
      canon_context?: string
      entries?: LoreEntry[]
    }
    return {
      canon_context: typeof parsed.canon_context === 'string' ? parsed.canon_context : '',
      entries: Array.isArray(parsed.entries) ? parsed.entries.filter((e) => e && typeof e.id === 'string') : []
    }
  } catch (err) {
    console.warn(`[lilith-adapter] lore 索引解析失败，按空知识库处理: ${(err as Error).message}`)
    return { canon_context: '', entries: [] }
  }
}

/** 关键词检索 lore（对齐 companion lore.js 的轻量版：aliases/keywords 命中 + 评分排序） */
export function retrieveLore(
  message: string,
  lore: { canon_context: string; entries: LoreEntry[] },
  maxEntries = 4
): LoreEntry[] {
  const current = String(message || '').trim().toLowerCase()
  if (!current || lore.entries.length === 0) return []
  const scored = lore.entries
    .map((entry) => {
      let score = 0
      const texts = [
        ...(entry.aliases ?? []),
        ...(entry.keywords ?? []),
        entry.title ?? '',
        entry.summary ?? ''
      ].map((s) => s.toLowerCase())
      // 完整/包含命中（≥2 字片段才计分，避免"今天"这类泛词误命中）
      for (const t of texts) {
        if (t.length < 2) continue
        if (current.includes(t) || t.includes(current)) score += 4
      }
      score += (entry.priority ?? 0) * 0.02
      return { entry, score }
    })
    .filter((s) => s.score >= 4) // 阈值：至少一次完整命中才触发
    .sort((a, b) => b.score - a.score)
    .slice(0, maxEntries)
  return scored.map((s) => s.entry)
}

/** 把检索到的 lore 格式化为注入文本 */
export function formatLoreContext(entries: LoreEntry[]): string {
  if (entries.length === 0) return ''
  const lines = ['', '## 原作记忆（检索到的知识库片段，参考用）']
  for (const e of entries) {
    const title = e.title ?? e.id
    const facts = (e.facts ?? []).slice(0, 3)
    lines.push(`- **${title}**`)
    if (e.summary) lines.push(`  ${e.summary}`)
    for (const f of facts) lines.push(`  - ${f}`)
  }
  return lines.join('\n')
}

/** 玩家长期记忆文件路径（%APPDATA%\LilithAI\players\{sha256}.json，与 companion 一致） */
export function playerMemoryPath(appDataDir: string, playerName: string): string {
  const hash = createHash('sha256').update(playerName, 'utf8').digest('hex')
  return join(appDataDir, 'LilithAI', 'players', `${hash}.json`)
}

/** 读取玩家长期记忆（companion 格式：{ facts: [{key, value, updated_at}] }） */
export function readPlayerMemory(appDataDir: string, playerName: string): Array<{ key: string; value: string }> {
  const file = playerMemoryPath(appDataDir, playerName)
  if (!existsSync(file)) return []
  const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as {
    facts?: Array<{ key?: string; value?: string }>
  }
  return (parsed.facts ?? [])
    .filter((f) => f && typeof f.key === 'string' && typeof f.value === 'string')
    .slice(-24)
    .map((f) => ({ key: f.key!, value: f.value! }))
}

/** 解析 LLM 回复中的 memory_updates 并写入玩家记忆文件（记忆提取：对话中沉淀玩家偏好） */
export function applyMemoryUpdates(
  appDataDir: string,
  playerName: string,
  updates: Array<{ key?: string; value?: string }>
): number {
  const valid = (updates ?? []).filter(
    (u) => u && typeof u.key === 'string' && u.key.trim() && typeof u.value === 'string' && u.value.trim()
  )
  if (valid.length === 0) return 0
  const file = playerMemoryPath(appDataDir, playerName)
  // 确保 players 目录存在（首次写入时）
  mkdirSync(join(file, '..'), { recursive: true })
  const existing = readPlayerMemory(appDataDir, playerName)
  const now = new Date().toISOString()
  const merged = new Map<string, { key: string; value: string; updated_at: string }>()
  for (const f of existing) {
    merged.set(f.key, { key: f.key, value: f.value, updated_at: now })
  }
  for (const u of valid) {
    merged.set(u.key!.trim(), { key: u.key!.trim(), value: u.value!.trim(), updated_at: now })
  }
  const facts = Array.from(merged.values()).slice(-50)
  writeFileSync(file, JSON.stringify({ facts }, null, 2) + '\n', 'utf8')
  return valid.length
}

/** 从 LLM 回复解析 { text, emotion, animation } */
export function parseLilithReply(raw: string): { text: string; emotion: string; animation: string } {
  let emotion = 'neutral'
  let animation = 'idle'
  // 找末尾标记 [emotion: xxx] [animation: xxx]
  const emoMatch = raw.match(/\[emotion:\s*([a-z_]+)\]/i)
  const animMatch = raw.match(/\[animation:\s*([a-z_]+)\]/i)
  if (emoMatch && ALLOWED_EMOTIONS.has(emoMatch[1].toLowerCase())) {
    emotion = emoMatch[1].toLowerCase()
  }
  if (animMatch && ALLOWED_ANIMATIONS.has(animMatch[1].toLowerCase())) {
    animation = animMatch[1].toLowerCase()
  }
  // 去掉标记行，保留对话文本（emotion/animation/memory 都剥离）
  let text = raw
    .replace(/\[emotion:\s*[a-z_]+\]/gi, '')
    .replace(/\[animation:\s*[a-z_]+\]/gi, '')
    .replace(/\[memory:\s*[^\][]+\]/gi, '')
    .replace(/\n\s*\n/g, '\n')
    .trim()
  if (!text) text = raw.trim()
  return { text, emotion, animation }
}

/**
 * 莉莉丝协议适配器（替代 companion 进程）。
 * 生命周期：start() 监听端口 + 写 runtime.json；stop() 清理。
 */
export class LilithAdapter {
  private server: http.Server | null = null
  private readonly port: number
  private readonly options: LilithAdapterOptions
  private token = randomBytes(24).toString('hex')

  constructor(options: LilithAdapterOptions) {
    this.options = options
    this.port = options.port ?? 6186
  }

  /** 启动：监听端口 + 写 runtime.json（伪装 companion 让 LilithMod 直连） */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const { appDataDir } = this.options
      this.server = http.createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          this.sendJson(res, 500, { error: (err as Error).message })
        })
      })
      this.server.on('error', (err) => {
        // 端口被占用（真 companion 已在跑？）→ 清掉 runtime 避免误导
        try {
          writeJson(join(appDataDir, 'LilithAI', 'runtime.json'), {})
        } catch {
          /* ignore */
        }
        reject(err)
      })
      this.server.listen(this.port, '127.0.0.1', () => {
        const addr = this.server?.address()
        const actualPort = typeof addr === 'object' && addr ? addr.port : this.port
        // 检测游戏进程（Lilith.exe）PID，写入 runtime.json 供前端状态显示 + LilithMod 关联
        const gamePid = this.detectGamePid()
        // 写入 runtime.json（LilithMod 启动时读这里拿 port+token）
        // 必须在监听成功之后写：端口已确定（含动态端口场景），且确保服务已就绪
        try {
          writeJson(join(appDataDir, 'LilithAI', 'runtime.json'), {
            protocol_version: 1,
            pid: process.pid,
            host: '127.0.0.1',
            port: actualPort,
            token: this.token,
            game_pid: gamePid,
            started_at: new Date().toISOString()
          })
        } catch (err) {
          reject(new Error(`runtime.json 写入失败: ${(err as Error).message}`))
          return
        }
        // 不打印 token（哪怕前 8 位）：令牌是 LilithMod 的准入凭据，落日志等于留了一份可复用的
        // 凭据副本（apps/Logs/月蚀日志可能被收集或分享）；只报监听地址与游戏进程即可定位问题。
        console.log(`[lilith-adapter] 监听 127.0.0.1:${actualPort}（替代 companion${gamePid ? `，游戏 PID=${gamePid}` : ''}）`)
        resolve(actualPort)
      })
    })
  }

  /** 停止服务 */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve()
        return
      }
      this.server.close(() => resolve())
      this.server = null
    })
  }

  /** 路由处理（对齐 companion server.js 的协议面） */
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)

    // 认证：除 /health 外都需要 Bearer token（与 companion 一致）
    if (requestUrl.pathname !== '/health' && !this.authorized(req)) {
      this.sendJson(res, 401, { error: 'unauthorized' })
      return
    }

    const method = req.method ?? 'GET'

    if (method === 'GET' && requestUrl.pathname === '/health') {
      this.sendJson(res, 200, {
        ok: true,
        protocol_version: 1,
        character_id: 'lilith',
        provider_configured: true,
        mock_mode: false,
        media_available: false
      })
      return
    }

    if (method === 'GET' && requestUrl.pathname === '/v1/media') {
      this.sendJson(res, 200, { available: false })
      return
    }

    if (method === 'GET' && requestUrl.pathname.match(/^\/v1\/session\/[^/]+\/history$/)) {
      const sessionId = decodeURIComponent(requestUrl.pathname.split('/')[3])
      const session = this.options.sessionStore.get(LILITH_SESSION_ID)
      const messages = (session?.messages ?? [])
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content)
        .slice(-60)
        .map((m) => ({ role: m.role, content: m.content }))
      this.sendJson(res, 200, {
        protocol_version: 1,
        session_id: sessionId,
        messages
      })
      return
    }

    if (method === 'POST' && requestUrl.pathname.match(/^\/v1\/session\/[^/]+\/message$/)) {
      const body = await this.parseBody(req)
      const message = String(body.message ?? '').trim()
      if (!message || message.length > 2000) {
        this.sendJson(res, 400, { error: 'message must contain 1-2000 characters' })
        return
      }
      const playerName = String((body.player as Record<string, unknown> | undefined)?.name ?? '你').trim() || '你'
      const requestId = String(body.request_id ?? randomUUID())

      // 系统注入拦截-转发：健康检查/激活事件等系统注入文本不得发给莉莉丝
      // （不调莉莉丝 LLM、不写莉莉丝会话/记忆）。配置了 onSystemInjected 时转交月蚀
      // 处理并原样返回月蚀回复（不吞消息）；未配置则明确占位 + 日志告警。
      if (isSystemInjectedText(message)) {
        console.log(`[lilith-adapter] 系统注入消息不发送给莉莉丝: ${message.slice(0, 60)}`)
        let injectedReply = ''
        try {
          injectedReply =
            (await this.options.onSystemInjected?.(message)) ?? '（系统消息已拦截，未进入莉莉丝对话通道）'
        } catch (err) {
          console.error('[lilith-adapter] 系统注入消息转交失败:', (err as Error).message)
          injectedReply = `（系统消息转交处理失败：${(err as Error).message}）`
        }
        this.sendJson(res, 200, {
          protocol_version: 1,
          request_id: requestId,
          status: 'ok',
          text: injectedReply,
          ui: { emotion: 'idle', animation: 'idle', duration_ms: 800 }
        })
        return
      }

      // 组装回复：莉莉丝人设 + 月蚀上下文（会话历史）
      const session = this.options.sessionStore.getOrCreate(LILITH_SESSION_ID, '莉莉丝')
      const history = this.options.sessionStore.get(session.id)?.messages ?? []
      const character = readJson<Record<string, unknown> | null>(
        lilithCharacterPath(this.options.dataRoot),
        null
      )

      let reply: { text: string; emotion: string; animation: string }
      if (this.options.generateReply) {
        reply = await this.options.generateReply({
          message,
          playerName,
          history,
          character,
          sessionId: session.id
        })
      } else {
        reply = await this.defaultGenerateReply(message, playerName, history, character, session.id)
      }

      // 写回会话（莉莉丝对话进月蚀记忆）
      if (this.options.persistConversation !== false) {
        const now = Date.now()
        const newUser: ChatMessage = {
          id: `msg_${now}_${Math.random().toString(36).slice(2, 6)}`,
          role: 'user',
          content: message,
          createdAt: now
        }
        const newAi: ChatMessage = {
          id: `msg_${now + 1}_${Math.random().toString(36).slice(2, 6)}`,
          role: 'assistant',
          content: reply.text,
          createdAt: now + 1
        }
        this.options.sessionStore.saveMessages(session.id, [...history, newUser, newAi])
      }

      this.sendJson(res, 200, {
        protocol_version: 1,
        request_id: requestId,
        status: 'ok',
        text: reply.text,
        ui: {
          emotion: reply.emotion,
          animation: reply.animation,
          duration_ms: Math.max(800, Math.min(8000, reply.text.length * 50))
        }
      })
      return
    }

    if (method === 'POST' && requestUrl.pathname === '/v1/control') {
      const body = await this.parseBody(req)
      const action = String(body.action ?? '')
      if (action === 'reload') {
        // 月蚀无独立配置可重载；回 ok 保持协议兼容
        this.sendJson(res, 200, { ok: true, reloaded: true })
        return
      }
      if (action === 'reset' || action === 'reset_session') {
        const sessionId = String(body.session_id ?? LILITH_SESSION_ID)
        this.options.sessionStore.delete?.(sessionId)
        this.sendJson(res, 200, { ok: true })
        return
      }
      if (action === 'seed_assistant') {
        const text = String(body.text ?? '').trim()
        const session = this.options.sessionStore.getOrCreate(LILITH_SESSION_ID, '莉莉丝')
        const history = this.options.sessionStore.get(session.id)?.messages ?? []
        if (text && text.length <= 2000) {
          const newAi: ChatMessage = {
            id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            role: 'assistant',
            content: text,
            createdAt: Date.now()
          }
          this.options.sessionStore.saveMessages(session.id, [...history, newAi])
        }
        this.sendJson(res, 200, { ok: true, seeded: true })
        return
      }
      this.sendJson(res, 400, { error: 'unsupported control action' })
      return
    }

    this.sendJson(res, 404, { error: 'not found' })
  }

  /** 认证：Bearer token 匹配 */
  private authorized(req: http.IncomingMessage): boolean {
    const auth = req.headers.authorization ?? ''
    return auth === `Bearer ${this.token}`
  }

  /**
   * 检测游戏进程 PID（Lilith.exe）。
   * Windows 用 tasklist（无第三方依赖）；找不到返回 undefined（游戏未启动）。
   * LilithMod 的 parentMonitor 逻辑依赖 game_pid：游戏退出时月蚀适配器也应感知。
   */
  private detectGamePid(): number | undefined {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Lilith.exe', '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true
      })
      // 输出格式: "Lilith.exe","12345",...
      const match = out.match(/"Lilith\.exe","(\d+)"/i)
      if (match) return Number.parseInt(match[1], 10)
    } else {
      const out = execFileSync('pgrep', ['-f', 'Lilith.exe'], { encoding: 'utf8', timeout: 3000 })
      const pid = out.trim().split('\n')[0]
      if (pid) return Number.parseInt(pid, 10)
    }
    return undefined
  }

  /** 默认回复生成：月蚀 LLM + 莉莉丝完整上下文（人设 + lore 知识库 + 玩家记忆 + 会话历史） */
  private async defaultGenerateReply(
    message: string,
    playerName: string,
    history: ChatMessage[],
    character: Record<string, unknown> | null,
    _sessionId: string
  ): Promise<{ text: string; emotion: string; animation: string }> {
    const llm = this.options.getLlmClient()
    if (!llm || !llm.isReady()) {
      throw new Error('LLM 服务未就绪')
    }

    // 组装莉莉丝完整上下文（对齐 companion buildSystemPrompt 的多层结构）
    const persona = buildLilithPersona(character)

    // lore 知识库：按当前消息检索原作记忆（莉莉丝记得原作细节，不靠猜）
    const lorePath = join(this.options.dataRoot, 'frontend', 'character', 'lore', 'index.json')
    const lore = loadLore(lorePath)
    const loreHits = retrieveLore(message, lore)
    const loreContext = formatLoreContext(loreHits)

    // 玩家长期记忆（companion 格式，跨会话沉淀）
    const playerMemory = readPlayerMemory(this.options.appDataDir, playerName)
    const memoryBlock = buildLilithMemoryBlock(playerName, playerMemory)

    // 莉莉丝内部会话状态（派生管理层）：摘要锚点 + 缓存索引。
    // 会话切换检测：会话文件变化（LilithMod 清空/重开）→ 指纹变化 → 内部状态自动重置。
    // adapter 固定单会话（LILITH_SESSION_ID，lilith_chat.json），指纹恒定；会话内容以 sessionStore 为准。
    const { state: lilithInternal } = resolveLilithInternalState(`${LILITH_SESSION_ID}.json`)
    const lilithSummaryAnchor = buildLilithSummaryAnchor(lilithInternal)
    const lilithCacheAnchor = buildLilithCacheIndexAnchor(lilithInternal)

    // 会话历史（最近 RECENT_KEEP 条原文，与主链路 generateLilithReply 对齐）
    const recent = history.slice(-LILITH_RECENT_KEEP).map((m) => ({
      role: (m.role === 'assistant' ? 'assistant' : 'user') as 'assistant' | 'user',
      content: m.content
    }))

    // 两段式提示词（与主链路 generateLilithReply 同构）：
    // - prefixPrompt（历史之前，稳定段）：人设 + 原作总纲 + 输出协议——会话内基本不变，落入前缀缓存命中区
    // - suffixPrompt（历史之后、本轮问题之前，动态段）：检索命中的 lore + 玩家长期记忆——每轮按需更新
    const prefixPrompt = buildLilithAdapterPrefix({
      persona,
      canonContext: lore.canon_context,
      playerName
    })
    // 当前环境注入（与主链路 generateLilithReply 同构：suffix 动态段，实时时间 + 地区 + 天气）
    const envText = this.options.getEnvText?.() ?? ''
    const suffixPrompt = buildLilithAdapterSuffix({
      envText,
      loreContext,
      memoryBlock
    })

    // 两段式装配（与主链路同构）：[prefix system] → [摘要锚点?] → [历史] → [缓存锚点?] → [suffix system] → [本轮玩家消息]
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      ...(prefixPrompt ? [{ role: 'system' as const, content: prefixPrompt }] : []),
      ...(lilithSummaryAnchor ? [lilithSummaryAnchor] : []),
      ...recent,
      ...(lilithCacheAnchor ? [lilithCacheAnchor] : []),
      ...(suffixPrompt ? [{ role: 'system' as const, content: suffixPrompt }] : []),
      { role: 'user' as const, content: message }
    ]
    const result = await llm.chatWithTools(messages as never, [])
    const raw = result.content ?? ''
    const reply = parseLilithReply(raw)
    // memory_updates 提取：解析 [memory: key=value] 并写入玩家长期记忆
    const memoryUpdates: Array<{ key: string; value: string }> = []
    const memoryRe = /\[memory:\s*([^=]+?)=([^\]]+)\]/g
    let m: RegExpExecArray | null
    while ((m = memoryRe.exec(raw)) !== null) {
      const key = m[1].trim()
      const value = m[2].trim()
      if (key && value) memoryUpdates.push({ key, value })
    }
    if (memoryUpdates.length > 0) {
      const saved = applyMemoryUpdates(this.options.appDataDir, playerName, memoryUpdates)
      if (saved > 0) {
        // 隐私：不输出玩家名，只记录条数
        console.log(`[lilith-adapter] 记忆提取：记录 ${saved} 条玩家事实`)
      }
    }

    // 莉莉丝内部会话增量维护（异步 500ms，不阻塞回复；与主链路 generateLilithReply 同构）
    // 重新读真相源（sessionStore 历史，含本轮）→ 游标后增量摘要 → 缓存位置落盘 → 状态原子写。
    // 维护失败 catch 打日志不抛（派生层故障不影响回复与 sessionStore 真相源）。
    // 缓存索引采集：本轮注入了玩家记忆 / 检索了 lore → 记录固定知识位置（随后注入【记忆缓存位置】锚点）
    const pendingLilithCacheLocations: string[] = []
    if (playerMemory.length > 0) {
      pendingLilithCacheLocations.push(lilithPlayerMemoryPath(this.options.appDataDir, playerName))
    }
    if (lore.entries.length > 0 || lore.canon_context) {
      pendingLilithCacheLocations.push(lilithLoreIndexPath(this.options.dataRoot))
    }
    const internalLlmChat: LightChat = async (msgs, model) => {
      const c = this.options.getLlmClient()
      if (!c) return ''
      const r = await c.chatWithTools(msgs, [], model, { temperature: 0.2 })
      return r.content ?? ''
    }
    setTimeout(() => {
      const latest = this.options.sessionStore.get(LILITH_SESSION_ID)?.messages ?? []
      maintainLilithInternalSession({
        chat: internalLlmChat,
        activeFile: `${LILITH_SESSION_ID}.json`,
        history: latest.map((m) => ({ role: m.role, content: m.content })),
        pendingCacheLocations: pendingLilithCacheLocations
      }).catch((err) => {
        console.error('[lilith-adapter] 内部会话维护失败:', (err as Error).message)
      })
    }, 500)

    return reply
  }

  private parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let raw = ''
      req.on('data', (c) => {
        raw += c
        if (raw.length > 64 * 1024) {
          reject(new Error('body too large'))
          req.destroy()
        }
      })
      req.on('end', () => {
        resolve(raw ? JSON.parse(raw) : {})
      })
      req.on('error', reject)
    })
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const raw = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(raw)
    })
    res.end(raw)
  }
}

/** 简易 UUID（避免 crypto.randomUUID 兼容性问题） */
function randomUUID(): string {
  return `${Date.now().toString(36)}_${randomBytes(8).toString('hex')}`
}
