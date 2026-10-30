/**
 * @category 核心
 * @summary 后端服务的进程级引用容器（引用单 owner）+ 只读 getter + 统一释放链
 *
 * 为什么存在：`startApiServer` 是单一大闭包，进程级引用（HTTP/WS server、配置订阅解绑、
 * 加载器与调度器实例、API 令牌、无头对话运行器等）此前以裸模块级 `let` 散落在 `server.ts` 顶部，
 * `closeApiServer` 再逐个人工释放——创建清单与释放清单靠人工对齐，漏一个即端口/句柄/订阅泄漏。
 * 本模块把这些引用收进单一容器：读写在 `serviceRefs` 上完成，释放收敛为一次
 * `releaseServiceRefs()`，创建与释放不再跨千行手工对齐。
 *
 * 什么作用：导出 `serviceRefs`（唯一可变状态）、只读 getter（`getApiToken` /
 * `getMessagingService` / `getHeadlessChatRunner` / `getGeoEnvText` / `getRestrictTools` 等）与
 * `releaseServiceRefs()`，以及常量 `SYSTEM_INJECTED_SESSION_ID`。宿主 `server.ts` 以 re-export 保持对外导入路径不变。
 *
 * 不删理由：容器是「引用生命周期」的唯一 owner。删掉它，释放链重新散落回宿主，
 * 「新增引用忘记登记释放」的缺陷模式会复发（收编前已实际出现于配置订阅泄漏）。
 *
 * 类型零运行时依赖：本模块只 `import type`，不引入任何运行时模块——被 `server.ts` 导入时
 * 不产生新的模块初始化环。
 */
import type { Server } from 'http'
import type { WebSocketServer } from 'ws'
import type { SkillLoader } from '../skills/loader'
import type { HookManager } from '../hooks'
import type { CronScheduler } from '../cron/scheduler'
import type { MessagingService } from '../messaging'
import type { AsyncDelegationManager } from '../tools/sub-agent-engine/async-delegation'
import type { MissionStore } from '../tools/sub-agent-engine/mission-store'
import type { StreamSession } from './stream-session'
import type { HeadlessChatRunner } from './run-headless-chat'
import type { ToolExecutor } from './llm-types'

/**
 * 无头对话运行器签名——**真源在 `./run-headless-chat`**（实现处），此处只再导出。
 * 为什么收敛：本文件曾自行重复声明一次；改签名时两处不同步会让调用方看到过期形参
 * （实测：加 `purpose` 后本文件没跟上 → `bootstrap/room-runtime.ts` 报 TS2554「Expected 2-3 arguments, but got 4」）。
 */
export type { HeadlessChatRunner }

/**
 * 进程级引用容器：13 个字段与拆分前的模块级 `let` 一一对应（字段名保持原名，便于逐符号核对迁移）。
 * 可空语义 = 拆分前同名变量：`null` 表示「尚未创建」或「已释放」。
 */
export interface ServiceRefs {
  /** HTTP server（`http.createServer(app)`；未启动为 null） */
  server: Server | null
  /** WebSocket server（挂 `WS_PATH`；未启动为 null） */
  wss: WebSocketServer | null
  /** 配置热同步解绑函数（`configStore.subscribe` 返回值的聚合） */
  unsubscribeConfig: (() => void) | null
  /** Skills 加载器（释放时停止文件监听） */
  skillLoaderRef: SkillLoader | null
  /** Hook 管理器 + 其配置监听解绑函数 + Cordis 事件桥卸载函数（未挂桥时缺省） */
  hookManagerRef: {
    hookManager: HookManager
    unwatchHooks: () => void
    /** Cordis 事件桥（观察桥）的 detach：恢复 `hookManager.run` 原实现 */
    detachEventBridge?: () => void
  } | null
  /** Cron 调度器（释放时停止 tick） */
  cronSchedulerRef: CronScheduler | null
  /** 消息接入服务（飞书等外部平台 → 月蚀大脑）；IPC 经 `getMessagingService` 读取同一实例 */
  messagingService: MessagingService | null
  /** 本机 API 访问令牌（语义见下方「令牌」注释） */
  apiTokenSecret: string
  /** 异步委托管理器（子 agent 后台跑、父对话不阻塞；释放时 dispose） */
  asyncDelegationRef: AsyncDelegationManager | null
  /** 长期目标（Mission）持久化层 + 失败重试编排 */
  missionStoreRef: MissionStore | null
  /** 流会话状态机（释放时 dispose 宽限计时器） */
  streamSessionRef: StreamSession | null
  /** 无头对话运行器（`startApiServer` 内定义后写入；释放时清空） */
  headlessChatRunnerRef: HeadlessChatRunner | null
  /**
   * **用途专属工具执行器**提供者（`purpose` → 追加到前端工具集之后的执行器）。
   * 为什么走本容器而不直连：按 §3.4「跨域装配只许在 `bootstrap/`」——`api/server.ts` 不得
   * import 房间域模块，故由组合根写入、`server.ts` 只读。
   */
  extraToolExecutorsRef: ((purpose: string | undefined, aiId?: number) => ToolExecutor[]) | null
  /**
   * **用途收窄**名单提供者（前置规划功能）：返回非 null 名单 = 本轮工具集按名收窄到名单内
   * （名单外工具物理不可见）；null = 不收窄。与 `extraToolExecutorsRef` 方向相反（一个加一个减），
   * 同走本容器的原因相同（§3.4：跨域装配只许在 `bootstrap/`，收窄名单的真源在房间域）。
   */
  restrictToolsRef: ((purpose: string | undefined, aiId?: number) => readonly string[] | null) | null
  /** 当前环境注入文本 getter（地理位置/天气等；释放时清空） */
  geoEnvTextRef: (() => string) | null
}

