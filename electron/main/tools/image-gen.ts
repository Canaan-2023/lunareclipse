/**
 * 文生图工具：为什么存在——AI 为对话/文档/封面生成配图需要可调用、可落盘的图像生成能力。
 * 作用：image_gen 调用 OpenAI 兼容 /v1/images/generations 端点，将图片保存到 generated 资产目录。
 */
import type { Tool, ToolResult, ToolContext } from './base-tool'
import type { ImageGenConfig } from '@shared/types'
import { saveGeneratedAsset } from '../api/gen/store'

/**
 * image_gen 工具：文生图。

 * 调用 OpenAI 兼容 /v1/images/generations 端点，把生成的图片保存到
 * abyssac_data/outputs/images/，返回本地路径（AI 可用浏览器面板预览/展示）。

 * 配置（config.json → imageGen）：
 * { "enabled": true, "baseURL": "https://api.siliconflow.cn/v1", "apiKey": "...", "model": "black-forest-labs/FLUX.1-schnell" }
 * enabled=false 时工具不暴露（TOOL_REGISTRY visible 条件）。

 * 支持任意 OpenAI 兼容文生图端点（硅基流动/通义万相/OpenAI 等）。
 */

export interface ImageGenToolParams {
  /** 图像描述（prompt，中英文均可） */
  prompt: string
  /** 输出尺寸（可选，默认 1024x1024；部分端点只支持特定尺寸） */
  size?: string
}

export class ImageGenTool implements Tool<ImageGenToolParams> {
  name = 'image_gen'
  description =
    '文生图：调用 OpenAI 兼容图像生成端点生成图片，保存到本地 outputs/images/ 返回路径。需要用户在设置中配置 imageGen（baseURL/apiKey/model）并启用。'

  parameters = [
    { name: 'prompt', type: 'string' as const, description: '图像描述（prompt），越具体越好', required: true },
    { name: 'size', type: 'string' as const, description: '输出尺寸（如 1024x1024 / 512x512），默认 1024x1024', required: false }
  ]

  async execute(params: ImageGenToolParams, ctx?: ToolContext): Promise<ToolResult> {
    const prompt = String(params.prompt ?? '').trim()
    if (!prompt) {
      return { ok: false, error: 'prompt 不能为空' }
    }

    // 读取配置（ctx.config 是完整 AppConfig 的 getter，取 imageGen 段）
    const cfg = ((ctx?.config as Record<string, unknown> | undefined)?.imageGen as ImageGenConfig | undefined) ?? null
    if (!cfg || !cfg.enabled) {
      return {
        ok: false,
        error: '图像生成未启用：请在 config.json 配置 imageGen（enabled/baseURL/apiKey/model）后重启'
      }
    }
    if (!cfg.baseURL || !cfg.apiKey || !cfg.model) {
      return { ok: false, error: 'imageGen 配置不完整：需要 baseURL / apiKey / model' }
    }

    const size = String(params.size ?? '1024x1024')
    const baseURL = cfg.baseURL.replace(/\/+$/, '')

    try {
      const resp = await fetch(`${baseURL}/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify({
          model: cfg.model,
          prompt,
          size,
          n: 1
        })
      })

      if (!resp.ok) {
        const errText = await resp.text()
        return { ok: false, error: `图像生成 API 错误 ${resp.status}: ${errText.slice(0, 300)}` }
      }

      const data = (await resp.json()) as {
        data?: Array<{ url?: string; b64_json?: string }>
      }
      const item = data.data?.[0]
      if (!item) {
        return { ok: false, error: '图像生成 API 返回空结果' }
      }

      let buf: Buffer
      if (item.b64_json) {
        buf = Buffer.from(item.b64_json, 'base64')
      } else if (item.url) {
        const imgResp = await fetch(item.url)
        if (!imgResp.ok) {
          return { ok: false, error: `下载图片失败: ${imgResp.status}` }
        }
        buf = Buffer.from(await imgResp.arrayBuffer())
      } else {
        return { ok: false, error: 'API 返回既无 url 也无 b64_json' }
      }

      // 按分类 + 日期落盘：generated/U{uid}/AI{aiId}/image/{年}/{月}/{日}/
      const asset = saveGeneratedAsset(ctx, 'image', buf, { slug: prompt, ext: 'png' })

      return {
        ok: true,
        data: {
          path: asset.path,
          url: asset.url,
          mediaUrl: asset.mediaUrl,
          relativePath: asset.relativePath,
          category: 'image',
          prompt,
          size,
          model: cfg.model,
          // AI 可用浏览器面板打开预览
          previewHint: `图片已保存：${asset.path}；前端可直接显示 ${asset.mediaUrl}，或用 browser_navigate 打开 ${asset.url}`
        }
      }
    } catch (err) {
      return { ok: false, error: `图像生成失败: ${(err as Error).message}` }
    }
  }
}
