/**
 * @category 核心
 * @summary 后端服务：提示词组装注入、对话流与 LLM 工具循环、IPC 与工具执行

 * 月蚀主进程的核心服务端：渲染进程 / headless / 消息接入的请求都汇聚到这里，
 * 集中走「组装上下文 → 调用 LLM → 执行工具 → 回流结果」的对话闭环。
 * 独立成文件是为把提示词注入、会话状态、工具循环与端点注册收拢在
 * 一个生命周期内，让莉莉丝等子链路复用其能力而不各自重造。
 */
import express, { type Router } from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import http from 'http'
import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { ConfigStore } from './config-store'
import type { SessionStore } from './session-store'
import { LLMClient, getCurrentToolCallId } from './llm'
import { SUBAGENT_GUARDRAIL_KEY } from './message-guardrail'
import { chatModePrompt, TASK_LEAD_PROMPT } from './chat-envelope'
// 注入前消息净化链（三段：外来指令样文本中和 / UI 残留标记剥离 / 深度工具结果清理）。
// 为什么放在此处：本文件是唯一调用点（buildInjectedMessages），抽取目的是可测性而非共享。
import { sanitizeContextMessages, resolveToolResultKeepRecent } from './context-sanitize'
import type { LLMConfig } from '@shared/types'
import { DEFAULT_AI_ID } from '@shared/types'
// 输出纪律机制层工具：正文落盘前剥离思考块（思考仅协议回传，不落正文）
import { stripThinkingLeak } from '@shared/utils/output-discipline'
import type { Context } from '../kernel/cordis-runtime'
import { attachCordisEventBridge } from '../kernel/event-bridge'
import type { ToolExecutor } from './llm'
import { readAttachment, formatAttachmentsForContext } from './attachment-reader'
import { estimateMessagesTokens } from '@shared/utils/token-estimate'
import { truncateConversation } from '@shared/utils/context-window'
import {
  createToolRegistry,
  type ToolRegistryOptions
} from '../tools'
import { buildSelfAwarenessSection } from '../kernel/introspection'
import { ToolSearchTool } from '../tools/tool-search'
import { browserViewManager } from '../tools/browser-view-manager'
import { browserManager } from '../tools/browser-manager'
import { systemInput } from './system-input'
import type { ToolContext, SubAgentTask, ContextUsageSnapshot, ToolResult } from '../tools/base-tool'
import { SubAgentManager } from '../sub-agent'
import { SubAgentRegistry } from '../tools/sub-agent-engine/engine'
import { AsyncDelegationManager } from '../tools/sub-agent-engine/async-delegation'
import { MissionStore } from '../tools/sub-agent-engine/mission-store'
import type { SubAgentExecuteFn } from '../sub-agent'
import { StreamSession } from './stream-session'
import { SkillLoader, getDomainSkillsDir } from '../skills/loader'
import { getDefaultSkillsConfigPath } from '../skills/skill-config'
import { getDefaultWorkspaceConfigPath, getActiveWorkspace } from '../services/workspace-config'
import { HookManager, loadAllHooks, watchHooksConfig } from '../hooks'
import { CronScheduler } from '../cron/scheduler'
import { getGlobalTimerRegistry } from '../monitor/timer-registry'
import type { UserStore } from '../models/user-store'
import { resolveScopePaths, type BaseDataPaths } from '../models/paths'
import { readAiRegistry, findAiById } from '../models/ai-registry'
import { AiManager } from '../services/ai-manager'
import type { PluginLoader } from '../plugins'
import type {
  AppConfig,
  ChatMessage,
  ConversationRow
} from '@shared/types'
import { ActivationManager } from './activation-manager'
import { RawMemoryWriter } from '../services/raw-memory-writer'
import type { SessionContext } from '@shared/types'
import { InternalSessionStore } from '../services/internal-session-store'
import {
  ToolResultDistiller,
  DEFAULT_DISTILL_CONFIG,
  type DistillConfig
} from '../services/tool-result-distiller'
import { getWorkspaceContext } from '../services/workspace-state'
import {
  getFrontendTools
} from '@shared/tools/registry'
import { MessagingService } from '../messaging'
import type { McpClientManager } from '../mcp/client-manager'
import { buildLifecycleInjection } from './restart-pending'
import { loadSharedPrompts, loadFrontendPrompt, listTopicPrompts } from '../prompts/loader'
import { createSegmentManifest, assembleSegments } from '../prompts/segments'
import { readUserMdContent, readAiMdContent } from '../prompts/abyss-md'
import { loadLore, retrieveLore, formatLoreContext } from '../services/lilith-adapter'
import { GeoLocationService } from '../services/geo-location'
import { detectSystemPosition } from '../services/system-position'
import { TeamManager, defaultTeamsRoot } from '../services/team-manager'
import {
  clearToolDescCache,
  buildToolDescription,
  toToolExecutor
} from './tool-bridge'
import {
  WS_MAX_PAYLOAD,
  CORS_MAX_AGE,
  WS_PATH,
  SOFT_BUDGET_RATIO,
  estimateModelWindow,
  tokensEqual
} from './server-utils'
// 异步委托子 agent 默认 prompt 统一集中管理（prompts/sub-agent.ts）
import { ASYNC_DELEGATION_SYSTEM_PROMPT } from '../prompts/sub-agent'
// 内部会话层独立模块（F-5 拆分）：摘要配置/上下文装配/两写摘要压缩单飞队列。
import { createInternalSessionLayer } from './internal-session'
// WS 协议层（F-7 拆分）：连接生命周期与消息路由独立模块。
import { createWsProtocol } from './ws-protocol'
// 服务装配层（F-7 拆分）：HTTP 端点/莉莉丝桥/消息接入/配置热同步/端口监听。
import { installServerAssembly } from './server-assembly'
// 代码审查通道独立模块（F-4 拆分）：审查链存储/HTML 报告渲染/独立审查提示词。
// hasReviewPass 不经本地绑定（见下方 re-export，独立语法），故不在此 import。
import {
  getReportsRoot,
  bindCodeReviewEnv
} from './code-review'
// 测试与 IPC 仍从 server 入口取审查通过判定，re-export 保持对外 API 稳定（拆分不改行为）。
export { hasReviewPass } from './code-review'
// 回环判定单源（lilith 面放行与 /api/v1 requireLoopback 共用，见 server-utils.isLoopback）
import { isLilithBypassPath, allowLilithBypass } from './server-utils'

// 模块级引用：closeApiServer 时用于关闭 HTTP + WebSocket server + skills 文件监听
let server: http.Server | null = null
let wss: WebSocketServer | null = null
let unsubscribeConfig: (() => void) | null = null
let skillLoaderRef: SkillLoader | null = null
let hookManagerRef: { hookManager: HookManager; unwatchHooks: () => void } | null = null
/** Cron 调度器引用（closeApiServer 时停止 tick） */
let cronSchedulerRef: CronScheduler | null = null
/** 消息接入服务（飞书等外部平台 → 月蚀大脑）：server.ts 持有实例，IPC 通过 getMessagingService 访问 */
let messagingService: MessagingService | null = null

/**
 * 本机 API 访问令牌。
 * 为什么存在：API server 监听本地端口且 WS/HTTP 均无登录态；本地任意网页（浏览器跨域
 * fetch/WS 天然可打到 127.0.0.1）曾能无条件驱动完整 LLM 对话、读写任意 sessionId 并继承其
 * 工具权限——这是「本地服务零鉴权」的真实攻击面（评审 CRITICAL）。WS 不受同源策略限制，
 * CORS 拦不住它，因此必须在传输层增加只有主进程与渲染进程（经 IPC）共享的令牌。
 * 作用：WS 握手与受保护 HTTP API 的凭据；每次启动随机生成，进程外无法预知。
 */
let apiTokenSecret = ''
/** 获取本机 API 访问令牌（IPC api:token 挂载点；尚未启动 API server 时返回空串） */
export function getApiToken(): string {
  return apiTokenSecret
}

/** 异步委托管理器：子 agent 后台跑、父对话不阻塞。closeApiServer 时 dispose */
let asyncDelegationRef: AsyncDelegationManager | null = null

/** 长期目标（Mission）持久化层 + 失败重试编排（对接 asyncDelegation） */
let missionStoreRef: MissionStore | null = null

/** 流会话状态机引用（startApiServer 内实例化，closeApiServer 时 dispose 宽限计时器） */
let streamSessionRef: StreamSession | null = null

/** 获取消息接入服务实例（IPC handler 用；未初始化时返回 null） */
export function getMessagingService(): MessagingService | null {
  return messagingService
}

/**
 * 无头对话运行器引用（局域网协作的 AI 自动回复经此走完整月蚀链路：会话历史 + 工具循环）。
 * startApiServer 内 runHeadlessChat 定义后赋值；closeApiServer 时清空。
 */
let headlessChatRunnerRef: ((text: string, sessionId: string, aiId?: number) => Promise<string>) | null = null

/**
 * 获取无头对话运行器（未启动 API server 时返回 null）。
 * aiId 缺省 1（月蚀）：聊天室/私聊/系统注入等月蚀主导线路不传；AI 社交/公示板按参与者 aiId 传。
 */
export function getHeadlessChatRunner(): ((text: string, sessionId: string, aiId?: number) => Promise<string>) | null {
  return headlessChatRunnerRef
}

/**
 * 系统注入消息转发月蚀时的专用会话 ID：健康检查/激活事件等不占用莉莉丝会话，
 * 固定在月蚀侧会话持久化，多轮系统事件可追溯，回复原路返回调用方（不被吞）。
 * generateLilithReply 与 lilith-adapter 的 onSystemInjected 一致使用该会话。
 */
export const SYSTEM_INJECTED_SESSION_ID = 'system_injected_events'

/**
 * 当前环境注入文本 getter（地理位置/天气等；供 lilith-adapter 等主链路之外的消费方
 * 获取与月蚀/莉莉丝主链路同构的环境注入，避免重复实例化 GeoLocationService）。
 * startApiServer 内赋值；closeApiServer 时清空。
 */
let geoEnvTextRef: (() => string) | null = null

/** 获取当前环境注入文本（未初始化或暂不可用时返回空串，调用方按缺省处理） */
export function getGeoEnvText(): string {
  return geoEnvTextRef ? geoEnvTextRef() : ''
}

