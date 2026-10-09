/**
 * 为什么存在：会话与消息是聊天核心域、状态多且耦合深，独立 slice 便于集中维护
 * 并与其他域（sandbox/browser 等）隔离出清晰边界。
 * @category 前端状态
 * @summary appStore 的 chat 域 slice：会话管理（增删改查/切换）、消息流（发送/中止/撤回/删除/
 * 编辑重发/重新生成）、附件、内部会话、置顶/视图模式、token 计量与工具调用状态。
 * 对应 AppState 中 sessions/currentMessages/streaming/status/token 计量等字段。
 */
import { DEFAULT_AI_ID } from '@shared/types'
import type { ChatMessage } from '@shared/types'
import type { AppState } from '../appStore-types'
import { useSkillStore } from '../skillStore'
import { wsState, safeSave } from '../appStore-handlers'
import {
  trimMessagesForWs,
  nextMsgId,
  SESSION_RESET_FIELDS,
  type SliceSet,
  type SliceGet
} from './appStore-shared'

export type ChatSlice = Pick<AppState,
  | 'sessions' | 'currentSessionId' | 'currentMessages' | 'streamingMessageId' | 'activeStreamStatus'
  | 'status' | 'errorMessage' | 'pendingAttachments' | 'inputPrefill'
  | 'lastTokenCount' | 'lastTokenBudget' | 'lastDroppedCount' | 'contextWarning' | 'lastUsage'
  | 'currentSessionModel' | 'currentSessionContinuousActivation' | 'activeToolCalls'
  | 'pinnedSessions' | 'chatViewMode' | 'internalSessions' | 'activeInternalSession' | 'activeInternalId' | 'editingMessageId'
  | 'togglePinSession' | 'setChatViewMode' | 'loadInternalSessions' | 'createInternalSession'
  | 'updateInternalSession' | 'deleteInternalSession' | 'setActiveInternalSession'
  | 'loadSessions' | 'selectSession' | 'createSession' | 'renameSession' | 'deleteSession'
  | 'sendMessage' | 'abortStream' | 'recallMessage' | 'deleteMessage' | 'editAndResend'
  | 'regenerateResponse' | 'setEditingMessageId' | 'setInputPrefill' | 'addAttachment'
  | 'removeAttachment' | 'setSessionModel' | 'toggleContinuousActivation' | 'triggerActivation'
  | 'ais' | 'currentAiId' | 'loadAis'
>

