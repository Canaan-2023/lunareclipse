/**
 * 会话结构共享类型（含内部会话与双层摘要）。
 * 为什么存在：会话由主进程持久化、前端渲染展示，内部会话（AI 视角）与滚动摘要又参与后端
 * 上下文注入，两侧必须共用同一结构契约。
 * 作用：导出 Session、InternalMessage/InternalSession、SessionSummaryConfig、SessionContext 等类型。
 */
import type { ChatMessage } from './chat'

export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  /** 所属 AI 编号（ai-registry.json 中的 id；月蚀=1 等）。旧会话/未设置时缺省回退 1 */
  aiId?: number
  model?: string
  /** 代码审查模式：开关开启时 AI 回复完成后系统自动触发 code-review agent 审查上一轮输出质量。
   *  状态持久化到 session，重启后恢复。undefined 等同 false。*/
  continuousActivation?: boolean
  /** 滚动摘要（MemGPT 式）：被上下文窗口截断的旧对话由 LLM 压缩成摘要，每轮注入。
   *  短期记忆（最近消息）完整保留，中期记忆（被截断部分）以摘要形式存活，不直接遗忘。*/
  summary?: string
  /** 摘要游标：上次已并入摘要的最后一条消息的 createdAt。用于增量摘要去重——
   *  每轮被截断的旧消息只在游标之后的新消息才并入摘要，避免重复压缩同一批旧消息导致摘要膨胀。*/
  summaryCursorAt?: number
}

/** 内部会话消息（AI 看的会话上下文；字段对齐 ChatMessage 渲染所需，前端直接复用普通消息气泡） */
export interface InternalMessage {
  id: string
  role: 'user' | 'assistant' | 'note'
  content: string
  createdAt: number
  /** 工具一句话摘要（复用展示层 extraction，AI 维护/用户可编辑） */
  toolSummaries?: string[]
}

/**
 * 内部会话（AI 后台自维护的会话池；存 sessions/{sessionId}/ai/{internalId}.json）
 * 继承链：上下文达上限后原会话不动，新建子会话承接（AI 再加工旧会话生成继承摘要写入
 * 子会话 summary，初始化锚点起效）。根会话无 parentId/gen=1；每继承一次 gen+1。
 * 原始会话完整保留供 AI 按 id 回翻（文件即原文），摘要不再覆盖旧会话。
 */
export interface InternalSession {
  /** 唯一 id（is_<时间戳随机>） */
  id: string
  /** 绑定用户会话（= 所在会话文件夹；双层校验字段） */
  ownerSessionId: string
  /** 会话名；AI/用户都可直接编辑 */
  title: string
  /** 摘要；AI 自维护，用户可直接编辑；子会话初始化 = 父会话的继承摘要 */
  summary: string
  /** 继承链父会话 id（根会话无）。有子会话的父会话不参与路由候选（只选最新叶子） */
  parentId?: string
  /** 继承代数：根=1（缺省视为 1），每继承一次 +1；最新叶子 = 链上 gen 最大者（仅内部使用，不展示 UI） */
  gen?: number
  /** ★ 新话题分支标记：true = AI 判定话题需要新开、从父会话引出的新会话（逆生树虚线连线，
   *  与继承（实线 = 同一延续）语义对立：新会话是「另一件事」而非父的压缩承接）。
   *  AI 经路由判定创建时显式设置；缺省 = 继承子（单线延续，实线）。 */
  isNewTopic?: boolean
  /** ★ 会话创建时间：本内部会话建立时刻；永不被压缩/删除（保留原始数据供回翻），供溯源 */
  createdAt: number
  /** 最近一次写入时间（排序依据） */
  updatedAt: number
  /** 上下文层；不设轮数上限，AI 自主追加，用户可直接增删改（继承后原会话消息不再改动） */
  messages: InternalMessage[]
  /** messages+summary 字符数（写入后重算；> summaryBudgetChars 触发继承子会话） */
  totalChars: number
  /** 记忆缓存：AI 调记忆系统后的位置索引（继承时复制给子会话，原会话保留） */
  cacheLocations: string[]
  /** ★ 时间连线下级 id（逆生树机制）：当 AI 找不到合适会话时，从最新会话延伸时间线到新建会话。
   *  被设置 timeBranchId 的会话 = 时间线已延续，不能再直接使用（只能回翻）；
   *  无 timeBranchId 的会话 = 时间线末梢，可继续写入或作为路由候选。
   *  与 parentId（父子继承）独立：一个会话可以同时有 parentId（继承来源）和 timeBranchId（时间延续）。 */
  timeBranchId?: string
  /** ★ 时间分叉标记：true = 本会话是通过时间线复制产生的副本（系统自动行为）；
   *  false/undefined = 普通会话（用户/AI 新建或继承产生）。用于 UI 区分显示。 */
  isTimeFork?: boolean
  /** ★ 时间分叉源会话 id（逆生树时间线回溯锚点）：仅 isTimeFork=true 时有值，
   *  记录本副本复制自哪个会话。AI 可沿 timeSourceId 逐级回翻上游原始会话文件，
   *  重建整条时间线（副本 → 源 → 源的源…）；与继承链 parentId 相互独立。 */
  timeSourceId?: string
  /** ★ 本会话的物理文件路径（相对于 `sessions/{ownerId}/ai/` 的相对路径）。
   *  为什么存在：逆生树 NNG 嵌套后目录深度不固定，O(n) 递归扫描每次操作不可接受。
   *  冷启动时由 store 层一次性扫描所有 .json 建立 id→filePath 索引，后续所有
   *  get/list/update/delete 均 O(1) 定位磁盘位置；移动/分叉时由 store 层写入新
   *  路径并同步更新索引。字段必选但冷启动兼容：缺失时回退到 aiDir/id.json 根目录。 */
  filePath: string
}

