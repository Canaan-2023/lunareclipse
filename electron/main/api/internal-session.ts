/**
 * @category 核心
 * @summary 内部会话层：摘要/路由配置、上下文装配、两写摘要继承单飞维护队列

 * 从 server.ts 拆出（纯搬移，不改行为；提供 createInternalSessionLayer(deps) 工厂注入依赖）。
 * 为什么存在：AI 后台自维护的会话池（v11 双层会话上下文层）承载「内部会话 → LLM 注入上下文」
 * 与「两写/摘要/超限继承延迟维护」两件事，跨 runStream / runHeadlessChat / lilith-endpoints 消费。
 * 独立成文件：把读 monitor 配置、摘要预算推导、锚点/缓存索引装配、单飞+末次合并的维护队列
 * 收拢为单一 Layer，调用方只拿四个能力点（internalLlmChat / buildSessionContext /
 * getSessionSummaryCfg / enqueueInternalSessionJob / resolveStreamSessionContext），
 * 不再与 server.ts 的主对话闭包互相纠缠。
 *
 * 超限处理语义（0.17 起，取代旧「原地压缩」）：
 * 会话 totalChars 超 summaryBudgetChars 时【不删消息、不覆盖旧摘要】——原会话完整冻结，
 * AI 再加工旧会话生成继承摘要，新建子会话承接（parentId/gen 继承链，路由只选叶子）。
 * 为什么这样设计：原地压缩会丢失原文，而原文是 AI 后续回翻的底稿；冻结+继承使历史
 * 可沿 parentId 链完整回溯，摘要只是索引而非替代品。
 * 原始数据始终保留：未来 AI 需要时可按继承链 parentId 回翻旧会话文件获取完整原始上下文。
 *
 * 未来功能增减规划（本模块扩展边界）：
 * - 新增内部会话维护维度（如按会话标记归档、过期清理）：在 runInternalSessionMaintenance
 * 批次尾部追加步骤即可，队列串行语义天然防竞态；
 * - 路由策略调整（阈值/优先级/多语言意图识别）：只改 resolveStreamSessionContext 内 routeSession
 * 的调用参数，或替换 routeSession 实现；
 * - 摘要格式/预算口径变更：getSessionSummaryCfg 与 buildSessionContext 同层内联，两处口径
 * 天然一致（K1：存储到预算就继承、注入到预算就截断）。
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { ConfigStore } from './config-store'
import type { SessionStore } from './session-store'
import type { ToolContext } from '../tools/base-tool'
import { LLMClient } from './llm'
import type {
  ChatMessage,
  InternalMessage,
  SessionSummaryConfig
} from '@shared/types'
import type { SessionContext, InternalSession } from '@shared/types'
import type { LightChat } from '../services/session-utils'
import { InternalSessionStore, DEFAULT_INTERNAL_SESSION_TITLE } from '../services/internal-session-store'
import { describePlacement } from '../services/session-placement'
import { confirmSessionMatch, routeSession } from '../services/session-router'
import { formatSessionTime } from '../services/session-utils'
import {
  generateSummaryUpdate,
  generateInheritanceSummary
} from '../services/session-summarizer'
// 内部会话配置单源（W1）：默认值统一从 monitor-config 取，不在本层二次书写。
import { DEFAULT_MONITOR_CONFIG } from '../monitor/monitor-config'
import { resolveSummaryBudgetChars } from './server-utils'
import type { LLMConfig } from '@shared/types'

/** 内部会话层依赖注入接口（createInternalSessionLayer 工厂参数） */
export interface InternalSessionLayerDeps {
  configStore: ConfigStore
  sessionStore: SessionStore
  /** 外部共享的内部会话存储（startApiServer 可选传入；无则按 sessionStore 目录自建） */
  sharedInternalSessionStore: InternalSessionStore | undefined
  toolCtx: ToolContext
  makeLlmClient: (cfg: LLMConfig) => LLMClient
}

/** 单条延迟维护任务：一轮对话的 user/assistant 两写 + 工具摘要 */
export interface InternalSessionJob {
  userMsg?: ChatMessage
  aiMsg: ChatMessage
  toolSummaries: string[]
}

/** 内部会话上下文解析请求（路由/装载入口），供 runStream 主回复轮与审查轮共用 */
export interface ResolveSessionContextParams {
  /** runStream opts（审查轮带 systemOverride 时走沿用分支，不路由不新建） */
  opts: { systemOverride?: string } | undefined
  sessionId: string | undefined
  messages: ChatMessage[]
  /** 该连接当前选中的内部会话（主回复轮路由后写入，审查轮沿用） */
  activeInternalContext: { sessionId: string; internalId: string } | null
}

