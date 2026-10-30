/**
 * 工具基座：为什么存在——几十个内置工具必须共享同一套入参解析/结果/上下文的约定，
 * 否则各写各的会导致行为漂移与安全漏洞。
 * 作用：定义 Tool / ToolResult / ToolContext 等公共类型、resolveToolPath 路径策略与
 * 子 agent 任务定义，是所有工具与执行链的契约层。
 */
import type { DataPaths } from '../models/paths'
import type { MemoryUser } from '../models/memory'
import type { SkillLoader } from '../skills/loader'
import type { HookManager } from '../hooks/hook-manager'
import type { WorkflowManager } from '../workflow/manager'
import { resolve } from 'path'

/**
 * 解析工具入参路径：优先使用上下文注入的 resolvePath，未注入时退化为 path.resolve。

 * 抽取原因：该 fallback 此前在 12 个文件工具里各自逐字重复（三种写法：三元式、
 * ?? 默认值式、以及 memory 工具漏掉 resolve 的变体）。任何路径策略调整
 * 都必须逐一改 12 处，极易漏改导致工具之间行为不一致。
 */
export function resolveToolPath(input: string, ctx?: ToolContext): string {
  return ctx?.resolvePath ? ctx.resolvePath(input) : resolve(input)
}

export interface ToolResult {
  ok: boolean
  data?: unknown
  error?: string
}

export interface FreezeManager {
  freeze(taskId: string, question: string, context: string | undefined, sessionId: string | null): Promise<string>
  unfreeze(taskId: string, answer: string | null): void
  isFrozen(taskId: string): boolean
  getFrozenAt(taskId: string): number | null
}

export interface SupervisorContext {
  freeze_manager: FreezeManager
}

/** 子 agent 任务定义 */
export interface SubAgentTask {
  prompt: string
  /** 工具白名单（只允许使用的工具名，不填则继承全部启用工具） */
  tools?: string[]
  /** 工具黑名单（从继承列表中移除的工具名） */
  disallowedTools?: string[]
  /** 最大轮次（2026-10-02 起默认不限制，由 timeoutMs 兜底） */
  maxTurns?: number
  /** 超时毫秒（默认 120000 = 2 分钟） */
  timeoutMs?: number
  /** 团队上下文（任务模式：注入子 agent 的成员身份，team_* 工具据此识别"我是谁"） */
  teamContext?: { teamId: string; memberId: string }
}