export function createChatSlice(set: SliceSet, get: SliceGet): ChatSlice {
  return {
    sessions: [],
    currentSessionId: null,
    currentMessages: [],
    /** AI 注册表快照（AiManagerPanel / 会话切换器 / 会话头共用） */
    ais: [],
    /** 当前会话归属 AI 编号（月蚀=1；旧会话/未设置回退 1） */
    currentAiId: DEFAULT_AI_ID,
    streamingMessageId: null,
    activeStreamStatus: null,
    status: 'idle',
    errorMessage: null,
    pendingAttachments: [],
    inputPrefill: null,
    lastTokenCount: null,
    lastTokenBudget: null,
    lastDroppedCount: 0,
    contextWarning: null,
    // 最新一轮真实 token 用量（done.usage，input 不含缓存命中）
    lastUsage: null,
    currentSessionModel: null,
    currentSessionContinuousActivation: false,
    activeToolCalls: [],
    pinnedSessions: (() => {
      try {
        const saved = localStorage.getItem('pinnedSessions')
        return saved ? JSON.parse(saved) as string[] : []
      } catch { return [] }
    })(),
    chatViewMode: 'normal' as 'normal' | 'tree',
    editingMessageId: null,
    internalSessions: [],
    activeInternalSession: null,
    activeInternalId: null,

    loadAis: async () => {
      // 拉取 AI 注册表快照（AiManagerPanel 打开/登录后刷新；失败静默，不阻塞主流程）
      try {
        const res = await window.lunareclipse.aiList()
        if (res?.ok && Array.isArray(res.ais)) {
          set({ ais: res.ais })
        }
      } catch (err) {
        console.warn('[chat] loadAis failed:', err)
      }
    },

    loadSessions: async () => {
      const sessions = await window.lunareclipse.listSessions()
      set({ sessions })
      if (sessions.length > 0 && !get().currentSessionId) {
        await get().selectSession(sessions[0].id)
      }
      if (!get().currentSessionId) {
        await get().createSession()
      }
    },

    selectSession: async (id) => {
      // 切走会话时：中止正在进行的普通对话流（activation 流不中止——持续激活由主进程
      // 主导续接，切走不影响；普通对话流切走即终止，避免幽灵流白跑）
      const pre = get()
      if (pre.status === 'streaming' && pre.streamingMessageId) {
        const streamingMsg = pre.currentMessages.find((m) => m.id === pre.streamingMessageId)
        if (!streamingMsg?.activation) {
          const marked = pre.currentMessages.map((m) =>
            m.id === pre.streamingMessageId
              ? { ...m, aborted: true, content: m.content || '[已切换会话]' }
              : m
          )
          if (pre.currentSessionId) {
            safeSave(pre.currentSessionId, marked)
          }
          pre.ws?.send(JSON.stringify({ type: 'abort' }))
        }
      }
      const session = await window.lunareclipse.getSession(id)
      if (session) {
        const prevAiId = get().currentAiId
        const aiId = session.aiId ?? DEFAULT_AI_ID
        set({
          currentSessionId: id,
          // 会话归属 AI：磁盘 aiId 缺省回退 1（月蚀），保持与后端 getAiIdentity 一致
          currentAiId: aiId,
          // 防御：磁盘会话 JSON 可能缺 messages 字段（损坏/旧版本）
          currentMessages: session.messages ?? [],
          currentSessionModel: session.model ?? null,
          currentSessionContinuousActivation: get().config?.continuousActivation === true,
          status: 'idle',
          streamingMessageId: null,
          errorMessage: null,
          lilithChatOpen: false,
          // 点击侧栏会话时自动切回聊天视图（行为约定：不在浏览器/社交等标签页也能直接跳回会话）
          activeRightPanel: 'chat',
          ...SESSION_RESET_FIELDS
        })
        // 窗口重载/应用重启后磁盘残留的半成品消息补收尾：最后一条 assistant 且正文空/无工具调用 → 标记 aborted
        const loadedMsgs = get().currentMessages
        const lastMsg = loadedMsgs[loadedMsgs.length - 1]
        if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.aborted && !lastMsg.error && !(lastMsg.content ?? '').trim() && !(lastMsg.toolCalls?.length) && !(lastMsg.rows?.some((r) => r.kind === 'assistantText' && r.state === 'complete'))) {
          const patched = loadedMsgs.map((m, i) => i === loadedMsgs.length - 1 ? { ...m, aborted: true } : m)
          set({ currentMessages: patched })
          safeSave(id, patched)
        }
        void window.lunareclipse.dmnSetActiveSession(id)
        // 切换会话后刷新任务清单（会话级隔离：每个会话有独立的 todo 文件）
        void get().refreshTodos()
        // 会话归属 AI 变化：SKILL 列表按 U{uid}/AI{aiId} 分层，自动刷新——
        // 主进程 loader 已按新作用域重扫，这里重拉列表让已打开的面板立即更新
        if (aiId !== prevAiId) {
          void useSkillStore.getState().refresh()
        }
      }
    },

    createSession: async (aiId?: number) => {
      const session = await window.lunareclipse.createSession(aiId)
      const prevAiId = get().currentAiId
      const nextAiId = aiId ?? DEFAULT_AI_ID
      set((s) => ({
        sessions: [session, ...s.sessions],
        currentSessionId: session.id,
        currentAiId: nextAiId,
        currentMessages: [],
        currentSessionContinuousActivation: s.config?.continuousActivation === true,
        status: 'idle',
        streamingMessageId: null,
        errorMessage: null,
        lilithChatOpen: false,
        ...SESSION_RESET_FIELDS
      }))
      // 通知后端当前活跃会话 ID
      void window.lunareclipse.dmnSetActiveSession(session.id)
      // 新会话没有 todo 计划——清空计划面板（会话级隔离）
      set({ todos: [] })
      // 会话归属 AI 变化：SKILL 列表按 U{uid}/AI{aiId} 分层，自动刷新（与 selectSession 同策略）
      if (nextAiId !== prevAiId) {
        void useSkillStore.getState().refresh()
      }
    },

    renameSession: async (id, title) => {
      await window.lunareclipse.renameSession(id, title)
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === id ? { ...sess, title } : sess
        )
      }))
    },

    deleteSession: async (id) => {
      await window.lunareclipse.deleteSession(id)
      set((s) => {
        const sessions = s.sessions.filter((sess) => sess.id !== id)
        const newCurrent =
          s.currentSessionId === id
            ? sessions[0]?.id ?? null
            : s.currentSessionId
        return {
          sessions,
          currentSessionId: newCurrent,
          currentMessages: [],
          status: 'idle',
          streamingMessageId: null,
          errorMessage: null,
          lilithChatOpen: false,
          ...SESSION_RESET_FIELDS
        }
      })
      if (get().currentSessionId) {
        await get().selectSession(get().currentSessionId!)
      } else {
        // 没有会话了，通知后端置空
        void window.lunareclipse.dmnSetActiveSession(null)
      }
    },

    sendMessage: async (content) => {
      const { currentSessionId, currentMessages, pendingAttachments, ws, currentSessionModel, status, streamingMessageId } = get()
      if (!currentSessionId) {
        set({ errorMessage: '没有活动会话，请先新建会话' })
        return
      }
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        set({ errorMessage: '与服务器未建立连接，请稍候再试（WebSocket 未就绪）' })
        console.error('[sendMessage] ws 未就绪:', ws?.readyState)
        return
      }
      if (!content.trim() && pendingAttachments.length === 0) return

      // 用户主动发新消息——清除中止标记，允许后续持续激活续接
      wsState.lastUserAbortTs = 0

      // 用户打断 AI：流式中发新消息时先保留已输出内容并 abort
      let baseMessages = currentMessages
      if (status === 'streaming' && streamingMessageId) {
        // 1) 标记当前 assistant 消息为已终止（保留已输出；不写 '[用户打断]' 进 content，
        //    终止提示由 MessageBubble 的 [已终止] 角标渲染）
        baseMessages = currentMessages.map((m) =>
          m.id === streamingMessageId
            ? { ...m, aborted: true }
            : m
        )
        // 2) 向后端发 abort 信号终止当前 LLM stream
        ws.send(JSON.stringify({ type: 'abort' }))
        // 3) 持久化已终止状态
        safeSave(currentSessionId, baseMessages)
      }

      const userMsg: ChatMessage = {
        id: nextMsgId('u'),
        role: 'user',
        content,
        createdAt: Date.now(),
        attachments: pendingAttachments.length > 0 ? pendingAttachments : undefined
      }

      const assistantMsg: ChatMessage = {
        id: nextMsgId('a'),
        role: 'assistant',
        content: '',
        createdAt: Date.now()
      }

      const newMessages = [...baseMessages, userMsg, assistantMsg]
      set({
        currentMessages: newMessages,
        streamingMessageId: assistantMsg.id,
        status: 'streaming',
        errorMessage: null,
        pendingAttachments: [],
        lastTokenCount: null,
        lastTokenBudget: null,
        lastDroppedCount: 0,
        contextWarning: null
      })

      safeSave(currentSessionId, newMessages)

      // 启动前端 AI stream
      // trimMessagesForWs：超大会话（AI 工具输出撑到几百 MB）全量发送会超 ws maxPayload 断连
      ws.send(
        JSON.stringify({
          type: 'token',
          messages: trimMessagesForWs(newMessages.filter((m) => m.id !== assistantMsg.id && !m.recalled)),
          sessionId: currentSessionId,
          model: currentSessionModel ?? undefined,
          messageId: assistantMsg.id
        })
      )
    },

    abortStream: () => {
      const { ws, streamingMessageId, currentSessionId, currentMessages } = get()
      if (!ws || !streamingMessageId) return
      // 记录中止时间——continuous_start 处理器据此拦截 abort 后 5s 内到达的续接推送
      wsState.lastUserAbortTs = Date.now()
      ws.send(JSON.stringify({ type: 'abort' }))
      set({
        status: 'idle',
        streamingMessageId: null,
        // abort 不再改 content（此前把 '[已终止]' 写进消息正文，
        // 污染会话文件 + 与 MessageBubble 的 [已终止] 角标重复显示）。
        // content 保留 AI 已输出的原文，终止提示交给渲染层角标（message.aborted）。
        currentMessages: currentMessages.map((m) =>
          m.id === streamingMessageId
            ? { ...m, aborted: true }
            : m
        )
      })
      if (currentSessionId) {
        const msgs = get().currentMessages
        safeSave(currentSessionId, msgs)
      }
    },

    recallMessage: async (messageId) => {
      const { currentSessionId, currentMessages } = get()
      if (!currentSessionId) return

      const updated = currentMessages.map((m) =>
        m.id === messageId
          ? { ...m, recalled: true, recalledAt: Date.now() }
          : m
      )
      set({ currentMessages: updated })
      safeSave(currentSessionId, updated)
      // 同步剔除内部会话中的对应原文（展示层只置 recalled 不清 content；
      // 内部会话须同步移除，否则下一轮锚点仍会把原文注入 AI）
      void window.lunareclipse?.removeInternalMessages?.(currentSessionId, [messageId])
    },

    deleteMessage: async (messageId) => {
      const { currentSessionId, currentMessages } = get()
      if (!currentSessionId) return

      const msg = currentMessages.find((m) => m.id === messageId)
      if (!msg) return

      // 删除消息对：用户消息连带其后继 AI 回复，AI 回复连带其前驱用户消息
      const toRemove = new Set([messageId])
      const idx = currentMessages.findIndex((m) => m.id === messageId)
      if (msg.role === 'user') {
        if (idx + 1 < currentMessages.length && currentMessages[idx + 1].role === 'assistant') {
          toRemove.add(currentMessages[idx + 1].id)
        }
      } else if (msg.role === 'assistant') {
        if (idx > 0 && currentMessages[idx - 1].role === 'user') {
          toRemove.add(currentMessages[idx - 1].id)
        }
      }

      const updated = currentMessages.filter((m) => !toRemove.has(m.id))
      set({ currentMessages: updated })
      safeSave(currentSessionId, updated)
      // 同步剔除内部会话中的对应原文（含消息对）
      void window.lunareclipse?.removeInternalMessages?.(currentSessionId, [...toRemove])
    },

    editAndResend: async (messageId, newContent) => {
      const { currentSessionId, currentMessages, ws, currentSessionModel, status, streamingMessageId } = get()
      if (!currentSessionId || !ws || ws.readyState !== WebSocket.OPEN) return

      // 流式中先 abort
      if (status === 'streaming' && streamingMessageId) {
        ws.send(JSON.stringify({ type: 'abort' }))
      }

      const idx = currentMessages.findIndex((m) => m.id === messageId)
      if (idx < 0) return

      // 更新用户消息内容，标记已编辑
      let updated = currentMessages.map((m) =>
        m.id === messageId
          ? { ...m, content: newContent, editedAt: Date.now() }
          : m
      )

      // 编辑后截断原 AI 回复及之后所有消息（内部会话由服务端两写维护，无独立撤回通道）
      if (idx + 1 < updated.length && updated[idx + 1].role === 'assistant') {
        updated = updated.slice(0, idx + 1)
      }

      // 创建新 AI 占位消息
      const assistantMsg: ChatMessage = {
        id: nextMsgId('a'),
        role: 'assistant',
        content: '',
        createdAt: Date.now()
      }

      const newMessages = [...updated, assistantMsg]
      set({
        currentMessages: newMessages,
        streamingMessageId: assistantMsg.id,
        status: 'streaming',
        errorMessage: null,
        editingMessageId: null,
        lastTokenCount: null,
        lastTokenBudget: null,
        lastDroppedCount: 0,
        contextWarning: null
      })

      safeSave(currentSessionId, newMessages)

      ws.send(
        JSON.stringify({
          type: 'token',
          messages: trimMessagesForWs(newMessages.filter((m) => m.id !== assistantMsg.id && !m.recalled)),
          sessionId: currentSessionId,
          model: currentSessionModel ?? undefined,
          messageId: assistantMsg.id
        })
      )
    },

    regenerateResponse: async (messageId) => {
      const { currentSessionId, currentMessages, ws, currentSessionModel, status, streamingMessageId } = get()
      if (!currentSessionId || !ws || ws.readyState !== WebSocket.OPEN) return

      // 流式中先 abort
      if (status === 'streaming' && streamingMessageId) {
        ws.send(JSON.stringify({ type: 'abort' }))
      }

      const idx = currentMessages.findIndex((m) => m.id === messageId)
      if (idx < 0) return

      // 清空 AI 回复内容，截断后续消息（内部会话由服务端两写维护，无独立撤回通道）
      const updated = currentMessages.map((m) =>
        m.id === messageId
          ? { ...m, content: '', reasoning: undefined, toolCalls: undefined, rows: undefined, aborted: false, error: undefined }
          : m
      )
      const trimmed = updated.slice(0, idx + 1)

      set({
        currentMessages: trimmed,
        streamingMessageId: messageId,
        status: 'streaming',
        errorMessage: null,
        lastTokenCount: null,
        lastTokenBudget: null,
        lastDroppedCount: 0,
        contextWarning: null
      })

      safeSave(currentSessionId, trimmed)

      ws.send(
        JSON.stringify({
          type: 'token',
          messages: trimMessagesForWs(trimmed.filter((m) => m.id !== messageId && !m.recalled)),
          sessionId: currentSessionId,
          model: currentSessionModel ?? undefined,
          messageId: messageId
        })
      )
    },

    setEditingMessageId: (id) => {
      set({ editingMessageId: id })
    },

    setInputPrefill: (text) => {
      set({ inputPrefill: text })
    },

    setSessionModel: async (model) => {
      const { currentSessionId } = get()
      if (!currentSessionId) return
      const updated = await window.lunareclipse.setSessionModel(currentSessionId, model)
      set({
        currentSessionModel: model,
        sessions: get().sessions.map((s) =>
          s.id === currentSessionId && updated ? { ...s, model: updated.model } : s
        )
      })
    },

    toggleContinuousActivation: async (enabled) => {
      // 从 session 级提升为全局级——写入 config.json，切会话不丢
      const { config, currentSessionId } = get()
      if (!currentSessionId) return
      const nextConfig = { ...config, continuousActivation: enabled }
      await window.lunareclipse.setConfig(nextConfig)
      set({
        config: nextConfig,
        currentSessionContinuousActivation: enabled,
        sessions: get().sessions.map((s) =>
          s.id === currentSessionId ? { ...s, continuousActivation: enabled } : s
        )
      })
    },

    addAttachment: (file) =>
      set((s) => ({ pendingAttachments: [...s.pendingAttachments, file] })),

    removeAttachment: (index) =>
      set((s) => ({
        pendingAttachments: s.pendingAttachments.filter((_, i) => i !== index)
      })),

    // 文档 15.2.1：自主激活入口——后端 activation:trigger 事件触发，前端发起无用户消息的 AI 请求
    // 后端 buildInjectedMessages 会注入激活事件，AI 自主决定是否输出
    // content：后端带来的激活内容（健康检查报错/倒计时/外部事件/持续激活续接）。
    // 非空时把它作为 user 消息插入对话流（UI 可见），随请求发给 LLM ——
    // AI 明确知道"谁激活了我"，用户也能在界面上看到激活来源。
    triggerActivation: async (content?: string) => {
      const { currentSessionId, currentMessages, ws, currentSessionModel, status } = get()
      if (!currentSessionId || !ws || ws.readyState !== WebSocket.OPEN) return
      if (status === 'streaming') return  // 正在对话中不打断

      // 有激活内容：先插入一条"系统注入" user 消息（UI 可见，不进真实用户消息流）
      let baseMessages = currentMessages
      if (content && content.trim()) {
        const sysMsg: ChatMessage = {
          id: `sys_act_${Date.now()}`,
          role: 'user',
          content: `【系统注入：本条为系统激活消息，非用户真实发言，请优先响应并明确其来源】\n${content}`,
          createdAt: Date.now(),
          activation: true
        }
        baseMessages = [...currentMessages, sysMsg]
        safeSave(currentSessionId, baseMessages)
      }

      const assistantMsg: ChatMessage = {
        id: nextMsgId('a'),
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        activation: true
      }
      const newMessages = [...baseMessages, assistantMsg]
      set({
        currentMessages: newMessages,
        streamingMessageId: assistantMsg.id,
        status: 'streaming',
        errorMessage: null,
        lastTokenCount: null,
        lastTokenBudget: null,
        lastDroppedCount: 0,
        contextWarning: null
      })
      safeSave(currentSessionId, newMessages)

      ws.send(
        JSON.stringify({
          type: 'token',
          messages: trimMessagesForWs(newMessages.filter((m) => m.id !== assistantMsg.id)),
          sessionId: currentSessionId,
          model: currentSessionModel ?? undefined,
          activation: true,
          messageId: assistantMsg.id
        })
      )
    },

    togglePinSession: (sessionId: string) => {
      const current = get().pinnedSessions
      const next = current.includes(sessionId)
        ? current.filter((id) => id !== sessionId)
        : [...current, sessionId]
      set({ pinnedSessions: next })
      try { localStorage.setItem('pinnedSessions', JSON.stringify(next)) } catch { /* 持久化失败不阻塞本次置顶操作，重启后回到上次持久化状态 */ }
    },

    setChatViewMode: (mode: 'normal' | 'tree') => {
      set({ chatViewMode: mode })
    },

    loadInternalSessions: async (sessionId: string) => {
      if (!sessionId) return
      // 列表 + 承接指针一起取：树画布既要点出全部会话，也要标出 AI 正在承接的那条
      const [list, activeInternalId] = await Promise.all([
        window.lunareclipse.listInternalSessions(sessionId),
        window.lunareclipse.getActiveInternalSession(sessionId)
      ])
      set({ internalSessions: list, activeInternalId })
    },

