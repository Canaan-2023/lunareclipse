/**
 * @category 记忆
 * @summary L8 记忆工作流引擎：raw_memory 精炼为结构化记忆
 * 为什么存在：原始记忆（raw_memory）需要自动精炼为结构化记忆才能被 AI 检索复用，
 * DAG 引擎把"精炼流程"变成可编排执行的工作流。
 * 作用：DAG 调度器核心——解析模板、按节点顺序执行（含条件分支）、维护运行期
 * context 传递、human 节点暂停/恢复、实例状态持久化与 HOOK 触发。
 * 不删理由：L8 记忆精炼与 chatflow 对话循环全部依赖本引擎调度（startInstance /
 * resumeInstance / cancelInstance 是 manager 与 AI 工具的唯一入口）；删除它等于
 * 移除整套可编排执行能力，记忆自动精炼与多轮对话推进全部失效。
 *
 * 核心职责：
 * 1. DAG 解析和调度：按节点顺序执行，处理条件分支
 * 2. context 传递：节点输出写进 context，后续节点用 {{context.xxx}} 读
 * 3. human 节点暂停/恢复：弹窗等用户输入
 * 4. 实例状态持久化：每次节点状态变化都同步写磁盘（崩溃恢复用）
 * 5. HOOK 触发：before_node / after_node / on_fail / on_complete / on_user_message
 *
 * 执行模型：引擎调度，AI 执行
 * - 引擎按 DAG 顺序告诉 AI"该做什么"
 * - AI 用月蚀已有能力（LLM stream / 工具池 / use_skill / MCP）执行
 * - 引擎收结果推进到下一个节点
 *
 * 不做的事：
 * - 不操心 raw_memory（由 RawMemoryWriter 在 stream 结束时自动写）
 * - 不归档已完成实例的 history（记忆系统已记录该记的）
 * - 不自己实现循环优化（复用月蚀 [TIMER] 机制，引擎只暴露执行结果）
 */
import type { WorkflowTemplate, WorkflowInstance, WorkflowNode, WorkflowEngineEvent, NodeHandlerContext, NodeRun } from '@shared/workflow/types'
import type { WorkflowInstanceStore } from './persister'
import { generateId } from './persister'
import { WorkflowHookRunner, type WorkflowHookContext } from './hook-runner'
import { getNodeHandler } from './handlers'
import { createTemplateResolver, resolveTemplate } from './template-var'
import { findStartNode, findNextNode } from './dag-nav'
import { validateTemplate } from './template-validate'

/** 引擎依赖（由上层 manager 注入） */
export interface EngineDeps {
  /** 实例存储器（持久化用） */
  instanceStore: WorkflowInstanceStore
  /** HOOK 执行器 */
  hookRunner: WorkflowHookRunner
  /** 事件推送器（推给前端 WS） */
  emit: (event: WorkflowEngineEvent) => void
  /** LLM stream 接口（llm 节点用） */
  llm?: NodeHandlerContext['llm']
  /** LLM 工具池（llm 节点用）：按 config.tools 过滤出可用工具子集 */
  toolPool?: NodeHandlerContext['toolPool']
  /** 工具执行器（tool 节点用） */
  toolExecutor?: NodeHandlerContext['toolExecutor']
  /** SKILL 加载器（skill 节点用） */
  skillLoader?: NodeHandlerContext['skillLoader']
  /** 工作流根目录（llm 节点 promptFile 路径校验用） */
  workflowsRoot?: string
  /** 请求用户输入（human 节点用）：上层 manager 注入，负责发 wf:paused + 创建 Promise + 超时管理 */
  requestHumanInput?: (instanceId: string, prompt: string, inputType: 'confirm' | 'text' | 'choice', options?: string[], timeoutMs?: number) => Promise<string>
  /**
   * 清理 pending human 输入（cancelInstance 时调用，避免 Promise 永久挂起）
   * C3 修复：cancelInstance 需清理 pendingHumanInputs，否则 runLoop 永远 await
   */
  onCleanHumanInput?: (instanceId: string) => void
  /** 取消 LLM stream（cancelInstance 时调用，避免请求继续浪费 token）M6 修复 */
  onAbortLlm?: () => void
  /**
   * 工作流实例级并发闸门（可选， 动态性能优化）：
   * 注入后，每个实例开始执行前 acquire 一次槽位、执行结束（完成/失败/取消/暂停）时
   * release。配合 DynamicPool 时上限随运行时设备参数（逻辑核/内存/当前 CPU 负载）
   * 动态变化——机器空闲自动放开并发实例数、负载高自动收拢，非固定静态配置。
   * 不注入则不限制（旧行为，多实例并行无上限）。
   */
  concurrencyGate?: { acquire(signal?: AbortSignal): Promise<boolean>; release(): void }
}