export interface ToolContext {
  handleAccessed?: (path: string) => void
  resolvePath?: (input: string) => string
  paths?: DataPaths
  user?: MemoryUser
  taskId?: string
  sessionId?: string | null
  supervisor?: SupervisorContext
  appDataDir?: string
  /** 系统级电脑操控引擎（computer-use 插件经此访问：截屏/鼠标/键盘/Win32） */
  getSystemInput?: () => import('../api/system-input').SystemInput
  /** 派发子 agent：tasks 为任务数组，mode 为 serial（顺序，前一个输出作为后一个上下文）或 parallel（并行） */
  launchSubAgent?: (tasks: SubAgentTask[], mode: 'serial' | 'parallel') => Promise<string[]>
  /** 应用配置（前端 AI 用：联网开关、自定义搜索端点等） */
  config?: Record<string, unknown>
  /** 请求用户授权（前端 AI 用：灰名单命令、系统设置等需用户确认的操作） */
  requestPermission?: (req: PermissionRequest) => Promise<PermissionResponse>
  /**
   * 子 agent 审批裁决器（自动化通道用：async delegation / workflow / batch 无用户交互时，
   * run_command 等工具经此按策略裁决灰名单命令；ask 无父级 → fail-closed 拒绝，与用户
   * 授权主链路语义一致）。主对话前端路径有 requestPermission，不看此裁决器。
   */
  getSubAgentApproval?: () => import('./sub-agent-engine/engine').ApprovalManager | null
  /**
   * AI 自我重启应用（权限绿通模式专用）：
   * 绿通开启时直接重启（app.relaunch + quit，新进程保留绿通）；
   * 绿通关闭时先请求用户授权，用户允许才重启。
   * 用户完全关闭应用（非 AI 重启）后，下次启动绿通自动重置为 false（防死循环保底）。
   */
  requestAppRestart?: (reason: string) => Promise<ToolResult>
  /** 更新应用配置并持久化（前端 AI 用：update_abyss_md/update_ai_name 等工具修改 config） */
  updateConfig?: (updater: (config: Record<string, unknown>) => Record<string, unknown>) => void
/** Skills 加载器（前端 AI 用：use_skill 工具访问） */
  skillLoader?: SkillLoader
  /** 控制层：Hook 管理器（PreToolUse/PostToolUse 等确定性钩子） */
  hookManager?: HookManager
  /** 插件加载器 getter（plugin_manage 工具访问） */
  getPluginLoader?: () => import('../plugins/loader').PluginLoader | null
  getModuleRegistry?: () => import('../monitor/module-registry').ModuleRegistry | null
  /** 定时任务调度器 getter（cron_manage 工具访问） */
  getCronScheduler?: () => import('../cron/scheduler').CronScheduler | null
  /**
   * 内部会话存储 getter（内部会话管理工具 internal_session 访问）。
   * 为什么存在：内部会话（sessions/{会话}/ai/ 下的 NNG 逆生树）的唯一安全写入口是
   * 主进程唯一的 InternalSessionStore 实例——它持有 pathIndex（NNG 路径推导）与
   * writeChains（写链串行化），确保与两写/摘要维护队列不并发覆盖同一文件。
   * 工具若自行裸读写 JSON 会绕过该实例，产生竞态与结构不一致，故经此 getter 复用同一实例。
   */
  getInternalSessionStore?: () => import('../services/internal-session-store').InternalSessionStore | null
  /**
   * 局域网多实例服务 getter（friend_manage / chat_room_manage / publish_board_manage 工具访问）。
   * 三个工具据此读写好友簿/聊天室/公示板，实现不同月蚀实例之间的相互交流。
   */
  getMultiInstance?: () => import('../multi-instance').MultiInstanceService | null
  /** 浏览器视图管理器 getter（浏览器工具模块化后，插件 tools.js 经此访问浏览器面板单例） */
  getBrowserViewManager?: () => typeof import('./browser-view-manager').browserViewManager | null
  /**
   * 设备管理器 getter（ 设备接入基底：device_scan / device_register / device_call 工具访问）。
   * 为什么用 getter：DeviceManager 由 index.ts 装配并注入 dataDir 后才有持久化能力，
   * 工具侧只在调用时按需获取，避免初始化时序依赖。
   */
  getDeviceManager?: () => import('../device/types').DeviceManager | null
  /**
   * MCP 客户端管理器 getter（list_mcp_resources / read_mcp_resource 工具访问）。
   * 为什么用 getter：McpClientManager 由宿主装配，工具侧只在调用时按需获取；
   * 未注入的环境（记忆工作流等无 MCP 管理器的上下文）调用资源工具会得到明确报错（fail-closed）。
   */
  getMcpClientManager?: () => import('../mcp/client-manager').McpClientManager | null
  /** 无头浏览器管理器 getter（headless-browser 插件经此访问 Playwright headless 单例：无头看页面+操作） */
  getBrowserManager?: () => typeof import('./browser-manager').browserManager | null
  /** 任务模式（Agent Teams）：TeamManager（team_* 工具访问） */
  teamManager?: import('../services/team-manager').TeamManager
  /**
   * L8 工作流引擎：WorkflowManager getter（按需获取，避免初始化时序依赖）
   * workflow_* 系列工具通过此 getter 访问 WorkflowManager
   */
  getWorkflowManager?: () => WorkflowManager | null
  /**
   * 上下文用量快照（context_usage 工具用）：返回当前会话的 token 估算/预算/消息数/摘要状态。
   * 由 server.ts 注入（能访问 sessionStore + token 估算），工具无感知实现细节。
   */
getContextUsage?: () => ContextUsageSnapshot | null
/**
   * 解析会话所属 AI 编号（多 AI P4：create_ai 等工具据此做 parentAiId 溯源/防递归守卫）。
   * 由 server.ts 注入 resolveSessionAiId：会话 aiId 合法正整数 → 用之；缺省/非法/旧会话 → 回退 1（月蚀）。
   */
  getSessionAiId?: (sessionId?: string) => number
  /** 中止信号（工具超时时由执行器注入；工具应监听 abort 终止自身工作，如 run_command 终止子进程树） */
  signal?: AbortSignal
  /**
   * 批量执行器（batch_tools 专用）：按工具名执行一个子工具，返回其 ToolResult。
   * 为什么由宿主注入而不是 batch_tools 直接拿工具注册表：子工具必须与主链路同一条执行链
   * （toToolExecutor 包装的 executeTool = 能力闸 + Pre/PostToolUse Hook + 脱敏），
   * 宿主持有"当前生效"的执行器集合（toolExecutorsRef 随配置热更新重建），
   * 闭包读 current 即永远遵守最新 policy——batch 内不可能绕过用户刚关闭的工具开关。
   * 未注入的环境（记忆工作流等无此执行器集合的场景）调用 batch_tools 会得到明确报错。
   */
  executeSubTool?: (name: string, params: Record<string, unknown>) => Promise<ToolResult>
}

