/**
 * 全局配置（AppConfig）共享类型。
 * 为什么存在：config.json 由主进程读写、前端设置页编辑，两端必须共享同一配置契约避免字段
 * 漂移，AppConfig 是系统配置的单一 schema。
 * 作用：定义 ThemeName 与 AppConfig 及各子配置块（LLM/评测/生成/工具策略等）接口。
 */
import type { AiAssistConfig } from './ai-assist'
import type { EvalConfig } from './eval'
import type { GenerationConfig, ImageGenConfig } from './generation'
import type { LilithConfig } from './lilith'
import type { LLMConfig, ContextWindowConfig, ToolResultDistillConfig } from './llm'
import type { MessagingConfig } from './messaging'
import type { FrontendToolPolicy } from './tool-policy'
import type { CommandPolicy, ToolPermissionPolicy } from './command-policy'
import type { SecurityGrants } from './permission'
import type { ModelRouterConfig } from './model-router'
import type { CollectorConfig } from './collector'

export type ThemeName = 'frost-glass' | 'parchment' | 'night' | 'violet-night' | 'eclipse' | 'gilded'

export interface AppConfig {
  llm: LLMConfig
  /** 记忆工作流后端 AI 的独立 LLM 配置（文档 15.4：记忆工作流的 LLM 独立配置不跟随前端 AI）。model 为空表示未配置，记忆工作流不运行 LLM 调用。
   *  workflowLlm 是记忆工作流 + 记忆工作流评测的 LLM 配置（设计依据：记忆工作流跑在服务端，需独立于前端会话的 LLM 配置，
   *  避免与前端 AI 模型切换互相影响，也保证记忆归档不受前端模型变更牵连）。不删理由：记忆工作流评测
   *  必须有稳定的后端模型入口，若删除则此类任务会错误复用前端 AI 配置。*/
  workflowLlm: LLMConfig

