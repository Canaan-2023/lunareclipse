// ===== web-search 搜索源 providers（域拆分自 web-search.ts）=====
// 为什么存在：检索需要多个后端源互为补充（博查 API / 百度百科 / MediaWiki 等），
// 每个源独立成 provider、auto 多源聚合，单一来源可独立替换而不牵动调用方。
// 每个搜索源一个独立 provider + auto 多源聚合。全部为纯函数（入参 query/config，出参结果数组）。

import { fetchText, postJson, respectRateLimit, humanJitter } from './web-search-http'
import { stripHtml, sanitizeResults } from './web-search-utils'
import type { SearchResult, WebSearchConfig } from './web-search-types'
import { DEFAULT_MAX_RESULTS } from './web-search-types'

// ============================================================
// 搜索源 1：博查 Search API（bochaai.com，国内 AI 友好，首选）
// ============================================================
// 端点：POST https://api.bochaai.com/v1/web-search
// Header: Authorization: Bearer {apiKey}
// Body: { query, count, freshness, summary, image_count }
// 响应：{ code, msg, data: { webPages: { value: [{ name, url, snippet, siteName }] } } }
export async function searchBocha(query: string, apiKey: string, maxResults: number): Promise<SearchResult[]> {
  if (!apiKey) throw new Error('博查 API Key 未配置')
  await respectRateLimit('bocha')
  const text = await postJson(
    'https://api.bochaai.com/v1/web-search',
    {
      query,
      count: maxResults,
      freshness: 'noLimit',
      summary: true,
      image_count: 0
    },
    { Authorization: `Bearer ${apiKey}` }
  )
  try {
    const data = JSON.parse(text)
    if (data.code !== 200) {
      throw new Error(`博查 API 错误: ${data.msg ?? data.code}`)
    }
    const arr = data?.data?.webPages?.value ?? []
    return arr.slice(0, maxResults).map((r: { name?: string; title?: string; url?: string; link?: string; snippet?: string; summary?: string; siteName?: string }) => ({
      title: r.name ?? r.title ?? '',
      url: r.url ?? r.link ?? '',
      snippet: r.snippet ?? r.summary ?? '',
      source: `博查${r.siteName ? `/${r.siteName}` : ''}`
    }))
  } catch (err) {
    throw new Error(`博查 API 响应解析失败: ${(err as Error).message}`, { cause: err })
  }
}

// ============================================================
// 搜索源 2：百度百科（公开 API，无需 key）
// ============================================================
// 接口：https://baike.baidu.com/api/openapi/BaikeLemmaCardApi
// 参数：scope=103&format=json&appid=379020&bk_key={关键词}&bk_length=600
// 响应：{ key, card: { abstract, title, url, ... } }
// 注：这个接口返回单条最相关词条，不是搜索列表。适合精确查询。
export async function searchBaike(query: string, maxResults: number): Promise<SearchResult[]> {
  await respectRateLimit('baike')
  await humanJitter()
  const url = `https://baike.baidu.com/api/openapi/BaikeLemmaCardApi?scope=103&format=json&appid=379020&bk_key=${encodeURIComponent(query)}&bk_length=600`
  const text = await fetchText(url, 8000, undefined, 'baike')
  try {
    const data = JSON.parse(text)
    if (!data?.card) return []
    const card = data.card
    const title = card.title ?? data.key ?? query
    const abstract = card.abstract ?? ''
    const pageUrl = card.url ?? `https://baike.baidu.com/item/${encodeURIComponent(title)}`
    const results: SearchResult[] = [{
      title: `【百度百科】${title}`,
      url: pageUrl,
      snippet: abstract.slice(0, 500),
      source: '百度百科'
    }]
    // 如果有相关词条，补充到结果里
    const related = card.relation ?? []
    for (let i = 0; i < Math.min(related.length, maxResults - 1); i++) {
      const r = related[i]
      if (r?.title && r?.abstract) {
        results.push({
          title: `【百度百科】${r.title}`,
          url: `https://baike.baidu.com/item/${encodeURIComponent(r.title)}`,
          snippet: String(r.abstract).slice(0, 300),
          source: '百度百科/相关词条'
        })
      }
    }
    return results.slice(0, maxResults)
  } catch {
    return []
  }
}

