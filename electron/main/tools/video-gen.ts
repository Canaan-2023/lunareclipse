/**
 * 文生视频工具：为什么存在——AI 创作短视频内容时需要生成视频素材并落盘为本地资产。
 * 作用：video_gen 调用 OpenAI 兼容生成端点，把视频保存到 generated 资产目录。
 */
import type { Tool, ToolResult, ToolContext } from './base-tool'
import type { GenMediaProviderConfig } from '@shared/types'
import { openAIMediaGeneration } from '../api/gen/providers'
import { saveGeneratedAsset } from '../api/gen/store'

/**
 * video_gen 工具：文生视频。

 * 调用 OpenAI 兼容 /videos/generations 端点，把生成的视频保存到
 * generated/U{uid}/AI{aiId}/video/{年}/{月}/{日}/，返回本地路径与 file:// URL。

 * 配置（config.json → generation.video）：
 * { "enabled": true, "baseURL": "https://.../v1", "apiKey": "...", "model": "...", "endpointPath": "videos" }
 * enabled=false 时工具不暴露（TOOL_REGISTRY visible 条件）。

 * 提示：视频生成通常耗时较长（数十秒~数分钟），端点若支持异步任务请先走可查询的任务接口，
 * 本工具按「同步返回首个体」处理；返回空需检查端点端 video 任务进度。
 */
export interface VideoGenToolParams {
  /** 视频内容描述（prompt，中英文均可） */
  prompt: string
  /** 时长（秒，可选；部分端点仅支持固定档位） */
  duration?: number
  /** 分辨率（可选，如 720p / 1280x720） */
  resolution?: string
}

export class VideoGenTool implements Tool<VideoGenToolParams> {
  name = 'video_gen'
  description =
    '文生视频：调用 OpenAI 兼容视频生成端点生成视频，按分类+日期保存到 generated/.../video/{年}/{月}/{日}/ 返回本地路径。需要用户在设置中配置 generation.video（baseURL/apiKey/model/endpointPath=videos）并启用。'

  parameters = [
    { name: 'prompt', type: 'string' as const, description: '视频内容描述（prompt），越具体越好', required: true },
    { name: 'duration', type: 'number' as const, description: '时长（秒），可选', required: false },
    { name: 'resolution', type: 'string' as const, description: '分辨率（如 720p / 1280x720），可选', required: false }
  ]

  async execute(params: VideoGenToolParams, ctx?: ToolContext): Promise<ToolResult> {
    const prompt = String(params.prompt ?? '').trim()
    if (!prompt) {
      return { ok: false, error: 'prompt 不能为空' }
    }

    const cfg = ((ctx?.config as Record<string, unknown> | undefined)?.generation as GenerationLike | undefined)?.video
    if (!cfg || !cfg.enabled) {
      return {
        ok: false,
        error: '视频生成未启用：请在 config.json 配置 generation.video（enabled/baseURL/apiKey/model/endpointPath=videos）后重启'
      }
    }
    if (!cfg.baseURL || !cfg.apiKey || !cfg.model) {
      return { ok: false, error: 'generation.video 配置不完整：需要 baseURL / apiKey / model' }
    }

    try {
      const result = await openAIMediaGeneration({
        baseURL: cfg.baseURL,
        apiKey: cfg.apiKey,
        model: cfg.model,
        endpointPath: cfg.endpointPath ?? 'videos',
        prompt,
        // 时长/分辨率等作为模态专属参数透传（端点不识别时自然忽略）
        params: {
          ...(params.duration ? { duration: params.duration, length: params.duration, seconds: params.duration } : {}),
          ...(params.resolution ? { resolution: params.resolution, size: params.resolution } : {})
        },
        timeoutMs: 300000
      })
      const asset = saveGeneratedAsset(ctx, 'video', result.buf, {
        slug: prompt,
        ext: result.ext
      })
      return {
        ok: true,
        data: {
          path: asset.path,
          url: asset.url,
          mediaUrl: asset.mediaUrl,
          relativePath: asset.relativePath,
          category: 'video',
          model: cfg.model,
          previewHint: `视频已保存，前端可直接播放：${asset.mediaUrl}（本地路径 ${asset.path}）`
        }
      }
    } catch (err) {
      return { ok: false, error: `视频生成失败: ${(err as Error).message}` }
    }
  }
}

// 局部结构化类型：只读 generation.video，避免全量依赖 AppConfig
interface GenerationLike {
  video?: GenMediaProviderConfig
}