  /** 前端 AI 接入方式存档：按 provider 名归档的 LLM 配置（UI 切换恢复用）。老配置无此字段时自动从扁平 llm 生成单槽 */
  llmProfiles: Record<string, LLMConfig>
  /** 当前激活的前端 AI 接入方式槽名 */
  llmActiveProfile: string
  /** 记忆工作流后端 AI 接入方式存档 */
  workflowLlmProfiles: Record<string, LLMConfig>
  /** 当前激活的记忆工作流后端 AI 接入方式槽名 */
  workflowLlmActiveProfile: string
  theme: ThemeName
  webSearchEnabled: boolean
  /** RAW 记忆字符上限（用户设计：按字符上限 + 会话实时追加，超限开新文件）。默认 20000，可在 config.json 配置调小（实测/调参用） */
  rawMaxChars?: number
  /** 博查 Search API Key（bochaai.com，国内 AI 友好搜索引擎，有免费额度）。空表示未配置，auto 模式下走百度百科+萌娘百科+DuckDuckGo 兜底 */
  bochaApiKey: string
  tokenBudget: number | null
  dataDir: string
  availableModels: string[]
  /** 记忆工作流后端 AI 的可用模型清单，与前端 AI 的 availableModels 分离，避免污染。*/
  workflowAvailableModels: string[]
  /** 前端 AI 角色的显示名，默认 '月蚀'。用户可在设置中自定义，也可由 AI 通过 update_ai_name 工具修改。*/
  aiName: string
  /** 角色设定（persona）：仅作为 AI.md 空态时的初始迁移内容，不再注入提示词。*/
  persona: string
  /** AI 输出模式：coding=编程模式（现状，完整工具/长回复/markdown）；chat=会话模式（硬约束：像人一样说话，强制语言/篇幅/格式净化）；task=任务模式（Team Lead 拆任务建团队，成员并行协作）。缺省为 coding（旧配置兼容）。*/
  aiMode: 'coding' | 'chat' | 'task'
  /** aiName 用户手动编辑标记：true 时 AI 调 update_ai_name 会被拒绝。*/
  aiNameManualEdited: boolean
  /** 用户档案用户手动编辑标记：true 时 AI 调 update_user_profile 会被拒绝。*/
  userProfileManualEdited?: boolean
  /** 轻量记忆用户手动编辑标记：true 时 AI 调 update_lite_memory 会被拒绝。*/
  liteMemoryManualEdited?: boolean
  /** context.md 用户手动编辑标记：true 时 AI 调 update_context_md 会被拒绝，需用户在设置页点"允许 AI 修改"重置。*/
  contextMdManualEdited: boolean
  /** 上下文窗口管理：发送请求时按配置截断历史消息，超出部分自动忘记 */
  contextWindow: ContextWindowConfig
  /** 工具结果 LLM 蒸馏：大体积工具结果提炼有用信息后进上下文，蒸馏失败保留原文 */
  toolResultDistill?: ToolResultDistillConfig
  /** 会话正文宽度：narrow/medium/wide 三档，控制 ChatArea 消息列最大宽度 */
  messageWidth: 'narrow' | 'medium' | 'wide'
  /** 前端 AI 工具策略：全局按需加载开关 + per-tool 启用配置 */
  frontendToolPolicy: FrontendToolPolicy
  /** 评测配置（judge 模型 + 成本阈值 + CI 门禁） */
  eval?: EvalConfig
  /**
   * 权限绿通模式：开启后 AI 执行灰名单命令/系统设置等不再弹权限框，直接放行。
   * 黑名单命令（rm -rf/format/diskpart 等）永远拦截，不受绿通影响。
   * 保底机制：用户完全关闭应用（非 AI 自我重启）后，下次启动自动重置为 false。
   */
  permissionGreenlight?: boolean
  /**
   * 命令安全策略（可配置规则层）。
   * 为什么存在：run_command 的黑白灰名单此前是模块内硬编码数组，用户无法按环境收紧/放宽；
   * 升级为配置后，主进程规则层与前端设置页/配置面板共享同一 schema。
   * 设计约束（详见 ./command-policy.ts）：黑名单只增不减（默认高危黑名单与 security-engine
   * 硬防线不可被配置移除）、白名单可增可减、只读自动放行默认关闭、危险检测永远优先。
   * undefined = 全默认（与改造前行为逐字节等价）。
   */
  commandPolicy?: CommandPolicy
  /**
   * 工具级权限覆写策略（key=工具名，如 'run_command'）。
   * default=走工具自身默认审批；require-approval=每次调用都要求用户授权（比默认更严，
   * 绿通开启时被全局授权覆盖）；deny=直接拒绝调用。只能收紧不能放宽——不存在 allow 档。
   * undefined = 全默认（不改动任何工具审批行为）。
   */
  toolPermissionOverrides?: Record<string, ToolPermissionPolicy>
  /**
   * 三层权限层的用户授予表（T1 逐项授权）。
   * 为什么存在：交接单 §0 要求 T1「默认关、显式授予、逐项、可撤回、全量审计」；授予必须持久化、
   * 用户可见可改，且 AI 不可自行改写。存放于此（AppConfig）以便与其它配置一同持久化与推送，
   * 但**刻意不进 `ipc/handlers/config.ts` 的 ALLOWED_CONFIG_KEYS**——通用 `config:set` 不得改写它，
   * 只能经 `security:grant` / `security:revoke` 用户 IPC（见 handlers/security.ts）。
   * 语义：undefined / 空表 = 无任何 T1 授予（安全默认）；T0 永不可授予、T2 默认开，均不出现在此表。
   */
  securityGrants?: SecurityGrants
  /**
   * AUTO 模型热切换（§8）：按复杂度在池内**轮间**切换模型。
   * undefined / enabled=false = 恒用 `llm.model`（老配置兼容，安全默认）。
   * 池内模型须来自提供商 `/v1/models` 且经 `llm:test` 就绪检查；同池默认同回传口径
   * （跨口径切换会 400 或字段污染，见 model-switch.ts）。
   */
  modelRouter?: ModelRouterConfig
  /**
   * 采集器（ROOM 记忆区的输入源）：环境状态 / 桌面。
   * 默认关（undefined 视为 { enabled: false, desktop: false }）——「默认关、范围可配、用户可见」（§7）。
   * AI 侧采集须先过 `t1.collector` 授予裁决（ADR-11）。
   */
  collector?: CollectorConfig
  /** 莉莉丝桌宠接入配置：gamePath=游戏 MOD 目录（companion 所在），autoStart=月蚀启动时是否自动拉起桌宠 */
  lilith?: LilithConfig
  /** 消息接入（外部平台 → 月蚀大脑）：飞书/企业微信等渠道配置 + 联系人映射 + 白名单 */
  messaging?: MessagingConfig
  /** 图像生成配置（OpenAI 兼容端点，如硅基流动/通义/OpenAI）。enabled=false 时 image_gen 工具不暴露 */
  imageGen?: ImageGenConfig
  /** 多模态生成系统配置：video/audio 按模态独立配置 provider；产物落 generated/U{uid}/AI{aiId}/{分类}/{年}/{月}/{日}/ */
  generation?: GenerationConfig
  /** AI 元搜索配置（ask_ai 工具）：多个 AI 平台 OpenAI 兼容端点。有任一 enabled 平台时 ask_ai 才暴露；未配置时回退主 LLM */
  aiAssist?: AiAssistConfig
  /**
   * 代码审查全局开关（从 session 级提升为全局级）。
   * true 时 AI 输出完成后自动触发 code-review agent 审查上一轮回复质量，**切换会话不中断**。
   * 老配置兼容：undefined 视为 false，首次开启后持久化到 config.json。
   * 0.53 前旧字段名 continuousActivation 由 config-store 读取时映射为 codeReview。
   */
  codeReview?: boolean
  /** 白煌桌宠窗口开关（持久化，重启自动恢复桌宠）。undefined 视为 false */
  /** 治理机制开关（LXK governance）：undefined=全部开启。可经配置覆盖层关闭单个机制 */
  governance?: {
    /** 空转抑制：连续空转 ≥2 轮强制收束 TASK_COMPLETE（默认开） */
    idleSuppression?: boolean
    /** 查证提醒：疑问句先查证再答（默认开） */
    factCheckReminder?: boolean
    /** 收尾反思：输出 TASK_COMPLETE 前复盘 + 自主改进（默认开） */
    closingReflection?: boolean
    /** 失败循环止损：连续工具全失败 ≥3 轮强制止损报告（默认开） */
    failureCircuitBreaker?: boolean
  }
  /**
   * 中继异步传输配置（L1.5 大云盘）：发送端上传到主系统中继暂存，接收方确认后下载到自定义位置。
   * 为什么需要配置：下载位置与保留策略是关键行为（文件落到哪、无人确认留多久），
   *   必须可由用户经设置页/config.json 调整，并随 AI 提示词让 AI 感知文件去向。
   * 空值语义：downloadDir 留空 = 主系统默认 {root}/relay/downloads（独立目录，不与其他系统数据混放）；
   *   retentionDays 缺省 = 7（与 relay-service 的 RELAY_DEFAULT_RETENTION_DAYS 语义一致）。
   */
  relay?: {
    /** 接收端取件下载位置（普通文件夹绝对路径；留空 = 默认 {root}/relay/downloads） */
    downloadDir?: string
    /** 无人确认保留天数：超过且未下载 → 主系统过期清理；发送方可随时撤回 */
    retentionDays?: number
  }
  /**
   * 局域网协作（L0 直连底座）配置。
   * 为什么默认关闭：分发版曾出现「用户不用社交功能也常驻监听 0.0.0.0:62003 且无握手鉴权」的
   *   分发阻断项（可被局域网内恶意客户端冒充 uid 收发信封）。默认关闭 + 显式开启，
   *   把"是否暴露监听面"交回用户；默认 bindHost=127.0.0.1 进一步收敛为仅本机。
   * enabled 语义：undefined/false = 完全不启动 LAN（好友/聊天室/发布板/技能市场同步不可用）；
   *   true = 按 bindHost 绑定监听。老配置无此字段一律视为 false（安全默认）。
   * bindHost 语义：缺省 '127.0.0.1'（仅本机回环，跨机协作不可用）；'0.0.0.0' 才对外开放，
   *   供局域网跨机协作——在握手鉴权（hello_auth 挑战）落地前，0.0.0.0 仅限可信局域网使用。
   */
  lan?: {
    /** 是否启用局域网协作（默认 false） */
    enabled?: boolean
    /** 监听绑定地址（默认 '127.0.0.1'；跨机协作需显式设为 '0.0.0.0'） */
    bindHost?: string
  }
  /**
   * ROOM 自主模式（ADR-29：承载面 = **会话页原位视图**，不再是独立窗口）。
   * - `enabled`：用户**意图**（undefined 视为 false，安全默认关）。**运行真值以运行时为准**，
   *   启动期对账（B-D1）——不要把它当「房间正在跑」来读。
   * - `viewMode`：承载面。`'inline'`（默认）= 会话页原位房间；`'window'` = 旧的独立窗口分支，
   *   **仅作一个发布周期的灰度回滚目标**（ADR-29 裁决①），默认路径不达，灰度稳定后物理删除。
   */
  room?: {
    /** 是否开启自主模式房间（用户意图；运行真值见运行时状态） */
    enabled?: boolean
    /** 承载面：inline（默认，会话页原位）| window（旧独立窗口，仅供回滚） */
    viewMode?: 'inline' | 'window'
  }
  /**
   * 浏览器面板配置：useSystemBrowser=true 时弃内置面板，导航/外链转系统默认浏览器。
   * geolocationPolicy：内置浏览器面板对外部网页的系统定位策略（隐私红线整改新增）。
   * 'deny'（默认 / undefined）：外部网页一律拒绝 navigator.geolocation，
   *   不触碰本机定位，也不向任何第三方透传；
   * 'allow'：由用户显式开启后，外部网页可请求系统定位（仍需网站自己的用户授权流程），
   *   精确位置仍不写入日志/记忆/缓存。受信本地窗口不受此策略影响，始终按其自身逻辑判定。
   */
  browser?: {
    useSystemBrowser: boolean
    geolocationPolicy?: 'deny' | 'allow'
  }
  /** UI 缩放：null/undefined=自动（跟随屏幕分辨率人眼最佳），number=手动覆盖值（范围 0.7~2.0） */
  uiZoom?: number | null
  /** 浏览器网页缩放：null/undefined=自动（与 uiZoom 同公式，作用于内置浏览器 webContents），number=手动覆盖值（范围 0.7~2.0） */
  browserZoom?: number | null
  /**
   * 地理位置隐私配置（隐私红线整改新增）。
   * preciseLocationEnabled=false（默认）：无任何定位来源——不请求 navigator.geolocation，
   *   不发生 IP 定位请求，不调用 photon 逆地理 / open-meteo 天气，
   *   AI 上下文仅注入时区（不再注入任何 IP 推导地区，已移除公共 IP 兜底链路）；
   * true：允许系统精确坐标链路（photon/open-meteo），仍只用于本机 AI 环境感知，
   *   精确坐标不写入日志、记忆与持久化缓存。
   * undefined 视为 false（老配置兼容，行为 = 最隐私默认）。
   */
  geo?: {
    /** 是否启用系统精确坐标链路（photon 逆地理 / open-meteo 天气）。默认 false */
    preciseLocationEnabled?: boolean
  }
}