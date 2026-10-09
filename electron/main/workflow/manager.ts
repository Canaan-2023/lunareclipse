/**
 * L8 工作流引擎：统一管理器
 *
 * 职责：
 * 1. 创建并持有 WorkflowEngine 实例（注入所有依赖）
 * 2. 管理模板 CRUD（WorkflowTemplateStore）
 * 3. 管理 pending human input（human 节点等用户响应时的 Promise resolver）
 * 4. 崩溃恢复：启动时扫描 paused/running 实例，恢复执行
 * 5. 暴露统一 API 供 IPC handlers 调用
 *
 * 依赖注入：由 server.ts 在启动时创建，注入 LLMClient / ToolRegistry / SkillLoader 等
 * 为什么存在：引擎实例/模板/待答复/崩溃恢复/外部 API 多份职责需要一个统一持有者，防止各调用方各自管理散落状态。
 * 不删理由：IPC 层与 AI 工具（workflow_define/run/modify/ask_user）全部经 manager 转发；
 * 删除它会导致 engine 装配散落到各调用方、模板/实例/待答复状态无处归属、崩溃恢复逻辑无处安放。
 */
import type { LLMClient } from '../api/llm'
import type { BaseDataPaths } from '../models/paths'
import type { SkillLoader } from '../skills/loader'
import type { McpClientManager } from '../mcp/client-manager'
import type { ToolRegistry } from '../tools'
import type {
  WorkflowTemplate,
  WorkflowInstance,
  WorkflowEngineEvent,
WorkflowNode,
  WorkflowEdge,
  WorkflowHook,
  WorkflowDefineParams,
  WorkflowRunParams,
  WorkflowModifyParams,
  WorkflowSaveParams,
  WorkflowListParams,
  WorkflowEditParams,
  AskUserParams
} from '@shared/workflow/types'
import { WorkflowEngine } from './engine'
import { buildEngineDeps, type PendingHumanInput, type MakeDistillCallbacks } from './build-engine-deps'
import { WorkflowTemplateStore, WorkflowInstanceStore, generateId } from './persister'
import { WorkflowHookRunner } from './hook-runner'
import { DEFAULT_TEMPLATES } from './default-templates'

/** manager 依赖（由 server.ts 注入） */
export interface WorkflowManagerDeps {
  paths: BaseDataPaths
  llmClient: LLMClient
  toolRegistry: ToolRegistry
  skillLoader: SkillLoader
  mcpClientManager?: McpClientManager
  /** 事件推送器（推给前端 WS） */
  emit: (event: WorkflowEngineEvent) => void
  /** 工具结果蒸馏回调工厂（可选）：工作流 LLM 节点的工具结果与主会话一致先蒸馏再进上下文 */
  makeDistillCallbacks?: MakeDistillCallbacks
  /** 工作流实例级并发闸门（可选， 动态性能优化）：上限随运行时设备参数动态变化 */
  concurrencyGate?: { acquire(signal?: AbortSignal): Promise<boolean>; release(): void }
}

export class WorkflowManager {
  private templateStore: WorkflowTemplateStore
  private instanceStore: WorkflowInstanceStore
  private engine: WorkflowEngine
  private hookRunner: WorkflowHookRunner

  /** pending human input resolvers：instanceId → resolver */
  private pendingHumanInputs = new Map<string, PendingHumanInput>()

  /** pending ask_user resolvers：requestId → resolver（ask_user 工具用，独立于 human 节点） */
  // C4 修复：增加 placeholder 字段，askUser 先放 placeholder，waitForAskUserResponse 覆盖为真正 resolver
  private pendingAskUser = new Map<string, { resolve: (response: string) => void; reject: (err: Error) => void; placeholder?: boolean }>()

  /**
   * 提前到达的 ask_user 响应缓冲：requestId → response。
   * 为什么存在：C4 双阶段设计存在竞态窗口——用户在 waitForAskUserResponse
   * 注册 resolver 之前就点了弹窗（前端事件走 IPC 比 LLM 工具调用链快），
   * respondAskUser 会 resolve placeholder 空函数 → 响应静默丢失、等待方挂起。
   * 不删理由：无缓冲时响应丢失且等待方永远等不到（无超时兜底），
   * 这是问用户-答用户链路的可靠性短板；Map 仅为竞态窗口服务，正常路径恒为空。
   */
  private pendingAskUserResponses = new Map<string, { cancelled: boolean; response?: string }>()