/**
 * 工作流引擎

 * 单实例多工作流：一个引擎可以同时管理多个工作流实例（每个实例独立执行，互不阻塞）。
 * 内部维护 runningInstances Map 跟踪正在执行的实例。
 */
export class WorkflowEngine {
  /** 正在执行的实例（instanceId → 执行状态） */
  /** runningInstances 条目：cancelling=取消标记；pausing=手动暂停标记（新增） */
  private runningInstances = new Map<string, { cancelling: boolean; pausing?: boolean }>()

  constructor(private deps: EngineDeps) {}

  /**
   * 启动新实例
   * @param template 工作流模板
   * @param input 输入参数（写进 context.input）
   * @param sessionId Chatflow 模式关联的会话 ID
   * @returns 创建的实例
   */
async startInstance(
    template: WorkflowTemplate,
    input?: unknown,
    sessionId?: string
  ): Promise<WorkflowInstance> {
    validateTemplate(template)

    const instance: WorkflowInstance = {
      id: generateId('wfi'),
      templateId: template.id,
      templateName: template.name,
      mode: template.mode,
      status: 'running',
      context: { input: input ?? null },
      currentNode: null,
      history: [],
      messages: template.mode === 'chatflow' ? [] : undefined,
      startedAt: Date.now(),
      sessionId: sessionId ?? null
    }

    // 找起始节点
    const startNode = findStartNode(template)
    if (!startNode) {
      throw new Error('工作流无起始节点（没有无入边的节点，可能存在循环）')
    }
    instance.currentNode = startNode.id

    // 持久化
    this.deps.instanceStore.save(instance)
    this.runningInstances.set(instance.id, { cancelling: false })

    // 发事件
    this.deps.emit({
      type: 'wf:started',
      instanceId: instance.id,
      templateName: template.name,
      mode: template.mode
    })

    // 启动执行循环（异步，不阻塞调用方）
    // runLoop 内部有完整 try-catch 处理所有错误（标记 failed + emit + archive），
    // 此处不兜底——逃逸 runLoop catch 的异常成为 unhandled rejection 暴露问题
    void this.runLoopGuarded(instance, template)

    return instance
  }

