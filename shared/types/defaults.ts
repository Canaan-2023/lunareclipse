/**
 * 默认配置常量（shared）。
 * 为什么存在：主进程缺省回退与前端首次初始化都需要同一份默认配置，避免两端默认值各自书写
 * 导致行为不一致。
 * 作用：导出 DEFAULT_LLM_CONFIG、DEFAULT_CONFIG 等默认配置对象。
 */
import type { AppConfig } from './app-config'
import type { LLMConfig, ToolResultDistillConfig } from './llm'

/**
 * 工具结果蒸馏「单源默认配置」。
 * 为什么存在：此前 DEFAULT_DISTILL_CONFIG（electron/services/tool-result-distiller.ts）与
 * DEFAULT_CONFIG.toolResultDistill（本文件）是两份值完全相同的默认配置，改一处忘另一处即
 * 两端行为漂移（评审：矛盾/重复实现）。抽为独立常量后，distiller 侧直接引用本常量，
 * 全工程蒸馏默认值只此一份。
 * 作用：提供蒸馏默认值（当前代码默认：minChars=0 无体积门槛 / onlyListSearchTools=false
 *      不限制工具白名单 / maxPerTurn=60 每分钟上限较宽；具体运行值以用户配置为准）。
 */
export const DEFAULT_TOOL_RESULT_DISTILL: ToolResultDistillConfig = {
  enabled: true,
  minChars: 0,
  maxInputChars: 24000,
  maxPerTurn: 60,
  // 'auto'：并发上限由运行时设备参数（CPU 核数/内存/负载）动态推导（T2 动态性能优化），
  // 低配机自动收敛、高配机自动放开；用户显式配置数字时仍以数字为准。
  maxConcurrent: 'auto',
  timeoutMs: 20000,
  model: '',
  onlyListSearchTools: false,
  // 指令型工具结果默认豁免蒸馏（2026-10-08）：use_skill 返回的 SKILL.md 正文是给主 AI
  // 的行为契约，蒸馏会把检查清单/红线/输出纪律压缩成要点——code-review 的审查维度、
  // ai-perspective-prompting 的四步方法论正是这类会被蒸馏破坏的指令；技能正文必须在
  // 后续每一轮完整可见，故默认逐字保留。后续新增指令型工具在此追加，设置页可覆盖。
  skipTools: ['use_skill'],
  intentTurnPairs: 4
}

/**
 * 默认 AI（月蚀）aiId。会话/AI 身份缺省、路径作用域回退、前端初始 state 一律引用此常量，
 * 禁止在业务代码中重复书写裸数字 1（曾因 index.ts 硬编码 ()=>1 导致技能装错作用域）。
 */
export const DEFAULT_AI_ID = 1

/**
 * 系统内置莉莉丝 aiId（ai-registry 默认注册表二号位）。
 * 为什么存在——内置 AI 的 id 是系统语义：月蚀=1、莉莉丝=2；头像兜底与注册表初始化
 * 都需要按 id 判别「是不是莉莉丝」。与 DEFAULT_AI_ID 同理，禁止散写裸数字 2——
 * 自定义 AI 顺延分配（maxId+1），引用命名常量才能保证注册表/前端判别方向一致。
 */
export const LILITH_AI_ID = 2

export const DEFAULT_LLM_CONFIG: LLMConfig = {
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  // 默认模型留空 = 未配置状态。OpenAI 模型迭代极快（如 GPT-5.5 发布不到半年即下线），
  // 写死任何具体模型名都会快速过时；空值配合设置页 placeholder 提示 + 下拉空显示，
  // 由用户在设置中按当前可用模型填写/选择（与 dmnLlm 的 model: '' 语义一致）。
  model: '',
  // 不设默认 temperature：由 AI 模式决定（coding=0.3, chat/task=0.7），用户显式配置后优先
  maxTokens: null,
  streamingSpeed: 1,
  provider: 'openai',
  reasoningEffort: 'medium'
}

