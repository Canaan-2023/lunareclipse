/**
 * @category 核心
 * @summary 无头对话能力 seam：外部消息 → 完整月蚀链路（上下文组装 / 回合驱动 / 结果持久化）
 *
 * 为什么存在：无头对话（飞书等外部平台 → 月蚀大脑，LAN 聊天室/私聊 AI 自动回复也复用）此前
 * 内联在 `server.ts` 的 `startApiServer` 巨型闭包内，占 ~160 行，与 WS 主对话链路的装配代码
 * 交错。抽成 `createHeadlessChatRunner(deps)` 后，三阶段（组装/驱动/持久化）与入口编排独立成模块，
 * 修改无头链路不再触碰协议层与端点装配代码（ADR-02 第 4 步）。
 *
 * 什么作用：返回 `(text, sessionId, aiId?) => Promise<string>` 的运行器；宿主把它赋给
 * `serviceRefs.headlessChatRunnerRef`（LAN 协作层经 `getHeadlessChatRunner()` 取用）。
 * 会话读写走注入的 `sessionStore`（确定性 sessionId → 外部会话跨重启保留）；
 * 对话对写入 RAW 记忆（与前端对话同链路，外部对话计入记忆系统）。
 *
 * 不删理由：外部消息接入是月蚀的「第二条主链路」——与 WS 前端链路共用同一
 * `streamSession` 串行队列、同一行 id 计数器与同一 RAW 写入口径；删掉本模块即把这 160 行
 * 重新并回宿主闭包，回归面与耦合度同时回升。
 *
 * 行为等价约束（拆分不改行为）：`streamSession.enqueue` 串行语义、行协议 `rowId` 递增口径、
 * 正文落盘前的思考块剥离、RAW 归档时机均与拆分前逐字一致。
 */
import type { ConfigStore } from './config-store'
import type { SessionStore } from './session-store'
import type { LLMClient, ToolExecutor } from './llm'
import type { StreamSession } from './stream-session'
import type { ToolContext } from '../tools/base-tool'
import type { ChatMessage, ConversationRow, LLMConfig, PromptPurpose, SessionContext } from '@shared/types'
import { stripThinkingLeak } from '@shared/utils/output-discipline'
import { estimateMessagesTokens } from '@shared/utils/token-estimate'

/** 蒸馏回调（与主会话流式路径共用同一工厂，见 server.ts `makeDistillCallbacks`） */
export interface DistillCallbacks {
  distillToolResult?: (
    toolName: string,
    toolCallId: string,
    result: string,
    intent?: string
  ) => Promise<string | undefined>
  distillIntentTurnPairs?: number
}

/**
 * 三阶段与入口共用的闭包依赖：全部由宿主 `startApiServer` 注入，本模块不新建任何状态。
 * ref 容器（`lastInjectedEstimateRef` / `llmClientRef` / `toolExecutorsRef` / `rowIdRef`）与主路径
 * **共用同一对象**——无头链路必须看到主对话的「当前生效」工具集与行 id 序列。
 */
