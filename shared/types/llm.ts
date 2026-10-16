/**
 * LLM 配置与模型相关类型（shared）。
 * 为什么存在：LLM 配置在设置页编辑、由主进程 API 客户端消费，token 用量统计与上下文窗口
 * 控制前后端都要使用，必须共享同一类型与预设。
 * 作用：导出 provider/思考强度/token 用量/LLMConfig/上下文窗口等类型及 PROVIDER_PRESETS、inferProvider。
 */
export type LLMProvider = 'openai' | 'ollama' | 'local' | 'custom' | 'opencode-go'

/**
 * 思考强度（产品级 7 档；wire 层按各 provider 契约归一，见 shared/reasoning-profiles.ts
 * 能力表——DeepSeek 认 低/高/最大 + thinking 开关、OpenAI 枚举到 high、Gemini 3.7 起
 * 无 minimal、千问仅 enable_thinking 布尔开关、Claude/未知网关走 OpenAI 兼容兜底）
 * - off      关闭思考（deepseek/gemini 显式 thinking disabled、千问 enable_thinking:false；
 *            其余不传参，依赖模型自身默认）
 * - minimal  最低思考（映射 API 的 minimal/low 档）
 * - low      低
 * - medium   中（默认）
 * - high     高
 * - very_high 极高（多数 API 归一到 high/max 上限档）
 * - max      最大（同 very_high；对不限制 effort 的 API 不设上限）
 */
export type ReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'very_high' | 'max'

/**
 * LLM 调用 token 用量（DISJOINT 计数：各通道独立记账）。
 * - inputTokens 不含 cacheReadTokens（DeepSeek 的 prompt_tokens 含缓存命中，需拆出）
 * - cacheReadTokens 存在时才出现（provider 报告了缓存命中）
 * - reasoningTokens 存在时才出现（深度思考模型）
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  reasoningTokens?: number
}

export interface LLMConfig {
  baseURL: string
  apiKey: string
  model: string
  /** 采样温度。未设置时由 AI 模式决定默认值（coding=0.3, chat/task=0.7）。用户显式配置后始终优先。 */
  temperature?: number
  maxTokens: number | null
  streamingSpeed: number
  /** 服务商类型，影响是否需要 apiKey、模型列表获取方式 */
  provider: LLMProvider
  /** 思考强度（可选字段，旧配置缺省时按 medium 处理） */
  reasoningEffort?: ReasoningEffort
  /** DMN LLM 跟随前端 AI 配置（dmnLlm 专用）：true 时回退为 config.llm */
  followMain?: boolean
  /** 频率惩罚覆盖值（默认 0.6），抑制重复 token 生成 */
  frequencyPenalty?: number
}

/** 根据 baseURL 推断 provider */
export function inferProvider(baseURL: string): LLMProvider {
  const url = baseURL.toLowerCase()
  if (url.includes('ollama') || url.includes(':11434')) return 'ollama'
  if (url.includes('localhost') || url.includes('127.0.0.1') || url.includes('0.0.0.0')) return 'local'
  if (url.includes('api.openai.com')) return 'openai'
  return 'custom'
}

/** 不同 provider 的默认 baseURL 和是否需要 apiKey */
export const PROVIDER_PRESETS: Record<LLMProvider, { label: string; baseURL: string; needsKey: boolean; hint: string }> = {
  openai: { label: 'OpenAI 官方', baseURL: 'https://api.openai.com/v1', needsKey: true, hint: '需要 API Key' },
  ollama: { label: 'Ollama 本地', baseURL: 'http://localhost:11434/v1', needsKey: false, hint: '无需 Key，需先启动 ollama serve' },
  local: { label: '本地服务', baseURL: 'http://localhost:8080/v1', needsKey: false, hint: '自定义本地推理服务' },
  custom: { label: '自定义', baseURL: '', needsKey: true, hint: '第三方 OpenAI 兼容接口' },
  'opencode-go': { label: 'OpenCode Go', baseURL: '', needsKey: true, hint: 'OpenCode Go 兼容接口' }
}

/** 上下文窗口截断模式 */
export type ContextWindowMode = 'off' | 'pairs' | 'chars'

