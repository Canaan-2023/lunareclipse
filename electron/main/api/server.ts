/**
 * @category 核心
 * @summary 后端服务：提示词组装注入、对话流与 LLM 工具循环、IPC 与工具执行

 * 月蚀主进程的核心服务端：渲染进程 / headless / 消息接入的请求都汇聚到这里，
 * 集中走「组装上下文 → 调用 LLM → 执行工具 → 回流结果」的对话闭环。
 * 独立成文件是为把提示词注入、会话状态、工具循环与端点注册收拢在
 * 一个生命周期内，让无头对话等子链路复用其能力而不各自重造。
 */
import express, { type Router } from 'express'
import { randomBytes } from 'crypto'
import type { ConfigStore } from './config-store'
import type { SessionStore } from './session-store'
import { LLMClient, attachContextRatio } from './llm'
import type { LLMConfig } from '@shared/types'
import type { Context } from '../kernel/cordis-runtime'
import type { ToolExecutor } from './llm'
import {
  createToolRegistry,
  type ToolRegistryOptions
} from '../tools'
import { installToolSearchBridge } from '../tools/tool-search'
import type { ToolContext } from '../tools/base-tool'
import { SubAgentManager } from '../sub-agent'
import { ApprovalManager } from '../tools/sub-agent-engine/engine'
import { StreamSession } from './stream-session'
import type { UserStore } from '../models/user-store'
import type { BaseDataPaths } from '../models/paths'
import type { PluginLoader } from '../plugins'
import { ActivationManager } from './activation-manager'
import { resolveSessionAiIdWithAudit } from './ai-scope'
import { InternalSessionStore } from '../services/internal-session-store'
import {
  getFrontendTools
} from '@shared/tools/registry'
import type { McpClientManager } from '../mcp/client-manager'
import { loadSharedPrompts, loadFrontendPrompt } from '../prompts/loader'
import {
  clearToolDescCache,
  toToolExecutor
} from './tool-bridge'
import {
  SOFT_BUDGET_RATIO,
  estimateModelWindow
} from './server-utils'
// 内部会话层独立模块（F-5 拆分）：摘要配置/上下文装配/两写摘要压缩单飞队列。
import { createInternalSessionLayer } from './internal-session'
// WS 协议层（F-7 拆分）：连接生命周期与消息路由独立模块。
import { createWsProtocol } from './ws-protocol'
// 服务装配层（F-7 拆分）：HTTP 端点/消息接入/配置热同步/端口监听。
import { installServerAssembly } from './server-assembly'
// 代码审查通道独立模块（F-4 拆分）：审查链存储/HTML 报告渲染/独立审查提示词。
// hasReviewPass 不经本地绑定（见下方 re-export，独立语法），故不在此 import。
import { getReportsRoot } from './code-review'
// 测试与 IPC 仍从 server 入口取审查通过判定，re-export 保持对外 API 稳定（拆分不改行为）。
export { hasReviewPass } from './code-review'
// CORS 白名单与令牌鉴权中间件（ADR-02 第 1 步外移）：回环判定口径仍单源在 server-utils，
// 由 auth-middleware 直接 import（不在本文件复制实现，见 CODE-RULES §3.7 协议面红线）。
import { installAuthMiddleware } from './auth-middleware'
// 只读报告端点与 /api/v1 网关（ADR-02 第 2 步外移）；注册顺序仍由本文件控制（见各调用点注释）。
import { installReportsEndpoint } from './reports-endpoint'
import { installMasterGateway } from './master-gateway'
// 无头对话能力 seam（ADR-02 第 4 步外移）：三阶段 + 入口编排收拢到该模块，宿主只注入闭包依赖。
import { createHeadlessChatRunner } from './run-headless-chat'
// ADR-02 第二轮外移：装配期安全读 paths / 段清单装配 / 注入消息组装 / RAW 写入 四个纯装配块。
import { safePaths } from './tool-ctx-safe'
import { migratePersonaToAiMd, createSegments } from './segment-manifest'
import { createBuildInjectedMessages } from './injected-messages'
import { createWriteRawMemoryForStream } from './raw-memory-for-stream'
// ADR-02 第二轮外移（第二批）：工具上下文 / 蒸馏回调 / 子 agent 执行面与 Mission 接线。
import { createServerCtx } from './server-ctx'
import { createDistillCallbacksFactory } from './distill-callbacks'
import { createSubAgentExecuteFnFactory, installMissionWiring } from './sub-agent-exec'
// ADR-02 第二轮外移（第三批）：装配期运行时服务 / WS 广播面 / HTTP+WS 服务。
import { createRuntimeServices } from './runtime-services'
import { createWsBroadcast } from './ws-broadcast'
import { createHttpWsServer } from './http-ws-server'
// 进程级引用容器（ADR-02 第 3 步外移）：13 个引用的唯一 owner、只读 getter 与释放链见该模块头注释。
import { serviceRefs, releaseServiceRefs, getExtraToolExecutors, getRestrictTools } from './service-refs'
// 对外 API 面不变：以下 5 符号仍从本入口导出（re-export），消费方导入路径与符号名零改动。
export {
  getApiToken,
  getMessagingService,
  getHeadlessChatRunner,
  getGeoEnvText,
  SYSTEM_INJECTED_SESSION_ID
} from './service-refs'

