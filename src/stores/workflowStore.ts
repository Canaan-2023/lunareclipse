/**
 * 为什么存在：工作流引擎运行状态（模板/实例/事件/token 流/human 弹窗）独立于
 * 主会话且与 UI 解耦（主进程 WorkflowManager 才是真源），需专门 store 承载订阅与缓存。
 * 作用：持有模板列表/活跃实例/实例详情，订阅 workflow:event 更新状态，
 * 暴露 run/pause/resume/cancel/respondHumanInput 等 actions 给 UI。
 */
import { create } from 'zustand'
import { useSyncExternalStore } from 'react'
import type {
  WorkflowTemplate,
  WorkflowInstance,
  WorkflowEngineEvent,
  WorkflowMode,
  WorkflowSaveParams,
  WorkflowDefineParams,
  WorkflowEditParams,
  WorkflowListParams,
  WorkflowRunParams,
  WorkflowModifyParams
} from '@shared/workflow/types'

/**
 * 工作流引擎：前端 store



 * 职责：
 * 1. 持有模板列表、活跃实例列表、当前实例详情
 * 2. 订阅主进程 workflow:event 事件，按事件类型更新状态
 * 3. 暴露 actions 给 UI 组件调用（run/pause/resume/cancel/respondHumanInput 等）
 * 4. 维护流式 token 缓存（按 instanceId 分组，供 UI 实时渲染）
 * 5. 维护 human 节点弹窗状态（pendingHumanInput）和 ask_user 弹窗状态（pendingAskUser）

 * 不做的事：
 * - 不直接调 LLM/工具（由主进程 WorkflowManager 处理）
 * - 不持久化（模板和实例状态在主进程持久化，前端只缓存）
 */

/** human 节点弹窗状态 */
export interface PendingHumanInput {
  instanceId: string
  prompt: string
  inputType: 'confirm' | 'text' | 'choice'
  options?: string[]
}

/** ask_user 弹窗状态（instanceId 字段为 ask_{requestId} 格式，用于区分 human 节点） */
export interface PendingAskUser {
  requestId: string
  question: string
  inputType: 'confirm' | 'text' | 'choice'
  options?: string[]
}

/** 单个实例的流式 token 缓存 */
interface InstanceStream {
  /** 累积的 token 文本 */
  text: string
  /** 累积的 reasoning 文本 */
  reasoning: string
  /** 当前节点 ID（用于 UI 标识） */
  currentNodeId?: string
  /** 工具调用列表（按调用顺序） */
  toolCalls: Array<{
    toolCallId: string
    toolName: string
    args?: Record<string, unknown>
    result?: string
    status: 'running' | 'done' | 'error'
  }>
}

interface WorkflowState {
  /** 模板列表（按 mode/tag 过滤后的缓存） */
  templates: WorkflowTemplate[]
  /** 模板列表是否已加载（避免重复加载） */
  templatesLoaded: boolean
  /** 活跃实例列表（running/paused） */
  activeInstances: WorkflowInstance[]
  /** 当前关注的实例详情（UI 展开/查看时填充） */
  currentInstance: WorkflowInstance | null
  /** 流式 token 缓存（按 instanceId 分组） */
  streams: Record<string, InstanceStream>
  /** human 节点弹窗状态（null 表示无弹窗） */
  pendingHumanInput: PendingHumanInput | null
  /** ask_user 弹窗状态（null 表示无弹窗） */
  pendingAskUser: PendingAskUser | null
  /** 错误信息（UI 提示用） */
  error: string | null
  /** 是否正在加载 */
  loading: boolean

  // ===== Actions =====
  /** 初始化：订阅事件 + 加载模板和活跃实例 */
  init: () => Promise<void>
  /** 刷新模板列表 */
  refreshTemplates: (params?: WorkflowListParams) => Promise<void>
  /** 刷新活跃实例列表 */
  refreshActiveInstances: () => Promise<void>
  /** 获取实例详情 */
  loadInstance: (instanceId: string) => Promise<void>
  /** 启动工作流实例 */
  runInstance: (params: WorkflowRunParams) => Promise<WorkflowInstance | null>
  /** 修改实例（pause/resume/cancel/update_context） */
  modifyInstance: (params: WorkflowModifyParams) => Promise<WorkflowInstance | null>
  /** 响应 human 节点 */
  respondHumanInput: (response: string) => Promise<boolean>
  /** 取消 human 节点 */
  cancelHumanInput: () => Promise<boolean>
  /** 响应 ask_user */
  respondAskUser: (response: string) => Promise<boolean>
  /** 取消 ask_user */
  cancelAskUser: () => Promise<boolean>
  /** Chatflow 继续 */
  continueChatflow: (instanceId: string, userMessage: string) => Promise<WorkflowInstance | null>
  /** 保存模板 */
  saveTemplate: (params: WorkflowSaveParams) => Promise<WorkflowTemplate | null>
  /** 定义模板（AI 工具 workflow_define 用） */
  defineTemplate: (params: WorkflowDefineParams) => Promise<WorkflowTemplate | null>
  /** 编辑模板 */
  editTemplate: (params: WorkflowEditParams) => Promise<WorkflowTemplate | null>
  /** 删除模板 */
  deleteTemplate: (id: string) => Promise<boolean>
  /** 导出模板 */
  exportTemplate: (id: string) => Promise<string | null>
  /** 导入模板 */
  importTemplate: (jsonStr: string, newName?: string) => Promise<WorkflowTemplate | null>
  /** 清除错误 */
  clearError: () => void