createInternalSession: async (sessionId: string, title: string, content?: string) => {
      if (!sessionId) return
      const created = await window.lunareclipse.createInternalSession(sessionId, title, content)
      if (!created) return
      // 直落盘成功后刷新列表（服务端排序：updatedAt 降序，新会话在最上）
      const list = await window.lunareclipse.listInternalSessions(sessionId)
      // 服务端建即承接（create 后写 active 指针）：前端徽章同步跟随该指针，
      // 否则树画布会把新会话标成非承接（与「下一条消息实际注入新会话」矛盾）
      const activeInternalId = await window.lunareclipse.getActiveInternalSession(sessionId)
      set({ internalSessions: list, activeInternalId })
    },

    updateInternalSession: async (sessionId, internalId, patch) => {
      const updated = await window.lunareclipse.updateInternalSession(sessionId, internalId, patch)
      if (!updated) return false
      // 以服务端返回为准：同步列表摘要 + 详情（防止乐观值与落盘不一致）
      set((s) => ({
        internalSessions: s.internalSessions.map((i) =>
          i.id === updated.id
            ? {
                ...i,
                title: updated.title,
                summary: updated.summary,
                messageCount: updated.messages.length,
                totalChars: updated.totalChars,
                cacheLocations: updated.cacheLocations,
                updatedAt: updated.updatedAt
              }
            : i
        ),
        activeInternalSession: s.activeInternalSession?.id === updated.id ? updated : s.activeInternalSession
      }))
      return true
    },

    deleteInternalSession: async (sessionId: string, internalId: string) => {
      if (!sessionId) return
      const ok = await window.lunareclipse.deleteInternalSession(sessionId, internalId)
      if (!ok) return
      set((s) => ({
        internalSessions: s.internalSessions.filter((i) => i.id !== internalId),
        activeInternalSession: s.activeInternalSession?.id === internalId ? null : s.activeInternalSession,
        activeInternalId: s.activeInternalId === internalId ? null : s.activeInternalId
      }))
    },

    setActiveInternalSession: (s) => {
      set({ activeInternalSession: s })
    }
  }
}