// ============================================================
// 搜索源 3：萌娘百科（MediaWiki API，无需 key）
// ============================================================
// 端点：https://zh.moegirl.org.cn/w/api.php
// 参数：action=query&list=search&srsearch={关键词}&format=json&srlimit={n}
// 响应：{ query: { search: [{ title, snippet }] } }
export async function searchMoegirl(query: string, maxResults: number): Promise<SearchResult[]> {
  await respectRateLimit('moegirl')
  await humanJitter()
  const url = `https://zh.moegirl.org.cn/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${maxResults}&utf8=1`
  const text = await fetchText(url, 8000, {
    'Accept': 'application/json'
  }, 'moegirl')
  try {
    const data = JSON.parse(text)
    const arr = data?.query?.search ?? []
    return arr.slice(0, maxResults).map((r: { title?: string; snippet?: string }) => ({
      title: `【萌娘百科】${r.title ?? ''}`,
      url: `https://zh.moegirl.org.cn/${encodeURIComponent(String(r.title ?? '').replace(/ /g, '_'))}`,
      snippet: stripHtml(r.snippet ?? ''),
      source: '萌娘百科'
    }))
  } catch {
    return []
  }
}

// ============================================================
// 搜索源 4：DuckDuckGo（HTML 抓取，国外可用，国内不稳定）
// ============================================================
export function parseDuckDuckGo(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g
  const links: { url: string; title: string }[] = []
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(html)) !== null) {
    let url = m[1]
    const uddgMatch = url.match(/uddg=([^&]+)/)
    if (uddgMatch) {
      try {
        url = decodeURIComponent(uddgMatch[1])
      } catch {
        // 解码失败用原始 URL
      }
    }
    const title = stripHtml(m[2])
    if (url && title) links.push({ url, title })
  }
  const snippets: string[] = []
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(stripHtml(m[1]))
  }
  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      snippet: snippets[i] ?? '',
      source: 'DuckDuckGo'
    })
  }
  return results
}

export async function searchDuckDuckGo(query: string, maxResults: number): Promise<SearchResult[]> {
  await respectRateLimit('duckduckgo')
  await humanJitter()
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const html = await fetchText(url, 8000, undefined, 'duckduckgo')
  return parseDuckDuckGo(html, maxResults)
}

// ============================================================
// 搜索源 6：B站（哔哩哔哩，公开 API，无需登录）
// ============================================================
// 端点：https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=xxx
// 参数：search_type=video|media|bili_user，page，page_size
// 响应：{ code, data: { result: [{ title, bvid, description, author, play, ... }] } }
// 注：title 含 <em class="keyword"> 高亮标签，需 stripHtml
export async function searchBilibili(query: string, maxResults: number): Promise<SearchResult[]> {
  await respectRateLimit('bilibili')
  await humanJitter()
  const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(query)}&page_size=${maxResults}&page=1`
  const text = await fetchText(url, 8000, {
    'Accept': 'application/json',
    'Referer': 'https://www.bilibili.com/'
  }, 'bilibili')
  try {
    const data = JSON.parse(text)
    if (data.code !== 0) {
      throw new Error(`B站 API 错误: ${data.message ?? data.code}`)
    }
    const arr = data?.data?.result ?? []
    return arr.slice(0, maxResults).map((r: { title?: string; bvid?: string; description?: string; author?: string; play?: number; pubdate?: number }) => {
      const bvid = r.bvid ?? ''
      return {
        title: `【B站】${stripHtml(r.title ?? '')}`,
        url: bvid ? `https://www.bilibili.com/video/${bvid}` : '',
        snippet: [
          r.description ? stripHtml(r.description) : '',
          r.author ? `UP主: ${r.author}` : '',
          typeof r.play === 'number' ? `播放: ${r.play}` : ''
        ].filter(Boolean).join(' | '),
        source: 'B站'
      }
    })
  } catch {
    return []
  }
}

