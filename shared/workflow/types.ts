/**
 * L8 工作流引擎：共享类型定义



 * 纯数据类型，供前端 UI 和主进程共享。
 * 引擎核心、节点处理器等实现在 electron/main/workflow/ 下。

 * 核心概念：
 * - WorkflowTemplate：工作流模板（nodes + edges + hooks + mode），可复用可导出
 * - WorkflowInstance：工作流运行实例（状态 + context + history），崩溃恢复用
 * - 引擎调度，AI 执行：节点处理器是薄包装，复用月蚀已有能力（LLM stream / 工具池 / SKILL / MCP）
 * - raw_memory 完整性：最终回复走 stream 触发 RawMemoryWriter 自动写
 */

// ===== 节点类型 =====

/**
 * 工作流节点类型

 * 7 种节点覆盖编排要素 + 条件分支 + 人工介入 + 两种模式的输出节点：
 * - llm/tool/skill：编排要素（AI 调用、工具调用、SKILL 调用）
 * - condition：条件分支（引擎自己评估，不需要 AI）
 * - human：人工介入（弹窗等用户输入）
 * - answer：回复用户（仅 Chatflow，输出后等用户下一条消息）
 * - end：终止并输出结果（仅 Workflow）
 */
export type NodeType = 'llm' | 'tool' | 'skill' | 'condition' | 'human' | 'answer' | 'end'

/**
 * 工作流模式
 * - chatflow：对话流，有对话上下文（messages 数组），用 answer 节点回复用户
 * - workflow：一次性工作流，无对话上下文，用 end 节点终止输出

 * 两者都自动写 raw_memory（RawMemoryWriter 在 stream 结束时自动写）
 */
export type WorkflowMode = 'chatflow' | 'workflow'

// ===== 节点配置 =====

export interface LlmConfig {
  /**
   * 提示词，可引用上下文变量 {{context.xxx}}。

   * 提示词存储规范（去 JSON 化，MD 为唯一真源）：
   * - 提示词正文一律外置为 workflows/prompts/{模板id}/{节点id}.md（promptFile 引用），
   *   用户直接编辑 MD 即为编辑生效提示词；promptFile 存在且可读时优先于本字段加载。
   * - 本字段仅在以下场景被持久化/使用：
   *   1) 内置模板源码 default-templates.ts（内置真源，save 时写入 MD）；
   *   2) 导入/新建模板的原始定义（save 时外置为 MD 后，磁盘 JSON 副本不保留本字段）；
   *   3) 运行期回退：promptFile 缺失/不可读时回退本字段。
   * - 磁盘 JSON 模板副本（templates/{id}.json）不再内嵌提示词正文，仅保留 promptFile 引用。
   */
  prompt?: string
  /**
   * 提示词外置文件路径（提示词恢复为文本文件，用户直接编辑 MD）。
   * 绝对路径，指向 workflows/prompts/{模板id}/{节点id}.md。
   * 文件存在 → 读文件内容作为提示词（用户可编辑副本优先）；不存在/读取失败 → 用 prompt 字段回退。
   */
  promptFile?: string
  /** 允许 AI 用的工具子集（可选，不填或空数组则不带工具，纯文本生成） */
  tools?: string[]
  /**
   * 是否走 stream 接口输出（默认 true）。
   * true：走 streamWithTools，触发 RawMemoryWriter 自动写 raw_memory，前端能看到流式输出
   * false：走 chatWithTools 非流式，仅返回结果到 context（不写 raw_memory，用于中间步骤）
   */
  stream?: boolean
  /**
   * 工具调用最大轮数（可选，默认 8）。
   * 复杂节点（如记忆处理流水线）需要 20-30 轮才能完成多步骤工具调用。
   * 引擎会透传给 LLMClient.streamWithTools 的 options.maxRounds。
   */
  maxRounds?: number
  /**
   * 输出变量提取（可选）：从 LLM 输出中提取 <json>...</json> 块，解析后按字段写入 context。

   * AI 需在输出中包含 `<json>{"field1": "val1", "field2": 2}</json>` 块。
   * handler 提取并解析 JSON，把 outputVars 中列出的字段写入 `context[fieldName]`，
   * 供后续节点的 {{context.fieldName}} 引用和 condition 出边条件评估使用。

   * 用途：DMN-6 质检节点输出 `{qa_result, redo_target, redo_count}` → condition 分支评估。
   * JSON 解析失败时仅 warn，不阻断节点（输出仍存为 context[nodeId]）。
   */
  outputVars?: string[]
}

