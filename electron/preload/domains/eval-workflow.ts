/**
 * 评测套件（L6）+ 工作流引擎（L8）preload 域。
 * 为什么存在：评测运行/人工评分回传与工作流实例调度由主进程引擎承载（依赖 AppConfig.eval
 * 与共享工作流类型），前端面板只能经此桥查询、触发与订阅。
 * 作用：暴露 eval:listSuites/runSuite/getLastResult/submitHumanGrade 及工作流模板与实例的
 * 列/存/删/运行等系列方法。
 */
import { ipcRenderer } from 'electron'
// 评测套件元信息和结果类型走 shared；完整 EvalTask/SuiteResult 类型留主进程
import type { SuiteResult, SuiteMeta } from '../../main/eval'
// L8 工作流引擎：共享类型
import type {
  WorkflowTemplate,
  WorkflowInstance,
  WorkflowEngineEvent,
  WorkflowSaveParams,
  WorkflowDefineParams,
  WorkflowEditParams,
  WorkflowListParams,
  WorkflowRunParams,
  WorkflowModifyParams
} from '@shared/workflow/types'

export const api = {
  // ===== 评测（L6 验证层）=====
  /** 列出可用评测套件 */
  evalListSuites: () =>
    ipcRenderer.invoke('eval:listSuites') as Promise<SuiteMeta[]>,
  /** 运行指定套件（异步，返回完整 SuiteResult） */
  evalRunSuite: (suite: string) =>
    ipcRenderer.invoke('eval:runSuite', suite) as Promise<{
      ok: boolean
      result?: SuiteResult
      error?: string
    }>,
  /** 获取上次运行结果（前端刷新时恢复显示） */
  evalGetLastResult: () =>
    ipcRenderer.invoke('eval:getLastResult') as Promise<SuiteResult | null>,
  /** 人工评分提交（HumanGrader 用，由前端 EvalPanel 调用） */
  evalSubmitHumanGrade: (taskId: string, trial: number, pass: boolean, reason: string) =>
    ipcRenderer.invoke('eval:submitHumanGrade', taskId, trial, pass, reason) as Promise<{
      ok: boolean
      error?: string
    }>,

  // ===== 工作流引擎（L8）=====
  /** 列出模板（可按 mode/tag 过滤） */
  workflowListTemplates: (params?: WorkflowListParams) =>
    ipcRenderer.invoke('workflow:listTemplates', params) as Promise<WorkflowTemplate[]>,
  /** 获取单个模板 */
  workflowGetTemplate: (id: string) =>
    ipcRenderer.invoke('workflow:getTemplate', id) as Promise<WorkflowTemplate | null>,
  /** 创建/更新模板（save 语义） */
  workflowSaveTemplate: (params: WorkflowSaveParams) =>
    ipcRenderer.invoke('workflow:saveTemplate', params) as Promise<{ ok: boolean; data?: WorkflowTemplate; error?: string }>,
  /** 从 define 参数创建模板（AI 工具 workflow_define 用） */
  workflowDefineTemplate: (params: WorkflowDefineParams) =>
    ipcRenderer.invoke('workflow:defineTemplate', params) as Promise<{ ok: boolean; data?: WorkflowTemplate; error?: string }>,
  /** 编辑模板（add_node/remove_node/update_node 等操作） */
  workflowEditTemplate: (params: WorkflowEditParams) =>
    ipcRenderer.invoke('workflow:editTemplate', params) as Promise<{ ok: boolean; data?: WorkflowTemplate; error?: string }>,
  /** 删除模板 */
  workflowDeleteTemplate: (id: string) =>
    ipcRenderer.invoke('workflow:deleteTemplate', id) as Promise<{ ok: boolean; data?: boolean; error?: string }>,
  /** 导出模板为 JSON 字符串 */
  workflowExportTemplate: (id: string) =>
    ipcRenderer.invoke('workflow:exportTemplate', id) as Promise<{ ok: boolean; data?: string; error?: string }>,
  /** 从 JSON 字符串导入模板 */
  workflowImportTemplate: (jsonStr: string, newName?: string) =>
    ipcRenderer.invoke('workflow:importTemplate', jsonStr, newName) as Promise<{ ok: boolean; data?: WorkflowTemplate; error?: string }>,
  /** 启动工作流实例 */
  workflowRunInstance: (params: WorkflowRunParams) =>
    ipcRenderer.invoke('workflow:runInstance', params) as Promise<{ ok: boolean; data?: WorkflowInstance; error?: string }>,
  /** 修改实例（pause/resume/cancel/update_context） */
  workflowModifyInstance: (params: WorkflowModifyParams) =>
    ipcRenderer.invoke('workflow:modifyInstance', params) as Promise<{ ok: boolean; data?: WorkflowInstance | null; error?: string }>,
  /** 获取实例状态 */
  workflowGetInstance: (instanceId: string) =>
    ipcRenderer.invoke('workflow:getInstance', instanceId) as Promise<WorkflowInstance | null>,
  /** 列出所有活跃实例 */
  workflowListActiveInstances: () =>
    ipcRenderer.invoke('workflow:listActiveInstances') as Promise<WorkflowInstance[]>,
  /** 响应 human 节点 */
  workflowRespondHumanInput: (instanceId: string, response: string) =>
    ipcRenderer.invoke('workflow:respondHumanInput', instanceId, response) as Promise<{ ok: boolean; error?: string }>,
  /** 取消 human 节点 */
  workflowCancelHumanInput: (instanceId: string) =>
    ipcRenderer.invoke('workflow:cancelHumanInput', instanceId) as Promise<{ ok: boolean; error?: string }>,
  /** 响应 ask_user（AI 临时提问） */
  workflowRespondAskUser: (requestId: string, response: string) =>
    ipcRenderer.invoke('workflow:respondAskUser', requestId, response) as Promise<{ ok: boolean; error?: string }>,
  /** 取消 ask_user */
  workflowCancelAskUser: (requestId: string) =>
    ipcRenderer.invoke('workflow:cancelAskUser', requestId) as Promise<{ ok: boolean; error?: string }>,
  /** Chatflow 模式：用户发新消息后继续工作流 */
  workflowContinueChatflow: (instanceId: string, userMessage: string) =>
    ipcRenderer.invoke('workflow:continueChatflow', instanceId, userMessage) as Promise<{ ok: boolean; data?: WorkflowInstance | null; error?: string }>,
  /** 订阅工作流事件（返回取消订阅函数） */
  onWorkflowEvent: (callback: (event: WorkflowEngineEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: WorkflowEngineEvent) => callback(data)
    ipcRenderer.on('workflow:event', handler)
    return () => void ipcRenderer.removeListener('workflow:event', handler)
  },
}