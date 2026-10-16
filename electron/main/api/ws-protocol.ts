/**
 * WS 协议层（F-7 拆分）：wss connection / message / close 生命周期与消息路由。
 * - 拆分前：连接处理器内联在 startApiServer，连接级状态（MAX_*、continuationTimerRef）
 * 与 HTTP 装配段混居，新增消息类型只能在巨型回调里继续堆积。
 * - 拆分后：createWsProtocol 工厂承载连接生命周期；依赖经 deps 注入（ref 容器共享
 * 服务级可变状态，含 createStreamRunner 的装配依赖），server.ts 只做一次装配。
 * - 可扩展性：新增消息类型 → 在 onMessage 分派处追加分支；连接级新状态 →
 * 在工厂返回的连接闭包内声明（与 runStream 共享时经 continuationTimerRef 同款 ref 容器）。
 */

// 流式引擎依赖注入面复用（除连接级 ws/maxRetry/maxStreamRetries/continuationTimerRef 外全量传入）
import { createStreamRunner, type StreamRunnerDeps } from './stream-runner'
import { WebSocket } from 'ws'
import type { HookManager } from '../hooks'
import type { MissionStore } from '../tools/sub-agent-engine/mission-store'
import type { AsyncDelegationManager } from '../tools/sub-agent-engine/async-delegation'
import type { ChatMessage, WSMessage } from '@shared/types'

/** createWsProtocol 依赖注入面：连接协议需要的服务级能力 + createStreamRunner 装配依赖 */
export interface WsProtocolDeps {
  /** 运行中连接注册表（server.ts 持有；连接建立时登记、关闭时移除） */
  activeStreams: Map<string, WebSocket>
  /** WS 推送封装：背压检查 + Open 状态守卫 */
  safeWsSend: (ws: WebSocket, data: string) => boolean
  /** 流状态广播（新连接/关闭/工具循环后广播给全部存活连接） */
  broadcastStreamStatus: () => void
  /** 控制层 Hooks（UserPromptSubmit / Stop / SubagentStop 等） */
  hookManager: HookManager
  /** 长期目标存储（mission_start 分派与记账；模块级引用，值语义） */
  missionStoreRef: MissionStore | null
  /** 异步委托管理器（mission 子 agent 后台执行；模块级引用，值语义） */
  asyncDelegationRef: AsyncDelegationManager | null
  /** createStreamRunner 装配依赖（除连接级 ws/maxRetry/maxStreamRetries/continuationTimerRef） */
  streamRunner: Omit<
    StreamRunnerDeps,
    'ws' | 'maxRetryDelayMs' | 'maxStreamRetries' | 'continuationTimerRef'
  >
}

/**
 * 创建 WS 协议处理器：返回 (ws) => void，绑定 error/message/close 三个生命周期。
 * 每条连接一份：streamId、重试常量、continuationTimerRef 都在连接闭包内创建，
 * 与 createStreamRunner 返回的 runStream 共享同一 continuationTimerRef（abort/close 可取消审查续轮）。
 */