/** 容器单例：13 个进程级引用的唯一可变状态。 */
export const serviceRefs: ServiceRefs = {
  server: null,
  wss: null,
  unsubscribeConfig: null,
  skillLoaderRef: null,
  hookManagerRef: null,
  cronSchedulerRef: null,
  messagingService: null,
  apiTokenSecret: '',
  asyncDelegationRef: null,
  missionStoreRef: null,
  streamSessionRef: null,
  headlessChatRunnerRef: null,
  extraToolExecutorsRef: null,
  restrictToolsRef: null,
  geoEnvTextRef: null
}

/**
 * 本机 API 访问令牌。
 * 为什么存在：API server 监听本地端口且 WS/HTTP 均无登录态；本地任意网页（浏览器跨域
 * fetch/WS 天然可打到 127.0.0.1）曾能无条件驱动完整 LLM 对话、读写任意 sessionId 并继承其
 * 工具权限——这是「本地服务零鉴权」的真实攻击面（评审 CRITICAL）。WS 不受同源策略限制，
 * CORS 拦不住它，因此必须在传输层增加只有主进程与渲染进程（经 IPC）共享的令牌。
 * 作用：WS 握手与受保护 HTTP API 的凭据；每次启动随机生成，进程外无法预知。
 */

/** 获取本机 API 访问令牌（IPC api:token 挂载点；尚未启动 API server 时返回空串） */
export function getApiToken(): string {
  return serviceRefs.apiTokenSecret
}

/** 获取消息接入服务实例（IPC handler 用；未初始化时返回 null） */
export function getMessagingService(): MessagingService | null {
  return serviceRefs.messagingService
}

/**
 * 获取无头对话运行器（未启动 API server 时返回 null）。
 * aiId 缺省 1（月蚀）：聊天室/私聊/系统注入等月蚀主导线路不传；AI 社交/公示板按参与者 aiId 传。
 */
export function getHeadlessChatRunner(): HeadlessChatRunner | null {
  return serviceRefs.headlessChatRunnerRef
}

/** 获取当前环境注入文本（未初始化或暂不可用时返回空串，调用方按缺省处理） */
export function getGeoEnvText(): string {
  return serviceRefs.geoEnvTextRef ? serviceRefs.geoEnvTextRef() : ''
}

/**
 * 取某用途专属的工具执行器（无头链路 `extraToolExecutors` 的读取点）。
 * 未登记 / 该用途无专属工具 → 空数组（= 只用前端工具集，与引入前逐字一致）。
 */
export function getExtraToolExecutors(purpose: string | undefined, aiId?: number): ToolExecutor[] {
  return serviceRefs.extraToolExecutorsRef?.(purpose, aiId) ?? []
}

/**
 * 取某用途的工具**收窄**名单（无头链路 `restrictTools` 的读取点）。
 * 未登记 / 该用途无收窄 → null（= 工具面与引入前逐字一致）。
 */
export function getRestrictTools(purpose: string | undefined, aiId?: number): readonly string[] | null {
  return serviceRefs.restrictToolsRef?.(purpose, aiId) ?? null
}

/**
 * 系统注入消息转发月蚀时的专用会话 ID：健康检查/激活事件等不占用用户会话，
 * 固定在月蚀侧会话持久化，多轮系统事件可追溯，回复原路返回调用方（不被吞）。
 */