/** 内部会话层对外能力点 */
export interface InternalSessionLayer {
  /** 内部会话轻量 LLM 通道（路由/摘要/压缩共用隔离实例，不与主对话抢占） */
  internalLlmChat: LightChat
  /** 内部会话 → 注入上下文（锚点 + 预算内保留消息 + 缓存索引） */
  buildSessionContext: (internal: InternalSession) => SessionContext
  getSessionSummaryCfg: () => SessionSummaryConfig
  /** 两写/摘要/压缩单飞队列入口（500ms 末次合并） */
  enqueueInternalSessionJob: (sid: string, internalId: string, job: InternalSessionJob) => void
  /**
   * 主回复轮路由（continue/create）+ 审查轮沿用 → sessionContext 与 activeInternalContext。
   * 任何未启用/路由失败 → 返回 null（线性管线，不截断）。
   */
  resolveStreamSessionContext: (
    params: ResolveSessionContextParams
  ) => Promise<{
    sessionContext: SessionContext | null
    activeInternalContext: { sessionId: string; internalId: string } | null
  }>
}

/**
 * 构建用户界面会话历史的预览文本（对话对口径，路由/二次确认前注入）。
 * 为什么需要（用户需求，2026-10-08）：旧路由只看 userInput 单条消息，路由 LLM 缺乏
 * 用户界面上的前后语境，难以精准判断该续哪个内部会话。选取内部会话注入前，先让路由
 * LLM 看到最近 N 个「对话对」（一个对话对 = 一条用户输入 + 一条 AI 输出），选取注入后
 * 与现状一致（预览不进入主链路、不落盘内部会话——它只是路由阶段的参考上下文）。
 * 为什么按对而非按字符（口径与 buildTurnPairsIntent 对齐）：主题延续是语义单元层面的
 * 判断，按字符硬切会把一问一答割裂成残句；按「对」取保证每个上下文单元自洽，且长度
 * 随对话节奏自然增长，没有魔法数字。
 * 为什么排除当前输入与激活消息：最后一条非激活 user 就是本轮输入（调用方已单独
 * 取作 userInput），预览应只覆盖「它之前」的历史，避免重复；activation 消息是 AI
 * 自主续写的产物、无对应用户输入，不算对话对，也不应占据预览配额。
 * 返回空串 = 无历史可预览或配置为 0（routePreviewTurnPairs<=0 等同旧行为：不带预览）。
 */
function buildUiHistoryPreview(messages: ChatMessage[], pairs: number): string {
  if (pairs <= 0) return ''
  // 从后往前定位最后一个非激活 user 消息（= 本轮输入），作为预览窗口的终点（不含自身）
  let currentUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user' && !m.activation) {
      currentUserIdx = i
      break
    }
  }
  if (currentUserIdx < 0) return ''
  // 在终点之前向后回溯 N 个「非激活 user」消息作为窗口起点（最近 N 对历史）；
  // 历史不足 N 对时从 0 开始尽量携带（宁多勿空，与 buildTurnPairsIntent 同策略）。
  let userSeen = 0
  let start = 0
  for (let i = currentUserIdx - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user' || m.activation) continue
    userSeen++
    if (userSeen === pairs) {
      start = i
      break
    }
  }
  // 窗口内按「用户: / AI:」成对渲染：跳过 activation/空内容，只留 user/assistant 正文。
  // 不截断单条消息（用户需求 2026-10-08）：预览是路由判断的参考上下文，完整上下文由 AI
  // 自行决定关注点，宿主不做预设截断——原文仍在用户会话里，选中注入时 AI 能看全量。
  const lines: string[] = []
  for (let i = currentUserIdx - 1; i >= start; i--) {
    const m = messages[i]
    if (m.role !== 'user' && m.role !== 'assistant') continue
    if (m.activation) continue
    const text = typeof m.content === 'string' ? m.content : ''
    if (!text.trim()) continue
    const label = m.role === 'user' ? '用户' : 'AI'
    lines.push(`${label}: ${text}`)
  }
  // 窗口是倒序推进（从近到远），翻转为时间正序再渲染，路由 LLM 读起来与用户界面一致
  return lines.reverse().map((l) => `- ${l}`).join('\n')
}