// ============================================================
// 搜索源 7：百度贴吧（HTML 抓取，公开，无需登录）
// ============================================================
// 端点：https://tieba.baidu.com/f/search/res?ie=utf-8&qw=xxx
// 解析：HTML 列表页，每个帖子条目含标题/链接/摘要/吧名
export async function searchTieba(query: string, maxResults: number): Promise<SearchResult[]> {
  await respectRateLimit('tieba')
  await humanJitter()
  const url = `https://tieba.baidu.com/f/search/res?ie=utf-8&qw=${encodeURIComponent(query)}`
  const html = await fetchText(url, 8000, undefined, 'tieba')
  const results: SearchResult[] = []

  // 帖子条目：<div class="s_post"> ... <a href="..." class="...">标题</a> ... <div class="p_content">摘要</div> ... <a class="...">吧名</a>
  const postRe = /<div\s+class="s_post">([\s\S]*?)<\/div>\s*(?=<div\s+class="s_post">|$)/g
  let m: RegExpExecArray | null
  while ((m = postRe.exec(html)) !== null) {
    const block = m[1]
    // 标题 + 链接：<a href="/p/1234567890" ...>标题</a>
    const titleMatch = block.match(/<a[^>]*href="(\/p\/\d+)"[^>]*>([\s\S]*?)<\/a>/)
    // 摘要：<div class="p_content">...</div>
    const snippetMatch = block.match(/<div\s+class="p_content">([\s\S]*?)<\/div>/)
    // 吧名：<a class="...">吧名</a> 或 <span class="...">吧名</span>
    const forumMatch = block.match(/<a[^>]*class="[^"]*p_forum[^"]*"[^>]*>([\s\S]*?)<\/a>/)
      ?? block.match(/<font\s+color="#e8e8e8">([^<]+)<\/font>/)

    if (titleMatch) {
      const link = titleMatch[1]
      const title = stripHtml(titleMatch[2])
      const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : ''
      const forum = forumMatch ? stripHtml(forumMatch[1]) : ''
      if (title) {
        results.push({
          title: `【百度贴吧】${title}`,
          url: link.startsWith('http') ? link : `https://tieba.baidu.com${link}`,
          snippet: [
            snippet,
            forum ? `吧: ${forum}` : ''
          ].filter(Boolean).join(' | '),
          source: `百度贴吧${forum ? `/${forum}` : ''}`
        })
      }
    }
    if (results.length >= maxResults) break
  }
  return results.slice(0, maxResults)
}

// ============================================================
// 搜索源 8：微博（移动端公开 API，无需登录 cookie）
// ============================================================
// 端点：https://m.weibo.cn/api/container/getIndex
// 参数：containerid=100103type=1&q={keyword}&page_type=searchall&page={n}
// 响应：{ ok, data: { cards: [{ card_type, mblog: { id, text, source, user: {screen_name} } }] } }
// 注：mblog.text 含 HTML 标签，需 stripHtml。card_type=9 为微博正文。
// 移动端 API 比 PC 端 s.weibo.com 反爬更宽松，UA 伪装成手机浏览器即可稳定访问。
export async function searchWeibo(query: string, maxResults: number): Promise<SearchResult[]> {
  await respectRateLimit('weibo')
  await humanJitter()
  // containerid 格式：100103type=1&q=xxx 是搜索综合页
  const containerId = `100103type=1&q=${encodeURIComponent(query)}`
  const url = `https://m.weibo.cn/api/container/getIndex?containerid=${encodeURIComponent(containerId)}&page_type=searchall&page=1`
  // UA 由 fetchText(source='weibo') 自动选移动端，不写死以便轮换
  const text = await fetchText(url, 8000, {
    'Accept': 'application/json',
    'Referer': 'https://m.weibo.cn/'
  }, 'weibo')
  try {
    const data = JSON.parse(text)
    if (data.ok !== 1) {
      throw new Error(`微博 API 错误: ${data.msg ?? '未知'}`)
    }
    const cards = data?.data?.cards ?? []
    const results: SearchResult[] = []
    for (const card of cards) {
      // card_type=9 是微博正文卡，mblog 字段含正文内容
      if (card?.card_type === 9 && card?.mblog) {
        const mb = card.mblog
        const id = mb.id ?? ''
        const text = stripHtml(mb.text ?? '')
        const author = mb.user?.screen_name ?? ''
        const source = mb.source ?? ''
        if (id) {
          results.push({
            title: `【微博】${author}${source ? ` · ${stripHtml(source)}` : ''}`,
            url: `https://m.weibo.cn/detail/${id}`,
            snippet: text,
            source: `微博/${author}`
          })
        }
      }
      if (results.length >= maxResults) break
    }
    return results.slice(0, maxResults)
  } catch {
    return []
  }
}

