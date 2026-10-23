/**
 * 监控/记忆工作流（历史标识 DMN）/记忆可视化共享类型。
 * 为什么存在：记忆工作流配置、记忆处理状态与健康检查由主进程后台产生、前端面板展示，数据形状
 * 需两端一致。
 * 作用：导出 MonitorConfig/MonitorState、可视化/健康检查/工作流实例摘要等类型。
 */
import type { SessionSummaryConfig } from './session'

export interface MonitorConfig {
  abyssac_root: string
  /** 记忆处理工作流调度（替代旧 DMN + heartbeat，由 raw_memory 驱动 L8 工作流引擎） */
  memoryWorkflow: {
    enabled: boolean
    check_interval_seconds: number
    /** 单批次 raw_memory 条数（默认 3，连续取不按长度分批） */
    batch_size: number
  }
  /** 日记工作流调度（后端自主日记，替代 AI 侧 cron diary-daily-write） */
  diaryWorkflow: {
    enabled: boolean
    check_interval_seconds: number
  }
  /** 双层会话摘要/路由配置（替代旧 contextTree 段；AI 存储整理阈值，非注入限制） */
  sessionSummary: SessionSummaryConfig
  mutex: {
    acquire_timeout_seconds: number
  }
  watchdog: {
    timeout_minutes: number
    tool_timeout_seconds: number
    continue_check_seconds: number
    max_retry: number
  }
  freeze: {
    timeout_minutes: number
  }
  task_log_max_entries: number
  shutdown: {
    grace_period_seconds: number
  }
}

// ===== P0 可视化数据类型 =====

export interface MonitorState {
  启动时间: string
  统计: {
    create_events: number
    modify_events: number
    delete_events: number
    move_events: number
  }
}

export interface ErrorLogEntry {
  id: string
  timestamp: string
  error: string
  task: { type: string; path?: string; workflowId?: string; detail?: string; file_type?: string }
  retry_count: number
  permanent_failure: boolean
  last_retry_at: string | null
}

export interface MemoryListItem {
  name: string
  path: string
  type: 'normal' | 'meta' | 'high'
  size: number
  mtime: string
}

export interface NngTreeNode {
  name: string
  path: string
  type: 'standard' | 'meta' | 'high'
  children: NngTreeNode[]
  jsonFile: string | null  // 该节点的 _nng.json 文件名（存在则表示该节点有对应 NNG 文件）
}

export interface VisualizationData {
  monitorState: MonitorState | null
  errorLogs: ErrorLogEntry[]
  memories: MemoryListItem[]
  nngTree: NngTreeNode[]
  /** RAW 记忆完整列表（raw_memory 下所有文件，新增） */
  rawMemoryList: RawMemoryListItem[]
  /** 记忆系统文件夹树（raw_memory/memory/NNG/cache 四根，新增） */
  directoryTree: MemoryDirectoryNode[]
  /** 工作流引擎实例进度（活跃 + 最近归档摘要），工作流迁移后真实进度来源 */
  workflowInstances: WorkflowInstanceSummary[]
  /** 最新一条 raw_memory 摘要（监控面板 RAW 接口） */
  latestRawMemory: RawMemoryLatest | null
  /** 健康检查模块状态（主进程 HealthCheck.getStatusSnapshot()，未初始化时为 null） */
  healthCheck: HealthCheckStatus | null
  /** 模块监控表：全架构模块清单 + 运行时状态（报错标红，可主动盘点） */
  modules: ModuleInfo[] | null
  /** 活跃 AI 倒计时（activation-manager.getActiveTimers()，面板「定时器」tab 展示） */
  timers: TimerInfo[]
}

/** RAW 记忆列表条目（监控面板 RAW 区） */
export interface RawMemoryListItem {
  path: string
  date: string
  seq: number
  size: number
  /** 对话对数（一个 RAW 含多个对话对） */
  entries: number
  /** 首个对话对用户原话预览（截断） */
  userText: string
}

/** 记忆系统文件夹树节点（注册表/资源管理器式展示，懒加载：目录只在展开时加载子层） */
export interface MemoryDirectoryNode {
  name: string
  path: string
  type: 'dir' | 'file'
  children?: MemoryDirectoryNode[]
  size?: number
  /** true=子层已加载过（点击展开不再重复拉取）；false/undefined=未加载（前端点击时调 viz:directoryChildren） */
  loaded?: boolean
  /** 目录是否有子项（无子项时展开直接显示空） */
  hasMore?: boolean
}

/** AI 倒计时条目（监控面板「定时器」tab） */
export interface TimerInfo {
  id: string
  /** 任务描述（[TIMER:30s:任务] 里的任务部分） */
  task: string
  /** 触发时间戳（ms） */
  fireAt: number
  /** 剩余毫秒（快照时点计算，前端自行倒计时刷新） */
  remainingMs: number
}

