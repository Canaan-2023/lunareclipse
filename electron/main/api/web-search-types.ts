// ===== web-search 类型与常量（域拆分自 web-search.ts）=====
// 为什么存在：搜索源枚举、结果结构与配置被多个子模块共享，
// 独立成类型文件避免模块间循环依赖——

export interface SearchResult {
  title: string
  url: string
  snippet: string
  /** 搜索源标记（bocha/baike/moegirl/duckduckgo/custom），便于 AI 区分来源 */
  source?: string
}

export type SearchSource =
  | 'auto'
  | 'bocha'
  | 'baike'
  | 'moegirl'
  | 'bilibili'
  | 'tieba'
  | 'weibo'
  | 'duckduckgo'
  | 'zhihu'
  | 'douban'
  | 'baidu'
  | 'bing'
  | 'gushiwen'
  | 'custom'

export interface WebSearchConfig {
  enabled: boolean
  maxResults: number
  /** 主搜索源：
   * - auto 自动选择（多源并行兜底，推荐）
   * - bocha 博查（正式 API，需 key，国内首选）
   * - baike 百度百科 / moegirl 萌娘百科（词条查询）
   * - bilibili B站 / tieba 百度贴吧 / weibo 微博（社区平台）
   * - zhihu 知乎（深度问答） / douban 豆瓣（图书电影）
   * - baidu 百度综合 / bing Bing中文（通用搜索） / duckduckgo（国外）
   * - gushiwen 古诗文网（古诗词/古典名著）
   * - custom 自定义端点 */
  source: SearchSource
  /** 博查 API Key（bochaai.com，空表示未配置） */
  bochaApiKey?: string
  /** 自定义端点配置（保留兼容） */
  provider?: 'duckduckgo' | 'custom'
  customEndpoint?: string
  customApiKey?: string
}

export const DEFAULT_MAX_RESULTS = 5

export interface PageContent {
  title: string
  url: string
  text: string
  /** 提取方式：http（直抓）/ browser（Playwright 渲染） */
  method: 'http' | 'browser'
}

export interface DeepSearchOptions {
  /** 限定站点域名，逗号分隔（如 bilibili.com,zhihu.com）。空则通用 Bing 搜索 */
  sites?: string
  maxResults?: number
  timeoutMs?: number
}