// ============================================================
// 搜索源 9：知乎（移动端 HTML 抓取，伪装正常用户）
// ============================================================
// 端点：https://www.zhihu.com/search?type=content&q={关键词}
// 反爬：知乎对未登录用户限制较严，可能返回少量结果或重定向到登录页
// 策略：UA 用移动端 + Referer 模拟从知乎首页点进搜索
// 解析：搜索结果 <div class="Card SearchResult-Card"> 内含 <a class="ContentLink-title"> 标题/链接
// 摘要在 <span class="RichText"> 或 <div class="CopyrightRichText-richText">
export async function searchZhihu(query: string, maxResults: number): Promise<SearchResult[]> {
  await respectRateLimit('zhihu')
  await humanJitter()
  const url = `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(query)}`
  const html = await fetchText(url, 10000, {
    'Referer': 'https://www.zhihu.com/',
    'Accept': 'text/html,application/xhtml+xml'
  }, 'zhihu')
  const results: SearchResult[] = []

  // 卡片块：<div class="Card SearchResult-Card">...</div>
  const cardRe = /<div[^>]*class="[^"]*SearchResult-Card[^"]*"[\s\S]*?(?=<div[^>]*class="[^"]*SearchResult-Card|<\/div>\s*<\/div>)/g
  let m: RegExpExecArray | null
  while ((m = cardRe.exec(html)) !== null) {
    const block = m[0]
    // 标题 + 链接：<a class="...ContentLink-title..." href="//..."> 或 href="/question/..."
    const titleMatch = block.match(/<a[^>]*class="[^"]*ContentLink-title[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
      ?? block.match(/<a[^>]*href="(\/question\/\d+[^"]*)"[^>]*>([\s\S]*?)<\/a>/)
      ?? block.match(/<a[^>]*href="(https?:\/\/[^"]*zhihu\.com\/question\/\d+[^"]*)"[^>]*>([\s\S]*?)<\/a>/)
    // 摘要
    const snippetMatch = block.match(/<span[^>]*class="[^"]*RichText[^"]*"[^>]*>([\s\S]*?)<\/span>/)
      ?? block.match(/<div[^>]*class="[^"]*CopyrightRichText-richText[^"]*"[^>]*>([\s\S]*?)<\/div>/)

    if (titleMatch) {
      let link = titleMatch[1]
      if (link.startsWith('//')) link = 'https:' + link
      else if (link.startsWith('/')) link = 'https://www.zhihu.com' + link
      const title = stripHtml(titleMatch[2])
      const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : ''
      if (title) {
        results.push({
          title: `【知乎】${title}`,
          url: link,
          snippet: snippet.slice(0, 500),
          source: '知乎'
        })
      }
    }
    if (results.length >= maxResults) break
  }
  return sanitizeResults(results.slice(0, maxResults))
}

// ============================================================
// 搜索源 10：豆瓣（综合搜索 HTML 抓取，覆盖图书/电影/小组）
// ============================================================
// 端点：https://www.douban.com/search?q={关键词}&cat=1001
// cat: 1001=书 1002=电影 1003=音乐 1005=小组 1006=用户（用综合搜索）
// 解析：<div class="result"> 内 <a class="...title" href="...">标题</a> + <span class="subject-cast">摘要</span>
// 注：豆瓣搜索结果页是服务端渲染，可直接 HTML 抓取
export async function searchDouban(query: string, maxResults: number): Promise<SearchResult[]> {
  await respectRateLimit('douban')
  await humanJitter()
  const url = `https://www.douban.com/search?q=${encodeURIComponent(query)}&cat=1001`
  const html = await fetchText(url, 10000, {
    'Referer': 'https://www.douban.com/',
    'Accept': 'text/html,application/xhtml+xml'
  }, 'douban')
  const results: SearchResult[] = []

  // 结果条目：<div class="result"> ... <div class="title"><a href="...">标题</a></div> ... <span class="subject-cast">摘要</span>
  const itemRe = /<div[^>]*class="[^"]*result[^"]*"[\s\S]*?(?=<div[^>]*class="[^"]*result"|$)/g
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(html)) !== null) {
    const block = m[0]
    const titleMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]*douban\.com\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    const snippetMatch = block.match(/<span[^>]*class="[^"]*subject-cast[^"]*"[^>]*>([\s\S]*?)<\/span>/)
      ?? block.match(/<p[^>]*>([\s\S]*?)<\/p>/)

    if (titleMatch) {
      const link = titleMatch[1]
      const title = stripHtml(titleMatch[2])
      const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : ''
      if (title) {
        results.push({
          title: `【豆瓣】${title}`,
          url: link,
          snippet: snippet.slice(0, 400),
          source: '豆瓣'
        })
      }
    }
    if (results.length >= maxResults) break
  }
  return sanitizeResults(results.slice(0, maxResults))
}