/** context_usage 工具返回的上下文用量快照 */
export interface ContextUsageSnapshot {
  sessionId: string | null
  /** 会话消息总数（含 system，不含注入的临时 system） */
  messageCount: number
  /** 对话消息（user/assistant/tool）数量 */
  conversationCount: number
  /** 估算 token（对话部分） */
  estimatedTokens: number
  /** 有效预算：config.tokenBudget ?? 软预算兜底 */
  effectiveBudget: number
  /** 当前模型 */
  model?: string
  /** 距离预算上限的剩余 token（估算） */
  remainingTokens: number
  /** 用量百分比 0-100 */
  usagePercent: number
}

export interface PermissionRequest {
  /** 权限类型：command（系统命令）/ setting（系统设置）/ clipboard_read（读剪贴板）/ device（控制外部设备） */
  type: 'command' | 'setting' | 'clipboard_read' | 'device'
  /** 操作描述（如 "执行命令: npm run build"） */
  description: string
  /** 完整命令或操作内容 */
  content: string
  /** 风险等级：low/medium/high */
  risk: 'low' | 'medium' | 'high'
  /** 超时毫秒（默认 30000，超时自动拒绝） */
  timeoutMs?: number
}

export interface PermissionResponse {
  allowed: boolean
  /** allowed=true 时的授权范围：once（单次）/ session（本次会话） */
  scope?: 'once' | 'session'
  /** 拒绝原因（allowed=false 时） */
  reason?: string
}

/**
 * 工具行为声明（可选）。
 * 为什么存在：统一工具池要让执行器/安全层按工具的真实性质做差异化处理
 * （并发调度、等价去重、大结果落盘、权限前置），这些信息只有工具实现者知道，
 * 必须在契约层显式声明，而不能在执行器里靠工具名硬编码。
 * 设计约束：
 * - 全部字段可选：存量工具不做任何声明也能正常工作（缺省值见 resolveToolBehavior）；
 * - 缺省 fail-closed：拿不准就按保守值处理（只读=false、高风险工具串行）；
 * - 命名遵循月蚀自身语义，不使用其他智能体产品的专属字段名。
 */