export async function startApiServer(
  configStore: ConfigStore,
  sessionStore: SessionStore,
  userStore: UserStore,
  activationManager: ActivationManager,
  toolCtx: ToolContext = {},
  dataPaths: BaseDataPaths,
  mcpClientManager?: McpClientManager,
   /** 插件加载器（提供插件工具并入统一工具池） */
  pluginLoader?: PluginLoader,
  /** 月蚀 Cordis 根上下文：核心服务门面（ctx.llm/ctx.tools）。可选——不传则退回直接构造，向后兼容 */
  ctx?: Context,
/** 共享内部会话存储（IPC 层与注入链路同一实例，写链串行化统一）。不传则内部创建，但 IPC 层将无法访问同一实例。 */
  sharedInternalSessionStore?: InternalSessionStore,
  /** 主分系统 API（master 模式）：/api/v1 挂载点。非 master 不传则不暴露。 */
  masterRouter?: Router,
  /** 主分系统 API 惰性取路由：注册成为主系统后 /api/v1 动态可用（热升级无需重启）。
   * 与 masterRouter 二选一：提供 getMasterRouter 则优先动态转发；仅传 masterRouter 保持旧行为（工具/测试）。 */
  getMasterRouter?: () => Router | null,
  /** 多实例（P5）：具名实例传 0 → 直接动态端口（避开 default 实例的固定 62002）；default 不传 → 保持固定端口逻辑 */
  preferredPort?: number
): Promise<number> {
  clearToolDescCache()
  // 生成本进程随机 API 令牌：WS 握手与受保护 HTTP API 共用（IPC api:token 下发渲染进程）。
  // 每次启动换新——上一轮进程泄露的令牌不会延续，且进程外无从预知。
  apiTokenSecret = randomBytes(32).toString('hex')
  const app = express()

  /**
   * 安全读取工具作用域 paths：paths 是动态 getter，未登录访问会抛
   * 「未登录态禁止解析工具作用域 paths」（登录后才可解析用户记忆域）。
   * 启动装配期只用「paths 是否可用」决定是否创建 geo/cron/team/mission
   * 等依赖用户作用域的服务；直接读 getter 会把未登录抛错升级成整进程启动崩溃
   * （打包版/全新环境首次启动无登录数据必现）。本函数把「不可用」归一到 null，
   * 与既有 `toolCtx.paths ? ... : null` 判空语义一致。
   * 登录恢复（index.ts 启动链）先于 initApiServer 执行，已登录用户启动不受影响；
   * 未登录时这些服务本就无意义，置 null 是正确语义而非掩盖错误。
   * 留存理由：干净环境首次启动必须能进登录页，装配期不能因 paths 抛错崩掉应用。
   */
  const safePaths = (tc: ToolContext): ToolContext['paths'] | null => {
    try {
      return tc?.paths ?? null
    } catch {
      return null
    }
  }
  // 装配期快照：登录态（含启动恢复）此后不再变化，快照与 getter 结果一致且避免重复求值。
  const toolPaths = safePaths(toolCtx)

  /**
   * 安全展开工具上下文：`...toolCtx` 对象展开会强制求值全部 getter——paths 是动态 getter，
   * 未登录抛「未登录态禁止解析工具作用域 paths」，求值阶段就崩，后续 defineProperty
   * 覆盖根本执行不到。此处跳过 paths 键（serverCtx 下方 defineProperty 重新挂动态 getter），
   * 其余属性（含其它 getter）按对象展开等价语义浅拷贝。
   * 留存理由：与 safePaths 同源——干净环境未登录启动必须能进登录页，展开不允许成为崩溃点。
   */
  const spreadToolCtx = (tc: ToolContext): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(tc)) {
      if (key === 'paths') continue
      out[key] = (tc as Record<string, unknown>)[key]
    }
    return out
  }

  // ===== CORS 白名单 =====
  // 为什么存在：dev 模式渲染进程从 vite dev server 加载（origin=localhost:5173/127.0.0.1:*
  // 等任意 dev 端口），fetch 到 127.0.0.1:port 属跨域，无 CORS 头会被浏览器拦截 →
  // LilithPanel 等面板的 fetch 全部静默失败（窗口空白/显示未连接）；生产环境渲染进程
  // 从 file:// 加载，Origin 为字符串 "null"。
  // 作用：只对可信来源回显 CORS 头；对任意网页 origin 返回 403，阻断浏览器侧跨域读取
  // 本机 API 响应的链路（WS 无同源限制，由令牌鉴权兜底；本中间件只封 HTTP 读取面）。
  const isAllowedOrigin = (o: string): boolean =>
    o === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)
  app.use((req, res, next) => {
    const origin = req.headers.origin
    if (origin) {
      if (isAllowedOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin)
      } else {
        res.status(403).json({ error: 'origin not allowed' })
        return
      }
    } else {
      // 非浏览器客户端（Lilith companion 等无 Origin 的外部进程）不受同源策略约束，放开。
      res.setHeader('Access-Control-Allow-Origin', '*')
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Access-Control-Max-Age', String(CORS_MAX_AGE))
    if (req.method === 'OPTIONS') {
      res.sendStatus(204)
      return
    }
    next()
  })

  // ===== 本机 API 令牌鉴权中间件 =====
  // 为什么存在：HTTP 面暴露「运行中流状态、LLM 连接测试」等仅限本机 UI 的接口，任意网页
  // 曾可跨域读取（配合 CORS `*` 是真实信息泄露链）；/api/health、/api/lilith/* 保持开放是刻意保留——
  // 游戏 companion 进程无 IPC 通道、无法携带令牌（bridge 设计耦合，见 lilith-endpoints）。
  // /api/v1 为卫星接入面，鉴权由 masterRouter 自管（public: hello/register/login；
  // 其余 requireSatellite Bearer 校验 + requireLoopback 回环限制），此处不重复设防。
  // 作用：除白名单路径外，要求请求头 `Authorization: Bearer <apiToken>`，否则 401。
  //
  // 2025 评审补充：主实例（挂 masterRouter）监听 0.0.0.0，/api/lilith/* 若直接放行，
  // 局域网内任意设备可免令牌读最近 200 条对话 / 清空会话 / 驱动 LLM 消耗 API 额度。
  // /api/lilith/* 与 MOD 桥接 /chat/completions 同属「本机进程（游戏 companion）桥接面」：
  // 仍免令牌（companion 带不了令牌），但来源必须回环——非回环一律 403，与 /api/v1 同口径。
  app.use((req, res, next) => {
    if (req.path === '/api/health' || req.path.startsWith('/api/v1')) {
      return next()
    }
    // lilith 桥接面：本机游戏 companion / ♥ 窗口 / MOD 桥接走这里；免令牌但仅限回环。
    // 判定口径复用 server-utils.allowLilithBypass：中间件与安全回归测试共用同一实现，
    // 防止「实现改了一处、测试按旧语义断言」的分叉（见 test/api-server.test.ts 回环拦截段）。
    if (allowLilithBypass(req.path, req.socket.remoteAddress)) {
      return next()
    }
    if (isLilithBypassPath(req.path)) {
      res.status(403).json({ error: '仅限本机回环访问' })
      return
    }
    // 月蚀内置浏览器导航只能带 URL，无法携带 Authorization 头，
    // 故 query 参数 ?token=<apiTokenSecret> 与 Bearer 头等效（与 WS 握手同源）。
    // 只放行 /reports/ 前缀且 token 精确匹配；其余路径仍必须走 Bearer 头校验。
    // 令牌判定统一走 server-utils.tokensEqual（timingSafeEqual，长度不同直接判不等）。
    if (
      req.path.startsWith('/reports/') &&
      typeof req.query.token === 'string' &&
      tokensEqual(req.query.token as string, apiTokenSecret)
    ) {
      return next()
    }
    const authHeader = req.headers.authorization
    if (
      typeof authHeader === 'string' &&
      authHeader.startsWith('Bearer ') &&
      tokensEqual(authHeader.slice('Bearer '.length), apiTokenSecret)
    ) {
      return next()
    }
    res.status(401).json({ error: 'unauthorized' })
  })

  // ===== /api/v1 卫星接入面 body 上限（200mb，仅此面前置放宽，其余 API 维持全局 50mb） =====
  // 为什么存在：分系统 push 的单批（最多 200 条）× content 为同步域文件全文，大文件堆积的同批更新
  // 可超全局 50mb 默认值——超限返回 413，sync-engine 会无限退避重试、同步永久卡死（比超时更硬的墙）。
  // 200mb 依据：同步域为 memory/sessions/NNG/cache/ABYSS 的 UTF-8 文本（单文件正常为 KB 级），
  // 200MB JSON 的解析峰值内存约 600MB（Buffer+字符串+对象），仅对 /api/v1 局域网卫星面放开可接受；
  // 与卫星侧体积感知超时（LAN_MIN_BYTES_PER_SEC=1MB/s → 200MB≈200s+基准）匹配。
  // 实现：body-parser 对已解析请求（req._body）跳过重复解析，故置于全局 50mb 之前即可做到
  // 只放开 /api/v1，其它接口仍受全局 50mb 约束，不扩大无谓的解析面。
  app.use('/api/v1', express.json({ limit: '200mb' }))
  app.use(express.json({ limit: '50mb' }))

  // ===== 只读报告静态服务（/reports/）=====
  // 为什么存在：code-review 等审查链落盘成 HTML 后，需要能在月蚀内置浏览器中打开。
  // 浏览器导航只能访问 http/https（browser-view-manager 协议白名单禁止 file:），故把工程
  // reports/ 目录经本机 HTTP 端点只读暴露；token 校验已在上面中间件完成，这里只做：
  // 1) 路径穿越防护——只允许 reports 根目录下的单层文件名（禁用 /、\、..）
  // 2) 扩展名白名单——只放行报告类静态资源，禁任意文件下载
  // 3) 统一 charset（html 为主，md/txt 原样返回纯文本，供浏览器直接渲染）
  const reportsRoot = getReportsRoot()
  mkdirSync(reportsRoot, { recursive: true })
  app.get('/reports/:name', (req, res) => {
    const name = req.params.name ?? ''
    // 防穿越：只允许单层文件名；含路径分隔符/上级引用直接拒绝（fail-fast）
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
      res.status(400).json({ error: 'bad report name' })
      return
    }
    const filePath = join(reportsRoot, name)
    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'report not found' })
      return
    }
    const lower = name.toLowerCase()
    const extOk =
      lower.endsWith('.html') ||
      lower.endsWith('.htm') ||
      lower.endsWith('.md') ||
      lower.endsWith('.txt')
    if (!extOk) {
      res.status(403).json({ error: 'report type not allowed' })
      return
    }
    res.type(lower.endsWith('.md') || lower.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8')
    res.send(readFileSync(filePath, 'utf-8'))
  })

  // 主分系统：master 角色挂载 /api/v1（注册/登录/令牌/同步/管理/归档）
  // 2026-10 热升级修复：路由不按启动时角色静态挂载——「注册成为主系统」是运行时动作
  // （auth:register createMaster → becomeMaster），启动时 standalone 则 createMasterRouter 返回 null，
  // 旧实现 app.use 只在启动时执行一次，升级后 /api/v1 永不挂载（分系统无法接入、本机账号管理局/备份中心 IPC 亦失效）。
  // 改为惰性转发：每次请求动态向 getMasterRouter 取路由（内部 ensureMasterAssets 幂等装配），
  // 启动即 standalone 时返回 503「非主系统」，注册升级后立即可用，无需重启。
  // 兼容性说明：保留 masterRouter 直挂分支供直接传 Router 的调用方（工具/测试）使用，不破坏旧签名。
  if (masterRouter || getMasterRouter) {
    app.use('/api/v1', (req, res, next) => {
      const router = getMasterRouter ? getMasterRouter() : masterRouter
      if (!router) {
        res.status(503).json({ ok: false, error: '非主系统' })
        return
      }
      router(req, res, next)
    })
  }

  // 核心服务门面：ctx 存在时经 ctx 统一构造点，否则退回直接构造（向后兼容）
  const makeLlmClient = (cfg: LLMConfig) => (ctx ? ctx.llm.create(cfg) : new LLMClient(cfg))
  const makeToolRegistry = (c: ToolContext = {}, o?: ToolRegistryOptions) =>
    ctx ? ctx.tools.createRegistry(c, o) : createToolRegistry(c, o)

  // 流式引擎共享状态（F-6）：runStream（stream-runner 工厂）经 ref 容器注入，懒重建与 getter 自动读到新实例
  const llmClientRef: { current: LLMClient } = { current: makeLlmClient(configStore.get().llm) }

  // ===== 内部会话层（F-5 拆分：摘要配置/上下文装配/两写摘要压缩维护队列）=====
  // 见 internal-session.ts：summaryLlmClient 懒创建、getSessionSummaryCfg、buildSessionContext、
  // internalLlmChat、enqueueInternalSessionJob、resolveStreamSessionContext 收拢为单一 Layer；
  // server.ts 只持有 layer，runStream/lilith-endpoints 经其能力点消费，不再与主对话闭包互相纠缠。
  const internalSessionLayer = createInternalSessionLayer({
    configStore,
    sessionStore,
    sharedInternalSessionStore,
    toolCtx,
    makeLlmClient
  })
  const { internalLlmChat, enqueueInternalSessionJob, resolveStreamSessionContext } = internalSessionLayer


  // raw_memory 写入器（系统自动写入对话对，AI 不参与）
  // 字符上限可配置（config.rawMaxChars，默认 20000）
  // 分层：getScope 动态取当前登录用户 + AI 编号（前端=月蚀=1）
  // 莉莉丝链路 write 时传 scopeOverride={uid, aiId:2} 落莉莉丝自己的 RAW。
  const rawMemoryWriter = dataPaths
    ? new RawMemoryWriter(
        dataPaths,
        () => {
          const u = userStore.getCurrentUser()
          return u ? { uid: u.UID, aiId: DEFAULT_AI_ID } : null
        },
        configStore.get().rawMaxChars ?? undefined
      )
    : null
  // 热更新：config.json 的 rawMaxChars 变化时同步（无需重启）
  try {
    configStore.subscribe((cfg) => {
      if (rawMemoryWriter && cfg.rawMaxChars) rawMemoryWriter.setRawMaxChars(cfg.rawMaxChars)
    })
  } catch {
    // 订阅失败不阻断（配置仅在重启后生效）
  }