  // ===== 内部：事件处理 =====
  _handleEvent: (event: WorkflowEngineEvent) => void
  /** 取消订阅函数（init 时设置，组件卸载时调用） */
  _unsubscribe: (() => void) | null
}

const workflowStore = create<WorkflowState>((set, get) => ({
  templates: [],
  templatesLoaded: false,
  activeInstances: [],
  currentInstance: null,
  streams: {},
  pendingHumanInput: null,
  pendingAskUser: null,
  error: null,
  loading: false,

  init: async () => {
    // 避免重复订阅
    if (get()._unsubscribe) return

    // 订阅主进程事件
    const unsubscribe = window.lunareclipse.onWorkflowEvent((event: WorkflowEngineEvent) => {
      get()._handleEvent(event)
    })
    set({ _unsubscribe: unsubscribe })

    // 加载初始数据
    await Promise.all([
      get().refreshTemplates(),
      get().refreshActiveInstances()
    ])
  },

  refreshTemplates: async (params?: WorkflowListParams) => {
    try {
      const templates = await window.lunareclipse.workflowListTemplates(params)
      set({ templates, templatesLoaded: true })
    } catch (err) {
      set({ error: `加载模板列表失败: ${(err as Error).message}` })
    }
  },

  refreshActiveInstances: async () => {
    try {
      const instances = await window.lunareclipse.workflowListActiveInstances()
      set({ activeInstances: instances })
    } catch (err) {
      set({ error: `加载活跃实例失败: ${(err as Error).message}` })
    }
  },

  loadInstance: async (instanceId: string) => {
    try {
      const instance = await window.lunareclipse.workflowGetInstance(instanceId)
      set({ currentInstance: instance })
    } catch (err) {
      set({ error: `加载实例失败: ${(err as Error).message}` })
    }
  },

  runInstance: async (params: WorkflowRunParams) => {
    set({ loading: true, error: null })
    try {
      const result = await window.lunareclipse.workflowRunInstance(params)
      if (!result.ok) {
        set({ error: result.error ?? '启动工作流失败' })
        return null
      }
      // 初始化流式缓存
      if (result.data) {
        set((state) => ({
          streams: {
            ...state.streams,
            [result.data!.id]: { text: '', reasoning: '', toolCalls: [] }
          }
        }))
      }
      await get().refreshActiveInstances()
      return result.data ?? null
    } catch (err) {
      set({ error: `启动工作流失败: ${(err as Error).message}` })
      return null
    } finally {
      set({ loading: false })
    }
  },

  modifyInstance: async (params: WorkflowModifyParams) => {
    try {
      const result = await window.lunareclipse.workflowModifyInstance(params)
      if (!result.ok) {
        set({ error: result.error ?? '修改实例失败' })
        return null
      }
      await get().refreshActiveInstances()
      return result.data ?? null
    } catch (err) {
      set({ error: `修改实例失败: ${(err as Error).message}` })
      return null
    }
  },

  respondHumanInput: async (response: string) => {
    const pending = get().pendingHumanInput
    if (!pending) return false
    try {
      const result = await window.lunareclipse.workflowRespondHumanInput(pending.instanceId, response)
      if (!result.ok) {
        set({ error: result.error ?? '响应 human 节点失败' })
        return false
      }
      set({ pendingHumanInput: null })
      return true
    } catch (err) {
      set({ error: `响应 human 节点失败: ${(err as Error).message}` })
      return false
    }
  },

  cancelHumanInput: async () => {
    const pending = get().pendingHumanInput
    if (!pending) return false
    try {
      const result = await window.lunareclipse.workflowCancelHumanInput(pending.instanceId)
      if (!result.ok) {
        set({ error: result.error ?? '取消 human 节点失败' })
        return false
      }
      set({ pendingHumanInput: null })
      return true
    } catch (err) {
      set({ error: `取消 human 节点失败: ${(err as Error).message}` })
      return false
    }
  },

  respondAskUser: async (response: string) => {
    const pending = get().pendingAskUser
    if (!pending) return false
    try {
      const result = await window.lunareclipse.workflowRespondAskUser(pending.requestId, response)
      if (!result.ok) {
        set({ error: result.error ?? '响应 ask_user 失败' })
        return false
      }
      set({ pendingAskUser: null })
      return true
    } catch (err) {
      set({ error: `响应 ask_user 失败: ${(err as Error).message}` })
      return false
    }
  },

  cancelAskUser: async () => {
    const pending = get().pendingAskUser
    if (!pending) return false
    try {
      const result = await window.lunareclipse.workflowCancelAskUser(pending.requestId)
      if (!result.ok) {
        set({ error: result.error ?? '取消 ask_user 失败' })
        return false
      }
      set({ pendingAskUser: null })
      return true
    } catch (err) {
      set({ error: `取消 ask_user 失败: ${(err as Error).message}` })
      return false
    }
  },

  continueChatflow: async (instanceId: string, userMessage: string) => {
    try {
      const result = await window.lunareclipse.workflowContinueChatflow(instanceId, userMessage)
      if (!result.ok) {
        set({ error: result.error ?? '继续 Chatflow 失败' })
        return null
      }
      await get().refreshActiveInstances()
      return result.data ?? null
    } catch (err) {
      set({ error: `继续 Chatflow 失败: ${(err as Error).message}` })
      return null
    }
  },

  saveTemplate: async (params: WorkflowSaveParams) => {
    try {
      const result = await window.lunareclipse.workflowSaveTemplate(params)
      if (!result.ok) {
        set({ error: result.error ?? '保存模板失败' })
        return null
      }
      await get().refreshTemplates()
      return result.data ?? null
    } catch (err) {
      set({ error: `保存模板失败: ${(err as Error).message}` })
      return null
    }
  },

  defineTemplate: async (params: WorkflowDefineParams) => {
    try {
      const result = await window.lunareclipse.workflowDefineTemplate(params)
      if (!result.ok) {
        set({ error: result.error ?? '定义模板失败' })
        return null
      }
      await get().refreshTemplates()
      return result.data ?? null
    } catch (err) {
      set({ error: `定义模板失败: ${(err as Error).message}` })
      return null
    }
  },

  editTemplate: async (params: WorkflowEditParams) => {
    try {
      const result = await window.lunareclipse.workflowEditTemplate(params)
      if (!result.ok) {
        set({ error: result.error ?? '编辑模板失败' })
        return null
      }
      await get().refreshTemplates()
      return result.data ?? null
    } catch (err) {
      set({ error: `编辑模板失败: ${(err as Error).message}` })
      return null
    }
  },

  deleteTemplate: async (id: string) => {
    try {
      const result = await window.lunareclipse.workflowDeleteTemplate(id)
      if (!result.ok) {
        set({ error: result.error ?? '删除模板失败' })
        return false
      }
      await get().refreshTemplates()
      return true
    } catch (err) {
      set({ error: `删除模板失败: ${(err as Error).message}` })
      return false
    }
  },

  exportTemplate: async (id: string) => {
    try {
      const result = await window.lunareclipse.workflowExportTemplate(id)
      if (!result.ok) {
        set({ error: result.error ?? '导出模板失败' })
        return null
      }
      return result.data ?? null
    } catch (err) {
      set({ error: `导出模板失败: ${(err as Error).message}` })
      return null
    }
  },

  importTemplate: async (jsonStr: string, newName?: string) => {
    try {
      const result = await window.lunareclipse.workflowImportTemplate(jsonStr, newName)
      if (!result.ok) {
        set({ error: result.error ?? '导入模板失败' })
        return null
      }
      await get().refreshTemplates()
      return result.data ?? null
    } catch (err) {
      set({ error: `导入模板失败: ${(err as Error).message}` })
      return null
    }
  },

  clearError: () => set({ error: null }),

  // ===== 内部：事件处理 =====

  _handleEvent: (event: WorkflowEngineEvent) => {
    switch (event.type) {
      case 'wf:started':
        // 新实例启动：初始化流式缓存
        set((state) => ({
          streams: {
            ...state.streams,
            [event.instanceId]: { text: '', reasoning: '', toolCalls: [] }
          }
        }))
        get().refreshActiveInstances()
        break

      case 'wf:node_start':
        // 节点开始：更新当前节点 ID
        set((state) => {
          const stream = state.streams[event.instanceId]
          if (!stream) return state
          return {
            streams: {
              ...state.streams,
              [event.instanceId]: { ...stream, currentNodeId: event.nodeId }
            }
          }
        })
        break

      case 'wf:token':
        // 流式 token：累积到缓存
        set((state) => {
          const stream = state.streams[event.instanceId]
          if (!stream) return state
          return {
            streams: {
              ...state.streams,
              [event.instanceId]: { ...stream, text: stream.text + event.token }
            }
          }
        })
        break

      case 'wf:reasoning':
        // 推理 token：累积到 reasoning
        set((state) => {
          const stream = state.streams[event.instanceId]
          if (!stream) return state
          return {
            streams: {
              ...state.streams,
              [event.instanceId]: { ...stream, reasoning: stream.reasoning + event.token }
            }
          }
        })
        break

      case 'wf:tool_start':
        // 工具开始：加入工具调用列表
        set((state) => {
          const stream = state.streams[event.instanceId]
          if (!stream) return state
          return {
            streams: {
              ...state.streams,
              [event.instanceId]: {
                ...stream,
                toolCalls: [
                  ...stream.toolCalls,
                  {
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    args: event.args,
                    status: 'running' as const
                  }
                ]
              }
            }
          }
        })
        break

      case 'wf:tool_end':
        // 工具结束：更新工具调用状态
        set((state) => {
          const stream = state.streams[event.instanceId]
          if (!stream) return state
          return {
            streams: {
              ...state.streams,
              [event.instanceId]: {
                ...stream,
                toolCalls: stream.toolCalls.map((tc) =>
                  tc.toolCallId === event.toolCallId
                    ? { ...tc, result: event.result, status: 'done' as const }
                    : tc
                )
              }
            }
          }
        })
        break

      case 'wf:answer':
        // Chatflow answer 节点：把 content 作为 AI 回复显示
        // 这里只更新流式缓存，实际 UI 显示由 ChatArea 处理
        set((state) => {
          const stream = state.streams[event.instanceId]
          if (!stream) return state
          return {
            streams: {
              ...state.streams,
              [event.instanceId]: { ...stream, text: event.content }
            }
          }
        })
        break

      case 'wf:paused':
        // 实例暂停：如果是 human 节点，弹出输入框
        if (event.reason === 'human' && event.prompt) {
          // 区分 ask_user（instanceId 以 ask_ 开头）和 human 节点
          if (event.instanceId.startsWith('ask_')) {
            const requestId = event.instanceId.slice(4)
            set({
              pendingAskUser: {
                requestId,
                question: event.prompt,
                inputType: (event.inputType ?? 'text') as 'confirm' | 'text' | 'choice',
                options: event.options
              }
            })
          } else {
            set({
              pendingHumanInput: {
                instanceId: event.instanceId,
                prompt: event.prompt,
                inputType: (event.inputType ?? 'text') as 'confirm' | 'text' | 'choice',
                options: event.options
              }
            })
          }
        }
        get().refreshActiveInstances()
        break

      case 'wf:resumed':
        // 实例恢复：清空弹窗状态
        set({ pendingHumanInput: null, pendingAskUser: null })
        get().refreshActiveInstances()
        break

      case 'wf:node_done':
      case 'wf:node_failed':
        // 节点完成/失败：刷新实例详情（如果有 currentInstance）
        if (get().currentInstance?.id === event.instanceId) {
          get().loadInstance(event.instanceId)
        }
        break

      case 'wf:completed':
      case 'wf:failed':
      case 'wf:cancelled':
        // 实例结束：清理流式缓存，刷新活跃列表
        set((state) => {
          const streams = { ...state.streams }
          delete streams[event.instanceId]
          return { streams }
        })
        get().refreshActiveInstances()
        // 如果有错误，显示
        if (event.type === 'wf:failed') {
          set({ error: `工作流失败: ${event.error}` })
        }
        break

      default:
        // 忽略其他事件
        break
    }
  },

  _unsubscribe: null
}))

// 绕开 zustand useStore 的 useCallback（React 19 组合 bug，
// areHookInputsEqual 收到 undefined deps 崩溃——见 appStore 同款注释）
const useWorkflowStoreHook = <T>(selector: (s: WorkflowState) => T): T =>
  useSyncExternalStore(
    workflowStore.subscribe,
    () => selector(workflowStore.getState()),
    () => selector(workflowStore.getInitialState())
  )
export const useWorkflowStore = Object.assign(useWorkflowStoreHook, workflowStore)

// 类型再导出，方便组件使用
export type { WorkflowTemplate, WorkflowInstance, WorkflowMode }