/**
 * LLM 工具执行器（llm 节点工具池用）

 * 与 api/llm.ts 的 ToolExecutor 结构一致，定义在 shared 层避免循环依赖。
 * manager.ts 负责把 ToolRegistry 的 AnyTool 转换为此格式注入工具池。
 */
export interface LlmToolExecutor {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(args: Record<string, unknown>): Promise<string>
}

export interface ToolConfig {
  /** 工具 ID（内置工具名 or MCP 工具 mcp_{serverName}.{toolName}） */
  toolId: string
  /** 参数，值可引用上下文变量 {{context.xxx}} */
  args: Record<string, string>
}

export interface SkillConfig {
  /** SKILL ID（如 'workflow-design'） */
  skillId: string
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 条件写在外边字段，节点配置本身允许为空对象
export interface ConditionConfig {
  /**
   * 条件写在出边的 condition 字段里，节点配置本身可以为空。
   * 引擎执行到 condition 节点时，逐条评估出边的条件表达式，走第一个满足的。
   */
}

export interface HumanConfig {
  /** 问用户什么 */
  prompt: string
  /** 输入类型 */
  inputType: 'confirm' | 'text' | 'choice'
  /** choice 类型时的选项 */
  options?: string[]
  /**
   * 超时时间（毫秒，可选）。
   * 超时后节点标记 failed，工作流停止（除非 on_fail HOOK 处理）。
   * 不填则无限等待（适合需要用户仔细思考的场景，但可能造成实例长期挂起）。
   */
  timeoutMs?: number
}

export interface AnswerConfig {
  /** 回复内容，可引用上下文变量 {{context.xxx}} */
  content: string
}

export interface EndConfig {
  /** 最终输出，可引用上下文变量 {{context.xxx}} */
  output: string
}

export type NodeConfig =
  | LlmConfig
  | ToolConfig
  | SkillConfig
  | ConditionConfig
  | HumanConfig
  | AnswerConfig
  | EndConfig

// ===== 节点与连线 =====

export interface WorkflowNode {
  id: string
  type: NodeType
  name: string
  config: NodeConfig
}

export interface WorkflowEdge {
  /** 起点节点 ID */
  from: string
  /** 终点节点 ID */
  to: string
  /**
   * 条件表达式（可选，仅 condition 节点的出边有效）

   * 表达式语法（简化版）：
   * - 字面量比较：context.xxx == 'value' / context.xxx != 'value'
   * - 数值比较：context.xxx > 10 / context.xxx >= 10 / < / <=
   * - 包含：context.xxx contains 'keyword'
   * - 存在性：context.xxx exists / not exists
   * - 默认：'default'（兜底分支，所有条件都不满足时走）

   * 引擎执行到 condition 节点时，按 edges 数组顺序评估，走第一个满足的。
   */
  condition?: string
}

// ===== HOOK 配置（工作流级别） =====

export type WorkflowHookEvent =
  | 'before_node'   // 节点执行前
  | 'after_node'    // 节点执行后（成功才触发）
  | 'on_fail'       // 节点失败时
  | 'on_complete'   // 工作流完成时
  | 'on_user_message' // Chatflow 收到用户消息时

export interface WorkflowHookAction {
  /** 动作类型：command=shell 命令 / javascript=同进程 JS 函数 */
  type: 'command' | 'javascript'
  /** type=command 时：要执行的 shell 命令 */
  command?: string
  /** type=command 时：命令参数 */
  args?: string[]
  /** type=javascript 时：JS 函数体字符串，签名 (ctx) => result */
  code?: string
  /** 超时（毫秒，默认 10000） */
  timeout?: number
}

export interface WorkflowHook {
  /** 触发事件 */
  event: WorkflowHookEvent
  /** 匹配条件（可选）：节点 ID 或正则，仅对匹配的节点生效 */
  matcher?: string
  /** 执行什么 */
  action: WorkflowHookAction
}

// ===== 工作流模板 =====

export interface WorkflowTemplate {
  id: string
  name: string
  description: string
  /** 标签，便于搜索 */
  tags?: string[]
  /** 模式：对话流 or 一次性工作流 */
  mode: WorkflowMode
  /** 节点列表 */
  nodes: WorkflowNode[]
  /** 连线列表 */
  edges: WorkflowEdge[]
  /** 工作流级别的 HOOK 配置 */
  hooks?: WorkflowHook[]
  /** 起始节点 ID（不填则取无入边的第一个节点） */
  startNode?: string
  createdAt: number
  updatedAt: number
  /** 创建来源：user=用户手动 / ai=AI 编排 / imported=导入 / default=内置默认模板 */
  source?: 'user' | 'ai' | 'imported' | 'default'
}

// ===== 工作流实例 =====

export type WorkflowInstanceStatus =
  | 'running'    // 正在执行
  | 'paused'     // 已暂停（human 节点等用户输入 / await_user 等 chatflow 下一轮 / manual 手动暂停）
  | 'completed'  // 已完成
  | 'failed'     // 失败
  | 'cancelled'  // 用户取消

export type NodeRunStatus = 'running' | 'done' | 'failed' | 'skipped'

/** 单个节点的执行记录 */
export interface NodeRun {
  /** 节点 ID */
  nodeId: string
  /** 节点名称（执行时的快照） */
  nodeName: string
  /** 节点类型（执行时的快照） */
  nodeType: NodeType
  /** 执行状态 */
  status: NodeRunStatus
  /** 开始时间（毫秒时间戳） */
  startedAt: number
  /** 结束时间（毫秒时间戳） */
  endedAt?: number
  /** 节点输出（完整结论/结果，写入 context 供后续节点引用） */
  output?: string
  /** 失败原因（status=failed 时） */
  error?: string
}

export type PauseReason = 'human' | 'await_user' | 'manual'

/** Chatflow 模式的对话消息 */
export interface ChatflowMessage {
  role: 'user' | 'assistant'
  content: string
  ts: number
}

export interface WorkflowInstance {
  /** 实例 ID（唯一） */
  id: string
  /** 来源模板 ID */
  templateId: string
  /** 来源模板名称（UI 显示用，创建时从模板拷贝） */
  templateName?: string
  /** 模式（从模板继承） */
  mode: WorkflowMode
  /** 当前状态 */
  status: WorkflowInstanceStatus
  /** 共享上下文：节点输出写到这里，后续节点用 {{context.xxx}} 读 */
  context: Record<string, unknown>
  /** 当前正在执行的节点 ID（无则 null） */
  currentNode: string | null
  /** 节点执行历史（按顺序追加） */
  history: NodeRun[]
  /** Chatflow 模式的对话历史 */
  messages?: ChatflowMessage[]
  /** 启动时间（毫秒时间戳） */
  startedAt: number
  /** 暂停时间 */
  pausedAt?: number
  /** 暂停原因 */
  pauseReason?: PauseReason
  /** 完成时间 */
  completedAt?: number
  /** 失败原因（status=failed 时） */
  error?: string
  /** 输入参数（启动时的 input，写进 context.input） */
  input?: unknown
  /** 最终输出（status=completed 时） */
  output?: string
  /** 关联的会话 ID（Chatflow 模式下用于回复前端） */
  sessionId?: string | null
}

// ===== 引擎事件（推送前端） =====

export type WorkflowEngineEvent =
  | { type: 'wf:started'; instanceId: string; templateName: string; mode: WorkflowMode }
  | { type: 'wf:node_start'; instanceId: string; nodeId: string; nodeName: string; nodeType: NodeType }
  | { type: 'wf:node_done'; instanceId: string; nodeId: string; output?: string }
  | { type: 'wf:node_failed'; instanceId: string; nodeId: string; error: string }
  | { type: 'wf:paused'; instanceId: string; reason: PauseReason; nodeId?: string; prompt?: string; inputType?: string; options?: string[]; timeoutMs?: number }
  | { type: 'wf:resumed'; instanceId: string }
  | { type: 'wf:token'; instanceId: string; token: string; nodeId?: string }
  | { type: 'wf:reasoning'; instanceId: string; token: string; nodeId?: string }
  | { type: 'wf:tool_start'; instanceId: string; toolName: string; toolCallId: string; args: Record<string, unknown>; nodeId?: string }
  | { type: 'wf:tool_end'; instanceId: string; toolName: string; toolCallId: string; result: string; nodeId?: string }
  | { type: 'wf:answer'; instanceId: string; content: string; nodeId: string }
  | { type: 'wf:completed'; instanceId: string; output?: string }
  | { type: 'wf:failed'; instanceId: string; error: string }
  | { type: 'wf:cancelled'; instanceId: string }

// ===== 引擎接口契约 =====

/** 节点处理器执行上下文（引擎传给 handler 的） */
export interface NodeHandlerContext {
  /** 当前实例 */
  instance: WorkflowInstance
  /** 当前节点 */
  node: WorkflowNode
  /** 引擎事件推送器 */
  emit: (event: WorkflowEngineEvent) => void
  /** 请求用户输入（human 节点用）：返回用户响应，被取消或超时则抛错 */
  requestHumanInput?: (prompt: string, inputType: 'confirm' | 'text' | 'choice', options?: string[], timeoutMs?: number) => Promise<string>
  /** 模板变量解析器：把 {{context.xxx}} 替换成实际值（字符串替换） */
  resolveTemplate: (text: string) => string
  /**
   * 模板变量解析器（保留原始类型）：整段是单个 {{context.xxx}} 时返回原始值（对象/数组/数字等）
   * H4 修复：tool 节点 args 需保留原始类型，否则工具收到字符串 "42" 而非数字 42
   */
  resolveValue?: (text: string) => unknown
  /** LLM stream 回调集合（llm 节点用） */
  llm?: {
    streamWithTools: (
      messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
      tools: unknown[],
      callbacks: {
        onToken: (token: string) => void
        onDone: () => void
        onError: (err: Error) => void
        onToolStart?: (toolName: string, toolCallId: string, args: Record<string, unknown>) => void
        onToolEnd?: (toolName: string, toolCallId: string, result: string) => void
        onReasoning?: (token: string) => void
      },
      options?: { maxRounds?: number; modelOverride?: string; guardrailSessionId?: string }
    ) => Promise<void>
    chatWithTools?: (
      messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
      tools: unknown[],
      options?: { modelOverride?: string; maxRounds?: number; guardrailSessionId?: string }
    ) => Promise<{ content: string | null; toolCalls: unknown[]; finishReason: string }>
  }
  /**
   * LLM 工具池（llm 节点用）：按 config.tools 过滤出可用工具子集。
   * - 传 toolIds：返回指定工具列表（保持顺序），不存在的工具跳过
   * - 不传或空数组：返回空数组（纯文本生成，不带工具）
   * manager.ts 负责构建工具池（从 ToolRegistry 转换为 LlmToolExecutor）
   */
  toolPool?: {
    filter(toolIds?: string[]): LlmToolExecutor[]
  }
  /** 工具执行器（tool 节点用） */
  toolExecutor?: {
    execute: (toolId: string, args: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown; error?: string }>
  }
  /** SKILL 加载器（skill 节点用） */
  skillLoader?: {
    load: (skillId: string) => { ok: boolean; body?: string; error?: string }
  }
  /** 工作流根目录（llm 节点 promptFile 路径校验用，限制文件读取范围） */
  workflowsRoot?: string
}

/** 节点处理器统一接口 */
export interface NodeHandler {
  /** 处理节点，返回输出（写入 context） */
  handle(ctx: NodeHandlerContext): Promise<{ output: string }>
}

// ===== 工具定义（给 AI 用的 8 个工具参数类型） =====

/** workflow_define 工具参数 */
export interface WorkflowDefineParams {
  name: string
  description: string
  mode: WorkflowMode
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  hooks?: WorkflowHook[]
  tags?: string[]
  /** 已有模板 ID（编辑时传，不传则新建） */
  templateId?: string
}

/** workflow_run 工具参数 */
export interface WorkflowRunParams {
  templateId: string
  /** 输入参数，写进 context.input */
  input?: unknown
  /** Chatflow 模式下关联的会话 ID */
  sessionId?: string
}

/** workflow_modify 工具参数 */
export interface WorkflowModifyParams {
  instanceId: string
  action: 'pause' | 'resume' | 'cancel' | 'update_context'
  /** action=update_context 时：要更新到 context 的键值 */
  contextPatch?: Record<string, unknown>
}

/** workflow_save 工具参数 */
export interface WorkflowSaveParams {
  templateId?: string  // 已有模板 ID（覆盖更新），不传则新建
  name: string
  description: string
  mode: WorkflowMode
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  hooks?: WorkflowHook[]
  tags?: string[]
}

/** workflow_list 工具参数 */
export interface WorkflowListParams {
  /** 按模式过滤（可选） */
  mode?: WorkflowMode
  /** 按标签过滤（可选） */
  tag?: string
}

/** workflow_edit 工具参数 */
export interface WorkflowEditParams {
  templateId: string
  /** 操作类型 */
  action:
    | 'add_node'       // 新增节点
    | 'remove_node'    // 删除节点（同时删除相关连线）
    | 'update_node'    // 修改节点配置
    | 'add_edge'       // 新增连线
    | 'remove_edge'    // 删除连线
    | 'update_edge'    // 修改连线条件
    | 'add_hook'       // 新增 HOOK
    | 'remove_hook'    // 删除 HOOK
    | 'rename'         // 改模板名/描述/标签
  /** 操作负载（结构取决于 action） */
  payload: Record<string, unknown>
}

/** ask_user 工具参数（工作流执行外，AI 临时问用户一个问题） */
export interface AskUserParams {
  question: string
  inputType?: 'confirm' | 'text' | 'choice'
  options?: string[]
}
