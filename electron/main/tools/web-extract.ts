/**
 * 网页正文提取工具：为什么存在——web_search 只给摘要与链接，AI 需要打开网页读全文，
 * 但又不能放行任意 URL（SSRF 防护）。
 * 作用：web_extract 先经 isPrivateUrl 校验，再抓取 URL 正文并截断为可读文本（默认 8000 字符）。
 */
import type { ToolContext, ToolResult } from './base-tool'
import { fetchPageContent, isPrivateUrl } from '../api/web-search'

/**
 * web_extract 工具：URL 正文提取（轻量网页阅读）
 *
 * 对比：
 * - web_search：给摘要与链接（找不到全文）
 * - 浏览器工具：重（导航→快照→读正文三步，且是用户可见的真实浏览器）
 * - web_extract：给 URL 直接吐正文（HTTP 直抓 + 启发式提取；JS 渲染页自动降级无头浏览器）
 *
 * 安全：复用 web-search 的 SSRF 防护（拦截内网/回环地址）。
 */
const DEFAULT_MAX_CHARS = 8000
const MAX_ALLOWED_CHARS = 30000
const MIN_ALLOWED_CHARS = 200
const FETCH_TIMEOUT_MS = 15000

export class WebExtractTool {
  name = 'web_extract'
  description = `提取网页正文（给 URL 直接返回标题+正文纯文本）。用于阅读文章/文档/页面全文——比 web_search 的摘要完整，比浏览器工具轻。
参数：url（必填，http/https）/ max_chars（可选，返回正文上限字符，默认 8000，最大 30000）。
JS 渲染的页面会自动用无头浏览器渲染后再提取。内网地址会被拦截，无法读取。`
  parameters = [
    {
      name: 'url',
      type: 'string' as const,
      description: 'http/https URL',
      required: true
    },
    {
      name: 'max_chars',
      type: 'number' as const,
      description: '正文上限字符（默认 8000，最大 30000）',
      required: false
    }
  ]

  async execute(params: Record<string, unknown>, _ctx?: ToolContext): Promise<ToolResult> {
    const url = String(params.url ?? '').trim()
    if (!url) return { ok: false, error: 'url 必填' }
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'url 必须是 http/https 链接' }
    // 显式 SSRF 检查（fetchPageContent 内部也有，这里给友好错误）
    if (isPrivateUrl(url)) {
      return { ok: false, error: 'SSRF 拦截：内网/回环地址不可读取' }
    }
    const maxChars = Math.min(Math.max(Number(params.max_chars) || DEFAULT_MAX_CHARS, MIN_ALLOWED_CHARS), MAX_ALLOWED_CHARS)

    try {
      const page = await fetchPageContent(url, { timeoutMs: FETCH_TIMEOUT_MS })
      const text = page.text.length > maxChars ? page.text.slice(0, maxChars) + `\n…（截断，全文 ${page.text.length} 字符）` : page.text
      return {
        ok: true,
        data: { title: page.title, url: page.url, method: page.method, text, charCount: text.length }
      }
    } catch (err) {
      return { ok: false, error: `抓取失败: ${(err as Error).message}` }
    }
  }
}
