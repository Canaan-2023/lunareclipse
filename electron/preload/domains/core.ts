/**
 * 系统内核 preload 域（配置/会话/窗口/LLM/API 端口与令牌/todos）。
 * 为什么存在：这些基础能力涉及主进程文件系统、动态端口与令牌鉴权，是渲染进程运行的地基，
 * 且令牌等敏感信息不对任意网页开放，统一在本桥白名单内暴露。
 * 作用：暴露 getApiPort/getApiToken（同步）、config 读写与订阅、会话读写、LLM 模型探测、todos 等基础方法。
 */
import { ipcRenderer, webUtils } from 'electron'
import type { AppConfig, LLMConfig, Session, InternalSession, InternalSessionSummary } from '@shared/types'

export const api = {
  /**
   * 拖拽/选择文件时取完整路径（Electron 32+ 移除了 File.path，必须走 webUtils）。
   * 同步 API，渲染进程直接调用。
   */
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  // 同步获取后端 API 服务器端口（主进程动态分配，必须通过 IPC 拿）
  getApiPort: () => ipcRenderer.sendSync('api:port') as number | undefined,
  // 同步获取本机 API 访问令牌（WS 握手 ?token= 与 HTTP Authorization 头用）。
  // 为什么存在：API server 已加令牌鉴权（WS 无同源限制，必须握手校验），渲染进程需要
  // 在主进程之外唯一合法获得该令牌的渠道就是 IPC；不暴露给任意网页（隔离在 preload）。
  // 作用：返回主进程随机生成的 apiToken；API server 未启动时返回空串（调用方按缺省处理）。
  getApiToken: () => ipcRenderer.sendSync('api:token') as string | undefined,
  /** 读取任务清单（计划面板用：.activation/todos-{sessionId}.json，会话级隔离） */
  todosGet: (sessionId?: string) =>
    ipcRenderer.invoke('todos:get', sessionId) as Promise<{ ok: boolean; todos?: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed'; priority: 'high' | 'medium' | 'low' }>; error?: string }>,
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (config: unknown) => ipcRenderer.invoke('config:set', config),
  /** 获取 config.json 文件路径（UI 跳转用） */
  getConfigFilePath: () => ipcRenderer.invoke('config:getFilePath') as Promise<string>,
  /** 一键重置全部工具策略（前端 AI + 各 DMN）到优化后的默认状态 */
  resetToolPolicy: () => ipcRenderer.invoke('config:resetToolPolicy') as Promise<{ ok: boolean; config?: AppConfig; error?: string }>,
  /**
   * 订阅 config 变化（AI 通过 update_abyss_md 等工具改 config 后触发，前端 appStore 同步刷新）。
   * 返回取消订阅函数。
   */
  onConfigChange: (callback: (config: AppConfig) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, config: AppConfig) => callback(config)
    ipcRenderer.on('config:changed', handler)
    return () => void ipcRenderer.removeListener('config:changed', handler)
  },
  llmListModels: (llmConfig: LLMConfig) =>
    ipcRenderer.invoke('llm:listModels', llmConfig) as Promise<{ ok: boolean; models: string[]; error?: string }>,
  llmTest: (llmConfig: LLMConfig) =>
    ipcRenderer.invoke('llm:test', llmConfig) as Promise<{ ok: boolean; models?: string[]; error?: string }>,
  listSessions: () => ipcRenderer.invoke('session:list'),
  getSession: (id: string) => ipcRenderer.invoke('session:get', id),
  createSession: (aiId?: number) => ipcRenderer.invoke('session:create', aiId),
  renameSession: (id: string, title: string) => ipcRenderer.invoke('session:rename', id, title),
  deleteSession: (id: string) => ipcRenderer.invoke('session:delete', id),
  saveMessages: (id: string, messages: unknown) =>
    ipcRenderer.invoke('session:saveMessages', id, messages),
  /** 内部会话列表（树块挂载位原位替换：前端内部会话面板用） */
  listInternalSessions: (sessionId: string) =>
    ipcRenderer.invoke('session:listInternalSessions', sessionId) as Promise<InternalSessionSummary[]>,
  /** 当前承接的内部会话 id（AI 设置的 active 指针；无则 null）——前端树高亮「正在承接」用 */
  getActiveInternalSession: (sessionId: string) =>
    ipcRenderer.invoke('session:getActiveInternalSession', sessionId) as Promise<string | null>,
  /** 内部会话详情 */
  getInternalSession: (sessionId: string, internalId: string) =>
    ipcRenderer.invoke('session:getInternalSession', sessionId, internalId) as Promise<InternalSession | null>,
  /** 新建内部会话（title 与可选首条内容） */
  createInternalSession: (sessionId: string, title: string, content?: string) =>
    ipcRenderer.invoke('session:createInternalSession', sessionId, title, content) as Promise<InternalSession | null>,
  /** 就地编辑内部会话（title/summary/messages 白名单字段） */
  updateInternalSession: (sessionId: string, internalId: string, patch: Partial<Pick<InternalSession, 'title' | 'summary' | 'messages' | 'cacheLocations'>>) =>
    ipcRenderer.invoke('session:updateInternalSession', sessionId, internalId, patch) as Promise<InternalSession | null>,
  /** 删除内部会话（无确认删除） */
  deleteInternalSession: (sessionId: string, internalId: string) =>
    ipcRenderer.invoke('session:deleteInternalSession', sessionId, internalId) as Promise<boolean>,
  /** 撤回/删除消息同步：从该会话名下所有内部会话剔除对应消息原文（返回剔除条数） */
  removeInternalMessages: (sessionId: string, messageIds: string[]) =>
    ipcRenderer.invoke('session:removeInternalMessages', sessionId, messageIds) as Promise<number>,
  setSessionModel: (id: string, model: string | null) =>
    ipcRenderer.invoke('session:setModel', id, model) as Promise<Session | null>,
  setSessionContinuousActivation: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('session:setContinuousActivation', id, enabled) as Promise<Session | null>,
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowMaximize: () => ipcRenderer.send('window:maximize'),
  windowClose: () => ipcRenderer.send('window:close'),
  getWindowMaximized: () => ipcRenderer.invoke('window:isMaximized') as Promise<boolean>,
  onWindowStateChange: (callback: (maximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { maximized: boolean }) =>
      callback(data.maximized)
    ipcRenderer.on('window:state', handler)
    return () => void ipcRenderer.removeListener('window:state', handler)
  },
  // ===== UI 缩放（分辨率自动适配 + 手动缩放） =====
  /** 获取当前缩放状态：mode=auto/manual, zoom=生效值, manual=手动覆盖值(null=自动) */
  uiZoomGet: () => ipcRenderer.invoke('ui:zoomGet') as Promise<{ mode: 'auto' | 'manual'; zoom: number; manual: number | null }>,
  /** 手动设置缩放（null 恢复自动）；写回 config 持久化 */
  uiZoomSet: (value: number | null) =>
    ipcRenderer.invoke('ui:zoomSet', value) as Promise<{ mode: 'auto' | 'manual'; zoom: number }>,
  /** 步进缩放（±0.1 等），同步持久化 */
  uiZoomStep: (delta: number) =>
    ipcRenderer.invoke('ui:zoomStep', delta) as Promise<{ mode: 'auto' | 'manual'; zoom: number }>,
  /** 重置为自动缩放（移除手动覆盖） */
  uiZoomReset: () => ipcRenderer.invoke('ui:zoomReset') as Promise<{ mode: 'auto'; zoom: number }>,
  /** 订阅缩放变化（快捷键/显示器变化/手动调整时推送） */
  onUiZoomChange: (callback: (state: { mode: 'auto' | 'manual'; zoom: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: { mode: 'auto' | 'manual'; zoom: number }) =>
      callback(state)
    ipcRenderer.on('ui:zoomChanged', handler)
    return () => void ipcRenderer.removeListener('ui:zoomChanged', handler)
  },
  onThemeChange: (callback: (theme: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, theme: string) => callback(theme)
    ipcRenderer.on('theme:change', handler)
    return () => void ipcRenderer.removeListener('theme:change', handler)
  },
}