  /**
   * 内部事件订阅者（MemoryWorkflowScheduler 等后台组件订阅工作流事件）
   * 与 deps.emit（推前端 WS）并行：事件同时推前端和内部订阅者
   */
  private listeners = new Set<(event: WorkflowEngineEvent) => void>()

  constructor(private deps: WorkflowManagerDeps) {
    this.templateStore = new WorkflowTemplateStore(deps.paths)
    this.instanceStore = new WorkflowInstanceStore(deps.paths)
    this.hookRunner = new WorkflowHookRunner()

    // wrap emit：事件同时推前端 WS（deps.emit）和内部订阅者（listeners）
    // 内部订阅者（如 MemoryWorkflowScheduler）通过 onEvent 订阅 wf:completed/wf:failed 等事件
    const emitDual: (event: WorkflowEngineEvent) => void = (event) => {
      deps.emit(event)
      for (const listener of this.listeners) {
        listener(event)
      }
    }

    // 构建引擎依赖（LLM 接口 / 工具执行器 / 工具池 / SKILL 加载器 / human 输入回调）
    // 装配逻辑在 build-engine-deps.ts（纯函数），便于单独测试与复用
    this.engine = new WorkflowEngine(buildEngineDeps({
      paths: deps.paths,
      llmClient: deps.llmClient,
      toolRegistry: deps.toolRegistry,
      skillLoader: deps.skillLoader,
      mcpClientManager: deps.mcpClientManager,
      emit: emitDual,
      instanceStore: this.instanceStore,
      hookRunner: this.hookRunner,
      pendingHumanInputs: this.pendingHumanInputs,
      makeDistillCallbacks: deps.makeDistillCallbacks,
      concurrencyGate: deps.concurrencyGate
    }))

    // 确保默认工作流模板存在（已存在则跳过，不覆盖用户修改）
    this.ensureDefaultTemplates()
  }

  // ===== 事件订阅 =====