  /**
   * 恢复 paused 实例

   * 两种恢复场景：
   * 1. human 节点恢复：用户通过弹窗响应了 human 节点
   * - manager 已通过 requestHumanInput 的 Promise resolve 传回响应
   * - runLoop 自然继续，不需要调 resumeInstance
   * - 此方法仅用于崩溃恢复后重新进入 runLoop

   * 2. chatflow answer 节点恢复：用户发了新消息
   * - 把用户消息追加到 instance.messages
   * - 找下一节点继续执行

   * @param instanceId 实例 ID
   * @param userMessage Chatflow 模式下的用户消息（answer 节点恢复时传）
   * @param template 工作流模板（用于查找下一节点）
   */
  async resumeInstance(
    instanceId: string,
    template: WorkflowTemplate,
    userMessage?: string
  ): Promise<WorkflowInstance | null> {
    const instance = this.deps.instanceStore.load(instanceId)
    if (!instance) {
      throw new Error(`实例 ${instanceId} 不存在`)
    }

    if (instance.status !== 'paused') {
      throw new Error(`实例 ${instanceId} 状态为 ${instance.status}，无法恢复（仅 paused 可恢复）`)
    }

    // C7 修复：检查是否已有 runLoop 在运行，避免双 runLoop 竞态
    if (this.runningInstances.has(instanceId)) {
      throw new Error(`实例 ${instanceId} 已有执行循环在运行，无法重复恢复`)
    }

    // C5 修复：resumeInstance 前检查最后一个 NodeRun 状态
    // 如果当前节点已完成（status='done'），说明 pause 发生在节点执行之后，
    // 恢复时应跳到下一节点，避免重复执行有副作用的工具
    // 修复：chatflow（await_user）**不**走此推进——answer 节点是对话
    // 暂停点，恢复时由下方 chatflow 分支统一从 answer 节点找下一节点。原实现 C5 先推进 +
    // chatflow 分支再推进 = 双重推进：终结点 answer 直接 completed 吞掉第二条消息 /
    // 有回边时跳过回边后第一个节点（如 understand）。
    if (instance.pauseReason !== 'await_user' && instance.history.length > 0 && instance.currentNode) {
      const lastRun = instance.history[instance.history.length - 1]
if (lastRun.nodeId === instance.currentNode && lastRun.status === 'done') {
        // 当前节点已完成，跳到下一节点
        const nextNodeId = findNextNode(template, instance.currentNode, instance.context)
        instance.currentNode = nextNodeId // 可能为 null（隐式完成）
      }
    }

    // Chatflow answer 节点恢复：追加用户消息
    if (instance.pauseReason === 'await_user' && userMessage !== undefined) {
      if (!instance.messages) instance.messages = []
      instance.messages.push({ role: 'user', content: userMessage, ts: Date.now() })
      instance.context.user_message = userMessage

      // 触发 on_user_message HOOK
      await this.runHooks(template, 'on_user_message', {
        instanceId: instance.id,
        templateId: template.id,
        event: 'on_user_message',
        userMessage,
        context: { ...instance.context }
      })

// 找下一节点（currentNode 此时仍指向 answer 节点——C5 已对 await_user 跳过推进）
      const nextNodeId = findNextNode(template, instance.currentNode!, instance.context)
      if (!nextNodeId) {
        // 修复：原实现直接标记 completed——answer 是终结点时第二条
        // 消息被静默吞掉（消息已追加进 messages 但工作流直接结束）。正确语义：chatflow
        // 的 answer 节点应有回边形成对话循环；无出边 = 模板配置问题——保持 paused 等待，
        // 消息不丢，warn 提示（引擎不做数据毁灭性操作）。
        console.warn(
          `[workflow] 实例 ${instance.id} chatflow answer 节点无出边（模板 ${template.id} 配置问题——answer 应有回边形成对话循环），保持暂停等待下一条消息`
        )
        this.deps.instanceStore.save(instance)
        return instance
      }
      instance.currentNode = nextNodeId
    }

    // 恢复执行
    instance.status = 'running'
    instance.pauseReason = undefined
    instance.pausedAt = undefined
    this.deps.instanceStore.save(instance)
    this.runningInstances.set(instance.id, { cancelling: false })

    this.deps.emit({ type: 'wf:resumed', instanceId: instance.id })

    // 重新进入执行循环
    // 不兜底——逃逸 runLoop catch 的异常成为 unhandled rejection 暴露问题
    void this.runLoopGuarded(instance, template)

    return instance
  }

  /**
   * 暂停实例（手动暂停，pauseReason='manual'）

   * 修复：原实现从磁盘 load 新对象改 status——runLoop 持有的是
   * startInstance 创建的内存对象，磁盘改动对它不可见（runLoop 的 paused 检查永远 false），
   * 且下一节点 save 又把 running 覆盖回磁盘。改为经 runningInstances Map 标记
   * （与 cancelling 同机制）：runLoop 在节点边界检查 pausing 标志后优雅暂停。
   */
  pauseInstance(instanceId: string): WorkflowInstance | null {
    const instance = this.deps.instanceStore.load(instanceId)
    if (!instance) return null
    if (instance.status !== 'running') return instance

    // 标记暂停（runLoop 检查此标志后停止）——内存对象隔离问题的根治
    const running = this.runningInstances.get(instanceId)
    if (running) {
      running.pausing = true
    }

    // 磁盘状态同步写（UI 展示/恢复入口用；runLoop 实际以 Map 标志为准）
    instance.status = 'paused'
    instance.pauseReason = 'manual'
    instance.pausedAt = Date.now()
    this.deps.instanceStore.save(instance)
    this.deps.emit({ type: 'wf:paused', instanceId: instance.id, reason: 'manual' })
    return instance
  }