// ===== 进程级引用（ADR-02 第 3 步）=====
// 13 个引用（server/wss/订阅解绑/加载器与调度器/令牌/无头对话运行器等）已收进 ./service-refs
// 的 serviceRefs 容器：本文件只写 `serviceRefs.xxx`，释放统一由 closeApiServer → releaseServiceRefs() 触发。
// 新增引用时：在 service-refs.ts 的 ServiceRefs 与 releaseServiceRefs() 同时登记（创建与释放同文件对齐）。

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
  serviceRefs.apiTokenSecret = randomBytes(32).toString('hex')
  const app = express()

  // 装配期安全读取工具上下文（safePaths / spreadToolCtx）已外移至 ./tool-ctx-safe（ADR-02 第二轮外移）。
  // 装配期快照：登录态（含启动恢复）此后不再变化，快照与 getter 结果一致且避免重复求值。
  const toolPaths = safePaths(toolCtx)

  // ===== CORS 白名单 + 本机 API 令牌鉴权（ADR-02：已外移至 ./auth-middleware）=====
  // 注册顺序即安全语义：CORS 必须先于鉴权；本调用必须先于 body 上限与全部路由（见 auth-middleware 头注释）。
  installAuthMiddleware(app, { getApiTokenSecret: () => serviceRefs.apiTokenSecret })


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

  // ===== 只读报告静态服务（ADR-02 第 2 步外移至 ./reports-endpoint）=====
  installReportsEndpoint(app, { reportsRoot: getReportsRoot() })


  // /api/v1 网关（ADR-02 第 2 步外移至 ./master-gateway）：惰性转发语义与 503 口径见该模块头注释。
  installMasterGateway(app, { masterRouter, getMasterRouter })

  // 核心服务门面：ctx 存在时经 ctx 统一构造点，否则退回直接构造（向后兼容）
  const makeLlmClient = (cfg: LLMConfig) => attachContextRatio(ctx ? ctx.llm.create(cfg) : new LLMClient(cfg), () => lastInjectedEstimateRef.current, () => configStore.get().tokenBudget || resolveSoftBudget())
  const makeToolRegistry = (c: ToolContext = {}, o?: ToolRegistryOptions) =>
    ctx ? ctx.tools.createRegistry(c, o) : createToolRegistry(c, o)

  // 流式引擎共享状态（F-6）：runStream（stream-runner 工厂）经 ref 容器注入，懒重建与 getter 自动读到新实例
  const llmClientRef: { current: LLMClient } = { current: makeLlmClient(configStore.get().llm) }

  // ===== 内部会话层（F-5 拆分：摘要配置/上下文装配/两写摘要压缩维护队列）=====
  // 见 internal-session.ts：summaryLlmClient 懒创建、getSessionSummaryCfg、buildSessionContext、
  // enqueueInternalSessionJob、resolveStreamSessionContext 收拢为单一 Layer；
  // server.ts 只持有 layer，runStream 经其能力点消费，不再与主对话闭包互相纠缠。
  const internalSessionLayer = createInternalSessionLayer({
    configStore,
    sessionStore,
    sharedInternalSessionStore,
    toolCtx,
    makeLlmClient
  })
  const { enqueueInternalSessionJob, resolveStreamSessionContext } = internalSessionLayer


  // raw_memory 写入器与地理位置服务随运行时服务一起外移（见下方 createRuntimeServices 调用）。

  // 工具结果 LLM 蒸馏层与蒸馏回调工厂已外移至 ./distill-callbacks（ADR-02 第二轮外移）：
  // 三路径（主会话流式/无头会话/子 agent）共用同一口径，宿主只提供 llmClientRef 与 configStore。
  const makeDistillCallbacks = createDistillCallbacksFactory({ llmClientRef, configStore })

  // 加载提示词：通用层（shared/，所有 AI 共享）+ 前端 AI 专属（唯一权威 prompts/ 目录）
  const SHARED_PROMPTS = loadSharedPrompts()
  const FRONTEND_AI_PROMPT = loadFrontendPrompt()

  // 统一工具池：前端 AI 与记忆工作流共用 createToolRegistry，按 policy 配置差异化启用
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
  serviceRefs.streamSessionRef = streamSession
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

  // 子 agent executeFn 统一构造已外移至 ./sub-agent-exec（ADR-02 第二轮外移）：
  // 工具事件转发 + 蒸馏共用同一回调工厂，与拆分前口径一致。
  const buildSubAgentExecuteFn = createSubAgentExecuteFnFactory({ makeDistillCallbacks })

  // 装配期运行时服务（raw_memory 写入器 / 地理位置服务 / Skills 加载器 / Hook 管理器（含事件桥与
  // 热重载）/ Cron 调度器）已外移至 ./runtime-services（ADR-02 第二轮外移）：创建即登记 serviceRefs，
  // 宿主只解构句柄注入下游；Cron「复用 index.ts 实例」与 Hook 事件桥 detach 的语义见该模块头注释。
  const { rawMemoryWriter, geoService, skillLoader, hookManager, cronScheduler } = createRuntimeServices({
    configStore,
    userStore,
    dataPaths,
    toolCtx,
    toolPaths: toolPaths ?? null,
    ctx,
    activationManager
  })

  const lastInjectedEstimateRef: { current: number | null } = { current: null }

  // 解析会话所属 AI 编号（多 AI P2）：实现已外移至 ./ai-scope（会话 aiId 合法则用之，
  // 缺省/非法回落月蚀 AI1 并记审计——ADR-25 §4.5 的 L2 处置：不删回落，加审计）
