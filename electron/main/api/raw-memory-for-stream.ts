/**
 * @category 核心
 * @summary RAW 记忆写入（主对话流/无头会话共用）：输出纪律剥离 → 用户/AI 实名标注 → 按会话 AI 归位落盘
 * @note 为什么存在：`writeRawMemoryForStream` 被主对话流 onDone/onError 与无头会话共用，
 * 是「对话对 → RAW」的唯一写入点；只依赖 rawMemoryWriter / 配置 / 用户 / 会话 id 四个注入点，
 * 故从宿主 `server.ts` 外移（ADR-02 第二轮），行为逐字节等价。
 * @note 不删理由：RAW 是记忆检索面（AI 可直接 Read 记忆文件），写入点若漏剥离思考块，
 * 思考会以「记忆命中内容」身份进入上下文，绕过 finalAiMsg 落盘处的剥离钩子。
 */
import type { ConfigStore } from './config-store'
import type { UserStore } from '../models/user-store'
import type { BaseDataPaths } from '../models/paths'
import type { ToolContext } from '../tools/base-tool'
import type { ChatMessage } from '@shared/types'
import type { RawMemoryWriter } from '../services/raw-memory-writer'
import { sourceOfSession } from '../services/raw-memory-writer'
import { readAiRegistry, findAiById } from '../models/ai-registry'
import { stripThinkingLeak } from '@shared/utils/output-discipline'

export interface RawMemoryForStreamDeps {
  rawMemoryWriter: RawMemoryWriter | null
  activationContentRef: { current: string | null }
  configStore: ConfigStore
  userStore: UserStore
  dataPaths: BaseDataPaths
  /** 会话 → 所属 AI 编号（多 AI P2；实现见 ./ai-scope） */
  resolveSessionAiId: (sessionId?: string) => number
  /** 宿主工具上下文：仅读 sessionId（每轮由 WS/流式链路写入） */
  serverCtx: ToolContext
}

export type WriteRawMemoryForStream = (
  isInterrupted: boolean,
  fullOutput: string,
  activation: boolean,
  messages: ChatMessage[],
  interruptReason?: string
) => void

/**
 * 构造统一写入 raw_memory 的函数（onDone + onError 共用，避免三处重复逻辑不一致）
 * - activation=true：用户原话栏写【系统自激活】{内容}
 * - activation=false：用户原话栏写真实用户消息
 * - 中断时：AI 回复末尾追加【中断】因 {原因} 中断
 *
 * 参数从流式链路内部传入（fullOutput/activation/messages 是 runStream 的局部变量）。
 */
