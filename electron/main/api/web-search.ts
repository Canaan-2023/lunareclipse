// ===== web-search 编排入口（域拆分后主文件）=====
// 为什么存在：搜索源多、抓取链路复杂，按「入口/类型/HTTP/工具/providers/深度」拆域，
// 对外只暴露搜索分发与结果格式化两个稳定入口，避免调用方依赖内部细节——
// 职责：搜索源分发（webSearch）+ 结果格式化（formatSearchResults）+ 对外导出面聚合。
// 子模块：types（类型/常量）/ http（抓取原语+SSRF）/ utils（文本处理）/ providers（各搜索源）/ deep（页面抓取+深度搜索）。

import {
  searchBocha,
  searchBaike,
  searchMoegirl,
  searchDuckDuckGo,
  searchBilibili,
  searchTieba,
  searchWeibo,
  searchZhihu,
  searchDouban,
  searchBaidu,
  searchBing,
  searchGushiwen,
  searchCustom,
  searchAuto
} from './web-search-providers'
import type { SearchResult, WebSearchConfig } from './web-search-types'
import { DEFAULT_MAX_RESULTS } from './web-search-types'

export * from './web-search-types'
export { setAllowPrivateUrl, isPrivateUrl } from './web-search-http'
export { extractKeywords, extractMainText } from './web-search-utils'
export { fetchPageContent, deepSearch } from './web-search-deep'

export async function webSearch(query: string, config: WebSearchConfig): Promise<SearchResult[]> {
  const max = config.maxResults > 0 ? config.maxResults : DEFAULT_MAX_RESULTS
  try {
    switch (config.source) {
      case 'bocha':
        return await searchBocha(query, config.bochaApiKey ?? '', max)
      case 'baike':
        return await searchBaike(query, max)
      case 'moegirl':
        return await searchMoegirl(query, max)
      case 'bilibili':
        return await searchBilibili(query, max)
      case 'tieba':
        return await searchTieba(query, max)
      case 'weibo':
        return await searchWeibo(query, max)
      case 'duckduckgo':
        return await searchDuckDuckGo(query, max)
      case 'zhihu':
        return await searchZhihu(query, max)
      case 'douban':
        return await searchDouban(query, max)
      case 'baidu':
        return await searchBaidu(query, max)
      case 'bing':
        return await searchBing(query, max)
      case 'gushiwen':
        return await searchGushiwen(query, max)
      case 'custom':
        if (!config.customEndpoint) throw new Error('自定义搜索端点未配置')
        return await searchCustom(config.customEndpoint, config.customApiKey ?? '', query, max)
      case 'auto':
      default:
        return await searchAuto(query, { ...config, maxResults: max })
    }
  } catch (err) {
    console.error('[web-search] failed:', err)
    return []
  }
}

export function formatSearchResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return ''
  const lines = [`网络搜索结果（关键词：${query}）：`, '']
  for (const r of results) {
    lines.push(`- ${r.title}`)
    if (r.url) lines.push(`  URL: ${r.url}`)
    if (r.snippet) lines.push(`  摘要: ${r.snippet}`)
    if (r.source) lines.push(`  来源: ${r.source}`)
    lines.push('')
  }
  lines.push('在回复中引用上述来源时请标注 URL。')
  return lines.join('\n')
}