export interface HeadlessChatDeps {
  configStore: ConfigStore
  sessionStore: SessionStore
  /** 注入前消息组装（宿主闭包：segment 装配 + 附件 + 净化链）；`purpose` 见 SegmentBuildCtx.purpose */
  buildInjectedMessages: (
    messages: ChatMessage[],
    sessionId?: string,
    sessionContext?: SessionContext | null,
    purpose?: PromptPurpose
  ) => Promise<ChatMessage[]>
  /** 最近一次注入 token 估算回写（宿主 ref 容器，供上下文用量工具读取） */
  lastInjectedEstimateRef: { current: number | null }
  /** 流会话状态机（与 WS 主对话共用同一串行队列） */
  streamSession: StreamSession
  /** LLM 客户端 ref（未就绪时本模块会经 makeLlmClient 重建并回写） */
  llmClientRef: { current: LLMClient }
  makeLlmClient: (cfg: LLMConfig) => LLMClient
  /** 工具执行器 ref（配置热更新后由宿主重建，闭包读 current 永远拿到当前生效集合） */
  toolExecutorsRef: { current: ToolExecutor[] }
  /**
   * **用途专属**工具执行器：`purpose` 命中时**追加**到前端工具集之后。
   *
   * 为什么需要：有些工具只对某一类轮次有意义（房间的「区工具」`room_note` 就是），
   * 塞进普通工具池会让普通对话的工具清单多出用不上的项——**工具面应当与用途一致**。
   * 省略 = 不追加任何工具（与引入前逐字一致）。
   */
  extraToolExecutors?: (purpose: PromptPurpose | undefined, aiId?: number) => ToolExecutor[]
  makeDistillCallbacks: () => DistillCallbacks
  /** 行协议行 id 全局递增计数器（与主路径共用，重试时不得重置） */
  rowIdRef: { current: number }
  /** RAW 记忆写入（宿主闭包：与主路径共用同一写入器与剥离口径） */
  writeRawMemoryForStream: (
    isInterrupted: boolean,
    fullOutput: string,
    activation: boolean,
    messages: ChatMessage[],
    interruptReason?: string
  ) => void
  /** 会话上下文（运行期写入/清空 sessionId：工具 paths 与 segment 注入经此读取） */
  serverCtx: ToolContext
  /**
   * 解析本轮要注入的**内部会话锚点**（v11 双层会话 / 逆生树）。
   *
   * 为什么存在：无头链路此前把 `sessionContext` 硬编码为 `null` → 走**线性管线**（裸历史），
   * 而 WS 主路径走的是「路由（continue/create）→ `buildSessionContext` 锚点（标题/代际/摘要/记忆缓存位置）」。
   * 结果是同一套 AI 在房间里比在普通会话里**明显简陋**（无路由、无代际、无摘要、无继承）。
   * 宿主注入 `api/internal-session.ts` 的 `resolveStreamSessionContext`（**同源**，不另造一套口径）。
   *
   * 契约：**返回 null** = 未启用 / 无路由（合法，调用方走线性管线）；
   * **抛错** = 真故障 → 调用方**不得吞掉**（让它上浮，别把故障静默降级成简陋上下文）。
   */
  resolveSessionContext?: (sessionId: string, messages: ChatMessage[]) => Promise<SessionContext | null>
}

/**
 * 无头对话运行器签名（LAN 协作层经 getHeadlessChatRunner 取用）。
 * `purpose`：本轮用途（可选）。`'room'` = 自主房间规划轮 → 注入链跳过对话纪律段
 * （见 `prompts/segments.ts` 的 `SegmentBuildCtx.purpose`）；省略 = 普通对话（行为不变）。
 */
export type HeadlessChatRunner = (
  text: string,
  sessionId: string,
  aiId?: number,
  purpose?: PromptPurpose
) => Promise<string>

/**
 * 创建无头对话运行器。
 *
 * 何时用：`startApiServer` 装配期调用一次，返回值赋给 `serviceRefs.headlessChatRunnerRef`。
 * 阶段划分（纯搬移，语义与拆分前一致）：
 * ① 上下文组装 → ② 回合驱动（入队串行 + 工具循环）→ ③ 结果持久化（行协议 + 会话 + RAW）。
 */
