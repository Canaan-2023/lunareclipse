// ===== web-search 文本处理工具（域拆分自 web-search.ts）=====
// 为什么存在：抓到的 HTML/正文含标签、乱码与噪声，AI 直接消费会浪费上下文并误解内容——
// HTML 剥标签、乱码过滤、正文容器提取、关键词提取。

import type { SearchResult } from './web-search-types'

export function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

// ============================================================
// 乱码过滤：清除抓取过程中产生的乱码字符，保证返回给 AI 的文本干净
// ============================================================
// 处理三类问题：
// 1. Unicode 替换字符 U+FFFD（解码失败的标志）
// 2. 控制字符（除 \t \n \r 外的 C0/C1 控制符）
// 3. BOM / 零宽字符 / 私有区字符
// 4. 连续的乱码占位符（如多个 ? 或 � 堆叠）
export function sanitizeText(s: string): string {
  if (!s) return ''
  return s
    // 去 BOM
    .replace(/\uFEFF/g, '')
    // 去零宽字符（零宽空格/连字/不连字）
    .replace(/[\u200B-\u200D\u2060]/g, '')
    // 去 Unicode 替换字符 U+FFFD
    .replace(/\uFFFD/g, '')
    // 去私有区字符（私用区 Plane 0/1/15/16）
    .replace(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu, '')
    // 去控制字符，保留 \t \n \r
    // eslint-disable-next-line no-control-regex -- 刻意清除控制字符（网页原文常见脏字节）
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
    // 连续 3+ 个 ? 或 � 压成 1 个（常见乱码特征）
    .replace(/[?？]{3,}/g, '?')
    .replace(/[*·•]{3,}/g, '…')
    // 多余空白归一
    .replace(/\s+/g, ' ')
    .trim()
}

/** 对 SearchResult[] 批量做乱码过滤（每个字段都过滤） */
export function sanitizeResults(results: SearchResult[]): SearchResult[] {
  return results.map((r) => ({
    title: sanitizeText(r.title),
    url: r.url, // URL 不过滤，避免破坏编码
    snippet: sanitizeText(r.snippet),
    source: r.source ? sanitizeText(r.source) : undefined
  })).filter((r) => r.title || r.snippet) // 过滤后空了的丢弃
}

/** HTTP 正文启发式提取：优先正文容器（article/main/常见 class/id），fallback body */
export function extractMainText(html: string): { title: string; text: string } {
  // 先剔除脚本/样式/模板/注释块：JS 渲染页（B站空间等）的脚本源码不该当正文，
  // 剔除后正文过短 → 触发降级 Playwright（而非把 script 代码当正文返回）
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/gi, ' ')
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? sanitizeText(titleMatch[1]) : ''

  // 常见正文容器（按优先级），class 覆盖主流博客/专栏/文档站
  const containerPatterns: RegExp[] = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<div[^>]*class="[^"]*(?:article-content|post-content|rich_media_content|article_content|md-content|blog-content|content-body|entry-content|article-detail)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*id="[^"]*(?:content|article|main|detail)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<body[^>]*>([\s\S]*?)<\/body>/i
  ]
  for (const re of containerPatterns) {
    const m = html.match(re)
    if (m) {
      const text = sanitizeText(stripHtml(m[1]))
      if (text.length >= 200) {
        return { title, text: text.slice(0, 30000) }
      }
    }
  }
  // fallback：全页文本
  const body = sanitizeText(stripHtml(html))
  return { title, text: body.slice(0, 30000) }
}

export function extractKeywords(text: string, maxKeywords = 6): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''
  const stopWords = new Set([
    '的', '了', '是', '在', '我', '你', '他', '她', '它', '我们', '你们', '他们',
    '和', '与', '或', '但', '因为', '所以', '如果', '虽然', '可以', '应该',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'and', 'or', 'but',
    'if', 'then', 'because', 'so', 'can', 'should', 'to', 'of', 'in', 'on', 'for'
  ])
  const words = cleaned
    .split(/[\s,，。.!！?？;；:：""''"'`'()[\]{}]+/)
    .filter((w) => w.length > 1 && !stopWords.has(w.toLowerCase()))
  const unique = Array.from(new Set(words))
  const picked = unique.slice(0, maxKeywords)
  return picked.join(' ') || cleaned
}