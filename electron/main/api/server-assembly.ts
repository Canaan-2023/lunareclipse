/**
 * @category 核心
 * @summary 服务装配层（F-7 拆分）：HTTP 端点 / 莉莉丝面板桥 / 消息接入 / 配置热同步 / 端口监听

 * 为什么这个模块存在、不删的理由：
 * server.ts 原本把「WS 连接协议」与「HTTP 服务装配」混在同一函数体内（startApiServer 后半段），
 * 两件事生命周期不同、变更频率不同：协议层随 WS 消息演化，装配层随端点/订阅/端口策略演化。
 * 拆出后 startApiServer 只做编排（创建 app/server/依赖 → 装配 → 返回端口），
 * 装配段的增量端点、订阅项、端口回退策略的修改不再触碰协议层代码，回归面收窄。
 * 若删除本模块，等价于把这些职责并回 server.ts——startApiServer 将重新膨胀为超长函数，
 * 且挂载点/订阅/端口策略与连接协议重新耦合，违背本次拆分的分层目标。
 *
 * 本模块不 import server.ts（避免循环依赖）：所有跨模块共享状态通过
 * deps 注入（ref 容器）或 setter 回调回写（setMessagingService / setUnsubscribeConfig）。
 *
 * 未来功能增减规划（扩展边界）：
 * - 新增 HTTP 端点：在本模块 app.* 注册处追加即可，协议层无感知；
 * - 新增外部消息平台：扩展 MessagingService 接入（其路由已支持联系人固定/白名单/串行队列）；
 * - 端口策略调整（固定/动态/局域网绑定）：只改本模块尾部 listen 段；
 * - 配置热同步项：在 setUnsubscribeConfig 的订阅回调中追加 diff 分支。
 */
import type { Express, Router } from 'express'
import type { Server } from 'http'
import type { ConfigStore } from './config-store'
import type { SessionStore } from './session-store'
import type { UserStore } from '../models/user-store'
import type { LLMClient, ToolExecutor } from './llm'
import type { Context } from '../kernel/cordis-runtime'
import type { ToolContext } from '../tools/base-tool'
import type { ToolRegistry, ToolRegistryOptions } from '../tools'
import { SubAgentManager } from '../sub-agent'
import type { SubAgentExecuteFn } from '../sub-agent'
import type { StreamSession } from './stream-session'
import type { PluginLoader } from '../plugins'
import type { McpClientManager } from '../mcp/client-manager'
import type { AppConfig, LLMConfig } from '@shared/types'
import type { BaseDataPaths } from '../models/paths'
import type { RawMemoryWriter } from '../services/raw-memory-writer'
import type { LightChat } from '../services/session-utils'
import type { GeoLocationService } from '../services/geo-location'
import { MessagingService } from '../messaging'
import { registerLilithEndpoints } from './lilith-endpoints'
import { toToolExecutor } from './tool-bridge'

/** installServerAssembly 依赖注入接口（服务装配层与主服务共享的运行时句柄） */
export interface ServerAssemblyDeps {
  app: Express
  server: Server | null
  configStore: ConfigStore
  sessionStore: SessionStore
  userStore: UserStore
  toolCtx: ToolContext
  dataPaths: BaseDataPaths
  geoService: GeoLocationService | null
  streamSession: StreamSession
  runHeadlessChat: (text: string, sessionId: string, aiId?: number) => Promise<string>
  llmClientRef: { current: LLMClient }
  makeLlmClient: (cfg: LLMConfig) => LLMClient
  makeToolRegistry: (c?: ToolContext, o?: ToolRegistryOptions) => ToolRegistry
  pluginLoader?: PluginLoader
  rawMemoryWriter: RawMemoryWriter | null
  internalLlmChat: LightChat
  systemInjectedSessionId: string
  toolExecutorsRef: { current: ToolExecutor[] }
  buildSubAgentExecuteFn: (getLlmClient: () => LLMClient) => SubAgentExecuteFn<ToolExecutor>
  /** SubAgentManager 共享引用：配置热同步重建后，主服务 launchSubAgent 闭包须读到新实例 */
  subAgentManagerRef: { current: SubAgentManager<ToolExecutor> | null }
  mcpClientManager?: McpClientManager
  ctx?: Context
  serverCtx: ToolContext
  masterRouter?: Router
  preferredPort?: number
  /** 回写模块级 messagingService（IPC getMessagingService 读取同一实例） */
  setMessagingService: (m: MessagingService | null) => void
  /** 回写模块级 unsubscribeConfig（closeApiServer 时调用解绑订阅） */
  setUnsubscribeConfig: (fn: (() => void) | null) => void
}

