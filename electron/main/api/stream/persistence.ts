/**
 * @category 核心
 * @summary 回合落盘：会话历史写入（含 partial_ 剔除）+ 内部会话上下文两写入队
 *
 * 为什么独立成文件：落盘是「会话不丢」的唯一保证，规则却很多——行终态收尾、思考块剥离、
 * `partial_` 续接锚剔除、内部会话「两写」的 user 侧来源判定（排除 activation 注入）。原先内联在
 * `stream-runner.ts` 的 `onDone`（1163 行闭包）中段，与行协议/审查链/错误分派混居。ADR-04 外移。
 *
 * 什么作用：`persistTurn(deps)` 在一次流正常结束后执行一次——把本轮 assistant 消息（含 rows 与
 * reasoning）落入会话历史，并把本轮 user/assistant/工具摘要交给内部会话单飞队列。
 *
 * 不删理由：删掉即会话历史不落盘（前端切走/断线即丢对话），且内部会话上下文不再更新（摘要/继承失效）。
 *
 * ⚠️ 三条不可去掉的规则（各有故障背书）：
 * 1. **partial_ 剔除**：续接成功后 finalAiMsg 已含完整正文+rows，partial（残片全文）只用于续接锚定；
 *    一并落盘会让下一轮注入出现同轮回复双份，且误导跨轮复读判定（prevAiMsg 命中 partial）。
 * 2. **思考块剥离只影响上下文**：rows 保留原文供 UI 展示；`stripThinkingLeak` 只作用于落盘进
 *    LLM 上下文的 content（"UI 完整、上下文剥离"）。
 * 3. **reasoning 必须随消息落盘**：DeepSeek 思考模式要求历史 assistant 的 reasoning_content 原样
 *    回传（缺失即 400）；这与「思考不做语义注入」不冲突（语义注入已移除，协议字段必须保留）。
 */
import type { ChatMessage } from '@shared/types'
import type { ToolCallRow } from '@shared/types'
import { stripThinkingLeak } from '@shared/utils/output-discipline'
import type { SessionStore } from '../session-store'
import type { InternalSessionJob } from '../internal-session'
import type { TurnRows } from './turn-rows'

export interface PersistTurnDeps {
  sessionId: string
  messageId: string
  /** 本轮请求消息（剔除 partial_ 后落盘） */
  messages: ChatMessage[]
  activation: boolean
  fullOutput: string
  fullReasoning: string
  /** 复读轮不落盘（历史断链：不留复读文本） */
  isRepeatTurn: boolean
  /** 主回复轮选中的内部会话（审查轮沿用；仅当其 sessionId 匹配才两写） */
  activeInternalContext: { sessionId: string; internalId: string } | null
  /** 激活内容快照容器（入队前读取；onDone 尾段会被置 null） */
  activationContentRef: { current: string | null }
  rows: TurnRows
  sessionStore: SessionStore
  enqueueInternalSessionJob: (sid: string, internalId: string, job: InternalSessionJob) => void
}