export function createWriteRawMemoryForStream(deps: RawMemoryForStreamDeps): WriteRawMemoryForStream {
  const { rawMemoryWriter, activationContentRef, configStore, userStore, dataPaths, resolveSessionAiId, serverCtx } = deps

  return (
    isInterrupted: boolean,
    fullOutput: string,
    activation: boolean,
    messages: ChatMessage[],
    interruptReason?: string
  ): void => {
    if (!rawMemoryWriter) {
      console.error(
        '[server] 写入 raw_memory 跳过：rawMemoryWriter 未初始化（dataPaths 为 null？）'
      )
      return
    }
    if (!fullOutput) {
      console.error('[server] 写入 raw_memory 跳过：fullOutput 为空（AI 未产出回复？）')
      return
    }
    // 输出纪律："思考不进上下文"的 RAW 记忆通道封堵——RAW 正文先剥离思考块再落盘。
    // 为什么存在：AI 会主动检索 raw_memory 原文（read_md / Read 可直接读取记忆文件，
    // 命中时正文以记忆内容身份进入上下文）。
    // 三个调用点（headless / 主路径 / 中断）传入的 fullOutput 均为
    // 未剥离原文，若思考块混入正文，AI 检索记忆时思考会以"记忆命中内容"身份进入上下文，
    // 绕过 finalAiMsg 处剥离钩子（2026-09-27 评审确认的 MAJOR）。
    // 注意：记忆链路只有「RAW → 记忆工作流提炼 → create_memory 落库」，无任何自动回注——
    // 提炼后的记忆条目不会被注入主对话上下文（PreLLMCall hook 仅治理指令，会话上下文
    // 组装只读会话历史），思考块进入上下文的唯一记忆通道就是 AI 主动检索 RAW 原文。
    // 作用：写入点统一剥离，与历史落盘同规；中断追加的【中断】说明仅供参考信息，
    // 不含模型思考，不参与剥离。
    // 不删理由：剥离钩子只在 finalAiMsg 落盘路径生效，RAW 是独立通道（记忆检索面），
    // 不在写入点剥离则 AI 检索记忆时读到的思考块无法被兜住。
    const cleanedOutput = stripThinkingLeak(fullOutput).text
    if (!cleanedOutput) {
      console.error('[server] 写入 raw_memory 跳过：fullOutput 剥离思考块后为空（仅思考无正文？）')
      return
    }
    let userMessageForMemory = ''
    let referencedFiles: string[] = []
    if (activation) {
      userMessageForMemory = `【系统自激活】${activationContentRef.current ?? '系统触发自动续接'}`
    } else {
      const userMsg = messages.length > 0 ? messages[messages.length - 1] : undefined
      // 同路由端与两写的取 user 逻辑，排除 activation 消息：
      // 若异常链路里尾部混入系统注入（审查 phaseMsg 等，本是 activation:true），
      // 不排除会把提示词全文写进 raw_memory 冒充用户记忆（注入面）。
      // 普通轮尾部必为真实用户输入（前端构造保证），此处是纵深防御，成本为零。
      if (userMsg && userMsg.role === 'user' && !userMsg.activation && userMsg.content) {
        userMessageForMemory = userMsg.content
        referencedFiles = (userMsg.attachments ?? []).map((a) => a.path).filter(Boolean)
      }
    }
    if (!userMessageForMemory) {
      console.error(
        '[server] 写入 raw_memory 跳过：未找到用户消息（messages 为空或最后一条非 user？）'
      )
      return
    }
    const aiReply =
      isInterrupted && interruptReason
        ? `${cleanedOutput}\n\n【中断】因 ${interruptReason} 中断`
        : cleanedOutput
    try {
      // 说话人实名标注：用户带实名+UID（如 `## 用户（用户名，UID=1）`），AI 带名字（如 `## AI（月蚀）`）
      // 无实名/无名字时回退裸标题，解析按行级前缀匹配均兼容
      const currentUser = userStore.getCurrentUser()
      const userLabel = currentUser ? `${currentUser.用户名}，UID=${currentUser.UID}` : undefined
      // 多 AI（P2）：RAW 写入按当前会话归属的 AI 归位（AI 社交/公示板=AI2 等，
      // 月蚀主链路会话无 aiId → resolveSessionAiId 回退 1，行为不变）
      const rawAiId = resolveSessionAiId(serverCtx.sessionId ?? undefined)
      const aiRecord = dataPaths ? findAiById(readAiRegistry(dataPaths.aiRegistryJson), rawAiId) : null
      const aiLabel = aiRecord?.name || configStore.get().aiName || '月蚀'
      rawMemoryWriter.write(
        userMessageForMemory,
        aiReply,
        referencedFiles,
        new Date().toISOString(),
        userLabel,
        aiLabel,
        currentUser ? { uid: currentUser.UID, aiId: rawAiId } : undefined,
        { source: sourceOfSession(serverCtx.sessionId ?? undefined) }
      )
    } catch (err) {
      console.error('[server] 写入 raw_memory 失败:', err, {
        activation,
        isInterrupted,
        userMessageLen: userMessageForMemory.length,
        aiReplyLen: aiReply.length,
        timestamp: new Date().toISOString()
      })
    }
  }
}