export interface ToolBehavior {
  /** 只读性：true = 纯读取无副作用（等价去重、只读免审判定的准入条件） */
  readOnly?: boolean
  /**
   * 并发安全：false = 执行器同会话串行排队，防止并发写同一资源/状态。
   * 缺省按风险等级推断（high/medium 串行、low 并行）；显式声明优先。
   */
  concurrencySafe?: boolean
  /**
   * 输入指纹：readOnly 工具返回字符串指纹时，执行器对相同指纹的重复调用做 LRU 去重，
   * 直接复用上次结果（减少无效往返）；返回 undefined 表示不去重。
   */
  inputFingerprint?: (params: unknown) => string | undefined
  /**
   * 结果体积阈值（字符）：结果序列化后超过阈值时，执行器先落盘、返回摘要与路径，
   * 替代固定字符数的硬截断；undefined = 不限制，由全局蒸馏配置兜底。
   */
  resultLimitChars?: number
  /**
   * 工具级权限前置校验：返回 false 或抛错 = 拒绝执行（fail-closed），在能力闸与
   * PreToolUse Hook 之后、实际执行之前调用；undefined = 放行，由外层策略兜底。
   */
  checkAllowed?: (ctx: ToolContext) => boolean | Promise<boolean>
  /**
   * 调用级动态描述：对本次调用生成更精准的中文描述，供审批提示/审计日志使用。
   * input 为本次调用参数、ctx 为执行上下文；返回 undefined 表示不生成（退化为静态 description）。
   * 执行器对相同输入做哈希缓存（inputHash），同参复用不重复生成；全部缺省 fail-safe，
   * 未声明或返回 undefined 时行为与改造前完全一致。
   */
  dynamicDescription?: (input: unknown, ctx?: ToolContext) => string | undefined
  /**
   * 破坏性声明：true = 工具可能删除/覆盖用户数据或修改系统状态（DeleteFile/Write/Edit/
   * MoveFile 等）。仅供审批 UI 强提示与审计标注，不改变权限语义（权限仍由工具内部/
   * 可配置规则层裁决）；缺省 false，与改造前行为一致。
   */
  destructive?: boolean
}

/** 解析后的行为（缺省值已填平，执行器/安全层直接消费，不再逐字段判空） */
export interface ResolvedToolBehavior {
  readOnly: boolean
  concurrencySafe: boolean
  inputFingerprint: ((params: unknown) => string | undefined) | undefined
  resultLimitChars: number | undefined
  checkAllowed: ((ctx: ToolContext) => boolean | Promise<boolean>) | undefined
  dynamicDescription: ((input: unknown, ctx?: ToolContext) => string | undefined) | undefined
  destructive: boolean
}

/**
 * 行为缺省值解析：显式声明优先，未声明按 fail-closed 默认值填补。
 * 为什么在契约层提供单点解析：执行器（execute-tool）、桥接（tool-bridge）、安全层三处
 * 消费同一套行为语义，任一处自行写判断都会导致行为漂移；不缓存（行为声明是静态数据，
 * 每次解析开销可忽略，且避免缓存失效）。
 */
export function resolveToolBehavior(
  behavior: ToolBehavior | undefined,
  meta?: { riskLevel?: 'low' | 'medium' | 'high' }
): ResolvedToolBehavior {
  const b = behavior ?? {}
  return {
    readOnly: b.readOnly ?? false,
    concurrencySafe:
      b.concurrencySafe ?? (meta?.riskLevel === 'high' || meta?.riskLevel === 'medium' ? false : true),
    inputFingerprint: b.inputFingerprint,
    resultLimitChars: b.resultLimitChars,
    checkAllowed: b.checkAllowed,
    dynamicDescription: b.dynamicDescription,
    destructive: b.destructive ?? false
  }
}

export interface Tool<P = Record<string, unknown>> {
  name: string
  description: string
  parameters: ToolParameter[]
  /** 行为声明（可选）：执行器/安全层差异化处理的依据，缺省见 resolveToolBehavior */
  behavior?: ToolBehavior
  execute(params: P, ctx?: ToolContext): Promise<ToolResult> | ToolResult
}

/**
 * 统一建造工厂：把工具实现类实例收敛为执行链消费的 AnyTool。
 * 为什么存在：工具登记表（ALL_TOOL_CTORS）与注册/工厂（registerBuiltinToolsMeta /
 * createAllTools）共用同一套收敛逻辑；行为声明在此透传，保证登记后的工具与实现类声明
 * 的行为一致（后续如需登记期校验，如 readOnly 工具的入参 schema 只读性检查，也在此单点加）。
 */
export function toTool(t: Tool): AnyTool {
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    behavior: t.behavior,
    execute: (params, ctx) => t.execute(params, ctx)
  }
}

export interface ToolParameter {
  name: string
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  description: string
  required?: boolean
  default?: unknown
  /** array 类型的元素类型：转 JSON schema 时输出 items（缺省不输出，与旧行为一致） */
  items?: { type: 'string' | 'number' | 'boolean' | 'object' }
}

export type AnyTool = {
  name: string
  description: string
  parameters: ToolParameter[]
  behavior?: ToolBehavior
  execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> | ToolResult
}