  /**
   * 取消实例
   */
  cancelInstance(instanceId: string): WorkflowInstance | null {
    const instance = this.deps.instanceStore.load(instanceId)
    if (!instance) return null

    // 防御：已完成/失败/已取消的实例（含归档实例）不允许重复取消
    if (instance.status === 'completed' || instance.status === 'failed' || instance.status === 'cancelled') {
      return instance
    }

    // 标记取消（runLoop 检查此标志后停止）
    const running = this.runningInstances.get(instanceId)
    if (running) {
      running.cancelling = true
    }

    instance.status = 'cancelled'
    instance.completedAt = Date.now()
    this.deps.instanceStore.save(instance)
    this.deps.emit({ type: 'wf:cancelled', instanceId: instance.id })

    // C3 修复：清理 pending human 输入 Promise，避免 runLoop 永久挂起（内存泄漏 + 死锁）
    if (this.deps.onCleanHumanInput) {
      this.deps.onCleanHumanInput(instanceId)
    }
    // M6 修复：取消正在进行的 LLM stream，避免请求继续浪费 token
    if (this.deps.onAbortLlm) {
      this.deps.onAbortLlm()
    }

    // H1 修复：cancelled 归档实例文件（保留最近完成记录），避免存储泄漏
    this.deps.instanceStore.archive(instance)

    // 清理运行状态
    this.runningInstances.delete(instanceId)
    return instance
  }

  /**
   * 更新实例 context（运行时动态修改，workflow_modify 工具用）
   */
  updateContext(instanceId: string, patch: Record<string, unknown>): WorkflowInstance | null {
    const instance = this.deps.instanceStore.load(instanceId)
    if (!instance) return null
    // 防御：仅运行中/暂停中实例可更新 context（归档等终态实例不再变更）
    if (instance.status !== 'running' && instance.status !== 'paused') {
      return instance
    }
    instance.context = { ...instance.context, ...patch }
    this.deps.instanceStore.save(instance)
    return instance
  }

  /**
   * 获取实例状态
   */
  getInstance(instanceId: string): WorkflowInstance | null {
    return this.deps.instanceStore.load(instanceId)
  }

  // ===== 内部：主执行循环 =====

  /**
   * 并发闸门包装（ 动态性能优化）：
   * 有 concurrencyGate 时先获取槽位再进 runLoop，结束后无论何种退出路径
   * （完成/失败/取消/暂停）都释放——用 try/finally 保证暂停分支（answer/manual
   * 早退）也会释放，避免实例暂停后闸门槽位被永久占用。
   */
  private async runLoopGuarded(instance: WorkflowInstance, template: WorkflowTemplate): Promise<void> {
    const gate = this.deps.concurrencyGate
    if (!gate) {
      await this.runLoop(instance, template)
      return
    }
    const admitted = await gate.acquire()
    if (!admitted) {
      // 排队期间被 abort（实例已取消）：不进入执行循环
      return
    }
    try {
      await this.runLoop(instance, template)
    } finally {
      gate.release()
    }
  }