  /**
   * 订阅工作流引擎事件（内部订阅者用，如 MemoryWorkflowScheduler）

   * 与 deps.emit（推前端 WS）并行：引擎事件同时推前端和内部订阅者。
   * 用于后台组件监听 wf:completed/wf:failed 等事件，驱动后续调度逻辑。

   * @param listener 事件回调函数
   * @returns 取消订阅函数
   */
  onEvent(listener: (event: WorkflowEngineEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // ===== 默认模板初始化 =====

  /**
   * 确保内置默认工作流模板存在且为最新

   * 用固定 ID（wf_default_*）写入。
   * - 不存在：写入
   * - 已存在且 source=default：直接覆盖（每次启动同步内置版本，保证代码修改生效）
   * - 已存在且 source!=default（用户用 editTemplate 修改过 / AI 创建的）：跳过，尊重用户修改

   * 注意：editTemplate 修改默认模板时会把 source 改为 'user'，避免被覆盖丢失修改。
   */
  private ensureDefaultTemplates(): void {
    for (const template of DEFAULT_TEMPLATES) {
      const existing = this.templateStore.load(template.id)
      if (!existing) {
        this.templateStore.save(template)
        console.log(`[workflow] 初始化默认模板: ${template.name} (${template.id})`)
        continue
      }
      // 用户修改过 / AI 创建的模板不覆盖
      if (existing.source !== 'default') continue
      // source=default 的模板直接覆盖（内置模板代码修改时自动同步）
      this.templateStore.save(template)
    }
  }

  // ===== 崩溃恢复 =====

  /**
   * 启动时恢复崩溃前未完成的实例

   * 扫描 status=running/paused 的实例：
   * - running：从 currentNode 重新跑（已完成的节点不重跑，但当前节点会重新执行）
   * - paused + pauseReason=human：重新发 wf:paused 事件，等用户响应
   * - paused + pauseReason=await_user：等用户发下一条消息
   * - paused + pauseReason=manual：保持 paused，等用户手动恢复
   */
  async recoverInstances(): Promise<void> {
    const active = this.instanceStore.listActive()
    for (const instance of active) {
      const template = this.templateStore.load(instance.templateId)
      if (!template) {
        // 模板已被删除，标记实例失败
        instance.status = 'failed'
        instance.error = '模板已被删除'
        this.instanceStore.save(instance)
        continue
      }

      if (instance.status === 'running') {
        // 重新进入执行循环
        console.log(`[workflow] 恢复 running 实例 ${instance.id}，从节点 ${instance.currentNode} 继续`)
        // M10 修复：清理 history 中 status='running' 的 NodeRun（崩溃时未完成的）
        // 避免恢复后出现两个同节点的记录（前一个 'running'，后一个 'running'/'done'）
        for (const run of instance.history) {
          if (run.status === 'running') {
            run.status = 'skipped'
            run.endedAt = run.endedAt ?? run.startedAt
            run.error = '进程崩溃，节点未完成'
          }
        }
        // 标记为 paused 然后用 resumeInstance 重新进入 runLoop
        instance.status = 'paused'
        instance.pauseReason = 'manual'
        this.instanceStore.save(instance)
        await this.engine.resumeInstance(instance.id, template)
      } else if (instance.status === 'paused' && instance.pauseReason === 'human') {
        // C2 修复：崩溃恢复后 paused+human 实例的 runLoop 已随进程退出消失
        // 不能只设置 pendingHumanInputs resolver 就指望 runLoop 继续
        // 正确做法：重新进入 runLoop，让 human-handler 重新调 requestHumanInput
        // requestHumanInput 会重新发 wf:paused 事件 + 创建新的 pending Promise
        console.log(`[workflow] 恢复 paused+human 实例 ${instance.id}，重新进入 runLoop`)
        await this.engine.resumeInstance(instance.id, template)
      }
      // paused + await_user / manual：保持 paused，等用户操作
    }
  }

  // ===== 模板管理 =====

  /** 创建/更新模板（workflow_define / workflow_save 工具用） */
  saveTemplate(params: WorkflowSaveParams): WorkflowTemplate {
    const now = Date.now()
    const template: WorkflowTemplate = {
      id: params.templateId ?? generateId('wf'),
      name: params.name,
      description: params.description,
      tags: params.tags,
      mode: params.mode,
      nodes: params.nodes,
      edges: params.edges,
      hooks: params.hooks,
      createdAt: params.templateId ? (this.templateStore.load(params.templateId)?.createdAt ?? now) : now,
      updatedAt: now,
      source: 'ai'
    }
    this.templateStore.save(template)
    return template
  }

  /** 从 workflow_define 参数创建模板 */
  defineTemplate(params: WorkflowDefineParams): WorkflowTemplate {
    const now = Date.now()
    const existing = params.templateId ? this.templateStore.load(params.templateId) : null
    const template: WorkflowTemplate = {
      id: params.templateId ?? generateId('wf'),
      name: params.name,
      description: params.description,
      tags: params.tags,
      mode: params.mode,
      nodes: params.nodes,
      edges: params.edges,
      hooks: params.hooks,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      source: 'ai'
    }
    this.templateStore.save(template)
    return template
  }

  /** 获取模板 */
  getTemplate(id: string): WorkflowTemplate | null {
    return this.templateStore.load(id)
  }

  /** 列出模板 */
  listTemplates(params?: WorkflowListParams): WorkflowTemplate[] {
    return this.templateStore.listFiltered(params?.mode, params?.tag)
  }

  /** 删除模板 */
  deleteTemplate(id: string): boolean {
    return this.templateStore.delete(id)
  }

  /** 编辑模板（workflow_edit 工具用） */
  editTemplate(params: WorkflowEditParams): WorkflowTemplate {
    const template = this.templateStore.load(params.templateId)
    if (!template) {
      throw new Error(`模板 ${params.templateId} 不存在`)
    }

    switch (params.action) {
      case 'add_node': {
        const node = params.payload as unknown as WorkflowNode
        if (!node.id || !node.type) throw new Error('add_node 需要 payload 包含 id 和 type')
        template.nodes.push(node)
        break
      }
      case 'remove_node': {
        const { nodeId } = params.payload as { nodeId: string }
        template.nodes = template.nodes.filter((n) => n.id !== nodeId)
        // 同时删除相关连线
        template.edges = template.edges.filter((e) => e.from !== nodeId && e.to !== nodeId)
        break
      }
      case 'update_node': {
        const { nodeId, config, name } = params.payload as { nodeId: string; config?: Record<string, unknown>; name?: string }
        const node = template.nodes.find((n) => n.id === nodeId)
        if (!node) throw new Error(`节点 ${nodeId} 不存在`)
        if (config) node.config = config as WorkflowNode['config']
        if (name) node.name = name
        break
      }
      case 'add_edge': {
        const edge = params.payload as unknown as WorkflowEdge
        if (!edge.from || !edge.to) throw new Error('add_edge 需要 payload 包含 from 和 to')
        template.edges.push(edge)
        break
      }
      case 'remove_edge': {
        const { from, to } = params.payload as { from: string; to: string }
        template.edges = template.edges.filter((e) => !(e.from === from && e.to === to))
        break
      }
      case 'update_edge': {
        const { from, to, condition } = params.payload as { from: string; to: string; condition?: string }
        const edge = template.edges.find((e) => e.from === from && e.to === to)
        if (!edge) throw new Error(`连线 ${from}→${to} 不存在`)
        if (condition !== undefined) edge.condition = condition
        break
      }
      case 'add_hook': {
        const hook = params.payload as unknown as WorkflowHook
        if (!hook.event || !hook.action) throw new Error('add_hook 需要 payload 包含 event 和 action')
        if (!template.hooks) template.hooks = []
        template.hooks.push(hook)
        break
      }
      case 'remove_hook': {
        const { index } = params.payload as { index: number }
        if (!template.hooks) break
        if (index < 0 || index >= template.hooks.length) throw new Error(`hook 索引 ${index} 越界`)
        template.hooks.splice(index, 1)
        break
      }
      case 'rename': {
        const { name, description, tags } = params.payload as { name?: string; description?: string; tags?: string[] }
        if (name) template.name = name
        if (description !== undefined) template.description = description
        if (tags) template.tags = tags
        break
      }
      default:
        throw new Error(`未知的编辑操作: ${params.action}`)
    }

    template.updatedAt = Date.now()
    // 用户编辑过默认模板 → source 改为 'user'，避免 ensureDefaultTemplates 覆盖丢失修改
    if (template.source === 'default') {
      template.source = 'user'
    }
    this.templateStore.save(template)
    return template
  }

  /** 导出模板为 JSON */
  exportTemplate(id: string): string | null {
    return this.templateStore.exportToJson(id)
  }

  /** 导入模板 */
  importTemplate(jsonStr: string, newName?: string): WorkflowTemplate {
    return this.templateStore.importFromJson(jsonStr, newName)
  }

  // ===== 实例管理 =====

  /** 启动工作流实例 */
  async runInstance(params: WorkflowRunParams): Promise<WorkflowInstance> {
    const template = this.templateStore.load(params.templateId)
    if (!template) {
      throw new Error(`模板 ${params.templateId} 不存在`)
    }
    return this.engine.startInstance(template, params.input, params.sessionId)
  }

  /** 修改实例（暂停/恢复/取消/更新 context） */
  async modifyInstance(params: WorkflowModifyParams): Promise<WorkflowInstance | null> {
    const instance = this.instanceStore.load(params.instanceId)
    if (!instance) {
      throw new Error(`实例 ${params.instanceId} 不存在`)
    }

    switch (params.action) {
      case 'pause':
        return this.engine.pauseInstance(params.instanceId)
      case 'resume': {
        const template = this.templateStore.load(instance.templateId)
        if (!template) throw new Error('模板已被删除')
        return this.engine.resumeInstance(params.instanceId, template)
      }
      case 'cancel':
        return this.engine.cancelInstance(params.instanceId)
      case 'update_context':
        if (params.contextPatch) {
          return this.engine.updateContext(params.instanceId, params.contextPatch)
        }
        return instance
      default:
        throw new Error(`未知的修改操作: ${params.action}`)
    }
  }

  /** 获取实例状态 */
  getInstance(instanceId: string): WorkflowInstance | null {
    return this.engine.getInstance(instanceId)
  }

  // ===== 人工节点响应 =====

  /**
   * 响应 human 节点的用户输入
   * 前端收到 wf:paused 事件后弹窗，用户响应后通过 IPC 调此方法
   * 清理超时 timer 避免误触发
   */
  respondHumanInput(instanceId: string, response: string): boolean {
    const pending = this.pendingHumanInputs.get(instanceId)
    if (!pending) {
      return false
    }
    if (pending.timer) clearTimeout(pending.timer)
    this.pendingHumanInputs.delete(instanceId)
    pending.resolve(response)
    return true
  }

  /** 取消 human 节点（用户关闭弹窗），清理超时 timer */
  cancelHumanInput(instanceId: string): boolean {
    const pending = this.pendingHumanInputs.get(instanceId)
    if (!pending) {
      return false
    }
    if (pending.timer) clearTimeout(pending.timer)
    this.pendingHumanInputs.delete(instanceId)
    pending.reject(new Error('用户取消了输入'))
    return true
  }

  // ===== Chatflow 继续 =====

  /**
   * Chatflow 模式：用户发新消息后继续工作流
   * 前端检测到会话有 paused + pauseReason=await_user 的实例时，调此方法而非启动新 AI 回复
   */
  async continueChatflow(instanceId: string, userMessage: string): Promise<WorkflowInstance | null> {
    const instance = this.instanceStore.load(instanceId)
    if (!instance) {
      throw new Error(`实例 ${instanceId} 不存在`)
    }
    if (instance.pauseReason !== 'await_user') {
      throw new Error(`实例 ${instanceId} 不在等待用户消息状态`)
    }
    const template = this.templateStore.load(instance.templateId)
    if (!template) {
      throw new Error('模板已被删除')
    }
    return this.engine.resumeInstance(instanceId, template, userMessage)
  }

  // ===== ask_user 工具（独立于 human 节点） =====

  /**
   * AI 临时问用户一个问题（ask_user 工具用）
   * C4 修复：原设计 askUser 返回 Promise<requestId> 且内部创建等待响应的 Promise，
   * 导致调用方 await askUser 时拿不到 requestId（死锁），或拿不到响应（被 .then 丢弃）。
   * 改为同步返回 requestId，调用方再通过 waitForAskUserResponse 等待响应。
   */
  askUser(params: AskUserParams): string {
    const requestId = generateId('ask')
    const inputType = params.inputType ?? 'text'
    // 只创建 placeholder resolver，真正的 resolver 由 waitForAskUserResponse 设置
    // 此处不创建等待 Promise，避免死锁
    this.pendingAskUser.set(requestId, {
      resolve: () => {},
      reject: () => {},
      placeholder: true
    })
    // 发 wf:paused 事件（前端弹窗）
    this.deps.emit({
      type: 'wf:paused',
      instanceId: `ask_${requestId}`,
      reason: 'human',
      prompt: params.question,
      inputType,
      options: params.options
    })
    return requestId
  }

  /**
   * 等待 ask_user 的用户响应
   * 调用方在 askUser 后立即调用此方法等待响应
   */
  waitForAskUserResponse(requestId: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // 竞态窗口内响应/取消已提前到达（见 pendingAskUserResponses 注释）→ 直接消费，不再挂等
      const early = this.pendingAskUserResponses.get(requestId)
      if (early !== undefined) {
        this.pendingAskUserResponses.delete(requestId)
        this.pendingAskUser.delete(requestId)
        if (early.cancelled) {
          reject(new Error('用户取消了输入'))
        } else {
          resolve(early.response ?? '')
        }
        return
      }
      const existing = this.pendingAskUser.get(requestId)
      if (existing && !existing.placeholder) {
        // 已有真正的 resolver（理论上不会走到这里，除非重复调用）
        reject(new Error(`askUser ${requestId} 已有等待中的 resolver`))
        return
      }
      // 覆盖 placeholder 为真正的 resolver
      this.pendingAskUser.set(requestId, { resolve, reject })
    })
  }