// ============================================================
// 搜索源 11：百度综合搜索（HTML 抓取，覆盖最广）
// ============================================================
// 端点：https://www.baidu.com/s?wd={关键词}
// 反爬：百度最严，需要强 UA + Referer + Cookie（无 Cookie 时仍可拿前 10 条）
// 解析：<div class="result" 或 <div class="c-container"> 内 h3 > a (标题/链接)
// 摘要在 <span class="content-right_8Zs40"> 或 <div class="c-abstract">
export async function searchBaidu(query: string, maxResults: number): Promise<SearchResult[]> {
  await respectRateLimit('baidu')
  await humanJitter()
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&pn=0&rn=${maxResults}`
  const html = await fetchText(url, 10000, {
    'Referer': 'https://www.baidu.com/',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'zh-CN,zh;q=0.9'
  }, 'baidu')
  const results: SearchResult[] = []

  // 百度结果块：<div class="result c-container ..."> 或 <div class="c-container ...">
  const itemRe = /<div[^>]*class="[^"]*(?:result|c-container)[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*(?:result|c-container)"|$)/g
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(html)) !== null) {
    const block = m[1]
    // 标题 + 链接：<h3><a href="..." ...>标题</a></h3>
    const titleMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    // 摘要：<span class="content-right_..."> 或 <div class="c-abstract">
    const snippetMatch = block.match(/<span[^>]*class="[^"]*content-right[^"]*"[^>]*>([\s\S]*?)<\/span>/)
      ?? block.match(/<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/)
      ?? block.match(/<span[^>]*class="[^"]*c-font-normal[^"]*"[^>]*>([\s\S]*?)<\/span>/)

    if (titleMatch) {
      const link = titleMatch[1]
      const title = stripHtml(titleMatch[2])
      const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : ''
      // 过滤百度自身的跳转链接（www.baidu.com/link?url=... 会被自动 follow 到真实地址）
      if (title && !link.includes('baidu.com/link')) {
        results.push({
          title: `【百度】${title}`,
          url: link,
          snippet: snippet.slice(0, 400),
          source: '百度搜索'
        })
      }
    }
    if (results.length >= maxResults) break
  }
  return sanitizeResults(results.slice(0, maxResults))
}

// ============================================================
// 搜索源 12：Bing 中文版（HTML 抓取，国内可访问，替代 DuckDuckGo）
// ============================================================
// 端点：https://cn.bing.com/search?q={关键词}
// 解析：<li class="b_algo"> 内 <h2><a href="...">标题</a></h2> + <p>摘要</p>
// 注：cn.bing.com 国内可访问，反爬较松
export async function searchBing(query: string, maxResults: number): Promise<SearchResult[]> {
  await respectRateLimit('bing')
  await humanJitter()
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}&first=1`
  const html = await fetchText(url, 10000, {
    'Referer': 'https://cn.bing.com/',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  }, 'bing')
  const results: SearchResult[] = []

  // Bing 结果块：<li class="b_algo">...</li>
  const itemRe = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/g
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(html)) !== null) {
    const block = m[1]
    // 标题 + 链接：<h2><a href="..." ...>标题</a></h2>
    const titleMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    // 摘要：<p>...</p> 或 <div class="b_caption"><p>...</p></div>
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/)

    if (titleMatch) {
      const link = titleMatch[1]
      const title = stripHtml(titleMatch[2])
      const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : ''
      if (title && link) {
        results.push({
          title: `【Bing】${title}`,
          url: link,
          snippet: snippet.slice(0, 400),
          source: 'Bing'
        })
      }
    }
    if (results.length >= maxResults) break
  }
  return sanitizeResults(results.slice(0, maxResults))
}