/** 架构模块清单行（ModuleRegistry.getSnapshot()，面板「模块监控」tab 展示） */
export interface ModuleInfo {
  id: string
  name: string
  category: '核心' | '工具' | '记忆系统' | '监控' | '渲染' | '基础设施'
  /** 功能一句话 */
  description: string
  /** 关键文件（相对 app 目录） */
  keyFiles: string[]
  /** true=健康 / false=有异常 / null=未知 */
  ok: boolean | null
  /** 最近错误摘要（无异常为空串） */
  error: string
  /** 最近状态变更时间戳（从未变更 null） */
  updatedAt: number | null
}

// ===== 健康检查状态（监控面板展示用，主进程 HealthCheck 模块内存态快照） =====

/**
 * 检查结果状态。
 * - pass=执行并通过；fail=执行且发现问题；timeout=命令超时被终止；
 * - error=检查器自身内部错误；
 * - unavailable=当前工作区缺少执行材料（明确「无法执行」，绝不伪装成通过）。
 * 配置关闭的检查项不进入报告（不做静默的成功）。
 */
export type HealthCheckOutcome = 'pass' | 'fail' | 'timeout' | 'error' | 'unavailable'

/** 单个检查项状态 */
export interface HealthCheckItemStatus {
  /** 检查项 key（开放字符串：由主进程注册表提供，新增检查项无需改渲染端） */
  key: string
  /** 展示名（主进程下发，渲染端不再维护第二份标签表） */
  label: string
  /** 检查结果：true=通过 / false=失败或无法执行 / null=尚未检查（面板灰点展示，避免未检查项被误报为失败） */
  ok: boolean | null
  /** 结果状态（null = 尚未检查）。UI 用它区分「失败 / 无法执行 / 内部错误」 */
  outcome: HealthCheckOutcome | null
  /** 失败时的错误摘要（成功为空串） */
  output: string
  /** 无法执行的原因（仅 outcome=unavailable 时非空） */
  reason: string
  /** 该项最近一次检查时间戳（从未检查为 null） */
  checkedAt: number | null
}

/** 健康检查修复记录条目（面板展示 AI 处理过程用） */
export interface HealthCheckRepairEntry {
  /** 事件时间戳 */
  time: number
  /** 检查项 key */
  key: string
  /** 事件类型：alert=发现异常注入事件 / recovered=恢复正常 / unavailable=无法执行 */
  kind: 'alert' | 'recovered' | 'unavailable'
  /** 摘要（alert 带错误摘要，recovered/unavailable 简短说明） */
  detail: string
}

/** 健康检查模块整体状态快照（viz:getAll 附带返回） */
export interface HealthCheckStatus {
  /** 模块可用性位：当前实现恒为 true（模块未就绪时整条快照为 null，前端按 null 提示）；保留字段供未来关闭单个模块用 */
  available: boolean
  /** 是否运行在打包产物中（仅用于说明执行环境；**不再据此关闭任何检查项**） */
  packaged: boolean
  /** 配置开关 */
  enabled: boolean
  /** 检查间隔（分钟） */
  interval_minutes: number
  /** 最近一次完整检查时间戳（未跑过为 null） */
  lastRunAt: number | null
  /** 是否正在执行检查 */
  running: boolean
  /** 整体健康（null = 尚未执行过；false = 至少一项失败或无法执行） */
  overallOk: boolean | null
  /** 是否有检查项「无法执行」（true 时不得把整体显示为健康） */
  incomplete: boolean
  checks: HealthCheckItemStatus[]
  /** 修复记录（发现异常/恢复/静默/无法执行事件，新在前，最多 50 条） */
  repairLog: HealthCheckRepairEntry[]
}

// ===== 工作流实例进度摘要（监控面板用，纯展示字段，与 shared/workflow/types.ts 的 WorkflowInstance 解耦） =====

export type WorkflowInstanceStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

export interface WorkflowNodeSummary {
  nodeId: string
  nodeName: string
  status: 'running' | 'done' | 'failed' | 'skipped'
  startedAt: number
  endedAt?: number
}

export interface WorkflowInstanceSummary {
  id: string
  templateId: string
  templateName?: string
  status: WorkflowInstanceStatus
  currentNode: string | null
  startedAt: number
  completedAt?: number
  error?: string
  /** 节点执行进度（按顺序） */
  nodes: WorkflowNodeSummary[]
}

/** 最新一条 raw_memory 摘要（监控面板 RAW 接口，展示用，内容截断由后端控制） */
export interface RawMemoryLatest {
  /** 序号（文件名，如 31.json → 31） */
  seq: number
  /** 日期（YYYY-MM-DD） */
  date: string
  /** 完整路径（前端可点击 openFilePreview 打开全文） */
  path: string
  /** 时间戳（raw_memory 文件内 时间戳 字段） */
  timestamp: string
  /** 用户原话（截断摘要） */
  userText: string
  /** AI 回复（截断摘要） */
  aiText: string
  /** 文件大小（字节） */
  size: number
  /** 是否发生截断（true=内容过长，已截断展示） */
  truncated: boolean
}