/**
 * 创建内部会话层（startApiServer 装配时调用一次，deps 注入闭包依赖）。
 * 为什么是工厂：本层需要 configStore/sessionStore/toolCtx 与 makeLlmClient 的组合能力，
 * 且内部持有懒创建的 summaryLlmClient 隔离实例——工厂让依赖显式化、生命周期归调用方。
 */
export function createInternalSessionLayer(deps: InternalSessionLayerDeps): InternalSessionLayer {
  const { configStore, sessionStore, sharedInternalSessionStore, toolCtx, makeLlmClient } = deps

  // 内部会话存储（v11 双层会话上下文层）：
  // AI 后台自维护的会话池：sessions/{sessionId}/ai/{internalId}.json，与 SessionStore 同 dir 跟随用户切换。
  const internalSessionStore = sharedInternalSessionStore ?? new InternalSessionStore(() => sessionStore.getDir())

  // 内部会话摘要/路由专用 LLMClient——与主对话隔离，防并发抢占。
  // 懒创建：首次调用时才构造，配置变化后下次重建。
  let summaryLlmClient: LLMClient | null = null
  const getSummaryLlmClient = (): LLMClient => {
    if (!summaryLlmClient || !summaryLlmClient.isReady()) {
      summaryLlmClient = makeLlmClient(configStore.get().llm)
    }
    return summaryLlmClient
  }

  // monitor 配置读取（.dmn_monitor/config.json；与 sys-state 注入同源）
  // 每轮读取（小文件，µs 级），保证用户改开关立即生效
  const readMonitorCfg = (): Record<string, unknown> | null => {
    try {
      const monitorConfigDir = toolCtx?.paths ? join(toolCtx.paths.root, '.dmn_monitor') : null
      if (monitorConfigDir && existsSync(join(monitorConfigDir, 'config.json'))) {
        return JSON.parse(readFileSync(join(monitorConfigDir, 'config.json'), 'utf-8'))
      }
    } catch {
      // 配置读取失败走默认值
    }
    return null
  }

  // 内部会话摘要/路由配置：monitor 文件 sessionSummary 段优先，未配置用单源默认值。
  // 单源（W1）：默认值统一来自 monitor-config 的 DEFAULT_MONITOR_CONFIG.sessionSummary，
  // 不再在本层维护第二份字面量（原 LOCAL_SESSION_SUMMARY_DEFAULT 与 monitor 双源，
  // 改默认值需同步两处，易漏——评审 W1 确认收敛）。
// summaryBudgetChars=0 时自动推导：模型窗口 × 1/4（resolveSummaryBudgetChars，保底 30000），
   // 使超限继承预算与主流模型窗口匹配（原 700000 字符远超窗口，继承层永不触发——评审 K1；
   // 设计依据：未配置时按自身模型最大上下文四分之一自动配置，且与注入预算
   // SOFT_BUDGET_RATIO(0.5) 拉开倍数差，保证存储继承阈值低于注入预算、上下文留有回翻余量）。
  // 推导口径复用 server-utils.resolveSummaryBudgetChars（IPC 层回显「生效值」同函数，
  // 避免两处推导分叉——评审 W1）。
  // ⚠️ 与 SOFT_BUDGET_RATIO(0.5，注入预算口径) 区分：存储继承阈值取 1/4 窗口而非 1/2，
  // 避免「存满即继承」时注入预算同值、上下文无余量回翻（4 倍于阈值才到 1 个窗口）。
  const getSessionSummaryCfg = (): SessionSummaryConfig => {
    const raw = readMonitorCfg()
    const seg = raw?.sessionSummary as Partial<SessionSummaryConfig> | undefined
    const merged: SessionSummaryConfig = {
      ...DEFAULT_MONITOR_CONFIG.sessionSummary,
      ...(seg ?? {})
    }
    const model = configStore.get().llm?.model ?? ''
    merged.summaryBudgetChars = resolveSummaryBudgetChars(model, merged.summaryBudgetChars)
    return merged
  }

  // 内部会话 → 注入上下文：锚点消息（id/title/createdAt/updatedAt/summary + 保留消息）
  // + 缓存索引消息（由 cacheLocations 渲染；无缓存时省略）。
  // 缓存索引并入 anchorMessages 尾部（作为该内部会话自身历史的一部分），不单独成注入段——
  // 各内部会话的缓存随各自历史会话注入、互不混用。
  // 注意：不复用 buildCacheIndexMessage（那是旧块树 CacheLocation 签名），这里渲染字符串数组。
  // 注入预算截断（K1）：messages 从最新往回累计，超过 summaryBudgetChars 预算即丢弃更早的
  // （至少保留最后一条，保证本轮可用）；锚点与缓存索引始终保留。与存储侧超限继承同预算同语义：
  // 存储到预算就触发继承、注入到预算就截断，两层口径一致，避免全量注入撑爆上下文。
  const buildSessionContext = (internal: InternalSession): SessionContext => {
    // 逆生树三边「摆放结构」（继承轴代际/时间轴时间线实线 + AI 判定新话题线虚线；
    // 单源实现 services/session-placement.ts）。
    // 为什么收敛：同一套语义此前在锚点注入 / session-router 候选清单 / session_select 工具
    // 三处各自书写，字段口径漂移无报错只会静默失效；describePlacement 统一兜底，
    // 三处消费格式逐字节一致（本注入行内联展示、不进 UI）。
    // 语义速读：继承=压缩上下文（父会话冻结、子会话承接，gen+1）；时间=话题延续
    // （timeBranchId 已延续=锁定只读、timeSourceId 可逐级回翻、isTimeFork=时间副本）；
    // 新话题（isNewTopic）=AI 判定话题新开，虚线、空白承接不复制父内容。
    const placement = describePlacement(internal, {
      get: (id) => internalSessionStore.get(internal.ownerSessionId, id),
      listSiblings: () => internalSessionStore.list(internal.ownerSessionId)
    })
    // 会话文件绝对路径：AI 需要原话/早期细节时，用 read_md/Read 按此路径回翻原始会话文件
    //（本文件为 JSON 会话全文，含 messages；锚点只注入了摘要与预算内最近消息）。
    const filePathAbs = internalSessionStore.absFilePath(internal.ownerSessionId, internal.filePath)
    const anchor: ChatMessage = {
      id: `internal_anchor_${internal.id}`,
      role: 'system',
      content: `【内部会话】id=${internal.id}\n${placement.genLine}${placement.timeLineBlock ? `\n${placement.timeLineBlock}` : ''}\n标题：${internal.title}\n创建于 ${formatSessionTime(internal.createdAt)}，更新于 ${formatSessionTime(internal.updatedAt)}\n会话文件：${filePathAbs}\n【会话摘要】${internal.summary || '（无摘要）'}`,
      createdAt: internal.createdAt
    }
    const budget = getSessionSummaryCfg().summaryBudgetChars
    const contextMsgs: ChatMessage[] = []
    // 从最新往回遍历，累计字符；budget 用尽即停（保留最近段）+ 至少保最后一条
    let usedChars = 0
    for (let i = internal.messages.length - 1; i >= 0; i--) {
      const m = internal.messages[i]
      const msgLen = (m.content ?? '').length
      if (contextMsgs.length > 0 && usedChars + msgLen > budget) break
      usedChars += msgLen
      contextMsgs.unshift({
        id: m.id,
        role: m.role === 'note' ? 'system' : m.role,
        content: m.content,
        createdAt: m.createdAt
      })
    }
    const cacheIndexMessage: ChatMessage | null =
      internal.cacheLocations.length > 0
        ? {
            id: `cache_index_${internal.id}`,
            role: 'system',
            content: `【记忆缓存位置】AI 可直接读取以下记忆缓存文件（免重复检索）：\n${internal.cacheLocations
              .map((c) => `- ${c}`)
              .join('\n')}`,
            createdAt: internal.updatedAt
          }
        : null
    return {
      internal,
      anchorMessages: [anchor, ...contextMsgs, ...(cacheIndexMessage ? [cacheIndexMessage] : [])]
    }
  }

  // 内部会话轻量 LLM 通道（路由/摘要/压缩共用 summaryLlmClient 隔离实例，不与主对话抢占）
  const internalLlmChat: LightChat = async (msgs, model) => {
    const result = await getSummaryLlmClient().chatWithTools(
      msgs,
      [],
      model,
      { temperature: 0.2 }
    )
    return result.content ?? ''
  }

  // ===== 内部会话延迟维护队列（K3 修复：单飞 + 末次合并）=====
  // 为什么存在：内部会话两写/摘要/压缩走延迟任务（不阻塞回复流），但原实现每个
  // done 回合独立 setTimeout —— 快速连发的多轮会各起一个任务并发执行，append 与
  // 摘要/压缩互相覆盖（两个任务同时读到旧状态再先后写回，后者覆盖前者的 patch）。
  // 本队列保证：同一内部会话的维护任务单飞串行（每轮一个 job，链式续跑），
  // 且 500ms 内连发的新回合合并进当前待办（多轮 jobs 合并一次摘要）。
  // 必要性：K3 摘要竞态已确认为 High 级缺陷；串行化是竞态的机制层修复，不依赖 LLM 时序。
  interface InternalSessionJobSlot {
    timer: ReturnType<typeof setTimeout> | null
    chain: Promise<void>
    jobs: InternalSessionJob[]
  }
  const internalSessionJobQueue = new Map<string, InternalSessionJobSlot>()

  // 入队 + 500ms 末次合并：新到达的 job 先并入同 key 待办，重置计时器；
  // 计时到点后把当前所有 job 作为一个批次，顺延到该 key 的串行链尾执行。
  const enqueueInternalSessionJob = (sid: string, internalId: string, job: InternalSessionJob): void => {
    const key = `${sid}/${internalId}`
    let slot = internalSessionJobQueue.get(key)
    if (!slot) {
      slot = { timer: null, chain: Promise.resolve(), jobs: [] }
      internalSessionJobQueue.set(key, slot)
    }
    slot.jobs.push(job)
    if (slot.timer) clearTimeout(slot.timer)
    slot.timer = setTimeout(() => {
      slot.timer = null
      const batches = slot.jobs.splice(0)
      if (batches.length === 0) return
      slot.chain = slot.chain
        .then(() => runInternalSessionMaintenance(sid, internalId, batches))
        .catch((err) => console.error('[session] 内部会话两写/摘要维护失败:', err))
    }, 500)
  }

  // 批次执行：一整个批次（含合并的多轮 jobs）只跑一次 append + 一次摘要 + 一次压缩。
  // 多轮合并语义：摘要输入把多轮的内容拼到同一轮输入里，一次 LLM 调用覆盖全部新内容
  // （避免每轮一次摘要的重复调用费用，且旧摘要只被读过一次，杜绝读到过期中间态）。
  const runInternalSessionMaintenance = async (
    sid: string,
    internalId: string,
    jobs: InternalSessionJob[]
  ): Promise<void> => {
    // 合并批次内所有 jobs 的两写消息（user + assistant 交替push，保自然顺序）
    const internalMsgs: InternalMessage[] = []
    for (const j of jobs) {
      if (j.userMsg) {
        internalMsgs.push({
          id: j.userMsg.id,
          role: 'user',
          content: typeof j.userMsg.content === 'string' ? j.userMsg.content : '',
          createdAt: j.userMsg.createdAt
        })
      }
      internalMsgs.push({
        id: j.aiMsg.id,
        role: 'assistant',
        content: typeof j.aiMsg.content === 'string' ? j.aiMsg.content : '',
        createdAt: j.aiMsg.createdAt,
        ...(j.toolSummaries.length > 0 ? { toolSummaries: j.toolSummaries } : {})
      })
    }
    await internalSessionStore.appendMessages(sid, internalId, internalMsgs)

    // 2) 常态摘要更新（失败 = 该次未执行，旧摘要保持）
    // 批次合并：多轮 user/assistant 内容拼接成一次摘要输入，工具摘要展平
    const afterAppend = internalSessionStore.get(sid, internalId)
    if (!afterAppend) return
    const mergedUser = jobs
      .map((j) => (typeof j.userMsg?.content === 'string' ? j.userMsg!.content : ''))
      .join('\n')
    const mergedAssistant = jobs.map((j) => j.aiMsg.content).join('\n')
    const mergedTools = jobs.flatMap((j) => j.toolSummaries)
    const newSummary = await generateSummaryUpdate(
      internalLlmChat,
      {
        oldSummary: afterAppend.summary,
        userContent: mergedUser,
        assistantContent: mergedAssistant,
        toolSummaries: mergedTools,
        createdAt: afterAppend.createdAt
      },
      getSessionSummaryCfg()
    )
    if (newSummary !== null) {
      await internalSessionStore.update(sid, internalId, { summary: newSummary })
    }

    // 3) 超限继承（totalChars > budget 时触发）：原会话【完全不动】，AI 再加工旧会话
    // 生成继承摘要 → 新建子会话承接（摘要写入子会话初始化 summary 与锚点）。
    // 失败 = 本次未执行，原会话保持，下次维护批次再试（不删消息、不覆盖旧摘要——继承方案核心约束）。
    // 与旧「原地压缩（generateConsolidation 删消息）」的差异：
    // 旧方案会物理删除 keepIds 之外的消息并覆盖旧摘要，原始数据丢失；
    // 新方案原始数据完整保留，未来 AI 需要时可按继承链 parentId 回翻父会话文件。
    const afterSummary = internalSessionStore.get(sid, internalId)
    if (
      afterSummary &&
      afterSummary.totalChars > getSessionSummaryCfg().summaryBudgetChars
    ) {
      const plan = await generateInheritanceSummary(internalLlmChat, { internal: afterSummary })
      if (plan) {
        // 子会话继承链：parentId = 父会话 id，gen = 父 gen+1（根=1）；
        // cacheLocations 沿用父会话（记忆缓存位置对子会话依然有效）。
        internalSessionStore.create(sid, {
          title: plan.title ?? afterSummary.title,
          parentId: afterSummary.id,
          gen: (afterSummary.gen ?? 1) + 1,
          summary: plan.summary,
          cacheLocations: plan.cacheLocations ?? afterSummary.cacheLocations
        })
      }
    }
  }

  // 主回复轮：路由（continue → 装载内部会话；create → 纯新建）→ sessionContext 锚点注入。
  // 审查轮（systemOverride）：沿用主回复轮路由选中的内部会话上下文。
  // 任何未启用/路由失败 → sessionContext=null → 线性管线（不截断）。
  const resolveStreamSessionContext = async (
    params: ResolveSessionContextParams
  ): Promise<{
    sessionContext: SessionContext | null
    activeInternalContext: { sessionId: string; internalId: string } | null
  }> => {
    const { opts, sessionId, messages } = params
    let active = params.activeInternalContext
    let sessionContext: SessionContext | null = null
    const sumCfg = getSessionSummaryCfg()
    if (sumCfg.enabled && sessionId) {
      try {
        if (opts?.systemOverride) {
          // 审查轮：不路由、不新建，沿用主回复轮选中的内部会话上下文
          const act = active
          if (act && act.sessionId === sessionId) {
            const internal = internalSessionStore.get(sessionId, act.internalId)
            if (internal) sessionContext = buildSessionContext(internal)
          }
        } else {
          // 主回复轮：显式选择优先 → 无显式选择才走自动路由（continue/create）
          // 显式选择：AI 经 session_select 工具把某个内部会话定为当前承接（store active 指针，
          // 跨请求持久）。存在且有效 → 直接装载所选会话，跳过自动路由（AI 自己路由的语义——
          // 自动路由只是从未选择过 / release 之后的兜底）。指针指向的会话已被删除（如用户
          // 手动清理）→ 清除失效指针后继续自动路由，绝不装载不存在的会话。
          const selectedId = internalSessionStore.getActive(sessionId)
          if (selectedId) {
            const selected = internalSessionStore.get(sessionId, selectedId)
            if (!selected) {
              // 指针指向的会话已不存在（用户/外部手动清理）→ 清失效指针走自动路由
              internalSessionStore.clearActive(sessionId)
            } else {
              // 显式装载前校验「仍可写」：装载后本轮对话与两写都会进入该会话，
              // 若它已被压缩（出现继承子 parentId 指向它）或时间锁定（已有 timeBranchId），
              // 继续写入会破坏「冻结+继承」语义（父会话冻结为只读底稿）。
              // 校验口径与 session_select 的拒绝规则、自动路由的可写尾端候选同源：
              // 自身无继承子 且 无 timeBranchId。
              const allSessions = internalSessionStore.list(sessionId)
              const childIds = new Set<string>()
              for (const s of allSessions) {
                if (s.parentId) childIds.add(s.parentId)
              }
              const isWritableTail = !childIds.has(selected.id) && !selected.timeBranchId
              if (isWritableTail) {
                sessionContext = buildSessionContext(selected)
                active = { sessionId, internalId: selected.id }
              } else {
                // 指针失效（已被压缩 / 已时间锁定）→ 清除后走自动路由，
                // 自动路由选中的正是最新可写尾端（继承子或时间延伸），语义连续。
                internalSessionStore.clearActive(sessionId)
              }
            }
          }
          // 显式选择成功 → 直接返回，不得再执行自动路由（否则 create/continue
          // 会把显式装载的 sessionContext 覆盖或新建会话，破坏「AI 自己路由」语义）
          if (sessionContext) return { sessionContext, activeInternalContext: active }
          // 自动路由（无显式选择 / 显式指针失效时）
          // 候选 = 逆生树最尾端：无 timeBranchId 且 无子继承（双重条件）。
          // timeBranchId 表示「本会话已向时间下级延续」→ 原会话锁定不可写；
          // 有继承子（被 parentId 引用）→ 原会话已被继承压缩，锁定。
          // 只有同时满足「自身无时间下级 + 无继承子」的会话才是可继续写入的尾端。
          // 注意：以 c.timeBranchId 是否存在判断锁定，而非「是否被他人指向」——
          // 时间副本（被指向者）恰恰是新的可写尾端，必须保留在候选内。
          const allSessions = internalSessionStore.list(sessionId)
          const childIds = new Set<string>()
          for (const c of allSessions) {
            if (c.parentId) childIds.add(c.parentId)
          }
          const candidates = allSessions.filter((c) => !childIds.has(c.id) && !c.timeBranchId)
          const lastUser = [...messages].reverse().find((m) => m.role === 'user' && !m.activation)
          const userInput =
            lastUser && typeof lastUser.content === 'string' ? lastUser.content : ''
          // 路由前预览：用户界面会话最近 N 对话对（routePreviewTurnPairs 配，0=不带），
          // 只进路由/确认提示词，不注入主链路、不落盘内部会话（需求 2026-10-08）
          const preview = buildUiHistoryPreview(messages, sumCfg.routePreviewTurnPairs)
          const route = await routeSession(internalLlmChat, { userInput, now: Date.now(), candidates, preview }, sumCfg)

          /**
           * 新建内部会话并纳入逆生树。
           * 为什么存在：首次使用内部会话、或需从一个既有会话分出新线时，需要一张承接当前
           * 输入的新会话。createAndActivate 是唯一的建档路径。
           * 父选择优先级（决定从哪个既有会话分叉，保证树形关系而非平铺成新根）：
           * 1. explicitParentId——路由契约的 parentId（AI 明确指定挂在哪个可写尾端下）；
           * 2. active 指针——当前正承接的会话（若仍为可写尾端）；
           * 3. 最近可写尾端——candidates 已按 updatedAt 降序，首项即最新承接节点；
           * 4. 以上皆无（首个会话）→ 建根，成为逆生树的第一棵树的根。
           * 双分支语义（0.31 定稿「新会话=虚线 / 延续=实线」）：
           * - newTopic=true（AI 判定话题需新开 → 虚线）：空白承接当前输入，【不复制】
           *   父会话任何内容（新话题是新的，不是旧话题的延续）；可挂 parentId 保持树形
           *   关系（虚线从该尾端引出），也可不带 parentId 成为新树根。
           * - newTopic 缺省/false（延续 → 实线）：有父时把父会话全部内容【原样继承】进新会话
           *   （messages/summary/cacheLocations 逐字复制），新会话挂继承轴向下（parentId，
           *   gen = 父 gen+1）并承接当前上下文；父会话完全不动（不改 timeBranchId、不另造
           *   副本），作为分叉基点保留原样，可随时回翻。
           * 摘要契约：initialSummary 由路由 create 输出携带（AI 写的初始摘要，描述新线干什么）；
           * 延续分支不带则沿用父会话摘要，新话题分支不带则留空（后台维护器首轮后自动生成）。
           */
          const createAndActivate = async (
            title?: string,
            explicitParentId?: string,
            initialSummary?: string,
            newTopic = false
          ) => {
            let parentId = explicitParentId
            if (!parentId) {
              const activeId = internalSessionStore.getActive(sessionId)
              if (activeId && candidates.some((c) => c.id === activeId)) parentId = activeId
            }
            if (!parentId && candidates.length > 0) parentId = candidates[0].id
            const parent = parentId ? internalSessionStore.get(sessionId, parentId) : null
            // 建即承接：新分支必须成为 active 指针（与 session_select 工具 create 路径
            // L297 语义对齐）。为什么必须：resolveStreamSessionContext 主回复轮是「显式选择
            // 优先」——store 的 active 指针存在且可写时直接装载会话、跳过自动路由。若建档
            // 不写指针，active 会残留指向旧承接（如 AI 曾 select 过的老分支），此后每轮
            // 新消息都被显式装载进老分支，新建分支永远收不到注入（0.31 线上缺陷）。
            // 同理 manual handler（ipc/session.ts createInternalSession）建后也要 setActive。
            // 副作用说明：建档即承接 = 「新分支是当前写入目标」，与「下次关键词对话应延续
            // 该分支」语义一致；AI 若要切回别的分支，用 session_select 重新选即可覆盖指针。
            if (newTopic) {
              // 新话题线（虚线）：空白承接当前输入，不复制父内容；树形关系仍保留（挂父下端）
              const internal = internalSessionStore.create(sessionId, {
                title: title ?? DEFAULT_INTERNAL_SESSION_TITLE,
                ...(parent ? { parentId: parent.id, gen: (parent.gen ?? 1) + 1 } : {}),
                ...(initialSummary ? { summary: initialSummary } : {}),
                isNewTopic: true
              })
              internalSessionStore.setActive(sessionId, internal.id)
              sessionContext = buildSessionContext(internal)
              active = { sessionId, internalId: internal.id }
            } else if (parent) {
              // 原样继承（延续实线）：父会话全部内容逐字复制进新会话（store.create 内深拷贝
              // 消息数组，两个会话对象互不共享引用，后续各自 append/update 互不影响）。
              const internal = internalSessionStore.create(sessionId, {
                title: title ?? parent.title,
                summary: initialSummary ?? parent.summary,
                messages: parent.messages,
                cacheLocations: parent.cacheLocations,
                parentId: parent.id,
                gen: (parent.gen ?? 1) + 1
              })
              internalSessionStore.setActive(sessionId, internal.id)
              sessionContext = buildSessionContext(internal)
              active = { sessionId, internalId: internal.id }
            } else {
              // 无父可继承（首个会话）：独立根（本就不存在分叉基点）。
              const internal = internalSessionStore.create(sessionId, {
                title: title ?? DEFAULT_INTERNAL_SESSION_TITLE,
                ...(initialSummary ? { summary: initialSummary } : {})
              })
              internalSessionStore.setActive(sessionId, internal.id)
              sessionContext = buildSessionContext(internal)
              active = { sessionId, internalId: internal.id }
            }
          }

          if (route?.action === 'continue' && route.internalId) {
            const internal = internalSessionStore.get(sessionId, route.internalId)
            if (internal) {
              // 选择→确认→注入（step 2 of 2）：路由只是「初步选中」候选，注入前必须二次确认
              // 该会话确实承接当前输入。确认匹配 → 注入；确认不匹配/确认失败 → 不注入
              // （选中但无关的会话【不进入上下文】，fail-closed），与 router 的
              // confirmSessionMatch 契约一致（失败按不匹配处理）。
              const cand = candidates.find((c) => c.id === route.internalId)
              const confirm = cand
                ? await confirmSessionMatch(
                    internalLlmChat,
                    { userInput, now: Date.now(), candidate: cand, preview },
                    /* model */ undefined
                  )
                : null
              if (cand && confirm?.matched) {
                sessionContext = buildSessionContext(internal)
                active = { sessionId, internalId: internal.id }
              } else {
                // 确认不匹配（含确认失败/解析失败 fail-closed）→ 输入与被选会话无关：
                // 用户定稿「无关的会话不会进入上下文」——新建【新话题】空白承接
                // （newTopic=true，虚线），不复制被否定会话的任何内容（否则无关历史照样
                // 流入新会话上下文）；树形挂接仍由 createAndActivate 自动取 active/最近尾端。
                await createAndActivate(route.title, undefined, route.summary, true)
              }
            } else {
              // 路由目标已不在存储中（已清理/索引过期）→ 视同无关：新建新话题空白承接
              await createAndActivate(route.title, undefined, route.summary, true)
            }
          } else if (route?.action === 'create') {
            // create：newTopic=true 建新话题线（虚线，空白承接不复制）；缺省/false 从可写尾端
            // 原样继承分叉（实线延续）。parentId 契约来自路由（AI 明确指定），缺省时
            // createAndActivate 自动取 active/最近可写尾端，保证树形关系不缺失。
            await createAndActivate(route.title, route.parentId, route.summary, route.newTopic)
          } else {
            // route 为 null（仅剩空输入一种情况：LLM 失败/解析失败/continue 非法已在
            // routeSession 内回退 create 兜底）→ 保持 sessionContext=null（线性管线，
            // 不注入不建档）；空输入无内容可归档，不需要建档动作。
          }
        }
      } catch (err) {
        console.error('[session] 内部会话路由/装载失败，回退线性管线:', err)
        active = null
      }
    }
    return { sessionContext, activeInternalContext: active }
  }

  return {
    internalLlmChat,
    buildSessionContext,
    getSessionSummaryCfg,
    enqueueInternalSessionJob,
    resolveStreamSessionContext
  }
}