// 地理位置服务：AI 感知当前时间和地区
  // 时间每轮实时注入；单一系统坐标链路（渲染进程 navigator.geolocation → 逆地理中文地址 + 天气），
  // 由 config.geo.preciseLocationEnabled 显式开关控制（默认 false）。
  // 隐私红线整改：公共免费 API 的 IP 定位兜底已移除——开关关闭时无任何定位来源，
  // 不发起任何外部定位请求，AI 上下文仅注入时区；开启后仅走系统坐标链路。
  const preciseLocationEnabled = configStore.get().geo?.preciseLocationEnabled ?? false
  const geoService = toolPaths
    ? new GeoLocationService(toolPaths.root, preciseLocationEnabled ? detectSystemPosition : null)
    : null
  if (geoService) {
    // 启动刷新：开关关闭时无定位来源，refresh 直接返回既有缓存、不触网
    void geoService.refresh()
  }
  // 供 lilith-adapter 等主链路之外的消费方获取同构环境注入（避免重复实例化定位服务）
  geoEnvTextRef = geoService ? () => geoService.buildInjection() : null

  // 工具结果 LLM 蒸馏层：大体积工具结果先用 LLM 提炼「有用信息」，其余逻辑丢弃。
  // 蒸馏成功则摘要直接替换 conversation 中的 tool 消息原文；失败重试一次，仍失败保留原文。
  const toolResultDistiller = new ToolResultDistiller(
    () => llmClientRef.current,
    (): DistillConfig => ({ ...DEFAULT_DISTILL_CONFIG, ...(configStore.get().toolResultDistill ?? {}) })
  )

  /**
   * 蒸馏回调工厂：主会话流式（runStream）与无头会话（runHeadlessChat，LAN 自动回复）共用。
   * 蒸馏成功则摘要直接替换 conversation 中 tool 消息原文，失败重试一次仍失败保留原文，两路径行为一致。
   * distillIntentTurnPairs：意图上下文「对话对数量」随配置注入 —— llm.ts 依此组装
   * 该工具调用前最近 N 对历史会话作为蒸馏 LLM 的相关性判定上下文（0 = 不携带）。
   */
  const makeDistillCallbacks = (): {
    distillToolResult?: (toolName: string, toolCallId: string, result: string, intent?: string) => Promise<string | undefined>
    distillIntentTurnPairs?: number
  } => {
    // 与 distiller 构造处同一合并形态：用户配置优先、缺省回退单源默认
    const distillCfg: DistillConfig = { ...DEFAULT_DISTILL_CONFIG, ...(configStore.get().toolResultDistill ?? {}) }
    return {
      // intent（该工具调用前最近 N 对历史会话，由 llm.ts 组装后透传）用于蒸馏器评估相关性；
      // 意图参与缓存指纹，同一结果在不同任务背景下各得其所，不复用错配摘要
      distillToolResult: async (toolName: string, _toolCallId: string, result: string, intent?: string) =>
        (await toolResultDistiller.distill(toolName, result, intent)) ?? undefined,
      distillIntentTurnPairs: distillCfg.intentTurnPairs
    }
  }

  // 加载提示词：通用层（shared/，所有 AI 共享）+ 前端 AI 专属（唯一权威 prompts/ 目录）
  const SHARED_PROMPTS = loadSharedPrompts()
  const FRONTEND_AI_PROMPT = loadFrontendPrompt()

  // 统一工具池：前端 AI 与 DMN 共用 createToolRegistry，按 policy 配置差异化启用
  // 直接注入模式：所有启用工具 schema 直接注入
  // 前端 AI 可通过 Agent 工具派发子 agent，每个子 agent 独立上下文
  // toolExecutorsRef.current / subAgentManager 延后赋值，launchSubAgent 闭包执行时才读取（已就绪）
  const toolExecutorsRef: { current: ToolExecutor[] } = { current: [] }
  // 统一子 agent 管理（并发限制 / 超时 / 摘要 / 工具黑名单）
  // 在 toolRegistry 创建后（下方赋值）才初始化；配置变更时重建（更新工具快照）
  const subAgentManagerRef: { current: SubAgentManager<ToolExecutor> | null } = { current: null }
  // 子 agent 过程事件转发器——runStream 开始时空绑定（当前 stream 的 ws+messageId）
  // SubAgentManager 的 onEvent 回调统一转发到这里。串行队列保证同一时刻只有一个 stream
  // 转发器不会被并发抢占（重试时 runStream 重新绑定同一 messageId）。
  const streamSession = new StreamSession()
  streamSessionRef = streamSession
  // 行协议：会话 → 上次使用的模型（modelChange 时间线标记跨轮对比用）
  const lastModelBySession = new Map<string, string>()
  const MAX_LAST_MODEL_ENTRIES = 100
  function setLastModel(sessionId: string, model: string): void {
    if (lastModelBySession.size >= MAX_LAST_MODEL_ENTRIES && !lastModelBySession.has(sessionId)) {
      const oldest = lastModelBySession.keys().next().value
      if (oldest) lastModelBySession.delete(oldest)
    }
    lastModelBySession.set(sessionId, model)
  }
  // 行协议：行 id 全局递增计数器（跨 runStream 持久）
  // 不能放 runStream 局部——重试时局部 nextRowId 重置为 0，新行 id 与旧行冲突
  // 前端按 rowId 去重会丢弃重试行。行协议语义：rowId 会话内全局唯一。
  const rowIdRef: { current: number } = { current: 0 }

  // 子 agent executeFn 统一构造——子 agent 内部工具调用事件转发给 opts.emit
  // 由 SubAgentManager 补 agentId 后推前端；LLM 输出只累积（最终结果由 done 事件携带）。
  // 子 agent 内部的 streamWithTools 与主对话共用 LLMClient，但不推 token（避免刷屏）。
  const buildSubAgentExecuteFn =
    (getLlmClient: () => LLMClient): SubAgentExecuteFn<ToolExecutor> => async (messages, tools, opts) => {
      let output = ''
      const emit = opts.emit
      await getLlmClient().streamWithTools(
        messages,
        tools,
        {
          onToken: (t) => {
            output += t
          },
          onDone: () => {},
          onError: (e) => {
            throw e
          },
          onToolStart: (toolName, toolCallId, args) => {
            emit?.({ type: 'tool_start', agentId: '', toolName, toolCallId, args })
          },
          onToolEnd: (toolName, toolCallId, result) => {
            emit?.({ type: 'tool_end', agentId: '', toolName, toolCallId, result })
          },
          // 子 agent 上下文内的工具结果同样走蒸馏（与主对话/无头会话共用同一回调工厂）：
          // 大体积工具结果（web_search/read_file 等）先经 LLM 提炼摘要再进子 agent 上下文，
          // 避免子 agent 上下文被大结果膨胀；失败重试一次仍失败保留原文，与主会话行为一致。
          ...makeDistillCallbacks()
        },
        {
          maxRounds: opts.maxTurns,
          signal: opts.signal,
          // 消息来源护栏：子 agent 内部上下文用独立固定键（不与会话哈希混淆）；
          // 子 agent 输出作为 tool 结果回流父对话时按工具名归类为 subagent
          guardrailSessionId: SUBAGENT_GUARDRAIL_KEY
        }
      )
      return output
    }
  // Skills 加载器（渐进式披露：元数据始终注入 / 正文 use_skill 触发加载）
  // 在 serverCtx 之前创建，以便 ToolContext 注入 skillLoader
  // 配置层：.skills.json 管理 per-skill enabled 覆盖（类似 .mcp.json）
  // 优先复用调用方注入的 skillLoader（index.ts 的 dmnSkillLoader 单例）——
  // 加载/监听时机由登录成功回调（onAuthSuccess）统一驱动，未登录不加载；
  // 仅当调用方未提供（独立启动/测试，且已登录）时才本地构造并自行 load。
  const skillLoader = toolCtx.skillLoader ?? (ctx && ctx.featurePlugins.isEnabled('skills')
    ? ctx.skills.init(
        getDomainSkillsDir,
        () => getDefaultSkillsConfigPath()
      )
    : new SkillLoader(
        getDomainSkillsDir,
        () => getDefaultSkillsConfigPath()
      ))
  if (!toolCtx.skillLoader) {
    skillLoader.load()
    skillLoader.startWatching()
  }
  skillLoaderRef = skillLoader // 模块级引用，closeApiServer 时停止监听
  // PreToolUse/PostToolUse 在 executeTool 中触发，UserPromptSubmit/Stop 在 stream 生命周期触发
  const hookManager = new HookManager()
  const hookConfigs = loadAllHooks()
  hookManager.loadHooks(hookConfigs)

  // 事件桥：把月蚀 hook 事件流桥到 Cordis 事件总线（观察桥，Cordis 模块可监听）
  // ctx 存在时挂载；detach 保留给 closeApiServer 阶段清理
  if (ctx) {
    attachCordisEventBridge(ctx, hookManager)
    // ctx.memory 注入数据路径（无 paths 时忽略——等后续调用点再 init）
    // memory 服务未挂载（功能禁用）时跳过：memory.dataPaths 保持 null，外部引用已容忍
    if (toolPaths && ctx.featurePlugins.isEnabled('memory')) {
      ctx.memory.init(toolPaths)
    }
    // 【装配收敛】Cordis 插件挂载唯一发生在 index.ts 启动链（mountCordisPlugins，
    // detach 保留给 onBeforeQuit 清理）。此处传入的 ctx 即启动链的 rootCtx，
    // 若再挂载一次会让同一批插件（时间戳 query 使每次 importEntry 生成全新
    // 模块实例）注册两份到 ctx.registry，产生重复副作用且 detach 无处置。
    // 阶段 4 迁移的插件挂在 rootCtx 上，server 侧经 ctx.<service> 门面取用即可。
  }
  // 监听配置文件变化，热重载
  const unwatchHooks = watchHooksConfig(() => {
    const newHooks = loadAllHooks()
    hookManager.loadHooks(newHooks)
    console.log(`[hooks] 配置热重载，加载 ${newHooks.length} 个 hook`)
  })
  hookManagerRef = { hookManager, unwatchHooks }

  // Cron 定时任务调度器
  // 复用 index.ts 已创建的实例（toolCtx.getCronScheduler），避免双实例 + Windows fs.watch
  // 不可靠导致删除任务后内存 jobs 不更新 → 已删任务继续触发。
  // 仅在 toolCtx 未提供实例时回退创建（非标准启动场景）。
  let cronScheduler: CronScheduler | null = null
  if (toolCtx.getCronScheduler?.()) {
    cronScheduler = toolCtx.getCronScheduler()!
    cronSchedulerRef = cronScheduler
  } else if (toolPaths?.cron) {
    try {
      cronScheduler = ctx && ctx.featurePlugins.isEnabled('cron')
        ? ctx.cron.create(toolPaths.cron, activationManager, getGlobalTimerRegistry())
        : new CronScheduler(toolPaths.cron, activationManager, getGlobalTimerRegistry())
      cronScheduler.start()
      cronSchedulerRef = cronScheduler
    } catch (err) {
      console.error('[cron] 调度器初始化失败:', err)
    }
  }

  const lastInjectedEstimateRef: { current: number | null } = { current: null }

  // 解析会话所属 AI 编号（多 AI P2）：会话 aiId 合法正整数 → 用之；缺省/非法/旧会话 → 回退 1（月蚀）