/** 内部会话列表摘要（路由候选/列表渲染用，不传消息正文） */
export interface InternalSessionSummary {
  id: string
  ownerSessionId: string
  title: string
  summary: string
/** 继承链父会话 id（与 InternalSession.parentId 同义；路由叶子过滤依据） */
  parentId?: string
  /** 继承代数：根=1（缺省视为 1）；每继承一次 +1；最新叶子 = 链上 gen 最大者 */
  gen?: number
  /** ★ 新话题分支标记：true = AI 判定话题需要新开、从父会话引出的新会话（虚线连线）。
   *  与继承（parentId，实线=同一延续）无关：新会话是「另一件事」，不是父的压缩承接；
   *  继承子则仍是单线延续。AI 经路由判定创建时显式设置，缺省 = 继承子。 */
  isNewTopic?: boolean
  createdAt: number
  updatedAt: number
  messageCount: number
  totalChars: number
  cacheLocations: string[]
  /** 时间连线下级 id（逆生树机制）：见 InternalSession.timeBranchId */
  timeBranchId?: string
  /** 时间分叉标记：见 InternalSession.isTimeFork */
  isTimeFork?: boolean
  /** 时间分叉源会话 id：见 InternalSession.timeSourceId */
  timeSourceId?: string
  /** 本会话的物理文件路径（相对于 `sessions/{ownerId}/ai/` 的相对路径）。
   *  与 InternalSession.filePath 同义：store 层 O(1) 定位、冷启动一次建索引、移动/分叉同步更新。
   *  必选但兼容存量：缺失时回退到 aiDir/id.json 根目录。 */
  filePath: string
}

/** 双层会话摘要/路由配置（替代旧 contextTree 段；AI 存储继承阈值，非注入限制） */
export interface SessionSummaryConfig {
  /** 总开关；false = 纯线性模式（无内部会话、无路由、无摘要维护） */
  enabled: boolean
  /** 摘要单条上限（默认 200） */
  summaryMaxChars: number
  /** 每个内部会话的存储继承阈值（字符；0 = 自动推导 = 模型窗口 × 1/4（SESSION_BUDGET_RATIO，保底 30000）。
   *  超限触发「继承」：原会话不动 + AI 再加工生成继承摘要 + 新建子会话承接（0.17 起取代旧语义压缩）。
   *  设置页可改；旧 700000 默认值已随 0.15 迁移为 0，避免远超主流窗口导致永不触发——评审 K1） */
  summaryBudgetChars: number
  /** 路由候选上限（默认 50，按 updatedAt 取最近；与 UI 展示上限 10 份独立） */
  routerMaxSessions: number
  /** 用户会话单分片文件大小上限（默认 500000 字节；JSON 序列化后超限切新片） */
  userShardMaxBytes: number
  /** 路由/二次确认前可见的用户界面会话「对话对」数（默认 4）。
   * 语义：一个对话对 = 一条用户输入 + 一条 AI 输出。选取内部会话（routeSession/confirmSessionMatch）
   * 前，AI 可先看到最近 N 对用户界面会话历史，作为判定「续哪个内部会话」的参考上下文；
   * 选取注入后与现状一致（预览不进入主链路注入，也不落盘到会话）。0 = 关闭，退回只看 userInput 的旧行为。 */
  routePreviewTurnPairs: number
}

/** 会话继承预算「配置值 vs 生效值」回显（内部会话视图配置小卡片读显用）。
 * 为什么存在：summaryBudgetChars=0 时语义为「按模型窗口自动推导」，纯配置值对用户
 * 不可理解；主进程经 dmn:sessionSummary:effective 通道统一计算后返回本结构，UI
 * 直接展示生效值，无须前端复算模型窗口（评审 T6）。 */
export interface SessionSummaryEffectiveInfo {
  /** 落盘配置值（0 = 自动推导模式） */
  configured: number
  /** 当前生效值（字符）：configured>0 时 = configured；否则 = max(30000, 模型窗口 × 1/4） */
  effective: number
  /** true = 自动推导模式（configured<=0），UI 据此显示「自动」标识 */
  auto: boolean
  /** 当前模型上下文窗口（token，按 config.llm.model 估算，仅展示用） */
  modelWindow: number
}

/** 内部会话注入上下文：buildInjectedMessages 第三参数，替代旧块树 blockHistory 链） */
export interface SessionContext {
  /** 路由选中的内部会话（锚点与缓存索引的数据源） */
  internal: InternalSession
  /** 内部会话历史段：id/title/createdAt/updatedAt/summary 锚点 + messages 转 ChatMessage
   *  + 缓存索引消息（由 internal.cacheLocations 渲染，无命中时不包含）。
   *  缓存索引作为该内部会话自身历史的一部分伴随注入（随会话走、互不混用），
   *  注入位放在 systemMsgs 之后、suffix 动态段之前 */
  anchorMessages: ChatMessage[]
}