export const SYSTEM_INJECTED_SESSION_ID = 'system_injected_events'

/**
 * 释放全部进程级引用：停止监听/订阅/调度，关闭 WS 与 HTTP server。
 *
 * 何时用：`closeApiServer` 在 app before-quit 时**单次调用**本函数——释放链不得分裂，
 * 任何新增引用都必须登记在此处（创建与释放同文件对齐）。
 * 释放顺序沿用拆分前 `closeApiServer` 的逐条顺序（先解绑订阅与监听，再关连接与端口）。
 */
export function releaseServiceRefs(): void {
  // 可观测性（复审轮 SRE R1）：释放链此前**完全静默**——释放失败只在下一次启动以
  // EADDRINUSE / 订阅残留显形，退出路径不留任何日志。此处先记「退出时持有的引用」，
  // 释放完成后再打一行清单：二者对照即可判断释放链是否走完。
  // 按设计不释放的 2 项（messagingService / apiTokenSecret）不进清单——它们由进程退出回收。
  const held: Array<[string, unknown]> = [
    ['unsubscribeConfig', serviceRefs.unsubscribeConfig],
    ['skillLoaderRef', serviceRefs.skillLoaderRef],
    ['hookManagerRef', serviceRefs.hookManagerRef],
    ['cronSchedulerRef', serviceRefs.cronSchedulerRef],
    ['asyncDelegationRef', serviceRefs.asyncDelegationRef],
    ['missionStoreRef', serviceRefs.missionStoreRef],
    ['streamSessionRef', serviceRefs.streamSessionRef],
    ['headlessChatRunnerRef', serviceRefs.headlessChatRunnerRef],
    ['extraToolExecutorsRef', serviceRefs.extraToolExecutorsRef],
    ['restrictToolsRef', serviceRefs.restrictToolsRef],
    ['geoEnvTextRef', serviceRefs.geoEnvTextRef],
    ['wss', serviceRefs.wss],
    ['server', serviceRefs.server]
  ]
  serviceRefs.headlessChatRunnerRef = null
  serviceRefs.extraToolExecutorsRef = null
  serviceRefs.restrictToolsRef = null
  serviceRefs.geoEnvTextRef = null
  if (serviceRefs.unsubscribeConfig) {
    serviceRefs.unsubscribeConfig()
    serviceRefs.unsubscribeConfig = null
  }
  // 停止 skills 文件监听，释放资源
  if (serviceRefs.skillLoaderRef) {
    serviceRefs.skillLoaderRef.stopWatching()
    serviceRefs.skillLoaderRef = null
  }
  // 停止 hooks 配置监听，释放资源
  // 顺序：先卸载 Cordis 事件桥（挂载晚于 HookManager 创建，按挂载逆序卸载），再解绑配置监听
  if (serviceRefs.hookManagerRef) {
    serviceRefs.hookManagerRef.detachEventBridge?.()
    serviceRefs.hookManagerRef.unwatchHooks()
    serviceRefs.hookManagerRef = null
  }
  // 停止 Cron 调度器 tick
  if (serviceRefs.cronSchedulerRef) {
    serviceRefs.cronSchedulerRef.stop()
    serviceRefs.cronSchedulerRef = null
  }
  if (serviceRefs.asyncDelegationRef) {
    try {
      serviceRefs.asyncDelegationRef.dispose()
    } catch (err) {
      console.error('[server] asyncDelegation dispose error:', err)
    }
    serviceRefs.asyncDelegationRef = null
  }
  if (serviceRefs.missionStoreRef) {
    serviceRefs.missionStoreRef = null
  }
  // 清流状态机宽限计时器（进程退出，不触发 onOrphan abort）
  serviceRefs.streamSessionRef?.dispose()
  serviceRefs.streamSessionRef = null
  // 关闭所有 WebSocket 连接
  serviceRefs.wss?.clients.forEach((ws) => {
    try {
      ws.close()
    } catch {
      /* 忽略 */
    }
  })
  // 关闭 WebSocket server
  try {
    serviceRefs.wss?.close()
  } catch {
    /* 忽略 */
  }
  // 关闭 HTTP server（不再接受新连接，已建立连接优雅关闭）
  serviceRefs.server?.close(() => {
    // 关闭完成
  })
  const releasedNames = held.filter(([, v]) => v !== null && v !== undefined).map(([n]) => n)
  console.info(
    `[server] closeApiServer 释放引用：${releasedNames.length ? releasedNames.join(' / ') : '（无持有引用）'}`
  )
}