const resolveSessionAiId = (sessionId?: string): number => {
    if (!sessionId) return DEFAULT_AI_ID
    try {
      const session = sessionStore.get(sessionId)
      const aiId = session?.aiId
return typeof aiId === 'number' && Number.isInteger(aiId) && aiId >= 1 ? aiId : DEFAULT_AI_ID
    } catch {
      return DEFAULT_AI_ID
    }
  }

  const serverCtx: ToolContext = {
    ...spreadToolCtx(toolCtx),
    // 多 AI（P4）：create_ai 等工具经此解析"当前会话所属 AI 编号"（parentAiId 溯源/防递归守卫）
    getSessionAiId: resolveSessionAiId,
    // 批量执行器（batch_tools 子步骤通道）：经 toToolExecutor 包装的执行器集合执行——
    // 复用主链路同一条执行链（能力闸 + Hook + 脱敏），且 toolExecutorsRef 随工具策略热更新重建，
    // 闭包读 current 永远指向"当前生效"的工具集：用户刚关闭的工具不可能被 batch 绕过。
    // 返回解析回 ToolResult（executor.execute 返回的是 JSON 字符串）。
    executeSubTool: async (name, params) => {
      const executor = toolExecutorsRef.current.find((e) => e.name === name)
      if (!executor) return { ok: false, error: `批量子工具未注册或未启用: ${name}` }
      try {
        return JSON.parse(await executor.execute(params)) as ToolResult
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
    // 动态注入当前配置（联网开关、自定义搜索端点、治理开关等），用 getter 保证读到最新值
    // 改 getEffective：治理开关经 config_patch 写覆盖层（patch 文件），get 读不到 → hook 开关失效
    get config() {
      return configStore.getEffective() as unknown as Record<string, unknown>
    },
    // update_ai_name 等工具通过此回调修改 config 并持久化（update_abyss_md 改写文件，不走此回调）
    // updater 接收当前 config，返回更新后的 config（不可变更新）
    updateConfig: (updater) => {
      const current = configStore.get() as unknown as Record<string, unknown>
      const next = updater({ ...current })
      configStore.save(next as unknown as AppConfig)
    },
// 注入 Skills 加载器（use_skill 工具通过此访问）
    skillLoader,
    // 注入 Hook 管理器（executeTool 通过此访问 Pre/PostToolUse）
    hookManager,
    // 注入 cron 调度器 getter（cron_manage 工具访问）
    getCronScheduler: () => cronScheduler,
    // 注入内部会话存储 getter（internal_session 工具访问）：复用与 IPC 面板同一 store 实例，
    // 走 store 的写链串行化 + NNG 路径推导，避免工具裸写 JSON 与维护队列并发覆盖
    getInternalSessionStore: () => sharedInternalSessionStore ?? null,
     // 插件 tools.js 经此访问浏览器面板单例（browser_* 工具在 bundled/headless-browser 插件，plugin.json name='headless-browser'；容器上下文注入，供插件获取 BrowserView 管理器做面板级展示）
    getBrowserViewManager: () => browserViewManager,
    // 经此访问 Playwright 单例（browser_* 工具用；快照看页面+操作，不依赖截图）
    getBrowserManager: () => browserManager,
     // computer-use 插件：系统级电脑操控引擎（截屏/鼠标/键盘，Windows+PowerShell，零新增依赖）
    getSystemInput: () => systemInput,
    // 任务模式（Agent Teams）：TeamManager——团队目录 {root}/teams，纯文件通信
    teamManager: toolPaths ? new TeamManager(defaultTeamsRoot(toolPaths.root)) : undefined,
    // 委托给 SubAgentManager（并发 / 超时 / 子 agent 输出 / 工具过滤统一处理）
    launchSubAgent: async (
      tasks: SubAgentTask[],
      mode: 'serial' | 'parallel'
    ): Promise<string[]> => {
      if (!subAgentManagerRef.current) {
        throw new Error('SubAgentManager 未初始化（工具注册尚未完成）')
      }
      const options = tasks.map((t) => ({
        systemPrompt: t.prompt,
        userMessage: '开始执行子任务。',
        allowedTools: t.tools,
        disallowedTools: t.disallowedTools,
        maxTurns: t.maxTurns,
        timeoutMs: t.timeoutMs,
        // 任务模式（Agent Teams）：成员身份透传（team_* 工具经 AsyncLocalStorage 识别）
        teamContext: t.teamContext
      }))
      // 读 AsyncLocalStorage 中的当前深度：主对话=0，子 agent 内部=currentDepth+1
      const depth = SubAgentManager.getCurrentDepth()
      // 读当前工具调用 id（Agent 工具的 toolCallId），子 agent 事件据此挂到主对话卡片
      const parentToolCallId = getCurrentToolCallId() ?? undefined
      const results = await subAgentManagerRef.current.launchBatch(options, mode, depth, parentToolCallId)
      // SubagentStop Hook：子 agent 完成后执行，拿到每个子任务的完整输出
      if (hookManager.isLoaded()) {
        for (const r of results) {
          await hookManager.run('SubagentStop', {
            event: 'SubagentStop',
            subagentOutput: r.output,
            sessionId: serverCtx.sessionId ?? undefined,
            cwd: process.cwd()
          })
        }
      }
      return results.map((r) => {
        // 软超时托管：子 agent 转入后台时 output 为空，error 中已含托管诊断与 taskId，
        // 直接透传给 AI，AI 可据此 tool_watch 续期/查进度、tool_stop 主动停止。
        if (r.timedOut && r.managedTaskId) return r.error ?? ''
        return r.output
      })
    },
    // context_usage 工具：查询当前会话上下文用量
    getContextUsage: (): ContextUsageSnapshot | null => {
      const sid = serverCtx.sessionId ?? undefined
      if (!sid) {
        // 无会话时仍返回基础信息（无消息）
        const cfgNow = configStore.get()
        const budget =
          cfgNow.tokenBudget && cfgNow.tokenBudget > 0 ? cfgNow.tokenBudget : resolveSoftBudget()
        return {
          sessionId: null,
          messageCount: 0,
          conversationCount: 0,
          estimatedTokens: 0,
          effectiveBudget: budget,
          model: cfgNow.llm.model,
          remainingTokens: budget,
          usagePercent: 0
        }
      }
      const session = sessionStore.get(sid)
      if (!session) return null
      const convMsgs = session.messages.filter((m) => m.role !== 'system')
      const estimated = lastInjectedEstimateRef.current ?? estimateMessagesTokens(convMsgs)
      const cfgNow = configStore.get()
      const budget =
        cfgNow.tokenBudget && cfgNow.tokenBudget > 0 ? cfgNow.tokenBudget : resolveSoftBudget()
      const usagePercent = Math.min(100, Math.round((estimated / budget) * 100))
      return {
        sessionId: sid,
        messageCount: session.messages.length,
        conversationCount: convMsgs.length,
        estimatedTokens: estimated,
        effectiveBudget: budget,
        model: cfgNow.llm.model,
        remainingTokens: Math.max(0, budget - estimated),
        usagePercent
      }
    }
  }
  // 多 AI（P2）：主对话工具路径按「当前登录用户 + 会话所属 AI」动态解析（复制莉莉丝样板，aiId 动态化）。
  // 工具读 ctx.paths.xxx 时自动落 memory/U{uid}/AI{aiId} 对应记忆域，实现双 AI 记忆/注入隔离。
  // 注意：展开用 spreadToolCtx 跳过 paths（避免 getter 在展开期被求值抛错——未登录场景），
// 此处 defineProperty 是 paths 唯一挂载点（动态 getter，登录后才可解析）。
  // sessions 同样走 scoped 作用域（{root}/sessions/U{uid}/AI{aiId}）：session-search 检索历史会话时应
  // 限定在当前用户当前 AI 的作用域内，避免跨账号/跨 AI 串扰隐私；曾强制覆盖为全局根 dataPaths.sessions，
  // 属于作用域定位错误（该"防回归"掩盖了 session-search 与分片存储形态脱节，已随扫描逻辑一并修复）。
  Object.defineProperty(serverCtx, 'paths', {
    get: () => {
      const u = userStore.getCurrentUser()
      if (!u) {
        throw new Error('[paths] 未登录态禁止解析工具作用域 paths：系统要求先登录')
      }
      const scoped = resolveScopePaths(dataPaths, { uid: u.UID, aiId: resolveSessionAiId(serverCtx.sessionId ?? undefined) })
      return scoped
    },
    enumerable: true,
    configurable: true
  })
  // 生效配置（核心 + 覆盖层）：工具策略等 AI 可覆盖的读取点用 getEffective
  const cfg0 = configStore.getEffective()
  const toolRegistry = makeToolRegistry(serverCtx, {
    toolsPolicy: cfg0.frontendToolPolicy.tools,
    mcpClientManager,
    // 权限绿通开启时自动启用系统调用工具（run_command/app_restart 等）
    greenlightEnabled: cfg0.permissionGreenlight === true,
    // 供工具元数据 visible 条件判定（webSearchEnabled 控制 web_search 是否暴露）
    config: cfg0,
     // 插件工具并入统一池（PluginLoader 运行时动态加载）
    pluginTools: pluginLoader?.getTools() ?? []
  })
   // 渐进式披露桥：tool_search 始终注入（MCP/插件工具多时 AI 用它找动态工具 schema）
  {
    const toolSearch = new ToolSearchTool(() => mcpClientManager ?? null)
    toolRegistry.tools.set('tool_search', toolSearch)
  }
  toolExecutorsRef.current = Array.from(toolRegistry.tools.values()).map((t) =>
    toToolExecutor(t, toolRegistry)
  )
  // 初始化 SubAgentManager（executeFn 包装 llmClientRef.current.streamWithTools）
  // 通过 getter 传入 llmClientRef.current，配置变更重建时 getter 自动读到新实例
  // onEvent：子 agent 过程事件 → currentSubAgentForwarder（runStream 绑定的 ws+messageId）→ 前端
  subAgentManagerRef.current = ctx && ctx.featurePlugins.isEnabled('subagent')
    ? ctx.subagent.create(
        buildSubAgentExecuteFn(() => llmClientRef.current),
        toolExecutorsRef.current,
        serverCtx,
        { maxConcurrent: 'auto', maxSpawnDepth: 1 },
        (evt) => streamSession.forward(evt)
      )
    : new SubAgentManager<ToolExecutor>(
        buildSubAgentExecuteFn(() => llmClientRef.current),
        toolExecutorsRef.current,
        serverCtx,
        { maxConcurrent: 'auto', maxSpawnDepth: 1 },
        (evt) => streamSession.forward(evt)
      )

  // 异步委托通道：
  // 子 agent 后台跑、父对话不阻塞。
  // 独立于 SubAgentManager（同步路径不动），runner 复用 buildSubAgentExecuteFn。
  // llm.ts 已并发化（controllers Map 每请求独立 controller），并发调 streamWithTools 安全；
  // 且子 agent 请求不走 streamChain（那只约束主对话 runStream 路径），无串行冲突。
  const asyncDelegation = new AsyncDelegationManager(
    new SubAgentRegistry(),
    {
      runner: async (record, signal, budget) => {
        // 迭代预算：runner 每轮调 streamWithTools 前 consume；
        // 预算耗尽则标记并整段终止（由 AsyncDelegationManager 识别为 interrupted）
        if (!budget.consume()) {
          record.status = 'interrupted'
          record.error = 'iteration_budget_exhausted'
          return ''
        }
        const messages: ChatMessage[] = [
          {
            id: `sub_sys_${Date.now()}`,
            role: 'system',
            content: ASYNC_DELEGATION_SYSTEM_PROMPT,
            createdAt: Date.now()
          },
          { id: `sub_usr_${Date.now()}`, role: 'user', content: record.task, createdAt: Date.now() }
        ]
return buildSubAgentExecuteFn(() => llmClientRef.current)(messages, toolExecutorsRef.current, {
          // 轮次上限已取消（2026-10-02）：不传 maxTurns，走 SubAgentManager 默认不限制；
          // 超时由 AsyncDelegationManager 的 HeartbeatMonitor(300_000ms) 兜底。
          timeoutMs: 300_000,
          signal
        })
      },
      // 委托记录落盘到 {root}/mission/delegations.json
      // 崩溃后 recoverAbandoned 把遗留 running 标记为 interrupted 留痕。
      persistencePath: toolPaths
        ? join(toolPaths.root, 'mission', 'delegations.json')
        : undefined
    }
  )
  // 恢复上次崩溃遗留的委托（running → interrupted 留痕），标记得可被续接/排查
  if (toolPaths) {
    try {
      const abandoned = asyncDelegation.recoverAbandoned()
      if (abandoned.length > 0) {
        console.warn(`[mission] 崩溃恢复：${abandoned.length} 个遗留委托标记为 interrupted`)
      }
    } catch (err) {
      console.error('[mission] recoverAbandoned error:', err)
    }
  }
  asyncDelegationRef = asyncDelegation

  // ===== 长期目标（Mission）持久化 + 失败重试编排 =====
  // MissionStore 存长期目标的目的/累计预算/失败计数/阻塞状态（文件即真相源，{root}/mission/）。
  // 订阅 asyncDelegation 结果事件：completed → 记账；failed → 记账 + transient 未超 failureLimit 自动重试（续接同 mission id）。
  const missionStore = toolPaths ? new MissionStore(toolPaths.root) : null
  missionStoreRef = missionStore
  if (missionStore) {
    asyncDelegation.on('completed', (rec) => {
      const m = missionStore.get(rec.id)
      if (m) {
        missionStore.completeSegment(rec.id, {
          usedThisSegment: rec.iterationsUsed ?? 0,
          ok: true,
          result: rec.result,
          done: true
        })
      }
    })
    asyncDelegation.on('failed', (rec, err) => {
      const m = missionStore.get(rec.id)
      if (!m) return
      missionStore.completeSegment(rec.id, {
        usedThisSegment: rec.iterationsUsed ?? 0,
        ok: false,
        error: err,
        blockKind: 'transient' // 默认按瞬时失败处理，可重试；truly-blocked 由任务语义显式标记
      })
      // 自动重试：仍 active（transient 未超 failureLimit）且剩余预算充足 → re-dispatch 续接同一 mission id
      const updated = missionStore.get(rec.id)
      if (updated && updated.status === 'active') {
        const remain = missionStore.remainingBudget(rec.id)
        if (remain > 0) {
          const retryTask = `${rec.task}\n[第 ${updated.segments + 1} 段续接；前次失败: ${err ?? 'unknown'}；继续推进该长期目标]`
          asyncDelegation.dispatch(retryTask, null, remain, rec.id) // 复用同 id → 同一 mission 累计
          console.warn(`[mission] ${rec.id} 瞬时失败自动重试（剩余预算 ${remain}）`)
        } else {
          console.warn(
            `[mission] ${rec.id} 失败但预算已尽（${updated.iterationsUsed}/${updated.maxIterations}），不再重试`
          )
        }
      }
    })
  }

  server = http.createServer(app)
  // code-review 报告打开需 server 端口与鉴权 token（注入 getter，模块内按需取值，避免循环依赖）
  bindCodeReviewEnv({ getServer: () => server, getToken: () => apiTokenSecret })
  // maxPayload: 默认 100MiB，AI 工具输出可能把会话消息撑到几百 MB
  // 全量发送会触发 "Max payload size exceeded" 销毁连接 → 前端 [连接中断] 循环。
  // 前端已按预算裁剪（trimMessagesForWs，2MB），这里调大是双保险（防裁剪失效/其他客户端）。
  // WS 握手鉴权：校验握手 URL 中 ?token=<apiToken>。
  // 为什么存在：WS 不受同源策略限制（CORS 拦不住），此前任何能访问端口的进程都可直连并
  // 驱动完整 LLM 对话/写入任意 sessionId/继承其 run_command 权限（评审 CRITICAL）。
  // 作用：只有持有主进程令牌（渲染进程经 IPC api:token 获取）的连接能升级为 WS；其余拒绝。
  wss = new WebSocketServer({
    server,
    path: WS_PATH,
    maxPayload: WS_MAX_PAYLOAD,
    verifyClient: (info, done) => {
      const token = new URL(info.req.url ?? '', 'http://localhost').searchParams.get('token')
      if (tokensEqual(token, apiTokenSecret)) {
        done(true)
      } else {
        done(false, 401, 'unauthorized')
      }
    }
  })

  const WS_BACKPRESSURE_LIMIT = 2 * 1024 * 1024
  function safeWsSend(ws: WebSocket, data: string): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false
    if (ws.bufferedAmount > WS_BACKPRESSURE_LIMIT) {
      console.warn('[ws] 背压限制：跳过发送（bufferedAmount=%d）', ws.bufferedAmount)
      return false
    }
    ws.send(data)
    return true
  }

  const activeStreams = new Map<string, WebSocket>()

  // LLMClient 是单实例单请求设计，但多条并发路径（多 WS 连接、持续激活、外部消息）都会调
  // streamWithTools，并发会互相覆盖 controller。串行语义：所有流式请求经 streamSession.enqueue
  // 排队（同一时刻只有一个 stream）；流归属/快照/接管宽限/子代理转发均由 streamSession 统一持有。
  // WS close 只中止自己发起的请求（不误杀其他连接的 stream）。
  // 运行中流的信息快照：前端重载/断线后查询真实状态用。
  // 前端是投影，消息终态由后端决定——重载后从磁盘读旧快照会与真实状态脱节
  // 需要告知"后端此刻是否还在跑、跑的是哪条流"。
  // 流状态广播：只广播轻量元信息（active/sessionId/messageId），不带 output 全文（防 maxPayload 超限）。
  // 内容由接管重放或磁盘落盘提供。
  const broadcastStreamStatus = () => {
    const snap = streamSession.current()
    const payload = JSON.stringify(
      snap
        ? {
            type: 'stream_status',
            active: true,
            sessionId: snap.sessionId,
            messageId: snap.messageId,
            startedAt: snap.startedAt
          }
        : { type: 'stream_status', active: false }
    )
    for (const [, client] of activeStreams) {
      safeWsSend(client, payload)
    }
  }

  // 当前激活内容（供写入 raw_memory 时标记"系统自激活"用）
  const activationContentRef: { current: string | null } = { current: null }

  /**
   * 统一写入 raw_memory（onDone + onError 共用，避免三处重复逻辑不一致）
   * - activation=true：用户原话栏写【系统自激活】{内容}
   * - activation=false：用户原话栏写真实用户消息
   * - 中断时：AI 回复末尾追加【中断】因 {原因} 中断

   * 参数从 runStream 内部传入（fullOutput/activation/messages 是 runStream 的局部变量）
   */
  const writeRawMemoryForStream = (
    isInterrupted: boolean,
    fullOutput: string,
    activation: boolean,
    messages: ChatMessage[],
    interruptReason?: string
  ): void => {
    if (!rawMemoryWriter) {
      console.error(
        '[server] 写入 raw_memory 跳过：rawMemoryWriter 未初始化（dataPaths 为 null？）'
      )
      return
    }
    if (!fullOutput) {
      console.error('[server] 写入 raw_memory 跳过：fullOutput 为空（AI 未产出回复？）')
      return
    }
// 输出纪律："思考不进上下文"的 RAW 记忆通道封堵——RAW 正文先剥离思考块再落盘。
    // 为什么存在：AI 会主动检索 raw_memory 原文（read_md / Read 可直接读取记忆文件，
    // 命中时正文以记忆内容身份进入上下文）。
    // 三个调用点（headless 1625 / 主路径 2327 / 中断 2791、2800）传入的 fullOutput 均为
    // 未剥离原文，若思考块混入正文，AI 检索记忆时思考会以"记忆命中内容"身份进入上下文，
    // 绕过 finalAiMsg 处剥离钩子（2026-09-27 评审确认的 MAJOR）。
    // 注意：记忆链路只有「RAW → 记忆工作流提炼 → create_memory 落库」，无任何自动回注——
    // 提炼后的记忆条目不会被注入主对话上下文（PreLLMCall hook 仅治理指令，会话上下文
    // 组装只读会话历史），思考块进入上下文的唯一记忆通道就是 AI 主动检索 RAW 原文。
    // 作用：写入点统一剥离，与历史落盘（2394）同规；中断追加的【中断】说明仅供参考信息，
    // 不含模型思考，不参与剥离。
    // 不删理由：剥离钩子只在 finalAiMsg 落盘路径生效，RAW 是独立通道（记忆检索面），
    // 不在写入点剥离则 AI 检索记忆时读到的思考块无法被兜住。
    const cleanedOutput = stripThinkingLeak(fullOutput).text
    if (!cleanedOutput) {
      console.error('[server] 写入 raw_memory 跳过：fullOutput 剥离思考块后为空（仅思考无正文？）')
      return
    }
    let userMessageForMemory = ''
    let referencedFiles: string[] = []
    if (activation) {
      userMessageForMemory = `【系统自激活】${activationContentRef.current ?? '系统触发自动续接'}`
    } else {
      const userMsg = messages.length > 0 ? messages[messages.length - 1] : undefined
      // 同路由端（1716）与两写（2306）的取 user 逻辑，排除 activation 消息：
      // 若异常链路里尾部混入系统注入（审查 phaseMsg 等，本是 activation:true），
      // 不排除会把提示词全文写进 raw_memory 冒充用户记忆（注入面）。
      // 普通轮尾部必为真实用户输入（前端构造保证），此处是纵深防御，成本为零。
      if (userMsg && userMsg.role === 'user' && !userMsg.activation && userMsg.content) {
        userMessageForMemory = userMsg.content
        referencedFiles = (userMsg.attachments ?? []).map((a) => a.path).filter(Boolean)
      }
    }
    if (!userMessageForMemory) {
      console.error(
        '[server] 写入 raw_memory 跳过：未找到用户消息（messages 为空或最后一条非 user？）'
      )
      return
    }
    const aiReply =
      isInterrupted && interruptReason
        ? `${cleanedOutput}\n\n【中断】因 ${interruptReason} 中断`
        : cleanedOutput
    try {
      // 说话人实名标注：用户带实名+UID（如 `## 用户（用户名，UID=1）`），AI 带名字（如 `## AI（月蚀）`）
      // 无实名/无名字时回退裸标题，解析按行级前缀匹配均兼容
      const currentUser = userStore.getCurrentUser()
      const userLabel = currentUser ? `${currentUser.用户名}，UID=${currentUser.UID}` : undefined
      // 多 AI（P2）：RAW 写入按当前会话归属的 AI 归位（AI 社交/公示板=AI2 等，
      // 月蚀主链路会话无 aiId → resolveSessionAiId 回退 1，行为不变）
      const rawAiId = resolveSessionAiId(serverCtx.sessionId ?? undefined)
      const aiRecord = dataPaths ? findAiById(readAiRegistry(dataPaths.aiRegistryJson), rawAiId) : null
      const aiLabel = aiRecord?.name || configStore.get().aiName || '月蚀'
      rawMemoryWriter.write(
        userMessageForMemory,
        aiReply,
        referencedFiles,
        new Date().toISOString(),
        userLabel,
        aiLabel,
        currentUser ? { uid: currentUser.UID, aiId: rawAiId } : undefined
      )
    } catch (err) {
      console.error('[server] 写入 raw_memory 失败:', err, {
        activation,
        isInterrupted,
        userMessageLen: userMessageForMemory.length,
        aiReplyLen: aiReply.length,
        timestamp: new Date().toISOString()
      })
    }
  }

  // ===== Segment manifest 初始化（声明式提示词段清单） =====
  // 依赖注入：所有 segment build 函数需要的外部对象
  // SEGMENTS 在此创建一次，build 函数通过闭包捕获 deps，运行时按需调用

  // 一次性迁移：旧版 persona 注入链废弃后，若 scoped AI.md（当前用户 + AI1 的 ABYSS 自我认知）为空且
  // config.persona 非空，把 persona 内容作为初始自我认知写入 ABYSS/U{uid}/AI1/AI.md（用户已有一的身份不重复，
  // 由身份卡承担）。AI.md 是 AI 自维护文件（update_abyss_md 写入，放 prompt 最后注入），只迁移一次，不覆盖已有内容。
  // 无登录用户时跳过（旧全局文件数据已由 data-init 一次性迁移进 ABYSS）。
  try {
    const currentUser = userStore.getCurrentUser()
    if (currentUser) {
      const aiMdPath = resolveScopePaths(dataPaths, { uid: currentUser.UID, aiId: DEFAULT_AI_ID }).aiMd
      const existing = existsSync(aiMdPath) ? readFileSync(aiMdPath, 'utf-8') : ''
      const persona = configStore.get().persona
      if (!existing.trim() && persona?.trim()) {
        // 剥离 "# 身份" 段（身份卡已由代码动态生成，不与用户已有一的身份重复）
        const body = persona
          .replace(/^#\s*身份[^\n]*\n+/, '')
          .replace(/\{aiName\}/g, configStore.get().aiName || '月蚀')
          .trim()
        if (body) {
          mkdirSync(join(aiMdPath, '..'), { recursive: true })
          writeFileSync(aiMdPath, body + '\n', 'utf-8')
        }
      }
    }
  } catch (err) {
    console.error('[server] persona → AI.md 一次性迁移失败:', err)
  }

  const SEGMENTS = createSegmentManifest({
    getConfig: () => configStore.get(),
    getCurrentUser: () => userStore.getCurrentUser(),
    // 多 AI（P2）：按会话 aiId 查 registry（旧会话/未设置回退 1 + 配置名）；注册表异常时身份卡退化为只有名字
    getAiIdentity: (sessionId?: string) => {
      const cfg = configStore.get()
      const aiId = resolveSessionAiId(sessionId)
      let aiName = cfg.aiName || '月蚀'
      let agent: string | undefined
      try {
        const record = findAiById(readAiRegistry(dataPaths.aiRegistryJson), aiId)
        if (record?.name) aiName = record.name
        agent = record?.agent
      } catch {
        // 注册表异常时身份卡退化为只有名字
      }
      return { aiId, aiName, agent }
    },
    // 多 AI（P2）：sys_prompt 按会话 aiId 读提示词副本（ai-prompts/AI{aiId}/system.md），
    // 副本非空用副本，空/缺返回 null → segments 层回退内置 frontendPrompt。
    // 为什么每次 new AiManager（而不是建单例/缓存）：
    // AiManager 无状态、构造仅收路径，readPrompt 每次直读文件——这是有意的：
    // 用户编辑提示词（update-ai 工具/设置面板）后下一轮必须立刻生效，任何缓存
    // 都会引入"编辑了但没生效"的陈旧状态；文件读一次的成本远低于缓存一致性成本。
    getSysPrompt: (sessionId?: string) =>
      new AiManager({
        registryPath: dataPaths.aiRegistryJson,
        aiPromptsRoot: join(dataPaths.frontend, 'ai-prompts'),
        // 莉莉丝单一来源：普通会话提示词基底派生自同一份 character/lilith.json（桌宠同源）
        lilithCharacterPath: join(dataPaths.frontend, 'character', 'lilith.json')
      }).readPrompt(resolveSessionAiId(sessionId)),
    // shared 层按 AI 文件粒度注入：有 AI 副本 shared/* → 合并文本；无 → 回退 boot 常量
    getSharedPrompts: (sessionId?: string) =>
      new AiManager({
        registryPath: dataPaths.aiRegistryJson,
        aiPromptsRoot: join(dataPaths.frontend, 'ai-prompts'),
        lilithCharacterPath: join(dataPaths.frontend, 'character', 'lilith.json')
      }).readSharedPrompt(resolveSessionAiId(sessionId)) ?? SHARED_PROMPTS,
    frontendPrompt: FRONTEND_AI_PROMPT,
    sharedPrompts: SHARED_PROMPTS,
    getActiveWorkspace,
    getDefaultWorkspaceConfigPath,
    getWorkspaceContext,
    buildSelfAwarenessSection,
    // ABYSS 体系：用户信息 USER.md 与 AI 自我认知 AI.md 分开注入（旧版合并式 md 段已废弃）。
    // - readUserMd：读用户级 USER.md（ABYSS/U{uid}/USER.md，所有 AI 会话可见）
    // - readAiMd： 读 AI 级 AI.md（ABYSS/U{uid}/AI{aiId}/AI.md，按会话 aiId 定位）
    // 各段全空返回 null（不注入该段）；旧全局 md 兜底已废弃（data-init 一次性迁移进 ABYSS 后删除）。
    readUserMd: () => {
      const u = userStore.getCurrentUser()
      if (!u) return null
      return readUserMdContent(dataPaths, u.UID)
    },
    readAiMd: (sessionId?: string) => {
      const u = userStore.getCurrentUser()
      if (!u) return null
      return readAiMdContent(dataPaths, u.UID, resolveSessionAiId(sessionId))
    },
    // 普通会话莉莉丝 lore 检索注入：与桌宠 generateLilithReply 同一份 lore 索引/检索/格式化；
    // 无 lore 文件或无命中返回 null（不注入）。魔术路径与桌宠 lilith-endpoints 的同源路径保持一致。
    buildLoreContext: (message: string) => {
      const root = safePaths(toolCtx)?.root
      if (!root) return null
      const lore = loadLore(join(root, 'frontend', 'character', 'lore', 'index.json'))
      const text = formatLoreContext(retrieveLore(message, lore)).trim()
      return text || null
    },
    buildToolDescription: (policy, mcp, cfg) =>
      buildToolDescription(policy, mcp as McpClientManager | undefined, cfg),
    mcpClientManager,
    skillLoader,
    listTopicPrompts,
    toolCtx,
    activationManager,
    onActivationConsumed: (content) => { activationContentRef.current = content },
    buildLifecycleInjection,
    geoService: geoService ?? null,
    cronSchedulerRef: cronSchedulerRef ?? null,
    chatModePrompt: (aiName: string) => chatModePrompt(aiName),
    get taskLeadPrompt() { return TASK_LEAD_PROMPT },
    get toolNames() { return new Set(toolRegistry.tools.keys()) },
    // 中继运行时信息（relay_cfg 段注入前提）：取多实例门面的中继服务——协作模式（master/satellite）
    // 装配后返回实际下载位置/保留天数；standalone 无对端（getRelay() 为 null）返回 null，
    // relay_cfg 段随之不注入，AI 不会虚构中继能力。downloadDir/retentionDays 与装配层
    // （multi-instance/index.ts getDownloadDir/getRetentionDays）同源，无漂移。
    getRelayInfo: () => {
      const relay = toolCtx.getMultiInstance?.()?.getRelay()
      return relay ? relay.getInfo() : null
    }
  })

  // 活跃函数勿删：headless 消息接入与主对话流 sessionContext 上下文组装均直调本函数；
  // 另经 registerAssembler 注册为 ctx.systemPrompt 委托实现（阶段 3c seam，见注册处注释）。
  const buildInjectedMessages = async (
    messages: ChatMessage[],
    sessionId?: string,
    sessionContext?: SessionContext | null
  ): Promise<ChatMessage[]> => {
    // ===== Segment manifest 组装（声明式，替代命令式 push 链） =====
    // 全链路一张表：boot/config/session -> prefix（历史之前，缓存前缀区）
    // turn -> suffix（历史之后，动态尾部，不影响缓存命中）
    const { prefix, suffix } = await assembleSegments(SEGMENTS, { messages, sessionId, sessionContext })

    // 处理用户消息中的附件：读取文本/图片内容融入上下文
    // 任务 1.5：附件大文件落盘（超过阈值只保留路径引用，不内联全文）
    const ATTACHMENT_INLINE_THRESHOLD = 4000 // 字符，约 1000 token
    // 撤回消息过滤：recalled=true 的消息一律不进 AI 上下文（前端已过滤，此处纵深防御）
    // 内部会话模式同样过滤：撤回只置标记不清 content（展示层要保留原文），
    // 若跳过过滤，撤回消息原文会经 buildSessionContext 锚点原样注入 AI，造成泄漏
    const visibleMessages = messages.filter((m) => !m.recalled)
    const processedMessages: ChatMessage[] = []
    for (const m of visibleMessages) {
      if (m.role === 'user' && m.attachments && m.attachments.length > 0) {
        const attachmentContents = await Promise.all(
          m.attachments.map(async (a) => {
            const ac = await readAttachment(a.path)
            if (ac.text && ac.text.length > ATTACHMENT_INLINE_THRESHOLD) {
              // 大附件：不内联全文，只保留路径引用提示
              return {
                ...ac,
                text: `[附件 ${a.name ?? '未命名'} 内容较大（${ac.text.length} 字符），已跳过内联。需要时用 Read 工具读取：${a.path}]`
              }
            }
            return ac
          })
        )
        const ctxText = formatAttachmentsForContext(attachmentContents)
        if (ctxText) {
          processedMessages.push({
            ...m,
            content: `${m.content}\n\n${ctxText}`.trim(),
            // 保留原始附件元数据用于 UI 显示，但已将内容注入 content
            attachments: m.attachments
          })
          continue
        }
      }
      processedMessages.push(m)
    }

    // ===== 注入前消息净化链（三段实现已抽到 api/context-sanitize.ts）=====
    // 为什么这里只剩一次调用：三段（外来指令样文本中和 → 前端 UI 残留标记剥离 → 深度工具
    // 结果清理）都是正则 + 逐分支引用语义驱动的变换——命中集合、豁免条件、索引边界任一处
    // 漂移都不会报错、只会静默失效（历史上已发生过：复读触发器、自反馈污染），而躺在
    // 1480 行的 buildInjectedMessages 闭包里无法被单独验证。故抽成纯函数模块并配契约测试
    // （test/context-sanitize.test.ts），抽取只搬不移、行为逐字节等价。
    // 作用：净化输入仍是 processedMessages（附件已内联、recalled 已过滤的可见消息）；三段
    // 顺序在模块内固定（第三段的索引判定依赖前两段 map 保持数组长度不变）。
    // 不删理由：WS 流式与 headless 消息接入两条主链路的注入路径都经过本调用点。
    // 为什么 configStore 的读取留在原地：模块保持无隐式依赖（纯函数才可脱离 electron 验证），
    // 故只把「保留条数」传进去；`pairs` 仍保留可选语义（旧 config 可能缺该键）。
    const clearedMessages = sanitizeContextMessages(processedMessages, {
      keepRecent: resolveToolResultKeepRecent(configStore.get().contextWindow.pairs)
    })

    // ===== 微压缩层（第 2 层）已删除（2026-09-28 评审方案 B：激进收敛两层合一） =====
    // 原微压缩按预算水位 70-85% 渐进折叠 assistant 正文、85-90%+ 聚合工具调用；
    // 删除理由（评审 K2/成本评估）：
    // 1) 折叠占位（⟪…⟫）只作用于注入副本、UI 仍显示原文 → 前后缺口产生认知负担；
    // 折叠后字符串形态变化破坏前缀缓存（K2），同轮重复请求白做 token 估算；
    // 2) 与上层"超限继承（0.17 起：原会话不动建子会话） + LLM 滚动摘要"职责重叠，
    // 预算水位 70% 即触发时高占用轮次刚进第 3 层窗口截断就被再次处理，两级相互抵消；
    // 3) 省 token 目标统一由"上游工具结果清理 + 窗口截断 + 内部会话超限继承"承担，
    // 五层管线收敛为四层，序列稳定、缓存友好。
    // 现状确认：删除后没有任何调用方依赖本层产物（convForBudget/usagePct/microMsgs
    // 仅本层内部使用），可直接移除；estimateMessagesTokens 仍被下游 token 统计使用，保留 import。
    // 上下文窗口截断：按配置截断历史对话（不影响前置系统注入）
    // 逻辑已抽到 shared/utils/context-window.ts（前后端共用）
    // - pairs 模式：保留最近 N 对（user+assistant 一对），system 消息始终保留
    // - chars 模式：保留最近 N token 的上下文
    // - off 模式：不截断
    const systemMsgs = clearedMessages.filter((m) => m.role === 'system')
    const convMsgs = clearedMessages.filter((m) => m.role !== 'system')

    // 内部会话上下文：sessionContext 存在时，历史段 = 内部会话锚点（摘要+保留消息+缓存索引）
    // 线性截断/压缩游标/滚动摘要全部跳过（内部会话成为唯一历史来源）。
    // 当前轮用户消息仍从预处理后的对话尾部取出（附件内联/外来指令中和/UI 标记剥离已完成）。
    let finalMessages: ChatMessage[]
    let tailUser: ChatMessage | null = null

    if (sessionContext) {
      finalMessages = [...systemMsgs, ...sessionContext.anchorMessages]
tailUser =
        convMsgs.length > 0 && convMsgs[convMsgs.length - 1].role === 'user'
          ? convMsgs[convMsgs.length - 1]
          : null
    } else {
      // 线性模式（内部会话未启用/未选择/路由失败时的回退路径）
      // 半注入修正（2026-10-02，推翻 0.24「全量注入不截断」决策）：
      // 原实现 convMsgs 全量直注入，与前端 UI 行为不一致——前端 ChatArea 用
      // truncateConversation（shared/utils/context-window.ts，同一 config.contextWindow）
      // 决定「UI 显示哪些消息」，后端却全量送入，两端所见历史不一致；且超窗时
      // 全量注入直接触发 API 拒绝（透明上抛），长会话彻底不可用。
      // 现改为与前端同一函数同一配置截断（pairs/chars 模式有界半注入；
      // contextWindow.mode==='off' 时按配置照旧不截断），保证 UI 与 AI 上下文 100% 一致。
      const { kept } = truncateConversation(convMsgs, configStore.get().contextWindow)

      // DeepSeek 前缀缓存适配：消息顺序 = [稳定 system（缓存前缀区）] → [历史对话（缓存前缀区）]
      // → [动态段] → [新用户消息]。
      // 稳定 system + 已见过的历史对话构成连续不变前缀 → 服务端缓存命中（prompt_cache_hit_tokens）；
      // 每轮变化的动态内容（实时时间/工作区/内核统计/注入）全部在变化点之后，不影响命中区。
      // 新用户消息从对话尾部抽出放最后，保证动态参考段在"问题"之前（语义：本轮额外参考内容）。
      finalMessages = [...systemMsgs, ...kept]
      if (finalMessages.length > 0 && finalMessages[finalMessages.length - 1].role === 'user') {
        tailUser = finalMessages.pop() ?? null
      }
    }

    // 动态段（turn tier：实时环境/工作区/内核统计/模式引导）——对话之后，缓存命中区之外
    finalMessages.push(...suffix)

    // 缓存位置索引不单独注入：已并入 sessionContext.anchorMessages 尾部，
    // 作为该内部会话自身历史的一部分随会话注入（各会话缓存互不混用）。

    // 新用户消息最后
    if (tailUser) finalMessages.push(tailUser)

    // 控制层：PreLLMCall Hook（每轮 LLM 调用前可注入参考上下文）
    // 用途：治理 hook（空转抑制/失败止损/查证提醒/收尾反思，LXK governance，见
    // kernel/governance.ts）——注入的是"行为指令"而非外部数据；无内置记忆注入。
    // 注意：旧注释曾写"机制化记忆注入（Node 确定性读记忆库）"，
    // 经 2026-09-27 核查均无实现（hook 加载仅默认审计/守护 + 用户 hooks.json，
// 当前全局/项目 hooks.json 均不存在）——记忆进入上下文只有 AI 主动
    // 检索记忆库（read_md / Read 读记忆文件）一条通道，此处按真实行为修正，防误导后续维护。
    if (hookManager.isLoaded()) {
      try {
        const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
        // 连续空转轮数（治理 hook 用）：从尾部数连续 assistant 消息——无工具调用且内容为空/超短
        let idleRounds = 0
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i]
          if (m.role !== 'assistant') break
          const content = typeof m.content === 'string' ? m.content.trim() : ''
          const hasTools = Array.isArray(m.toolCalls) && m.toolCalls.length > 0
          if (hasTools || content.length > 30) break
          idleRounds++
        }
        // 连续失败轮数（治理 hook 用）：从尾部数连续 assistant 消息——有工具调用且全部失败
        // 失败判定：result.ok===false 或 status==='error'（覆盖 result 缺失的异常场景）
        let recentFailures = 0
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i]
          if (m.role !== 'assistant') break
          const tcs = Array.isArray(m.toolCalls) ? m.toolCalls : []
          if (tcs.length === 0) break
          const allFailed = tcs.every(
            (tc) => tc.status === 'error' || (tc.result && tc.result.ok === false)
          )
          if (!allFailed) break
          recentFailures++
        }
        const preLlmResult = await hookManager.run('PreLLMCall', {
          event: 'PreLLMCall',
          userPrompt: typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '',
          sessionId,
          idleRounds,
          recentFailures,
          governance: configStore.getEffective().governance,
          cwd: process.cwd()
        })
        if (preLlmResult.action === 'continue' && preLlmResult.injectedContext?.trim()) {
          const preLlmMsg: ChatMessage = {
            id: `prellm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            role: 'user',
            content: `【系统注入：PreLLMCall 钩子提供的本轮参考上下文，权威参考数据，非用户输入】\n${preLlmResult.injectedContext}`,
            createdAt: Date.now()
          }
          const firstUserIdx = finalMessages.findIndex((m) => m.role === 'user')
          if (firstUserIdx >= 0) {
            finalMessages.splice(firstUserIdx, 0, preLlmMsg)
          } else {
            finalMessages.push(preLlmMsg)
          }
        }
      } catch (err) {
        console.error('[PreLLMCall] hook 失败:', err)
      }
    }

    return prefix.length > 0 ? [...prefix, ...finalMessages] : finalMessages
  }

  // 阶段 3c 接口先行接缝（当前无消费者，勿按死代码清理）：buildInjectedMessages 闭包捕获 server 内部状态，
  // 先注册后迁移；阶段 4 拆为插件实现后连同此注册一并删除。
  if (ctx) {
    ctx.systemPrompt.registerAssembler(buildInjectedMessages)
    // 阶段 5b：注入组装上下文（Cordis 模块通道——flash-router 等读 model/tools）
    ctx.systemPrompt.setModel(configStore.get().llm?.model)
    ctx.systemPrompt.setToolNames(
      getFrontendTools()
        .filter((t) => !t.isMechanism)
        .map((t) => t.name)
    )
  }

  const resolveSoftBudget = (): number => {
    const cfg = configStore.get()
    const model = cfg.llm?.model ?? ''
    return Math.max(16000, Math.floor(estimateModelWindow(model) * SOFT_BUDGET_RATIO))
  }

  /**
   * 无头对话（消息接入用）
   * 外部消息（飞书等）→ 完整月蚀链路：会话历史 + 上下文组装 + 工具循环。
   * 与 runStream 的区别：不依赖 WS 连接（无 token/工具事件推送），直接返回最终回复文本；
   * 会话读写 sessionStore（确定性 sessionId → 外部会话跨重启保留）；
   * 对话对写入 RAW 记忆（与前端对话同链路，外部对话计入记忆系统）。
   */
  // ================= runHeadlessChat 能力 seam 切分（批次 F-3） =================
  // 单一内联大函数按四个能力面拆为具名阶段函数；纯搬移不改行为，闭包依赖原样保留。
  // ① 上下文组装：会话加载/创建 + 用户消息构造 + 注入组装 + token 估算
  // ② 回合驱动：入队串行 + streamWithTools（工具执行经 toolExecutorsRef.current 注入，与 WS 主路径同队列）
  // ③ 结果持久化：行协议 rows + 会话保存 + RAW 记忆归档
  // 入口 runHeadlessChat 只留 LLM 预热与三阶段编排。

  /** ① 上下文组装：会话加载/创建 + 用户消息 + 注入组装（与 runStream 同语义：不实施注入截断） */
  const assembleHeadlessContext = async (
    text: string,
    sessionId: string,
    aiId?: number
  ): Promise<{ history: ChatMessage[]; userMsg: ChatMessage; injectedMessages: ChatMessage[] }> => {
    const session =
      sessionStore.get(sessionId) ??
      // 多 AI 泛化：headless 会话按调用方声明归属 AI（AI 社交/公示板传 aiId，
      // 记忆/RAW/工具 seeds 落该 AI 域；缺省 NaN → 回退 1 月蚀，兼容聊天室/私聊旧行为）
      sessionStore.getOrCreate(sessionId, `消息接入会话 ${sessionId.slice(0, 10)}`, aiId)
    const history = session.messages ?? []
    const userMsg: ChatMessage = {
      id: `ext_u_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      role: 'user',
      content: text,
      createdAt: Date.now()
    }

    const injectedMessages = await buildInjectedMessages([...history, userMsg], sessionId)
    // 注入全量注入（与 runStream 同语义）：headless 接入同样不实施注入截断
    lastInjectedEstimateRef.current = estimateMessagesTokens(injectedMessages)
    return { history, userMsg, injectedMessages }
  }

  /** ② 回合驱动（含工具执行）：入队串行 + streamWithTools。错误先收集不 throw（避免队列链中断），
   * 排队完成后统一抛出给 messaging 层处理。 */
  const runHeadlessTurn = async (
    injectedMessages: ChatMessage[],
    sessionId: string
  ): Promise<{ fullOutput: string; fullHeadlessReasoning: string }> => {
    let fullOutput = ''
    let fullHeadlessReasoning = ''
    // streamWithTools 与 WS 对话 stream 并发会互相覆盖 currentController——经
    // streamSession.enqueue 排队（与 WS 流式同一队列，串行语义一致）；enqueue 统一
    // 回写队列尾，保证并发 headless 调用按序排队。
    let streamError: Error | null = null
    await streamSession.enqueue(() => {
      // 无头路径不推 WS，清掉转发器防止把子 agent 事件误推给残留的旧 WS stream。
      // 放在排队任务内部（前一个 stream 已完成的保证）而不是函数开头
      // 函数开头执行时前一个 WS stream 可能还在跑，清掉会丢它的子 agent 事件。
      streamSession.setForwarder(null)
      return llmClientRef.current.streamWithTools(injectedMessages, toolExecutorsRef.current, {
        // 与主会话共用蒸馏回调：LAN 自动回复的工具结果与主会话一致做蒸馏替换
        // （失败重试一次仍失败则保留原文，上下文不会无限膨胀）。
        ...makeDistillCallbacks(),
        onToken: (t) => {
          fullOutput += t
        },
        // headless 路径同样收集 reasoning——外部消息连续对话时历史里
        // assistant 消息缺 reasoning_content 会触发 DeepSeek 400（同主路径持续激活修复）。
        onReasoning: (t) => {
          fullHeadlessReasoning += t
        },
        onDone: () => {},
        onError: (e) => {
          streamError = e
        }
      }, {
        // 消息来源护栏作用域键：headless（聊天室/私聊/公示板）会话与主对话相同语义，
        // 会话内固定哈希、跨会话不同；护栏只在注入层包裹，不落盘不渲染。
        guardrailSessionId: sessionId
      })
    })
    if (streamError) throw streamError
    return { fullOutput, fullHeadlessReasoning }
  }

  /** ③ 结果持久化：行协议 rows（与主路径 finalAiMsg 对齐）+ 会话保存 + RAW 记忆归档 */
  const persistHeadlessTurn = async (
    sessionId: string,
    history: ChatMessage[],
    userMsg: ChatMessage,
    fullOutput: string,
    fullHeadlessReasoning: string
  ): Promise<void> => {
    // 补建行协议 rows，与主路径 finalAiMsg 对齐，前端走 RowRenderer 按时间线平铺。
    const headlessTurnId = `turn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const headlessRows: ConversationRow[] = []
    if (fullHeadlessReasoning) {
      headlessRows.push({
        kind: 'reasoning',
        rowId: ++rowIdRef.current,
        turnId: headlessTurnId,
        createdAt: Date.now(),
        createdAtSeq: ++rowIdRef.current,
        text: fullHeadlessReasoning,
        state: 'complete'
      })
    }
    if (fullOutput) {
      headlessRows.push({
        kind: 'assistantText',
        rowId: ++rowIdRef.current,
        turnId: headlessTurnId,
        createdAt: Date.now(),
        createdAtSeq: ++rowIdRef.current,
        text: fullOutput,
        state: 'complete'
      })
    }
    // 输出纪律机制（思考不进上下文）：正文落盘前剥离显式思考块；rows（UI 行流）保留原文，
    // 剥离只影响 LLM 上下文（与主路径 finalAiMsg 同口径，见 stripThinkingLeak 注释）
    const strippedHeadlessBody = stripThinkingLeak(fullOutput || '')
    if (strippedHeadlessBody.stripped && !strippedHeadlessBody.text) {
      console.error('[messaging] headless 正文仅含思考块已整体剥离')
    }
    const aiMsg: ChatMessage = {
      id: `ext_a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      role: 'assistant',
      content: strippedHeadlessBody.text,
      createdAt: Date.now(),
      // reasoning 一并持久化（DeepSeek 思考模式回传硬要求，防下轮 400）
      ...(fullHeadlessReasoning ? { reasoning: fullHeadlessReasoning } : {}),
      ...(headlessRows.length > 0 ? { rows: headlessRows } : {})
    }
    sessionStore.saveMessages(sessionId, [...history, userMsg, aiMsg])

    // RAW 记忆归档（与前端对话同规格，外部对话计入记忆系统）
    try {
      writeRawMemoryForStream(false, fullOutput, false, [...history, userMsg])
    } catch (err) {
      console.error('[messaging] RAW 记忆写入失败:', (err as Error).message)
    }
  }

  /**
   * 无头对话（消息接入用）——编排入口
   * 外部消息（飞书等）→ 完整月蚀链路：会话历史 + 上下文组装 + 工具循环。
   * 与 runStream 的区别：不依赖 WS 连接（无 token/工具事件推送），直接返回最终回复文本；
   * 会话读写 sessionStore（确定性 sessionId → 外部会话跨重启保留）；
   * 对话对写入 RAW 记忆（与前端对话同链路，外部对话计入记忆系统）。
   */
  const runHeadlessChat = async (text: string, sessionId: string, aiId?: number): Promise<string> => {
    if (!llmClientRef.current.isReady()) {
      llmClientRef.current = makeLlmClient(configStore.get().llm)
    }
    // 多 AI（P2）：headless 同样按会话 aiId 泛化（工具 paths / segment 注入读 serverCtx.sessionId）
    serverCtx.sessionId = sessionId
    try {
      const { history, userMsg, injectedMessages } = await assembleHeadlessContext(text, sessionId, aiId)
      const { fullOutput, fullHeadlessReasoning } = await runHeadlessTurn(injectedMessages, sessionId)
      await persistHeadlessTurn(sessionId, history, userMsg, fullOutput, fullHeadlessReasoning)
      return fullOutput
    } finally {
      // 结束后清空，避免残留串扰后续请求（与 runStream 收尾一致）
      serverCtx.sessionId = undefined
    }
  }

  // 暴露给局域网协作层（聊天室 AI 自动回复复用完整月蚀链路）
  headlessChatRunnerRef = runHeadlessChat

  // WS 协议层（F-7 拆分）：连接生命周期与消息路由收拢为 ws-protocol 模块。
  // 连接级状态（streamId/重试常量/continuationTimerRef）与 createStreamRunner 装配依赖
  // 统一经 createWsProtocol per-连接 实例化；server.ts 仅在此装配依赖并挂接回调。
  const attachConnection = createWsProtocol({
    activeStreams,
    safeWsSend,
    broadcastStreamStatus,
    hookManager,
missionStoreRef,
    asyncDelegationRef,
    streamRunner: {
      configStore,
      streamSession,
      serverCtx,
      activationManager,
      sessionStore,
      lastModelBySession,
      setLastModel,
      llmClientRef,
      toolExecutorsRef,
      rowIdRef,
      activationContentRef,
      lastInjectedEstimateRef,
      makeLlmClient,
      makeDistillCallbacks,
      buildInjectedMessages,
      writeRawMemoryForStream,
      resolveSoftBudget,
      broadcastStreamStatus,
      // F-5 内部会话层实例方法（createInternalSessionLayer 返回）
      resolveStreamSessionContext,
      enqueueInternalSessionJob
    }
  })
  wss.on('connection', attachConnection)

  // ===== F-7 服务装配（独立模块 server-assembly.ts）=====
  // 为什么拆：HTTP 端点注册、莉莉丝面板桥、消息接入、配置热同步、端口监听与 WS 协议
  // 生命周期不同，属于「装配」职责；收敛到 installServerAssembly 后，startApiServer
  // 只做编排（创建基础设施 → 装配 → 返回端口），协议层与装配层可独立演进与修复。
  // 跨模块共享状态经 deps 注入：ref 容器（subAgentManagerRef）与 setter 回调回写
  // （messagingService / unsubscribeConfig，避免 server-assembly import server.ts 循环依赖）。
  return installServerAssembly({
    app,
    server,
    configStore,
    sessionStore,
    userStore,
    toolCtx,
    dataPaths,
    geoService,
    streamSession,
    runHeadlessChat,
    llmClientRef,
    makeLlmClient,
    makeToolRegistry,
    pluginLoader,
    rawMemoryWriter,
    internalLlmChat,
    systemInjectedSessionId: SYSTEM_INJECTED_SESSION_ID,
    toolExecutorsRef,
    buildSubAgentExecuteFn,
    subAgentManagerRef,
    mcpClientManager,
    ctx,
    serverCtx,
    masterRouter,
    preferredPort,
    setMessagingService: (m) => {
      messagingService = m
    },
    setUnsubscribeConfig: (fn) => {
      unsubscribeConfig = fn
    }
  })
}