export function createHeadlessChatRunner(deps: HeadlessChatDeps): HeadlessChatRunner {
  const {
    configStore,
    sessionStore,
    buildInjectedMessages,
    lastInjectedEstimateRef,
    streamSession,
    llmClientRef,
    makeLlmClient,
    toolExecutorsRef,
    makeDistillCallbacks,
    rowIdRef,
    writeRawMemoryForStream,
    serverCtx
  } = deps

  /** ① 上下文组装：会话加载/创建 + 用户消息 + 注入组装（与 runStream 同语义：不实施注入截断） */
  const assembleHeadlessContext = async (
    text: string,
    sessionId: string,
    aiId?: number,
    purpose?: PromptPurpose
  ): Promise<{ history: ChatMessage[]; userMsg: ChatMessage; injectedMessages: ChatMessage[] }> => {
    const session =
      sessionStore.get(sessionId) ??
      // 多 AI 泛化：headless 会话按调用方声明归属 AI（AI 社交/公示板传 aiId，
      // 记忆/RAW/工具 seeds 落该 AI 域；缺省 NaN → 回退 1 月蚀，兼容聊天室/私聊旧行为）
      sessionStore.getOrCreate(sessionId, `消息接入会话 ${sessionId.slice(0, 10)}`, aiId)
    const history = session.messages ?? []
    const userMsg: ChatMessage = {
      id: `ext_u_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      role: 'user',
      content: text,
      createdAt: Date.now()
    }

    // **不兜底**（用户裁决：「兜底不要轻易下放，有时候报错比兜底更好，我不喜欢不干净的东西」）。
    // 必须区分两种「没有锚点」：
    // - **返回 null** = 机制自己声明「未启用 / 无路由」→ 合法状态，走线性管线；
    // - **抛错** = 真出了问题 → **让它抛**，由上层看见（静默降级成简陋的线性管线才是「不干净」）。
    const sessionContext = deps.resolveSessionContext
      ? await deps.resolveSessionContext(sessionId, [...history, userMsg])
      : null
    const injectedMessages = await buildInjectedMessages([...history, userMsg], sessionId, sessionContext, purpose)
    // 注入全量注入（与 runStream 同语义）：headless 接入同样不实施注入截断
    lastInjectedEstimateRef.current = estimateMessagesTokens(injectedMessages)
    return { history, userMsg, injectedMessages }
  }

  /**
   * ② 回合驱动（含工具执行）：streamWithTools。错误先收集不 throw（避免队列链中断），
   * 完成后统一抛出给 messaging 层处理。
   * **调用方必须已在 streamSession 队列内**（见编排入口）：serverCtx.sessionId 是全局单例，
   * 只有把「组装 + 流 + 持久化」整体串行，才不会与 WS 主链路/其它无头轮互相覆盖。
   * 工具集 = 前端工具集 + **该用途专属工具**（`extraToolExecutors`；房间轮才有，普通对话为空）。
   */
  const runHeadlessTurn = async (
    injectedMessages: ChatMessage[],
    sessionId: string,
    purpose?: PromptPurpose,
    aiId?: number
  ): Promise<{ fullOutput: string; fullHeadlessReasoning: string }> => {
    let fullOutput = ''
    let fullHeadlessReasoning = ''
    const extraTools = deps.extraToolExecutors?.(purpose, aiId) ?? []
    const executors = extraTools.length > 0 ? [...toolExecutorsRef.current, ...extraTools] : toolExecutorsRef.current
    let streamError: Error | null = null
    // 无头路径不推 WS，清掉转发器防止把子 agent 事件误推给残留的旧 WS stream。
    // 此时已在队列任务内，前一个 stream 已完成，清掉不会丢它的子 agent 事件。
    streamSession.setForwarder(null)
    await llmClientRef.current.streamWithTools(
      injectedMessages,
      executors,
      {
        // 与主会话共用蒸馏回调：LAN 自动回复的工具结果与主会话一致做蒸馏替换
        // （失败重试一次仍失败则保留原文，上下文不会无限膨胀）。
        ...makeDistillCallbacks(),
        onToken: (t) => {
          fullOutput += t
        },
        // headless 路径同样收集 reasoning——外部消息连续对话时历史里
        // assistant 消息缺 reasoning_content 会触发 DeepSeek 400（同主路径续接修复）。
        onReasoning: (t) => {
          fullHeadlessReasoning += t
        },
        onDone: () => {},
        onError: (e) => {
          streamError = e
        }
      },
      {
        // 消息来源护栏作用域键：headless（聊天室/私聊/公示板）会话与主对话相同语义，
        // 会话内固定哈希、跨会话不同；护栏只在注入层包裹，不落盘不渲染。
        guardrailSessionId: sessionId
      }
    )
    if (streamError) throw streamError
    return { fullOutput, fullHeadlessReasoning }
  }

  /** ③ 结果持久化：行协议 rows（与主路径 finalAiMsg 对齐）+ 会话保存 + RAW 记忆归档 */
  const persistHeadlessTurn = async (
    sessionId: string,
    history: ChatMessage[],
    userMsg: ChatMessage,
    fullOutput: string,
    fullHeadlessReasoning: string
  ): Promise<void> => {
    // 补建行协议 rows，与主路径 finalAiMsg 对齐，前端走 RowRenderer 按时间线平铺。
    const headlessTurnId = `turn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const headlessRows: ConversationRow[] = []
    if (fullHeadlessReasoning) {
      headlessRows.push({
        kind: 'reasoning',
        rowId: ++rowIdRef.current,
        turnId: headlessTurnId,
        createdAt: Date.now(),
        createdAtSeq: ++rowIdRef.current,
        text: fullHeadlessReasoning,
        state: 'complete'
      })
    }
    if (fullOutput) {
      headlessRows.push({
        kind: 'assistantText',
        rowId: ++rowIdRef.current,
        turnId: headlessTurnId,
        createdAt: Date.now(),
        createdAtSeq: ++rowIdRef.current,
        text: fullOutput,
        state: 'complete'
      })
    }
    // 输出纪律机制（思考不进上下文）：正文落盘前剥离显式思考块；rows（UI 行流）保留原文，
    // 剥离只影响 LLM 上下文（与主路径 finalAiMsg 同口径，见 stripThinkingLeak 注释）
    const strippedHeadlessBody = stripThinkingLeak(fullOutput || '')
    if (strippedHeadlessBody.stripped && !strippedHeadlessBody.text) {
      console.error('[messaging] headless 正文仅含思考块已整体剥离')
    }
    const aiMsg: ChatMessage = {
      id: `ext_a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      role: 'assistant',
      content: strippedHeadlessBody.text,
      createdAt: Date.now(),
      // reasoning 一并持久化（DeepSeek 思考模式回传硬要求，防下轮 400）
      ...(fullHeadlessReasoning ? { reasoning: fullHeadlessReasoning } : {}),
      ...(headlessRows.length > 0 ? { rows: headlessRows } : {})
    }
    sessionStore.saveMessages(sessionId, [...history, userMsg, aiMsg])

    // RAW 记忆归档（与前端对话同规格，外部对话计入记忆系统）
    try {
      writeRawMemoryForStream(false, fullOutput, false, [...history, userMsg])
    } catch (err) {
      console.error('[messaging] RAW 记忆写入失败:', (err as Error).message)
    }
  }

  /**
   * 编排入口：LLM 预热 + 三阶段串联 + sessionId 收尾。
   * 外部消息（飞书等）→ 完整月蚀链路：会话历史 + 上下文组装 + 工具循环。
   * 与 runStream 的区别：不依赖 WS 连接（无 token/工具事件推送），直接返回最终回复文本。
   *
   * **整轮入队**（0.53.10）：`serverCtx.sessionId` 是跨模块共享的可变单例；若只把
   * streamWithTools 入队、组装留在队列外，WS/房间/局域网并发时会互相覆盖上下文
   * （A 的段构建读到 B 的 sessionId，甚至读到 undefined）。现在把
   * 「设 sessionId → 组装 → 流 → 持久化 → 清 sessionId」整体放进同一串行队列，
   * 与 WS 主链路（同样经 streamSession.enqueue）严格互斥。
   */
  return async (text: string, sessionId: string, aiId?: number, purpose?: PromptPurpose): Promise<string> => {
    let output = ''
    await streamSession.enqueue(async () => {
      // LLM 预热也放进队列：makeLlmClient 会写共享 ref，不能与在飞轮次并发。
      if (!llmClientRef.current.isReady()) {
        llmClientRef.current = makeLlmClient(configStore.get().llm)
      }
      // 多 AI（P2）：headless 同样按会话 aiId 泛化（工具 paths / segment 注入读 serverCtx.sessionId）
      serverCtx.sessionId = sessionId
      try {
        const { history, userMsg, injectedMessages } = await assembleHeadlessContext(text, sessionId, aiId, purpose)
        const { fullOutput, fullHeadlessReasoning } = await runHeadlessTurn(
          injectedMessages,
          sessionId,
          purpose,
          aiId
        )
        await runHeadlessTurn(injectedMessages, sessionId, purpose, aiId)
        // 房间规划轮**不落盘**（0.53.18）：规划是房间自己的 TODO（给 AI 自己看），不是一段
        // 要对用户说的话。写进会话历史会以「提示词当成用户消息 + JSON 计划当成 AI 回复」的形式
        // 混进用户正常聊天，且每轮循环都追加一条。上下文改由承载会话的逆生树与采集输入承担。
        if (purpose !== 'room') await persistHeadlessTurn(sessionId, history, userMsg, fullOutput, fullHeadlessReasoning)
        output = fullOutput
      } finally {
        // 结束后清空，避免残留串扰后续请求（与 runStream 收尾一致）
        serverCtx.sessionId = undefined
      }
    })
    return output
  }
}