  /**
   * 主执行循环

   * 从 instance.currentNode 开始，按 DAG 顺序执行节点：
   * 1. 检查取消标志
   * 2. 执行当前节点
   * 3. 写输出到 context
   * 4. 触发 after_node HOOK
   * 5. 若是 answer 节点（chatflow）：暂停，return
   * 6. 若是 end 节点：完成，return
   * 7. 找下一节点，循环
   */
  private async runLoop(instance: WorkflowInstance, template: WorkflowTemplate): Promise<void> {
    try {
      // M1 修复：防止自环边或循环依赖导致死循环
      // 上限 = 节点数 × 10（允许条件循环合理重入，但防止无限循环）
      const maxIterations = Math.max(template.nodes.length * 10, 100)
      let iterations = 0

      while (instance.currentNode) {
        // M1：迭代次数保护
        iterations++
        if (iterations > maxIterations) {
          throw new Error(`工作流执行超过最大迭代次数 ${maxIterations}，可能存在循环依赖`)
        }

        // 检查取消
        const running = this.runningInstances.get(instance.id)
        if (!running || running.cancelling) {
          return
        }

        // 检查手动暂停（修复：pauseInstance 经 runningInstances.pausing 标记——
        // 磁盘 load 对象改 status 对 runLoop 内存对象不可见；这里统一在节点边界优雅暂停）
        if (running.pausing || instance.status === 'paused') {
          if (instance.status !== 'paused') {
            instance.status = 'paused'
            instance.pauseReason = 'manual'
            instance.pausedAt = Date.now()
            this.deps.instanceStore.save(instance)
            this.deps.emit({ type: 'wf:paused', instanceId: instance.id, reason: 'manual' })
          }
          // 清理运行标记：resumeInstance 的 C7 检查 runningInstances.has，残留会挡恢复
          this.runningInstances.delete(instance.id)
          return
        }

        const node = template.nodes.find((n) => n.id === instance.currentNode)
        if (!node) {
          throw new Error(`节点 ${instance.currentNode} 不存在于模板中`)
        }

        // 执行节点
        const result = await this.executeNode(instance, node, template)

        // answer 节点（chatflow）：暂停等用户消息
        if (node.type === 'answer' && instance.mode === 'chatflow') {
          // C1 修复：把 answer 的 content 作为 assistant 消息追加到 instance.messages
          // 否则多轮对话中 LLM 节点看不到 AI 自己的上一轮回复，对话历史断裂
          if (!instance.messages) instance.messages = []
          instance.messages.push({ role: 'assistant', content: result.output, ts: Date.now() })
          instance.status = 'paused'
          instance.pauseReason = 'await_user'
          instance.pausedAt = Date.now()
          this.deps.instanceStore.save(instance)
          // 修复：清理运行标记——answer 暂停后 runLoop 退出，Map 残留会让
          // continueChatflow → resumeInstance 的 C7 检查 throw"已有执行循环在运行"（第二轮对话必挂）
          this.runningInstances.delete(instance.id)
          return
        }

        // end 节点：完成
        if (node.type === 'end') {
          instance.status = 'completed'
          instance.completedAt = Date.now()
          instance.output = result.output
          instance.currentNode = null
          this.deps.instanceStore.save(instance)

          // 触发 on_complete HOOK
          await this.runHooks(template, 'on_complete', {
            instanceId: instance.id,
            templateId: template.id,
            event: 'on_complete',
            output: result.output,
            context: { ...instance.context }
          })

          // 实例完成后归档（保留最近 50 个完成记录用于诊断，不直接删除）
          this.deps.instanceStore.archive(instance)
          this.runningInstances.delete(instance.id)
          return
        }

// 找下一节点
        const nextNodeId = findNextNode(template, node.id, instance.context)
        if (!nextNodeId) {
          // 没有下一节点，隐式完成
          instance.status = 'completed'
          instance.completedAt = Date.now()
          instance.currentNode = null
          this.deps.instanceStore.save(instance)
          this.deps.emit({ type: 'wf:completed', instanceId: instance.id, output: result.output })

          await this.runHooks(template, 'on_complete', {
            instanceId: instance.id,
            templateId: template.id,
            event: 'on_complete',
            output: result.output,
            context: { ...instance.context }
          })

          this.deps.instanceStore.archive(instance)
          this.runningInstances.delete(instance.id)
          return
        }

        instance.currentNode = nextNodeId
        this.deps.instanceStore.save(instance)
      }
    } catch (err) {
      // H2 修复：识别"用户取消"错误，标记为 cancelled 而非 failed
      // 用户关闭 human 弹窗是合理操作，不应让整个工作流标记为失败
      const errMsg = (err as Error).message
      const isUserCancel = errMsg.includes('用户取消了输入') || errMsg.includes('用户取消')
      if (isUserCancel) {
        instance.status = 'cancelled'
        instance.completedAt = Date.now()
        this.deps.instanceStore.save(instance)
        this.deps.emit({ type: 'wf:cancelled', instanceId: instance.id })
        this.deps.instanceStore.archive(instance) // H1 修复：cancelled 也归档实例文件
        this.runningInstances.delete(instance.id)
        console.log(`[workflow] 实例 ${instance.id} 已取消（用户取消输入）`)
        return
      }

      // 节点执行失败，标记实例失败
      instance.status = 'failed'
      instance.error = errMsg
      instance.completedAt = Date.now()
      this.deps.instanceStore.save(instance)
      this.deps.emit({ type: 'wf:failed', instanceId: instance.id, error: errMsg })
      this.deps.instanceStore.archive(instance) // H1 修复：failed 也归档实例文件，保留失败诊断
      this.runningInstances.delete(instance.id)
      console.error(`[workflow] 实例 ${instance.id} 失败:`, err)
    }
  }