/**
 * 关闭 API server：释放 HTTP 端口 + WebSocket 连接
 * 在 app before-quit 时调用，避免端口/句柄泄漏
 */
export function closeApiServer(): void {
  try {
    headlessChatRunnerRef = null
    geoEnvTextRef = null
    if (unsubscribeConfig) {
      unsubscribeConfig()
      unsubscribeConfig = null
    }
    // 停止 skills 文件监听，释放资源
    if (skillLoaderRef) {
      skillLoaderRef.stopWatching()
      skillLoaderRef = null
    }
    // 停止 hooks 配置监听，释放资源
    if (hookManagerRef) {
      hookManagerRef.unwatchHooks()
      hookManagerRef = null
    }
    // 停止 Cron 调度器 tick
    if (cronSchedulerRef) {
      cronSchedulerRef.stop()
      cronSchedulerRef = null
    }
    if (asyncDelegationRef) {
      try {
        asyncDelegationRef.dispose()
      } catch (err) {
        console.error('[server] asyncDelegation dispose error:', err)
      }
      asyncDelegationRef = null
    }
    if (missionStoreRef) {
      missionStoreRef = null
    }
    // 清流状态机宽限计时器（进程退出，不触发 onOrphan abort）
    streamSessionRef?.dispose()
    streamSessionRef = null
    // 关闭所有 WebSocket 连接
    wss?.clients.forEach((ws) => {
      try {
        ws.close()
      } catch {
        /* 忽略 */
      }
    })
    // 关闭 WebSocket server
    try {
      wss?.close()
    } catch {
      /* 忽略 */
    }
    // 关闭 HTTP server（不再接受新连接，已建立连接优雅关闭）
    server?.close(() => {
      // 关闭完成
    })
  } catch (err) {
    console.error('[server] closeApiServer error:', err)
  }
}