// ============================================================
// 搜索源 13：古诗文网（名著/古诗词/古文专门站，无 API）
// ============================================================
// 端点：https://www.gushiwen.org/search.aspx?value={关键词}&valuej={拼音首字母}
// 解析：<div class="sons"> 内 <b>标题</b> · <a>作者</a> + <div class="contson">内容</div>
// 注：valuej 拼音首字母非必需，留空也能搜到
// 适合查古诗词/文言文/古典名著片段
export async function searchGushiwen(query: string, maxResults: number): Promise<SearchResult[]> {
  await respectRateLimit('gushiwen')
  await humanJitter()
  const url = `https://www.gushiwen.org/search.aspx?value=${encodeURIComponent(query)}&valuej=`
  const html = await fetchText(url, 10000, {
    'Referer': 'https://www.gushiwen.org/',
    'Accept': 'text/html,application/xhtml+xml'
  }, 'gushiwen')
  const results: SearchResult[] = []

  // 诗文块：<div class="sons">...</div>
  const itemRe = /<div[^>]*class="[^"]*sons[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*sons"|$)/g
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(html)) !== null) {
    const block = m[1]
    // 标题：<b>标题</b>
    const titleMatch = block.match(/<b[^>]*>([\s\S]*?)<\/b>/)
    // 作者：<a href="...">作者</a> 或 <p class="source">作者</p>
    const authorMatch = block.match(/<p[^>]*class="[^"]*source[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/)
      ?? block.match(/<a[^>]*href="[^"]*\/authors\/[^"]*"[^>]*>([\s\S]*?)<\/a>/)
    // 内容：<div class="contson">...</div>
    const contentMatch = block.match(/<div[^>]*class="[^"]*contson[^"]*"[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/div>/)
    // 链接：<a href="..."> 标题或诗文链接
    const linkMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]*gushiwen\.cn?\/[^"]+)"[^>]*>/)
      ?? block.match(/<a[^>]*href="(\/shiwenv_[^"]+)"[^>]*>/)

    if (titleMatch) {
      const title = stripHtml(titleMatch[1])
      const author = authorMatch ? stripHtml(authorMatch[1]) : ''
      const content = contentMatch ? stripHtml(contentMatch[2]) : ''
      let link = linkMatch ? linkMatch[1] : ''
      if (link && !link.startsWith('http')) link = 'https://www.gushiwen.org' + link
      if (title) {
        results.push({
          title: `【古诗文网】${title}${author ? ` · ${author}` : ''}`,
          url: link,
          snippet: content,
          source: '古诗文网'
        })
      }
    }
    if (results.length >= maxResults) break
  }
  return sanitizeResults(results.slice(0, maxResults))
}

// ============================================================
// 搜索源 5：自定义端点（兼容旧配置）
// ============================================================
export async function searchCustom(
  endpoint: string,
  apiKey: string,
  query: string,
  maxResults: number
): Promise<SearchResult[]> {
  const url = `${endpoint}?q=${encodeURIComponent(query)}&count=${maxResults}`
  const text = await fetchText(url, 8000, apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined)
  try {
    const data = JSON.parse(text)
    const arr = Array.isArray(data) ? data
      : Array.isArray(data.results) ? data.results
      : Array.isArray(data.web?.results) ? data.web.results
      : Array.isArray(data.organic_results) ? data.organic_results
      : Array.isArray(data.data?.webPages?.value) ? data.data.webPages.value
      : []
    return arr.slice(0, maxResults).map((r: { title?: string; name?: string; url?: string; link?: string; snippet?: string; content?: string; description?: string; summary?: string }) => ({
      title: r.title ?? r.name ?? '',
      url: r.url ?? r.link ?? '',
      snippet: r.snippet ?? r.content ?? r.description ?? r.summary ?? '',
      source: 'custom'
    }))
  } catch {
    return []
  }
}

