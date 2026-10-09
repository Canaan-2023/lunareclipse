/**
 * 监控 preload 域（记忆工作流/DMN/日记/可视化）。
 * 为什么存在：记忆处理、DMN 心智模型与日记调度是主进程内的后台自治运行，前端需要开关、
 * 状态回执与按需拉取的可视化数据（P0）。
 * 作用：暴露 memoryWorkflow* / dmn* / diary* 开关与状态及 viz 数据接口、记忆面板查询。
 */
import { ipcRenderer } from 'electron'
import type {
  MonitorConfig,
  HealthCheckStatus,
  TimerInfo,
  SessionSummaryEffectiveInfo,
  SessionSummaryConfig
} from '@shared/types'

/** dmn:config:update 允许只传部分字段的深层部分更新（supervisor.updateConfig 走 mergeConfig
 * 深合并各子段，只覆盖显式给出的字段）。为什么存在：内部会话小卡片只改 summaryBudgetChars
 * 一个字段，类型若要求完整 SessionSummaryConfig 会强制 UI 先整读再整写（评审： 类型收紧
 * 导致的 TS2322/TS2739 根源），故此处放宽为子段部分类型。 */
export type MonitorConfigPatch = Partial<Omit<MonitorConfig, 'sessionSummary'>> & {
  sessionSummary?: Partial<SessionSummaryConfig>
}

export const api = {
  // 记忆处理工作流开关（UI 设置页可关，默认开启）
  memoryWorkflowToggle: (enabled: boolean) =>
    ipcRenderer.invoke('memoryWorkflow:toggle', enabled),
  // 记忆处理工作流状态查询（开关 + 是否正在处理一批）
  memoryWorkflowGetStatus: () =>
    ipcRenderer.invoke('memoryWorkflow:status') as Promise<{ enabled: boolean; running: boolean } | null>,
  dmnAnswer: (dmnId: string, answer: string | null) =>
    ipcRenderer.invoke('dmn:answer', dmnId, answer),
  dmnHeartbeatToggle: (enabled: boolean) =>
    ipcRenderer.invoke('dmn:heartbeat:toggle', enabled),
  dmnGetConfig: () => ipcRenderer.invoke('dmn:config:get') as Promise<MonitorConfig | null>,
  dmnUpdateConfig: (partial: MonitorConfigPatch) =>
    ipcRenderer.invoke('dmn:config:update', partial),
  /** 会话继承预算「生效值」回显（内部会话视图配置小卡片读显用） */
  dmnGetSessionSummaryEffective: () =>
    ipcRenderer.invoke('dmn:sessionSummary:effective') as Promise<SessionSummaryEffectiveInfo | null>,
  dmnSetFrontendIdle: (idle: boolean) =>
    ipcRenderer.invoke('dmn:frontend:idle', idle),
  dmnSetActiveSession: (sessionId: string | null) =>
    ipcRenderer.invoke('dmn:setActiveSession', sessionId),
  // 日记工作流开关（后端 DiaryWorkflowScheduler）
  diaryToggle: (enabled: boolean) =>
    ipcRenderer.invoke('dmn:diary:toggle', enabled),
  diaryGetStatus: () =>
    ipcRenderer.invoke('dmn:diary:status') as Promise<{ enabled: boolean; running: boolean } | null>,
  // P0 可视化数据
  vizGetAll: () => ipcRenderer.invoke('viz:getAll'),
  /** 记忆 tab 全量数据（按需加载：memories/nngTree/injections/rawMemoryList/directoryTree；aiId 指定 AI 编号 1=月蚀/2=莉莉丝） */
  vizMemoryTab: (aiId?: number) => ipcRenderer.invoke('viz:memoryTab', aiId ?? 1),
  /** 目录树懒加载：某目录的直接子节点 */
  vizDirectoryChildren: (absPath: string) => ipcRenderer.invoke('viz:directoryChildren', absPath),
  /** 手动触发一轮健康检查（监控面板「立即检查」按钮），返回最新快照 */
  vizHealthCheckRun: () => ipcRenderer.invoke('viz:healthCheckRun') as Promise<HealthCheckStatus | null>,
  vizReferenceModule: (moduleId: string) => ipcRenderer.invoke('viz:referenceModule', moduleId) as Promise<boolean>,
  vizTimerCancel: (id: string) => ipcRenderer.invoke('viz:timerCancel', id) as Promise<TimerInfo[]>,
  vizGetMemories: () => ipcRenderer.invoke('viz:memories'),
  vizGetNngTree: () => ipcRenderer.invoke('viz:nngTree'),
  /** 读取记忆完整内容（可视化面板查看用） */
  vizGetMemoryContent: (path: string) =>
    ipcRenderer.invoke('viz:memoryContent', path) as Promise<Record<string, unknown> | null>,
  /** 读取 NNG 完整内容（可视化面板查看用） */
  vizGetNngContent: (path: string) =>
    ipcRenderer.invoke('viz:nngContent', path) as Promise<Record<string, unknown> | null>,
  onDmnEvent: (callback: (event: unknown) => void) => {
    const channels = [
      'dmn:output',
      'dmn:start',
      'dmn:complete',
      'dmn:crash',
      'dmn:continueHint',
      'dmn:stopped',
      'dmn:cycleStart',
      'dmn:cycleComplete',
      'dmn:noMemory',

      'dmn:conditionWait',
      'dmn:askUser',
      'activation:trigger',
      'dmn:event'
    ]
    const listeners = channels.map((channel) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) =>
        callback({ type: channel, ...(payload as object) })
      ipcRenderer.on(channel, listener)
      return { channel, listener }
    })
    return () => {
      for (const { channel, listener } of listeners) {
        ipcRenderer.removeListener(channel, listener)
      }
    }
  },
}