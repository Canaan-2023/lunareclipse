/**
 * 文生音频/音乐工具：为什么存在——AI 创作口播、音乐、音效时需要生成能力并落地为本地资产。
 * 作用：audio_gen 调用 OpenAI 兼容生成端点，把生成音频保存到 generated 资产目录。
 */
import type { Tool, ToolResult, ToolContext } from './base-tool'
import type { GenMediaProviderConfig } from '@shared/types'
import { openAIMediaGeneration } from '../api/gen/providers'
import { saveGeneratedAsset } from '../api/gen/store'

/**
 * audio_gen 工具：文生音频/音乐。

 * 调用 OpenAI 兼容 /audio/generations 端点，把生成的音频保存到
 * generated/U{uid}/AI{aiId}/audio/{年}/{月}/{日}/，返回本地路径与 file:// URL。

 * 配置（config.json → generation.audio）：
 * { "enabled": true, "baseURL": "https://.../v1", "apiKey": "...", "model": "...", "endpointPath": "audio" }
 * enabled=false 时工具不暴露（TOOL_REGISTRY visible 条件）。
 */
export interface AudioGenToolParams {
  /** 音频/音乐描述（prompt，曲风/情绪/时长等描述） */
  prompt: string
  /** 时长（秒，可选） */
  duration?: number
}

export class AudioGenTool implements Tool<AudioGenToolParams> {
  name = 'audio_gen'
  description =
    '文生音频/音乐：调用 OpenAI 兼容音频生成端点生成音频，按分类+日期保存到 generated/.../audio/{年}/{月}/{日}/ 返回本地路径。需要用户在设置中配置 generation.audio（baseURL/apiKey/model/endpointPath=audio）并启用。'

  parameters = [
    { name: 'prompt', type: 'string' as const, description: '音频/音乐描述（曲风/情绪/乐器等），越具体越好', required: true },
    { name: 'duration', type: 'number' as const, description: '时长（秒），可选', required: false }
  ]

  async execute(params: AudioGenToolParams, ctx?: ToolContext): Promise<ToolResult> {
    const prompt = String(params.prompt ?? '').trim()
    if (!prompt) {
      return { ok: false, error: 'prompt 不能为空' }
    }

    const cfg = ((ctx?.config as Record<string, unknown> | undefined)?.generation as GenerationLike | undefined)?.audio
    if (!cfg || !cfg.enabled) {
      return {
        ok: false,
        error: '音频生成未启用：请在 config.json 配置 generation.audio（enabled/baseURL/apiKey/model/endpointPath=audio）后重启'
      }
    }
    if (!cfg.baseURL || !cfg.apiKey || !cfg.model) {
      return { ok: false, error: 'generation.audio 配置不完整：需要 baseURL / apiKey / model' }
    }

    try {
      const result = await openAIMediaGeneration({
        baseURL: cfg.baseURL,
        apiKey: cfg.apiKey,
        model: cfg.model,
        endpointPath: cfg.endpointPath ?? 'audio',
        prompt,
        params: {
          ...(params.duration ? { duration: params.duration, length: params.duration, seconds: params.duration } : {})
        },
        timeoutMs: 300000
      })
      const asset = saveGeneratedAsset(ctx, 'audio', result.buf, {
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
          category: 'audio',
          model: cfg.model,
          previewHint: `音频已保存，前端可直接播放：${asset.mediaUrl}（本地路径 ${asset.path}）`
        }
      }
    } catch (err) {
      return { ok: false, error: `音频生成失败: ${(err as Error).message}` }
    }
  }
}

// 局部结构化类型：只读 generation.audio
interface GenerationLike {
  audio?: GenMediaProviderConfig
}