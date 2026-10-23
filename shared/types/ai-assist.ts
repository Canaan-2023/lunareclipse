/**
 * AI 元搜索配置（ask_ai 工具，shared）。
 * 为什么存在：元搜索依赖各 AI 平台（OpenAI 兼容端点）的凭据与模型配置，主进程执行、设置页
 * 编辑，需要共享 schema。
 * 作用：导出 AiAssistConfig、AiAssistPlatform。
 */
/** AI 元搜索配置（ask_ai 工具） */
export interface AiAssistConfig {
  platforms: AiAssistPlatform[]
}

/** 单个 AI 平台（OpenAI 兼容 chat completions 端点） */
export interface AiAssistPlatform {
  /** 平台 id（deepseek/qwen/glm 等，唯一） */
  id: string
  /** 展示名 */
  name?: string
  /** OpenAI 兼容 baseURL（如 https://api.dashscope.com/v1 / https://open.bigmodel.cn/api/paas/v4） */
  baseURL: string
  apiKey: string
  /** 模型名 */
  model: string
  enabled: boolean
}