export interface ContextWindowConfig {
  /** 截断模式：
   *  - off: 不截断，发送全部历史
   *  - pairs: 按对话对数截断，保留最近 N 对（user+assistant 算一对）
   *  - chars: 按字符数截断，保留最近 N 字符的上下文
   */
  mode: ContextWindowMode
  /** pairs 模式下保留的对话对数量（默认 10） */
  pairs: number
  /** chars 模式下保留的字符数（默认 8000）
   * chars 字段含义从"字符数"变为"token 数"。
   * tokensMode=true 表示已迁移到 token 模式，false/undefined 表示旧字符模式（需迁移）。
   */
  chars: number
  /** chars 模式是否已迁移到 token 估算。true=已迁移（chars 单位为 token），false/undefined=旧字符模式（需迁移） */
  tokensMode?: boolean
}

/**
 * 工具结果 LLM 蒸馏：工具返回大体积结果时，用 LLM 提炼有用信息、其余逻辑丢弃。
 * 蒸馏成功 → 摘要（重包消息来源护栏）直接替换 conversation 中 tool 消息原文；失败重试一次，仍失败保留原文。
 */
export interface ToolResultDistillConfig {
  /** 总开关；关闭时保留原文进上下文 */
  enabled: boolean
  /** 体积阈值（字符）：低于此值不蒸馏；0 = 全量过滤（0.17 起默认） */
  minChars: number
  /** 单次蒸馏输入上限（字符），超出按头 80% + 尾 20% 截断 */
  maxInputChars: number
  /** 单位时间（60s 滚动窗口）内最多蒸馏次数 */
  maxPerTurn: number
  /**
   * 并发上限：显式数字 = 固定上限（兼容旧配置）；'auto' = 运行时按当前设备参数
   * （逻辑核/内存/当前 CPU 负载）+ 场景策略动态推导（T2 动态性能优化），
   * 空闲放开、负载高自动收拢，不再写死固定值。
   */
  maxConcurrent: number | 'auto'
  /** 单次蒸馏超时（毫秒） */
  timeoutMs: number
  /** 蒸馏所用模型；空串 = 跟随主 LLM */
  model: string
  /** true = 仅白名单（搜索/列表/读文件/局域网三工具）蒸馏；false = 所有达阈值工具都蒸馏 */
  onlyListSearchTools: boolean
  /** 自定义蒸馏白名单工具名列表（onlyListSearchTools=true 时生效）；缺省 = 内置白名单（V1 参数化） */
  whitelist?: string[]
  /**
   * 永不蒸馏的工具名列表：这些工具的结果是指令/契约型内容——返回给主 AI 的是行为规范
   * 正文（如 use_skill 的技能 SKILL.md：清单/红线/输出格式逐字即约束），压缩成摘要即丢失
   * 语义，AI 后续轮次将按残缺指令执行。无论蒸馏总开关、白名单还是体积阈值如何，这些
   * 工具的结果一律逐字保留原文。信息检索型结果（搜索/读文件/列表）才适合走蒸馏提炼。
   * 缺省 = 内置指令型工具名单（见 DEFAULT_TOOL_RESULT_DISTILL.skipTools），可在此覆盖。
   */
  skipTools?: string[]
  /**
   * 蒸馏意图上下文宽：传给蒸馏 LLM 的对话「回溯窗口」宽度（按 user 消息计数，
   * 一对 = 一个 user 消息 + 其后的 assistant 轮）。
   * 为什么按对话对而非字数：工具结果一律蒸馏，触发面不设体积阈值；而「为什么
   * 要调这个工具」的上下文长度只取决于该工具调用前发生在多少个对话轮内——按
   * 字数截断会切碎语义（详情见 tool-result-distiller.ts）。
   * 窗口内消息以完整形态呈现（含调用者 AI 的思考 reasoning、工具调用声明与
   * 此前工具消息链），与调取工具的那个 AI 同视角；本配置只限制窗口宽。
   * 0 = 不携带历史上下文（蒸馏器仅凭工具名 + 原文判断相关性）；数值越大蒸馏越
   * 准确、token 成本越高。
   */
  intentTurnPairs: number
}

/**
 * 模型能力信息（listModels 扩展返回 / 前端展示用）。
 * contextWindow / maxOutputTokens 由主进程 model-capability 解析，
 * 未知时省略字段或为 0 表示不可用；前端按缺失做保守处理。
 */
export interface ModelInfo {
  /** 模型 id（/v1/models 返回的原始 id） */
  id: string
  /** 上下文窗口上限（token）。未解析到时省略 */
  contextWindow?: number
  /** 最大输出 token 上限（官方规格存在时才有）。未解析到时省略 */
  maxOutputTokens?: number
  /** 能力来源：registry=内置精确表 / infer=家族推断 / fallback=兜底 */
  source?: 'registry' | 'infer' | 'fallback'
}