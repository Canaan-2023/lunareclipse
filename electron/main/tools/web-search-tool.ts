/**
 * 联网搜索工具：为什么存在——AI 回答实时信息（新闻/最新数据）需要联网搜索，搜索能力
 * 与端点由配置控制，不能硬编码。
 * 作用：web_search 封装 webSearch / deepSearch / fetchPageContent，支持 query / url / read 模式。
 */
import type { Tool, ToolResult, ToolContext } from './base-tool'
import { webSearch, formatSearchResults, deepSearch, fetchPageContent } from '../api/web-search'
import type { SearchSource } from '../api/web-search'

export interface WebSearchToolParams {
  /** 搜索关键词（url/read 模式可不传） */
  query?: string
  maxResults?: number
  /**
   * 搜索源（可选，默认 auto）：
   * - auto：自动选择（有博查 key 用博查，否则并行 11 源兜底）
   * - bocha：博查 Search API（需在设置中配置 API Key，国内 AI 友好首选）
   * - baike：百度百科（公开 API，适合精确词条查询）
   * - moegirl：萌娘百科（MediaWiki API，适合 ACG/二次元内容）
   * - bilibili：B站（公开 API，视频/UP主/ACG 内容）
   * - tieba：百度贴吧（HTML 抓取，民间讨论/小众话题）
   * - weibo：微博（移动端公开 API，实时热点/名人动态/舆论风向）
   * - zhihu：知乎（HTML 抓取，专业问答/深度讨论）
   * - douban：豆瓣（HTML 抓取，图书/电影/小组评论）
   * - baidu：百度综合搜索（HTML 抓取，通用搜索最广覆盖）
   * - bing：Bing 中文版（HTML 抓取，国内可访问）
   * - duckduckgo：DuckDuckGo（HTML 抓取，国内可能不稳定）
   * - gushiwen：古诗文网（HTML 抓取，古诗词/文言文/古典名著）
   * - custom：自定义端点（需在设置中配置）
   */
  source?: SearchSource
  /**
   * 搜索模式：
   * - search（默认）：普通搜索，多源摘要列表
   * - deep：深度搜索，用真实浏览器（Playwright headless）搜索，能拿到普通搜索拿不到的
   * 站内内容（B站/知乎/微博）、JS 渲染页面、强反爬站点
   * - read：读取指定 url 的网页正文（等价于直接传 url 参数）
   */
  mode?: 'search' | 'deep' | 'read'
  /** 要读取正文的网页 URL（mode=read 或直接传 url 都行），HTTP 失败自动降级浏览器渲染 */
  url?: string
  /**
   * 限定搜索站点域名，逗号分隔（如 bilibili.com,zhihu.com），配合 mode=deep 使用。
   * 已知站点走站内搜索（B站/知乎/微博/豆瓣/贴吧/掘金/CSDN/StackOverflow/npm），
   * 未知站点走 Bing 搜索 + site: 限定。
   */
  sites?: string
}

export class WebSearchTool implements Tool<WebSearchToolParams> {
  name = 'web_search'
  description =
    '网络搜索工具，三种模式：\n' +
    '1. 普通搜索（默认）：query + source（可选源），快速返回摘要列表。\n' +
    '2. 深度搜索：mode="deep" + query + sites（可选，逗号分隔域名限定站点），用真实浏览器搜索，' +
    '能拿到普通搜索拿不到的站内内容（B站/知乎/微博等）、JS 渲染页面、强反爬站点。\n' +
    '3. 读网页：url（直接读取指定网页正文，HTTP 失败自动降级浏览器渲染）。\n' +
    '使用建议：站内内容或普通搜索无结果时用深度搜索；已有具体 URL 想读内容时用 url。' +
    '普通搜索可选源：auto（默认，多源并行）/ baidu / bing / bocha（需 key）/ baike / zhihu / douban / bilibili / weibo / tieba / moegirl / gushiwen / duckduckgo。' +
    '返回结果列表（标题/URL/摘要/来源），回复时需标注 URL。'
  parameters = [
    { name: 'query', type: 'string' as const, description: '搜索关键词（url/read 模式可不传）', required: false },
    {
      name: 'source',
      type: 'string' as const,
      description: '搜索源（仅普通搜索用，可选，默认 auto）。不确定就用 auto 或 bing。可选值：auto/baidu/bing/bocha/baike/zhihu/douban/bilibili/weibo/tieba/moegirl/gushiwen/duckduckgo',
      required: false
    },
    {
      name: 'mode',
      type: 'string' as const,
      description: '搜索模式（可选，默认 search）：search 普通搜索 / deep 浏览器深度搜索 / read 读 url 正文',
      required: false
    },
    {
      name: 'url',
      type: 'string' as const,
      description: '要读取正文的网页 URL（mode=read 或直接传 url），HTTP 失败自动降级浏览器',
      required: false
    },
    {
      name: 'sites',
      type: 'string' as const,
      description: '限定搜索站点域名，逗号分隔（如 bilibili.com,zhihu.com），配合 mode=deep；已知站点走站内搜索，未知站点走 Bing site:',
      required: false
    },
    { name: 'maxResults', type: 'number' as const, description: '最大结果数（默认 5，深度搜索默认 8，可选）', required: false }
  ]

