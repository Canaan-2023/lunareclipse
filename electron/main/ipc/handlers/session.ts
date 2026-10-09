/**
 * 会话管理 IPC：渲染进程对会话（月蚀对话 + 内部会话）的
 * 列表/读取/创建/改名/删除/清空等操作在这里注册通道，
 * 参数经校验后转发给 SessionStore，是聊天与设置界面的数据出入口。
 */
import type { ipcMain as ipcMainType } from 'electron'
import type { SessionStore } from '../../api/session-store'
import type { ConfigStore } from '../../api/config-store'
import type { InternalSessionStore } from '../../services/internal-session-store'
import { DEFAULT_INTERNAL_SESSION_TITLE } from '../../services/internal-session-store'
import type { ChatMessage, Session, InternalSession, InternalSessionSummary } from '@shared/types'
import { safeHandle } from './safe-handle'
import { clearPreviewFile } from '../../services/workspace-state'

export function registerSessionHandlers(
  ipc: typeof ipcMainType,
  sessionStore: SessionStore,
  configStore: ConfigStore,
  getInternalSessionStore: () => InternalSessionStore | null,
  onSessionDeleted?: (id: string) => void
): void {
  ipc.handle('session:list', () => sessionStore.list())

  ipc.handle('session:get', (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return null
    return sessionStore.get(id)
  })

  // 多 AI：新建会话可指定所属 AI 编号（aiId；旧调用不传 = 月蚀 AI1）
  ipc.handle('session:create', (_event, aiId: unknown) => {
    const n = typeof aiId === 'number' && Number.isInteger(aiId) && aiId >= 1 ? aiId : undefined
    return sessionStore.create(n)
  })

  safeHandle<Session | null>(
    ipc, 'session:rename',
    (_event, id: unknown, title: unknown) => {
      if (typeof id !== 'string' || !id) return null
      sessionStore.rename(id, typeof title === 'string' ? title : '')
      return sessionStore.get(id)
    },
    null
  )

  ipc.handle('session:delete', (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return false
    sessionStore.delete(id)
    // 级联：清掉该会话名下内部会话的在飞写链（文件已随会话文件夹删除）
    getInternalSessionStore()?.deleteByOwner(id)
    clearPreviewFile()
    onSessionDeleted?.(id)
    return true
  })

  safeHandle<boolean>(
    ipc, 'session:saveMessages',
    (_event, id: unknown, messages: unknown) => {
      if (typeof id !== 'string' || !id) return false
      if (!Array.isArray(messages)) return false
      sessionStore.saveMessages(id, messages as ChatMessage[])
      return true
    },
    false // 校验失败返回 false；保存异常直接抛出由渲染进程捕获
  )

  safeHandle<Session | null>(
    ipc, 'session:setModel',
    (_event, id: unknown, model: unknown) => {
      if (typeof id !== 'string' || !id) return null
      sessionStore.setModel(id, typeof model === 'string' ? model : null)
      return sessionStore.get(id)
    },
    null
  )

  safeHandle<Session | null>(
    ipc, 'session:setContinuousActivation',
    (_event, id: unknown, enabled: unknown) => {
      // 持续激活从 session 级提升为全局级（切换会话不中断）。
      // 老 channel 名保留兼容前端，实际写入全局配置。
      if (typeof id !== 'string' || !id) return null
      const cfg = configStore.get()
      configStore.save({ ...cfg, continuousActivation: enabled === true })
      return sessionStore.get(id) ?? null
    },
    null
  )

  // ===== 内部会话 CRUD：前端树块挂载位原位替换为内部会话列表/详情=====
  // 读 2：列表（不含消息正文）+ 单条详情

  ipc.handle('session:listInternalSessions', (_event, sessionId: unknown): InternalSessionSummary[] => {
    if (typeof sessionId !== 'string' || !sessionId) return []
    const store = getInternalSessionStore()
    if (!store) return []
    return store.list(sessionId)
  })

  // 当前承接指针（AI 经 session_select 设置）：前端树用它标出「正在承接」的那条会话。
  // 与 activeInternalSession（用户点开的详情）无关——前者是 AI 的写入目标，后者是 UI 预览。
  ipc.handle('session:getActiveInternalSession', (_event, sessionId: unknown): string | null => {
    if (typeof sessionId !== 'string' || !sessionId) return null
    const store = getInternalSessionStore()
    if (!store) return null
    return store.getActive(sessionId)
  })

  ipc.handle('session:getInternalSession', (_event, sessionId: unknown, internalId: unknown): InternalSession | null => {
    if (typeof sessionId !== 'string' || !sessionId) return null
    if (typeof internalId !== 'string' || !internalId) return null
    const store = getInternalSessionStore()
    if (!store) return null
    return store.get(sessionId, internalId)
  })

  // 写 3：创建 / 更新（title/summary/messages 就地编辑）/ 删除

  // 前端手动「新建会话」：保持独立根语义（不挂 parentId、不向下展开）。
  // 为什么：向下展开只发生在 AI 新建链路（自动路由/session_select 工具按候选尾端挂父）；
  // 用户手动新建是显式开启一张与既有会话无关的白纸，挂父会错误地把已有工作线压缩冻结。
  // 若未来前端要「在该会话下新建子会话」（手动分叉），需另行传入 parentId 并复用 store.create 的继承参数。
  // 建即承接：create 成功后写入 active 指针（与 session_select 工具 create 路径、自动路由
  // createAndActivate 建即承接语义对齐）。为什么必须：主回复轮是「显式选择优先」——active
  // 指针残留指向老承接时，新建分支永远收不到新消息注入（0.31 线上缺陷）；用户手动新建就是
  // 显式宣告「接下来写这张新白纸」，必须覆盖旧指针。
  ipc.handle('session:createInternalSession', (_event, sessionId: unknown, title: unknown, content: unknown): InternalSession | null => {
    if (typeof sessionId !== 'string' || !sessionId) return null
    const store = getInternalSessionStore()
    if (!store) return null
    const created = store.create(sessionId, {
      title: typeof title === 'string' ? title : DEFAULT_INTERNAL_SESSION_TITLE,
      content: typeof content === 'string' && content.length > 0 ? content : undefined
    })
    if (created) store.setActive(sessionId, created.id)
    return created
  })

  ipc.handle('session:updateInternalSession', async (_event, sessionId: unknown, internalId: unknown, patch: unknown): Promise<InternalSession | null> => {
    if (typeof sessionId !== 'string' || !sessionId) return null
    if (typeof internalId !== 'string' || !internalId) return null
    const store = getInternalSessionStore()
    if (!store) return null
    if (!patch || typeof patch !== 'object') return null
    const p = patch as Partial<Pick<InternalSession, 'title' | 'summary' | 'messages' | 'cacheLocations'>>
    // 只允许白名单字段写入；messages 必须是数组
    if (p.title !== undefined && typeof p.title !== 'string') return null
    if (p.summary !== undefined && typeof p.summary !== 'string') return null
    if (p.messages !== undefined && !Array.isArray(p.messages)) return null
    if (p.cacheLocations !== undefined && !Array.isArray(p.cacheLocations)) return null
    await store.update(sessionId, internalId, {
      title: p.title,
      summary: p.summary,
      messages: p.messages,
      cacheLocations: p.cacheLocations
    })
    return store.get(sessionId, internalId)
  })

  ipc.handle('session:deleteInternalSession', (_event, sessionId: unknown, internalId: unknown): boolean => {
    if (typeof sessionId !== 'string' || !sessionId) return false
    if (typeof internalId !== 'string' || !internalId) return false
    const store = getInternalSessionStore()
    if (!store) return false
    store.delete(sessionId, internalId)
    return true
  })

  // 撤回/删除消息同步：从该用户会话名下所有内部会话中剔除对应消息原文
  // （展示层撤回只置 recalled 不清 content；内部会话若留原文，下一轮注入仍会带上 → 泄漏）
  safeHandle<number>(
    ipc, 'session:removeInternalMessages',
    async (_event, sessionId: unknown, messageIds: unknown) => {
      if (typeof sessionId !== 'string' || !sessionId) return 0
      if (!Array.isArray(messageIds)) return 0
      const ids = messageIds.filter((m): m is string => typeof m === 'string')
      if (ids.length === 0) return 0
      const store = getInternalSessionStore()
      if (!store) return 0
      return store.removeMessagesByOwner(sessionId, ids)
    },
    0
  )
}