export const DEFAULT_CONFIG: AppConfig = {
  llm: DEFAULT_LLM_CONFIG,
  // DMN 独立 LLM 配置：默认空 model，表示未配置，DMN 不执行 LLM 调用
  // 用户可在设置中为 DMN 配置轻量模型（如 qwen2.5:3b），与前端 AI 分离
  dmnLlm: { ...DEFAULT_LLM_CONFIG, model: '' },
  llmProfiles: {},
  llmActiveProfile: '',
  dmnLlmProfiles: {},
  dmnLlmActiveProfile: '',
  theme: 'parchment',
  webSearchEnabled: true,
  rawMaxChars: 10000,
  bochaApiKey: '',
  tokenBudget: 96000,
  dataDir: './data',
  availableModels: [],
  dmnAvailableModels: [],
  aiName: '月蚀',
  // 自我认知初始内容：仅当 AI.md 为空时一次性迁移，之后由 AI 通过 update_abyss_md 维护 AI.md。
  persona: '# 性格\n清冷、沉静、话少而准。不卖萌、不谄媚，有判断有立场。像月光一样安静地存在，但该说的话一句不少。\n\n# 说话风格\n优先做事，做完了再说。不报工具名、不播报过程、不写 AI 腔、不抢答、不表格汇报。长篇用自然段落，短回复直接说。\n\n# 行为规则\n- 先做事，做完才说话；拿工具结果说话，不空谈结论\n- 分清轻重缓急：记忆/上下文预算出事，第一优先级保它，禁止先汇报\n- 思考在后台，过程不外播\n- 诚实：不知道就说不知道，不编造\n- 查完即答，不反复折腾',
  // AI 输出模式：默认编程模式（现状）。会话模式 = 硬约束（中文优先/简短/无代码块/输出后强制规范）
  aiMode: 'coding',
  aiNameManualEdited: false,
  // context.md 手动编辑标记，默认 false（允许 AI 修改）
  contextMdManualEdited: false,
  // 权限绿通模式：默认关闭。开启后 AI 执行命令不再弹权限框（黑名单仍拦截），
  // 用户完全关闭应用后自动重置为 false（保底防 AI 无限重启死循环）。
  permissionGreenlight: false,
  // 持续激活全局开关：默认关闭（AI 输出完成后不自动续接）
  continuousActivation: false,
  // 上下文窗口：默认按对话对截断，保留最近 40 对（80 条消息）。设计依据：
  // 控制上下文规模，超出部分由 DMN 记忆系统承接（设计哲学保留）；从 24 对
  // 提到 40 对——工具密集任务一轮消耗 4-6 条消息，24 对很快看不到开头需求。
  // 用户可在设置中切换为字符模式或关闭。
  contextWindow: {
    mode: 'pairs',
    pairs: 40,
    chars: 8000,
    // 默认已迁移到 token 模式（新配置）
    tokensMode: true
  },
  // 工具结果 LLM 蒸馏：默认开启（工具输出体积远大于其有效信息，蒸馏可显著降低上下文占用）。
  // 默认值（仅当前代码默认）：minChars=0 无体积门槛 / onlyListSearchTools=false
  // 不限制工具白名单 / maxPerTurn=60 每分钟上限较宽；实际运行值以用户配置为准，用户可在设置页
  // 调低过滤强度（如只蒸馏大结果/只蒸馏白名单工具）。值定义单源在 DEFAULT_TOOL_RESULT_DISTILL，
  // 此处直接引用不再另写一份，避免与 distiller 侧默认值漂移。蒸馏失败保留原文进上下文，
  // 不落盘、不截断，因此风险可控。
  toolResultDistill: DEFAULT_TOOL_RESULT_DISTILL,
  // 会话正文宽度：三档标准尺寸（设计依据：对齐主流阅读线宽）——窄 768（主流对话产品标准
  // max-w-3xl）/ 中 896（max-w-4xl 中文阅读舒适线宽）/ 宽 1100（大屏舒适）
  messageWidth: 'medium',
  // 前端 AI 工具策略：默认直接注入所有启用工具（onDemandEnabled=false）。
  // 设计变更原因：onDemand 模式下小模型反复出现 call_tool 参数错误（把 tool_info 当工具名、
  // 注释：onDemand 两步机制已退役，统一直接注入。
  // tools 空对象表示所有工具按 registry 的 defaultEnabled
  frontendToolPolicy: {
    tools: {}
  },
  // 后端 DMN 配置：旧 DMN 已迁移到记忆处理工作流
  dmn: {},
  // 评测配置默认值
  // judge.model 默认 'claude-sonnet-4-5'（建议与 generator 不同家族防 SPB）
  // costThresholds 默认 50K tokens / 60s / $0.5（超出任一阈值 cost_latency 轴失败）
  eval: {
    judge: {
      model: 'claude-sonnet-4-5'
    },
    costThresholds: {
      maxTokens: 50000,
      maxMs: 60000,
      maxCost: 0.5
    },
    ciEnabled: false,
    regressionGate: 0.95
  },
  // 消息接入：默认关闭（设置页配置凭证并开启后才启动飞书适配器）
  // 白名单默认空 = 开放全部；联系人映射默认空 = 外部消息统一走月蚀（能干活）
  messaging: {
    enabled: false,
    feishu: { appId: '', appSecret: '' },
    allowFrom: [],
    contacts: []
  },
  // 莉莉丝桌宠模块：分发初始默认关闭（开源分发不捆绑莉莉丝）。
  // enabled:false 时主进程 lilithEnabled() 停用、前端不显示莉莉丝入口——
  // 与 lilith-session.ts 的 lilithEnabled() 语义对齐（enabled !== false 才算启用）。
  lilith: {
    enabled: false,
    gamePath: '',
    autoStart: false
  },
  // 中继异步传输（L1.5 大云盘）：下载位置默认留空 = 运行时解析到 {root}/relay/downloads（root
  // 因主分系统而异无法在此写死绝对路径）；无人确认保留 7 天，超期由主系统清理（发送方可撤回）。
  relay: {
    downloadDir: '',
    retentionDays: 7
  },
  // 地理位置隐私配置：默认关闭系统精确坐标链路（隐私红线整改）。
  // 关闭时无任何定位来源——不请求 navigator.geolocation、不发生 IP 定位请求，
  // AI 环境注入仅用时区（公共 IP 兜底链路已移除，不触碰 GPS/photon/open-meteo）；
  // 用户显式开启 preciseLocationEnabled 后才发起系统坐标链路（仍不写入日志/记忆/缓存）。
  geo: {
    preciseLocationEnabled: false
  }
}