const resolveSessionAiId = (sessionId?: string): number => resolveSessionAiIdWithAudit(sessionId, sessionStore)

  // 子 agent 审批裁决器（自动化通道共用：async delegation / workflow / batch 无用户交互时，
  // run_command 等工具经此按策略裁决灰名单命令；默认 ask=fail-closed，只有显式 setToolPolicy
  // 放行的工具才自动获批。主对话前端路径走 requestPermission，不经过此裁决器。）
  const subAgentApproval = new ApprovalManager()

  // 工具上下文（serverCtx）已外移至 ./server-ctx（ADR-02 第二轮外移）：动态 paths getter 与
  // 「未登录不崩」不变量同处该模块；宿主只提供依赖（getCronScheduler 用 getter 保热更新语义）。
  const serverCtx = createServerCtx({
    toolCtx,
    configStore,
    sessionStore,
    userStore,
    dataPaths,
    resolveSessionAiId,
    subAgentApproval,
    mcpClientManager,
    toolExecutorsRef,
    subAgentManagerRef,
    skillLoader,
    hookManager,
    getCronScheduler: () => cronScheduler,
    sharedInternalSessionStore,
    toolPaths: toolPaths ?? null,
    lastInjectedEstimateRef,
    getSoftBudget: () => resolveSoftBudget()
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
   // 渐进式披露桥：tool_search 始终注入（MCP/插件工具多、或内置 deferred 工具未在清单中时，AI 用它找 schema）。
  // 与 server-assembly 热更新路径共用 installToolSearchBridge，避免两处注册逻辑漂移。
  installToolSearchBridge(toolRegistry, mcpClientManager)
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

  // 异步委托通道 + 长期目标（Mission）接线已外移至 ./sub-agent-exec（ADR-02 第二轮外移）：
  // 创建即登记 serviceRefs（asyncDelegationRef / missionStoreRef），宿主只提供依赖。
  installMissionWiring({ toolPaths: toolPaths ?? null, buildSubAgentExecuteFn, llmClientRef, toolExecutorsRef })

  // HTTP 服务与 WS 升级服务（含握手令牌鉴权）已外移至 ./http-ws-server（ADR-02 第二轮外移）：
  // 创建即登记 serviceRefs（server / wss），宿主只解构句柄；握手鉴权口径见该模块头注释。
  const { server, wss } = createHttpWsServer(app)

  // WS 广播面（活跃流集合 / 背压保护发送 / 流状态广播）已外移至 ./ws-broadcast（ADR-02 第二轮外移）。
  const { activeStreams, safeWsSend, broadcastStreamStatus } = createWsBroadcast({ streamSession })

  // 当前激活内容（供写入 raw_memory 时标记"系统自激活"用）
  const activationContentRef: { current: string | null } = { current: null }

  // 统一写入 raw_memory（onDone + onError 共用）已外移至 ./raw-memory-for-stream（ADR-02 第二轮外移）：
  // 输出纪律剥离 / 实名标注 / 按会话 AI 归位的口径见该模块头注释，宿主只注入依赖。
  const writeRawMemoryForStream = createWriteRawMemoryForStream({
    rawMemoryWriter,
    activationContentRef,
    configStore,
    userStore,
    dataPaths,
    resolveSessionAiId,
    serverCtx
  })

  // ===== Segment manifest 初始化（声明式提示词段清单）=====
  // persona → AI.md 一次性迁移与段清单装配（createSegmentManifest 的 deps 收口）
  // 已外移至 ./segment-manifest（ADR-02 第二轮外移）：宿主只提供依赖，不再内联 deps 字面量。
  migratePersonaToAiMd({ configStore, userStore, dataPaths })
  const SEGMENTS = createSegments({
    configStore,
    userStore,
    dataPaths,
    resolveSessionAiId,
    SHARED_PROMPTS,
    FRONTEND_AI_PROMPT,
    toolCtx,
    activationManager,
    activationContentRef,
    geoService,
    cronSchedulerRef: serviceRefs.cronSchedulerRef ?? null,
    mcpClientManager,
    skillLoader,
    toolRegistry
  })

  // 活跃函数勿删：headless 消息接入与主对话流 sessionContext 上下文组装均直调本函数；
  // 另经 registerAssembler 注册为 ctx.systemPrompt 委托实现（阶段 3c seam，见注册处注释）。
  // 实现已外移至 ./injected-messages（ADR-02 第二轮外移）：附件内联/净化链/窗口截断/段清单/hook 口径见该模块。
  const buildInjectedMessages = createBuildInjectedMessages({ configStore, hookManager, segments: SEGMENTS })

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

  // 无头对话运行器（ADR-02 第 4 步外移）：三阶段 + 入口编排收拢到 ./run-headless-chat，
  // 宿主只注入闭包依赖——ref 容器与主路径**共用同一对象**，故无头链路读到的是「当前生效」的
  // LLM 客户端 / 工具集 / 行 id 序列（与拆分前闭包语义一致）。
  const runHeadlessChat = createHeadlessChatRunner({
    configStore,
    sessionStore,
    buildInjectedMessages,
    lastInjectedEstimateRef,
    streamSession,
    llmClientRef,
    makeLlmClient,
    toolExecutorsRef,
    // 用途专属工具（当前只有房间轮的区工具）：组合根经 serviceRefs 写入（§3.4 跨域装配只在 bootstrap/）。
    // 普通对话拿空数组 → 工具面与引入前逐字一致。
    extraToolExecutors: getExtraToolExecutors,
    // 用途收窄（前置规划轮只读工具面）：与 extraToolExecutors 同走 serviceRefs（§3.4），null = 不收窄。
    restrictTools: getRestrictTools,
    makeDistillCallbacks,
    rowIdRef,
    writeRawMemoryForStream,
    serverCtx,
    // 无头链路与 WS 主路径**同源**的内部会话解析（v11 双层会话 / 逆生树）：
    // 房间规划与外部消息接入由此获得与普通会话一致的「路由 → 锚点 → 摘要」上下文，
    // 而不是裸线性历史。同一函数、同一口径，避免两套逆生树规则漂移。
    resolveSessionContext: async (sessionId, messages) => {
      const r = await resolveStreamSessionContext({
        opts: undefined,
        sessionId,
        messages,
        activeInternalContext: null
      })
      return r.sessionContext
    }
  })

  // 暴露给局域网协作层（聊天室 AI 自动回复复用完整月蚀链路）
  serviceRefs.headlessChatRunnerRef = runHeadlessChat

  // WS 协议层（F-7 拆分）：连接生命周期与消息路由收拢为 ws-protocol 模块。
  // 连接级状态（streamId/重试常量/continuationTimerRef）与 createStreamRunner 装配依赖
  // 统一经 createWsProtocol per-连接 实例化；server.ts 仅在此装配依赖并挂接回调。
  const attachConnection = createWsProtocol({
    activeStreams,
    safeWsSend,
    broadcastStreamStatus,
    hookManager,
    missionStoreRef: serviceRefs.missionStoreRef,
    asyncDelegationRef: serviceRefs.asyncDelegationRef,
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
  // 为什么拆：HTTP 端点注册、消息接入、配置热同步、端口监听与 WS 协议
  // 生命周期不同，属于「装配」职责；收敛到 installServerAssembly 后，startApiServer
  // 只做编排（创建基础设施 → 装配 → 返回端口），协议层与装配层可独立演进与修复。
  // 跨模块共享状态经 deps 注入：ref 容器（subAgentManagerRef）与 setter 回调回写
  // （messagingService / unsubscribeConfig，避免 server-assembly import server.ts 循环依赖）。
  return installServerAssembly({
    app,
    server,
    configStore,
    sessionStore,
    streamSession,
    runHeadlessChat,
    llmClientRef,
    makeLlmClient,
    makeToolRegistry,
    pluginLoader,
    toolExecutorsRef,
    buildSubAgentExecuteFn,
    subAgentManagerRef,
    mcpClientManager,
    ctx,
    serverCtx,
    masterRouter,
    preferredPort,
    setMessagingService: (m) => {
      serviceRefs.messagingService = m
    },
    setUnsubscribeConfig: (fn) => {
      serviceRefs.unsubscribeConfig = fn
    }
  })
}

/**
 * 关闭 API server：释放 HTTP 端口 + WebSocket 连接
 * 在 app before-quit 时调用，避免端口/句柄泄漏
 *
 * 释放链单点：13 个进程级引用的释放全在 `releaseServiceRefs()`（service-refs.ts），
 * 本函数只负责「单次调用 + 兜底日志」——不得在此就地展开释放（否则创建与释放重新分裂）。
 */
export function closeApiServer(): void {
  try {
    releaseServiceRefs()
  } catch (err) {
    console.error('[server] closeApiServer error:', err)
  }
}