  execute(params: WebSearchToolParams, ctx?: ToolContext): Promise<ToolResult> {
    // 联网开关关闭时拒绝调用
    const cfg = ctx?.config as {
      webSearchEnabled?: boolean
      webSearchProvider?: string
      webSearchEndpoint?: string
      webSearchApiKey?: string
      bochaApiKey?: string
    } | undefined
    if (cfg?.webSearchEnabled === false) {
      return Promise.resolve({ ok: false, error: '联网开关已关闭，用户未授权网络搜索' })
    }

    // 模式 3：读网页正文（url 或 mode=read）
    const wantRead = !!params.url || params.mode === 'read'
    if (wantRead) {
      if (!params.url || params.url.trim().length === 0) {
        return Promise.resolve({ ok: false, error: 'read 模式需要传 url' })
      }
      return fetchPageContent(params.url).then((content) => ({
        ok: true,
        data: {
          query: params.query ?? '',
          url: content.url,
          title: content.title,
          method: content.method,
          text: content.text,
          formatted: `网页正文（${content.method === 'browser' ? '浏览器渲染' : 'HTTP 抓取'}）：\n标题: ${content.title}\nURL: ${content.url}\n\n${content.text}`
        }
      })).catch((err) => ({ ok: false, error: (err as Error).message }))
    }

    if (!params.query || params.query.trim().length === 0) {
      return Promise.resolve({ ok: false, error: 'query 不能为空' })
    }
    const query = params.query.trim()

    // 模式 2：深度搜索（mode=deep 或传了 sites）
    if (params.mode === 'deep' || params.sites) {
      const maxResults = params.maxResults && params.maxResults > 0 ? params.maxResults : 8
      return deepSearch(query, { sites: params.sites, maxResults }).then((results) => {
        if (results.length === 0) {
          return { ok: true, data: { query, results: [], message: '深度搜索无结果' } }
        }
        return { ok: true, data: { query, results, formatted: formatSearchResults(query, results) } }
      }).catch((err) => ({ ok: false, error: (err as Error).message }))
    }

    // 模式 1：普通搜索（原有逻辑）
    const maxResults = params.maxResults && params.maxResults > 0 ? params.maxResults : 5
    const useCustom = cfg?.webSearchProvider === 'custom' && !!cfg?.webSearchEndpoint
    const source: SearchSource = params.source ?? 'auto'

    return webSearch(query, {
      enabled: true,
      maxResults,
      source,
      bochaApiKey: cfg?.bochaApiKey,
      provider: useCustom ? 'custom' : 'duckduckgo',
      customEndpoint: cfg?.webSearchEndpoint,
      customApiKey: cfg?.webSearchApiKey
    }).then((results) => {
      if (results.length === 0) {
        return { ok: true, data: { query, results: [], message: '无搜索结果' } }
      }
      const formatted = formatSearchResults(query, results)
      return { ok: true, data: { query, results, formatted } }
    }).catch((err) => {
      return { ok: false, error: (err as Error).message }
    })
  }
}