  /** 响应 ask_user */
  respondAskUser(requestId: string, response: string): boolean {
    const pending = this.pendingAskUser.get(requestId)
    if (!pending) return false
    if (pending.placeholder) {
      // resolver 尚未注册（waitForAskUserResponse 未执行）→ 缓冲响应，
      // 由 waitForAskUserResponse 注册时消费；不 resolve 空函数导致响应丢失
      this.pendingAskUserResponses.set(requestId, { cancelled: false, response })
      this.pendingAskUser.delete(requestId)
      return true
    }
    this.pendingAskUser.delete(requestId)
    pending.resolve(response)
    return true
  }

  /** 取消 ask_user */
  cancelAskUser(requestId: string): boolean {
    const pending = this.pendingAskUser.get(requestId)
    if (!pending) return false
    this.pendingAskUser.delete(requestId)
    if (pending.placeholder) {
      // 取消先于 resolver 注册到达：缓冲取消标记，由 waitForAskUserResponse 注册时消费，
      // 避免等待方永远挂起（与 pendingAskUserResponses 的响应缓冲同一竞态窗口）
      this.pendingAskUserResponses.set(requestId, { cancelled: true })
      return true
    }
    pending.reject(new Error('用户取消了输入'))
    return true
  }

  // ===== 诊断 =====

  /** 列出所有活跃实例（前端 UI 用） */
  listActiveInstances(): WorkflowInstance[] {
    return this.instanceStore.listActive()
  }
}
