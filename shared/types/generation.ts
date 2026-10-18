/**
 * 图像/多模态生成配置（shared）。
 * 为什么存在：图像/视频/音频生成由主进程调用 OpenAI 兼容端点执行，配置在设置页编辑，两端
 * 须共用同一 schema。
 * 作用：导出 ImageGenConfig、GenModality、GenMediaProviderConfig、GenerationConfig。
 */
/** 图像生成配置（OpenAI 兼容 /v1/images/generations） */
export interface ImageGenConfig {
  enabled: boolean
  /** OpenAI 兼容端点 baseURL（如 https://api.siliconflow.cn/v1） */
  baseURL: string
  apiKey: string
  /** 文生图模型名（如 black-forest-labs/FLUX.1-schnell / dall-e-3） */
  model: string
}

/** 生成模态：图片 / 视频 / 音频 / 文稿 */
export type GenModality = 'image' | 'video' | 'audio' | 'document'

/** 单个生成模态的「OpenAI 兼容媒体端点」provider 配置（video/audio 用；image 沿用顶层 imageGen 兼容） */
export interface GenMediaProviderConfig {
  enabled: boolean
  /** OpenAI 兼容端点 baseURL（如 https://api.siliconflow.cn/v1） */
  baseURL: string
  apiKey: string
  /** 模型名 */
  model: string
  /** 端点路径段（默认按模态：video→videos / audio→audio；自定义端点可覆盖） */
  endpointPath?: string
}

/** 多模态生成系统配置：按模态独立配置 provider */
export interface GenerationConfig {
  video?: GenMediaProviderConfig
  audio?: GenMediaProviderConfig
}