  /**
   * 执行单个节点
   */
  private async executeNode(
    instance: WorkflowInstance,
    node: WorkflowNode,
    template: WorkflowTemplate
  ): Promise<{ output: string }> {
    // 记录 NodeRun
    const run: NodeRun = {
      nodeId: node.id,
      nodeName: node.name,
      nodeType: node.type,
      status: 'running',
      startedAt: Date.now()
    }
    instance.history.push(run)
    instance.currentNode = node.id
    this.deps.instanceStore.save(instance)

    // 发 node_start 事件
    this.deps.emit({
      type: 'wf:node_start',
      instanceId: instance.id,
      nodeId: node.id,
      nodeName: node.name,
      nodeType: node.type
    })

    // 触发 before_node HOOK
    const beforeHookResult = await this.runHooks(template, 'before_node', {
      instanceId: instance.id,
      templateId: template.id,
      event: 'before_node',
      nodeId: node.id,
      nodeName: node.name,
      nodeType: node.type,
      context: { ...instance.context }
    })
    if (beforeHookResult.action === 'block') {
      // H3 修复：before_node HOOK 的 block 应跳过当前节点而非失败整个工作流
      // 语义：block = "这个节点不要执行了"，而非"工作流失败"
      console.log(`[workflow] 节点 ${node.name} 被 before_node HOOK 跳过: ${beforeHookResult.message}`)
      run.status = 'skipped'
      run.endedAt = Date.now()
      this.deps.instanceStore.save(instance)
      // 返回空输出，runLoop 继续下一节点
      return { output: '' }
    }

    // 构建处理器上下文
    const resolver = createTemplateResolver(instance)
    const handlerCtx: NodeHandlerContext = {
      instance,
      node,
      emit: this.deps.emit,
      requestHumanInput: this.deps.requestHumanInput
        ? (prompt, inputType, options, timeoutMs) =>
            this.deps.requestHumanInput!(instance.id, prompt, inputType, options, timeoutMs)
        : undefined,
      resolveTemplate: resolver.resolve,
      // H4 修复：注入 preserveType 版本，tool 节点 args 用它保留原始类型
      resolveValue: (text: string) => resolveTemplate(text, instance.context, true),
      llm: this.deps.llm,
      toolPool: this.deps.toolPool,
      toolExecutor: this.deps.toolExecutor,
      skillLoader: this.deps.skillLoader,
      workflowsRoot: this.deps.workflowsRoot
    }

    try {
const handler = getNodeHandler(node.type)
      const result = await handler.handle(handlerCtx)

      // 写输出到 context（节点 id 作为 key）
      instance.context[node.id] = result.output

      // 更新 NodeRun
      run.status = 'done'
      run.endedAt = Date.now()
      run.output = result.output

      // 发 node_done 事件
      this.deps.emit({
        type: 'wf:node_done',
        instanceId: instance.id,
        nodeId: node.id,
        output: result.output
      })

      // 触发 after_node HOOK
      await this.runHooks(template, 'after_node', {
        instanceId: instance.id,
        templateId: template.id,
        event: 'after_node',
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        output: result.output,
        context: { ...instance.context }
      })

      return result
    } catch (err) {
      // 节点失败
      run.status = 'failed'
      run.endedAt = Date.now()
      run.error = (err as Error).message

      // 发 node_failed 事件
      this.deps.emit({
        type: 'wf:node_failed',
        instanceId: instance.id,
        nodeId: node.id,
        error: (err as Error).message
      })

      // 触发 on_fail HOOK
      await this.runHooks(template, 'on_fail', {
        instanceId: instance.id,
        templateId: template.id,
        event: 'on_fail',
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        error: (err as Error).message,
        context: { ...instance.context }
      })

      throw err
    }
  }

// ===== 内部：HOOK 执行 =====

  private async runHooks(
    template: WorkflowTemplate,
    event: WorkflowHookContext['event'],
    ctx: Omit<WorkflowHookContext, 'event'> & { event: WorkflowHookContext['event'] }
  ): Promise<{ action: 'continue' | 'block' | 'error'; message?: string }> {
    return this.deps.hookRunner.run(template.hooks, event, ctx)
  }
}