// ============================================================
// 多源聚合（auto 模式）：博查 → 11 源并行兜底
// ============================================================
/**
 * auto 模式策略：
 * 1. 配置了 bochaApiKey → 用博查（AI 友好、结果干净、内容合规，国内首选，已聚合大平台）
 * 2. 未配置 bochaApiKey → 并行多源兜底（共 11 个源）：
 * - 百度百科 + 萌娘百科：精确词条查询（人物/作品/概念）
 * - B站：视频/UP主/ACG 内容
 * - 百度贴吧：民间讨论/小众话题
 * - 微博：实时热点/名人动态/舆论风向
 * - 知乎：专业问答/深度讨论
 * - 豆瓣：图书/电影/小组评论
 * - 百度综合搜索：通用搜索（最广覆盖）
 * - Bing 中文：通用搜索（国内可访问，替代 DuckDuckGo）
 * - DuckDuckGo：通用搜索（国内可能访问不了）
 * - 古诗文网：古诗词/文言文/古典名著片段
 *
 * 多源并行兜底覆盖尽量广的需求场景，每源取少量结果合并去重。
 */
export async function searchAuto(query: string, config: WebSearchConfig): Promise<SearchResult[]> {
  const max = config.maxResults > 0 ? config.maxResults : DEFAULT_MAX_RESULTS

  // 有博查 key → 优先用博查（已聚合大平台内容），但不阻塞兜底（并行启动）
  // 博查失败或慢时由兜底源接管
  const bochaTask = config.bochaApiKey
    ? searchBocha(query, config.bochaApiKey, max)
    : Promise.resolve([] as SearchResult[])

  // 无博查 key 或博查失败 → 并行多源兜底
  // 每个源取少量结果（避免某源淹没其他源），合并后按 url 去重
  const perSource = Math.max(2, Math.ceil(max / 6))
  const tasks: Array<Promise<SearchResult[]>> = [
    bochaTask,
    searchBaike(query, Math.min(perSource, 3)),
    searchMoegirl(query, Math.min(perSource, 3)),
    searchBilibili(query, perSource),
    searchTieba(query, perSource),
    searchWeibo(query, perSource),
    searchZhihu(query, perSource),
    searchDouban(query, perSource),
    searchBaidu(query, perSource),
    searchBing(query, perSource),
    searchDuckDuckGo(query, max),
    searchGushiwen(query, Math.min(perSource, 3))
  ]

  // 早停竞速：每源完成立即合并，累计达到 max*1.5 条就 resolve，不等其他源
  // 最差情况：3 秒后强制 resolve（用 Promise.race 兜底超时）
  const merged: SearchResult[] = []
  const seen = new Set<string>()
  const targetCount = Math.max(max, Math.ceil(max * 1.5)) // 目标条数（多收一些用于去重后仍够）

  const earlyStop = new Promise<SearchResult[]>((resolve) => {
    let completed = 0
    const total = tasks.length
    for (const task of tasks) {
      task.then((list) => {
        completed++
        for (const r of list) {
          const key = r.url || r.title
          if (key && !seen.has(key)) {
            seen.add(key)
            merged.push(r)
          }
        }
        // 收集到足够结果或所有源都完成 → resolve
        if (merged.length >= targetCount || completed >= total) {
          resolve(merged)
        }
      })
    }
  })

  // 强制 8 秒内必须返回（即使没收集够，也用已有的）
  // 原 3.5 秒太短：每源速率限制 1.2-2s + fetchText 5s 超时，多源并行时慢源还没返回就被强制 resolve
  let forceTimer: ReturnType<typeof setTimeout> | undefined
  const forceTimeout = new Promise<SearchResult[]>((resolve) => {
    forceTimer = setTimeout(() => resolve(merged), 8000)
  })

  // 取早停和强制超时的先到者
  const finalResults = await Promise.race([earlyStop, forceTimeout])
  if (forceTimer) clearTimeout(forceTimer)
  // 再等 500ms 让慢源有机会补结果（如果还没达到目标）
  if (finalResults.length < max) {
    await new Promise((r) => setTimeout(r, 500))
  }
  return sanitizeResults(merged).slice(0, max)
}