export function createWsProtocol(deps: WsProtocolDeps): (ws: WebSocket) => void {
  const {
    activeStreams,
    safeWsSend,
    broadcastStreamStatus,
    hookManager,
    missionStoreRef,
    asyncDelegationRef,
    streamRunner
  } = deps

  return (ws) => {
    // 流式引擎共享实例解构（message/close handler 自由引用，与 runStream 同一份）
    const { streamSession, activationManager, llmClientRef } = streamRunner
    const streamId = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    activeStreams.set(streamId, ws)

    // 绑定 error 监听——maxPayload 超限等协议错误若无人接，ws 会 emit('error') 且无监听器 → uncaughtException 刷屏；记录即可，连接由 ws 内部关闭。
    ws.on('error', (err) => {
      console.warn(`[ws] connection error (${streamId}):`, err.message)
    })

    // 直接注入：stream 异常时 server 内部直接续接，不走 IPC 回环，前端无感
    // - 超时类错误（ttft_timeout/idle_timeout）：直接重试，前端看到 stream 没断过
    // - 网络错误：延迟后重试
    // - 重试次数不设上限（原 MAX_STREAM_RETRIES=5，2026-10-02 按用户要求取消）；
    // 永久错误（未配置/余额不足）与用户中止仍按 stream-error-policy 短路，不回环
    const MAX_RETRY_DELAY_MS = 30000
    const MAX_STREAM_RETRIES = Number.POSITIVE_INFINITY // 重试不设次数上限（调用上限已取消）
    // 代码审查定时器句柄（F-6 ref 容器）：runStream 与 message/close handler 共享同一份
    const continuationTimerRef: { current: ReturnType<typeof setTimeout> | null } = { current: null }
    // 主回复轮路由选中的内部会话：审查轮（systemOverride）沿用其上下文装载
    // 连接级内部会话句柄已迁入 stream-runner 工厂闭包（每连接一份），此处不再声明

    /**
     * 执行一轮流式请求（含缓冲推送、工具调用、激活注入）
     * 抽成函数以便 onError 直接续接，实现"直接注入"
     */
    // 流式引擎独立模块（F-6 拆分）：缓冲推送/行协议/蒸馏/落盘/审查链调度收拢为 stream-runner。
    // 工厂按连接实例化（每连接一份内部会话句柄等中间态）；共享可变状态经 ref 容器
    // 传入，保证与 headless 链路、message/close handler 读写同一份内存，纯搬移不改行为。
    const { runStream } = createStreamRunner({
      ...streamRunner,
      ws,
      maxRetryDelayMs: MAX_RETRY_DELAY_MS,
      maxStreamRetries: MAX_STREAM_RETRIES,
      continuationTimerRef
    })

    ws.on('message', async (data) => {
      let msg: WSMessage & { messages?: ChatMessage[]; sessionId?: string; model?: string }
      try {
        msg = JSON.parse(data.toString())
      } catch {
        safeWsSend(ws, JSON.stringify({ type: 'error', payload: 'Invalid JSON' }))
        return
      }

      if (msg.type === 'token' && msg.messages) {
        // 用户主动发新消息（非激活）→ 重置中断恢复计数，表示中断恢复周期结束
        if (!msg.activation) {
          activationManager.resetInterruptRecovery()
        }

        // 控制层：UserPromptSubmit Hook（用户提交消息时触发）
        // 可用于输入过滤/预处理/拒绝不当内容
        if (hookManager.isLoaded() && msg.messages.length > 0) {
          const lastMsg = msg.messages[msg.messages.length - 1]
          if (lastMsg.role === 'user') {
            const promptResult = await hookManager.run('UserPromptSubmit', {
              event: 'UserPromptSubmit',
              userPrompt: lastMsg.content ?? '',
              sessionId: msg.sessionId,
              cwd: process.cwd()
            })
            if (promptResult.action === 'block') {
              if (streamSession.isOpen(ws)) {
                streamSession.push(
                  ws,
                  JSON.stringify({
                    type: 'error',
                    payload: `输入被 Hook 拒绝: ${promptResult.message ?? ''}`,
                    messageId: msg.messageId ?? `m_${Date.now()}`
                  })
                )
              }
              return
            }
          }
        }

        const clientMsg = msg as { messageId?: string }
        const messageId = clientMsg.messageId ?? `m_${Date.now()}`
        // LLMClient 单实例串行设计 → 所有流式请求经 streamSession 排队，同一时刻只有一个 stream。
        // 注意：闭包内 TS 无法收窄 msg.messages 的可选性，先取局部变量
        const queuedMessages = msg.messages
        const queuedSessionId = msg.sessionId
        const queuedModel = msg.model
        // enqueue 返回值不 await（发消息即入队，不阻塞消息处理）；异常由任务内 try/catch
        // 消化 + StreamSession 内部链保护，不会再断队列。
        void streamSession.enqueue(async () => {
          try {
            await runStream(
              queuedMessages,
              !!msg.activation,
              messageId,
              queuedSessionId,
              queuedModel,
              0,
              ''
            )
            // 控制层：Stop Hook（AI 完成响应后触发）
            // 可用于自动化后续动作（测试/通知/审计）
            if (hookManager.isLoaded()) {
              await hookManager.run('Stop', {
                event: 'Stop',
                sessionId: queuedSessionId,
                cwd: process.cwd()
              })
            }
          } catch (streamErr) {
            console.error('[server] runStream error:', streamErr)
            streamSession.push(
              ws,
              JSON.stringify({ type: 'error', payload: (streamErr as Error).message, messageId })
            )
            activationManager.setStreamActive(false)
          }
        })
      } else if (msg.type === 'takeover') {
        // 接管：新连接接管运行中流——推送目标切到本连接、清宽限计时器、重放已生成内容。
        // 前端重载/断线重连后凭 /api/streams/active 查询结果发 takeover，后端把 token 推送改道新连接
        // 已生成的 output/reasoning 重放，后续增量继续推——后台任务被前端看见，而不是被 abort 掐死。
        // 归属改道 + 宽限撤销收进 streamSession.takeover（相位 streaming，历史可查）。
        const snap =
          typeof msg.messageId === 'string' ? streamSession.takeover(ws, msg.messageId) : null
        if (snap) {
          safeWsSend(ws, 
            JSON.stringify({
              type: 'takeover_ok',
              sessionId: snap.sessionId,
              messageId: snap.messageId
            })
          )
          if (snap.output) {
            safeWsSend(ws, 
              JSON.stringify({ type: 'token', payload: snap.output, messageId: snap.messageId })
            )
          }
          if (snap.reasoning) {
            safeWsSend(ws, 
              JSON.stringify({
                type: 'reasoning',
                reasoning: snap.reasoning,
                messageId: snap.messageId
              })
            )
          }
        }
      } else if (msg.type === 'abort') {
        llmClientRef.current.abort('main')
        // 用户主动中止：取消 onDone 已调度但尚未触发的代码审查（setTimeout 500ms 窗口）
        // 否则用户点停止后 500ms 又开始新一轮审查，"停止按钮无效"
        if (continuationTimerRef.current) {
          clearTimeout(continuationTimerRef.current)
          continuationTimerRef.current = null
        }
        activationManager.resetInterruptRecovery()
      } else if (msg.type === 'mission_start') {
        // 任务来源：创建/续接一个自主 mission（后台异步委托）。
        // 通过 MissionStore 持久化：先生成稳定 mission id → create 记录 → dispatch 用同一 id → completed/failed 记账+可自动重试续接。
        // 前端/月蚀 AI 传 task（任务描述）与可选 maxIterations（2026-10-02 默认不再限制，取消迭代预算上限）。
        // 注意：此字段会持久化到 JSON，用 MAX_SAFE_INTEGER 表示"不限制"（Infinity 序列化会变 null）。
        const m = msg as unknown as { task?: string; parentId?: string; maxIterations?: number }
        const mTask = typeof m.task === 'string' && m.task.trim() ? m.task.trim() : ''
        if (!mTask) {
          safeWsSend(ws, JSON.stringify({ type: 'mission_started', ok: false, error: 'task 必填' }))
        } else if (!missionStoreRef) {
          safeWsSend(ws, 
            JSON.stringify({
              type: 'mission_started',
              ok: false,
              error: 'mission store 不可用（paths 未初始化）'
            })
          )
        } else {
          const maxIt =
            typeof m.maxIterations === 'number' && m.maxIterations > 0
              ? m.maxIterations
              : Number.MAX_SAFE_INTEGER
          const missionId = `ms_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
          missionStoreRef.create(missionId, mTask, { maxIterations: maxIt })
          const mId = asyncDelegationRef?.dispatch(
            mTask,
            typeof m.parentId === 'string' && m.parentId ? m.parentId : null,
            maxIt,
            missionId // 显式 id → 与 MissionStore 记录同键，跨段累计/失败重试生效
          )
          safeWsSend(ws, JSON.stringify({ type: 'mission_started', ok: !!mId, missionId }))
        }
      } else if (msg.type === 'interrupt_subagent') {
        const ok =
          asyncDelegationRef?.interrupt(msg.subagentId ?? '', msg.reason ?? 'user interrupt') ??
          false
        safeWsSend(ws, JSON.stringify({ type: 'subagent_interrupted', subagentId: msg.subagentId, ok }))
      } else if (msg.type === 'steer_subagent') {
        const ok = asyncDelegationRef?.steer(msg.subagentId ?? '', msg.instruction ?? '') ?? false
        safeWsSend(ws, JSON.stringify({ type: 'subagent_steered', subagentId: msg.subagentId, ok }))
      } else if (msg.type === 'list_subagents') {
        const subagents = asyncDelegationRef?.listActive() ?? []
        safeWsSend(ws, JSON.stringify({ type: 'subagents_list', subagents }))
      } else if (msg.type === 'list_missions') {
        const missions = asyncDelegationRef?.listAll() ?? []
        safeWsSend(ws, JSON.stringify({ type: 'missions_list', missions }))
      }
    })

    ws.on('close', () => {
      // 连接关闭：取消已调度但未触发的代码审查续轮（配合回调内 isOpen 判断，双保险防孤立审查轮）
      if (continuationTimerRef.current) {
        clearTimeout(continuationTimerRef.current)
        continuationTimerRef.current = null
      }
      // 只中止本连接发起的请求（streamSession 记录当前 stream 归属），避免误杀其他连接的 stream。
      if (streamSession.isOwner(ws)) {
        // 接管宽限：原连接关闭不立即 abort——留 5s 给新连接 takeover（重载/断线重连）
        // 超时仍无接管才终止，避免残留流永远空跑。宽限状态机收在 streamSession.ownerClosed。
        streamSession.ownerClosed(() => {
          broadcastStreamStatus()
          llmClientRef.current.abort('main')
        })
      }
      activeStreams.delete(streamId)
    })
}
}