export function persistTurn(deps: PersistTurnDeps): void {
  const {
    sessionId,
    messageId,
    messages,
    activation,
    fullOutput,
    fullReasoning,
    isRepeatTurn,
    activeInternalContext,
    activationContentRef,
    rows,
    sessionStore,
    enqueueInternalSessionJob
  } = deps

  // 行协议终态收尾（text/reasoning → complete、turnHeader → completedSuccess）
  const finalRows = rows.finalizeTurn()
  // 输出纪律机制（思考不进上下文）：正文落盘进会话历史前剥离显式思考块
  // （<thinking>/<reasoning>/<analysis> 标签与 thinking fence）。rows（UI 行流）
  // 已保留原文供展示，剥离只影响 LLM 上下文——与"UI 完整、上下文压缩"哲学一致
  // （微压缩层已删，输出纪律是当前唯一的"UI 完整、上下文剥离"机制）
  const strippedBody = stripThinkingLeak(fullOutput || '')
  if (strippedBody.stripped && !strippedBody.text) {
    console.error(`[server] 正文仅含思考块已整体剥离（messageId=${messageId}）`)
  }
  const finalAiMsg: ChatMessage = {
    id: messageId,
    role: 'assistant',
    content: strippedBody.text || '',
    createdAt: Date.now(),
    activation,
    ...(finalRows.length > 0 ? { rows: finalRows } : {}),
    // 保存 reasoning 到会话历史——之前 fullReasoning 只在重试续接时用
    // 正常完成时丢弃了。导致下一轮 LLM 上下文里完全没有上轮的思考内容
    // AI 看不到自己之前想过什么（"思考内容对AI屏蔽"的根因）。
    // 注意：这是 wire 协议层回传（DeepSeek 思考模式 reasoning_content 缺失即 400）
    // 与"思考不进上下文"的语义约束不冲突（语义注入已移除，协议字段必须保留）
    ...(fullReasoning ? { reasoning: fullReasoning } : {})
  }
  if (!isRepeatTurn) {
    // 落盘前剔除续接锚 partial_ 消息（理由见模块头 ⚠️ 规则 1）
    sessionStore.saveMessages(sessionId, [
      ...messages.filter((m) => !(typeof m.id === 'string' && m.id.startsWith('partial_'))),
      finalAiMsg
    ])
  }

  // 内部会话：上下文层两写（延迟 500ms 异步——摘要+压缩轻量 LLM，不阻塞回复流）
  // 仅主回复轮写入：审查/修正轮（review_/rework_ 前缀）与 isRepeatTurn 不写内部会话、不触发摘要/压缩
  const idHead = messageId.split('_')[0]
  const isContextWriteTurn = !isRepeatTurn && idHead !== 'review' && idHead !== 'rework'
  if (isContextWriteTurn && activeInternalContext?.sessionId === sessionId) {
    // 两写 user 侧消息 = 本轮真实用户输入，排除 activation 系统注入（与路由端取 userInput 的逻辑同构）：
    // activation 消息是系统注入（审查提示词 phaseMsg / 健康检查激活等），被视为"用户发言"
    // 写进内部会话会污染会话内容与摘要语义——Q1 根因：审查轮 phaseMsg 是 user+activation，
    // 若出现在 messages 尾部会被 find 命中（如激活轮无 content、尾部恰为 phaseMsg），
    // 导致【代码审查】提示词全文进入内部会话与摘要。
    // 激活轮（activation=true）messages 尾部是系统激活消息而非真实用户输入，
    // 若走 find 会退回更早的历史 user 与"本轮激活回复"错配成对（Q2）——
    // 故复用 RAW 记忆链路的【系统自激活】占位语义，
    // 保证"激活来源可见且与回复成对成立"，不冒充任何历史真实发言。
    // activationContentRef.current 在本轮 onDone 尾段会被置 null，这里必须在入队前完成快照。
    const turnUserMsg: ChatMessage | undefined = activation
      ? {
          // 占位 id 加随机后缀：内部会话消息 id 用作撤回剔除的匹配键（removeMessagesByOwner），
          // 仅用 Date.now() 在同毫秒两次激活时可能重号，导致撤回时两条占位一并被剔除；
          // 随机后缀与 internal-session-store 自身 id 生成风格一致，保证全局唯一。
          id: `sys_act_2write_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          role: 'user',
          content: `【系统自激活】${activationContentRef.current ?? '系统触发自动续接'}`,
          createdAt: Date.now()
        }
      : [...messages].reverse().find((m) => m.role === 'user' && !m.activation)
    const blockToolSummaries = finalRows
      .filter((r): r is ToolCallRow => r.kind === 'toolCall')
      .map((r) => {
        const text = r.error?.message ?? r.output?.text ?? ''
        const brief = text.replace(/\s+/g, ' ').slice(0, 160)
        return brief ? `${r.toolName}: ${brief}` : r.toolName
      })
    // K3：两写/摘要/继承走单飞队列（enqueueInternalSessionJob，内部会话层单飞合并队列）——
    // 原实现每轮独立 setTimeout(500) 并发执行，快速连发多轮时 append 与摘要/继承互相覆盖
    // （两个任务同时读到旧状态再先后写回，后者覆盖前者 patch）。
    // 入队即把本轮 user/assistant/工具摘要交给队列：500ms 末次合并 + 同会话串行链执行，
    // 每轮至多一次 append + 一次摘要 + 一次超限继承（0.17 起：原会话不动，新建子会话承接），
    // 快照之后追加的消息不会被并发覆盖。
    enqueueInternalSessionJob(sessionId, activeInternalContext.internalId, {
      userMsg: turnUserMsg,
      aiMsg: finalAiMsg,
      toolSummaries: blockToolSummaries
    })
  }
}
