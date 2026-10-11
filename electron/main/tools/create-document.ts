/**
 * 文稿归档工具：为什么存在——AI 起草的文稿需要按用户/日期归档到 generated/ 目录，
 * 形成可回溯的产出体系而非散落各处。
 * 作用：create_document 把 md/txt 文稿保存到 generated/U{uid}/AI{aiId}/document/{年}/{月}/{日}/。
 */
import type { Tool, ToolResult, ToolContext } from './base-tool'
import { saveGeneratedAsset } from '../api/gen/store'

/**
 * create_document 工具：文稿归档。

 * 把 AI 起草的文稿（md/txt）保存到
 * generated/U{uid}/AI{aiId}/document/{年}/{月}/{日}/
 * 做按分类 + 时间的归档，返回本地路径与 file:// URL。
 * 文稿正文由 LLM 直接生成，无需外部生成端点 —— 即时可用。
 * 与写作创作类能力互补：本工具专注「已完成的文稿落盘归档」。
 */
export interface CreateDocumentToolParams {
  /** 文稿标题（文件名主体；会被净化，尽量去掉路径分隔符） */
  title: string
  /** 文稿正文（Markdown 或纯文本） */
  content: string
  /** 存档格式：md（默认）/ txt */
  format?: 'md' | 'txt'
}

export class CreateDocumentTool implements Tool<CreateDocumentToolParams> {
  name = 'create_document'
  description =
    '文稿归档：把 AI 起草的文稿按分类+日期保存到 generated/.../document/{年}/{月}/{日}/ 返回本地路径。参数 title/content/format。适合把长文、报告、脚本、方案保存为可引用文件；正文由你直接写，不依赖外部生成端点。'

  parameters = [
    { name: 'title', type: 'string' as const, description: '文稿标题（文件名主体，避免含路径分隔符）', required: true },
    { name: 'content', type: 'string' as const, description: '文稿正文（Markdown 或纯文本）', required: true },
    { name: 'format', type: 'string' as const, description: '存档格式：md（默认）/ txt', required: false }
  ]

  async execute(params: CreateDocumentToolParams, ctx?: ToolContext): Promise<ToolResult> {
    const title = String(params.title ?? '').trim()
    const content = String(params.content ?? '')
    if (!title) {
      return { ok: false, error: 'title 不能为空' }
    }
    if (!content.trim()) {
      return { ok: false, error: 'content 不能为空（文案需有正文）' }
    }
    const fmt = params.format === 'txt' ? 'txt' : 'md'

    try {
      const asset = saveGeneratedAsset(ctx, 'document', content, {
        slug: title,
        ext: fmt
      })
      return {
        ok: true,
        data: {
          path: asset.path,
          url: asset.url,
          mediaUrl: asset.mediaUrl,
          relativePath: asset.relativePath,
          category: 'document',
          format: fmt,
          previewHint: `文稿已归档：${asset.path}`
        }
      }
    } catch (err) {
      return { ok: false, error: `文稿归档失败: ${(err as Error).message}` }
    }
  }
}