/** 执行服务装配；返回实际监听端口（监听失败/未创建 server 时为 0） */
export async function installServerAssembly(deps: ServerAssemblyDeps): Promise<number> {
  const {
    app, server, configStore, sessionStore, userStore, toolCtx, dataPaths, geoService,
    streamSession, runHeadlessChat, llmClientRef, makeLlmClient, makeToolRegistry,
    pluginLoader, rawMemoryWriter, internalLlmChat, systemInjectedSessionId,
    toolExecutorsRef, buildSubAgentExecuteFn, subAgentManagerRef, mcpClientManager,
    ctx, serverCtx, masterRouter, preferredPort, setMessagingService, setUnsubscribeConfig
  } = deps

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  // 运行中流状态查询——前端重载/断线重连后拉取真实状态（不是磁盘旧快照）
  // 判断后端是否仍有流在跑、属于哪个会话哪条消息。前端据此终止残留流或确认无事。
  app.get('/api/streams/active', (_req, res) => {
    const streamSnap = streamSession.current()
    res.json(streamSnap ? { active: true, ...streamSnap } : { active: false })
  })

  // ===== 莉莉丝会话面板（companion 代理）=====
  // LilithPanel 前端 → 月蚀后端 → 转发 companion API（读 runtime.json 拿 port+token，绕 CORS + 注入认证）
  // 注意：LilithPanel 轮询的 history 是 companion 自己的游戏内会话（MOD 侧记录）；
  // 而 companion 的 fetchLunarSharedHistory 拉的是月蚀 lilith_chat 会话（月蚀记忆侧）。
  // 两者语义不同，不能互相转发（避免循环）。
  // 莉莉丝共享会话 ID：companion fetchLunarSharedHistory 通过 {base_url}/api/lilith/history
  // 拉取"莉莉丝的月蚀会话历史"（唯一上下文），与 MOD 桥接 /chat/completions 写入的会话一致。
  // 实现已拆分至 lilith-endpoints.ts（registerLilithEndpoints），此处仅注册并取回 generateLilithReply
  // 供消息接入（MessagingService.onLilithChat）复用；llmClientRef.current 懒重建/读取经 llmRef 回传。
  const { generateLilithReply } = registerLilithEndpoints({
    app,
    configStore,
    userStore,
    toolCtx,
    dataPaths,
    geoService,
    runHeadlessChat,
    llmRef: {
      get: () => llmClientRef.current,
      set: (client) => {
        llmClientRef.current = client
      }
    },
    makeLlmClient,
    makeToolRegistry,
    pluginLoader,
    rawMemoryWriter,
    internalLlmChat,
    systemInjectedSessionId
  })


  // ===== 消息接入：外部消息平台（飞书等）→ 月蚀大脑 =====
  // 飞书长连接适配器 + 路由（联系人固定：月蚀 or 莉莉丝）+ 白名单 + 串行队列。
  // 对话入口复用现有链路：月蚀 = runHeadlessChat（完整工具循环，可指挥干活），莉莉丝 = generateLilithReply（角色对话）。
  const ms = new MessagingService({
    configStore,
    sessionStore,
    onXiChat: (text, sessionId) => runHeadlessChat(text, sessionId),
    onLilithChat: (text, playerName) => generateLilithReply(text, playerName).then((r) => r.text),
    isLlmBusy: () => llmClientRef.current.isStreaming(),
    getPlayerName: () => userStore.getCurrentUser()?.用户名 ?? 'Player'
  })
  // 回写模块级引用：IPC getMessagingService 与 closeApiServer 生命周期共享同一实例。
  setMessagingService(ms)
  // 启动时按配置同步一次（enabled + 凭证齐全才启动长连接）
  ms.sync()
  // 配置变化热同步：设置页保存后立即生效（启停/换凭证/白名单/联系人映射都不用重启）。
  // 订阅解绑函数须与下方 unsubscribeConfig 一并纳入组合解绑，否则 closeApiServer 后
  // 配置变更仍会触发 ms.sync()，对已关闭的服务产生悬空调用（P6 订阅泄漏修复）。
  const unsubscribeMsSync = configStore.subscribe(() => ms?.sync())


  app.post('/api/llm/test', async (req, res) => {
    const config = req.body
    try {
      const testClient = makeLlmClient(config)
      if (!testClient.isReady()) {
        return res.status(400).json({ ok: false, error: 'API Key 未填写' })
      }
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message })
    }
  })

  // 订阅配置变更：
  // 1) LLM 配置变化 → 重建 LLMClient（避免 stream 跑在旧实例、abort 打到新实例失效）
  // 2) frontendToolPolicy 变化 → 重建 toolExecutorsRef.current（修复前端工具开关不生效的 Bug）
  // 之前只在 llm 变化时重建 LLMClient，工具开关变化被直接 return，导致用户切换
  // "直接注入所有工具"后仍只能调旧工具，需重启才生效。
  // 为何存局部再回写：订阅解绑函数须能让 closeApiServer（server.ts 模块级）在退出时调用；
  // 先赋给局部变量再经 setter 回写，避免跨模块共享闭包变量，语义与旧版模块级 assign 等价。
  // 重建前端工具执行器 + 子 agent 工具快照（配置策略变更 / 插件工具变化共用同一逻辑）。
  // 为什么抽函数：两处触发都要重建且内容必须一致——重复书写会漂移（历史上就漏传过 pluginTools）。
  const rebuildToolExecutors = (cfg: AppConfig): void => {
    const toolRegistry = makeToolRegistry(serverCtx, {
      toolsPolicy: cfg.frontendToolPolicy.tools,
      mcpClientManager,
      // 插件工具运行时动态加载，重建时必须重新取：否则新装插件的工具不注入
      pluginTools: pluginLoader?.getTools() ?? [],
      greenlightEnabled: cfg.permissionGreenlight === true,
      config: cfg
    })
    toolExecutorsRef.current = Array.from(toolRegistry.tools.values()).map((t) =>
      toToolExecutor(t, toolRegistry)
    )
    // 重建 SubAgentManager（更新工具快照；executeFn getter 仍读 let llmClientRef.current，LLM 变更时自动生效）
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
          { maxConcurrent: 'auto', maxSpawnDepth: 1 }
        )
  }

  const unsubscribeConfig = configStore.subscribe((newConfig, oldConfig) => {
    const llmChanged = JSON.stringify(newConfig.llm) !== JSON.stringify(oldConfig.llm)
    const toolPolicyChanged =
      JSON.stringify(newConfig.frontendToolPolicy) !==
        JSON.stringify(oldConfig.frontendToolPolicy) ||
      // 绿通开关切换 → 系统调用工具启用集变化（run_command/app_restart 等），需要重建工具集
      oldConfig.permissionGreenlight !== newConfig.permissionGreenlight ||
      // 联网开关切换 → web_search 可见性变化（visible 条件），需要重建工具集
      oldConfig.webSearchEnabled !== newConfig.webSearchEnabled ||
      // AI 模式切换 → team_* 工具 visible 条件变化（aiMode==='task' 才可见）
      // 缺此项导致切到任务模式后执行器仍无团队工具，Lead 提示词在但工具调不动（用户反馈"不好用"第二根因）
      oldConfig.aiMode !== newConfig.aiMode ||
      // 生成模态开关切换 → image_gen/video_gen/audio_gen 可见性变化（visible 条件）
      JSON.stringify(oldConfig.imageGen) !== JSON.stringify(newConfig.imageGen) ||
      JSON.stringify(oldConfig.generation) !== JSON.stringify(newConfig.generation)
    if (llmChanged) {
      llmClientRef.current = makeLlmClient(newConfig.llm)
      console.log('[server] LLMClient 已重建（LLM 配置变更）')
    }
    if (toolPolicyChanged) {
      rebuildToolExecutors(newConfig)
      console.log('[server] toolExecutorsRef.current 与 SubAgentManager 已重建（工具策略变更）')
    }
  })
  // 插件工具变化（install/启停/热重载/卸载）→ 重建工具集：使新装插件的工具立即注入前端会话，无需重启。
  // 此前只有配置变更触发重建，插件装好后工具永不注入（plugin_manage 文档称"热重载生效"，
  // 但前端工具执行器不重建即名不符实——本次修复该缺口；插件 reload 已有 500ms 防抖，重建不会风暴）。
  const unsubscribePlugins = pluginLoader
    ? pluginLoader.onChanged(() => {
        rebuildToolExecutors(configStore.getEffective())
        console.log('[server] toolExecutorsRef.current 与 SubAgentManager 已重建（插件工具变化）')
      })
    : null
  // 组合解绑：LLM/工具重建订阅 + 插件变化订阅 + 消息服务热同步订阅一起释放（closeApiServer 统一调用）。
  setUnsubscribeConfig(() => {
    unsubscribeConfig()
    unsubscribePlugins?.()
    unsubscribeMsSync()
  })

  const port = await new Promise<number>((resolve) => {
    if (!server) {
      resolve(0)
      return
    }
    // 莉莉丝桥接稳定性：优先用固定端口（config.lilith.apiPort），避免动态端口导致
    // companion 配置漂移（游戏已启动时 companion 缓存的 base_url 指向旧端口）。
    // 固定端口被占用时回退动态端口（多实例/端口冲突场景）。
    const srv = server // 局部引用：回调内 server 可能被 TS 视为 null（闭包可变），srv 不可变安全
    const cfgNow = configStore.get()
    const fixedPort = cfgNow.lilith?.apiPort ?? preferredPort ?? 62002
    const onListen = (actualPort: number) => {
      const addr = srv.address()
      resolve(typeof addr === 'object' && addr ? addr.port : actualPort)
    }
    srv.once('error', () => {
      // 固定端口被占用：回退动态端口（仅监听失败时）
      try {
        srv.close()
      } catch {
        /* ignore */
      }
      srv.listen(0, masterRouter ? '0.0.0.0' : '127.0.0.1', () => {
        const addr = srv.address()
        resolve(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })
    // 主系统（master）须监听 0.0.0.0 供局域网内分系统接入；单机保持仅本机
    srv.listen(fixedPort, masterRouter ? '0.0.0.0' : '127.0.0.1', () => onListen(fixedPort))
  })

  return port
}
