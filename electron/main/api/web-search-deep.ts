// ===== web-search 页面抓取 + 深度搜索（域拆分自 web-search.ts）=====
// 为什么存在：搜索引擎只返回摘要，研究型提问需要拿到网页正文与站内搜索结果，
// 独立成域（HTTP 直抓优先、失败降级真实浏览器渲染）以便复用与维护。
// 网页正文提取（HTTP 优先，失败降级真实浏览器）+ deepSearch 站内搜索。

import { fetchText } from './web-search-http'
import { sanitizeText, sanitizeResults, extractMainText } from './web-search-utils'
import type { PageContent, SearchResult, DeepSearchOptions } from './web-search-types'
// browser-manager 已由主进程入口静态导入（随主 chunk 加载），此处静态导入保持构造警告清零
import { browserManager } from '../tools/browser-manager'
// 为什么存在：fetchPageContent 降级到 Playwright 渲染时，page.goto 可导航任意
// 协议（file://）与任意地址（内网/回环）——HTTP 路径的 fetchText 自带 SSRF 校验，
// 但旧实现把校验只放在 HTTP 层，降级路径成为越权读文件的旁路（评审 CRITICAL 实测
// 成立：web_search url=file:///C:/... 经浏览器渲染读回本地文件内容）。作用：在
// 入口统一做协议白名单 + 内网/元数据拦截，HTTP 与浏览器两条路径共享同一道防线。
import {
  isBlockedIp,
  isSafeUrl,
} from '../tools/security-engine/url-safety'

/** 为什么存在：fetchPageContent 双路径共用的前置 SSRF/协议校验，防降级浏览器旁路。
 * 作用：① 协议白名单 http/https（file:/javascript:/data: 等一律拒绝）；
 * ② 字面 IP/主机名内网检查（127.0.0.0/8、10/8、172.16/12、192.168/16、.local、云元数据
 * 哨兵 169.254.169.254）；③ isSafeUrl 做 DNS 解析复核（域名指向内网也拦截，含
 * metadata.google.internal 等始终拦截的云元数据主机名）。
 * 与 web-search-http.fetchText 内的校验保持同一套语义，入口先拦、传输层再拦（纵深防御）。 */
export async function assertSafeFetchUrl(url: string): Promise<void> {
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    throw new Error(`SSRF 拦截：URL 无法解析（${url}）`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`SSRF 拦截：仅允许 http/https 协议（${url}）`)
  }
  const host = u.hostname.toLowerCase()
  // 字面 IP / localhost / .local 快速拦截（与 fetchText 的 isPrivateUrl 语义一致）
  if (host === 'localhost' || host.endsWith('.local') || host === '0.0.0.0') {
    throw new Error(`SSRF 拦截：目标地址是内网/回环地址（${url}）`)
  }
  if (isBlockedIp(host)) {
    throw new Error(`SSRF 拦截：目标地址是内网/回环地址（${url}）`)
  }
  // DNS 复核：域名指向内网段或命中云元数据哨兵（fail-closed，解析失败也拦截）
  if (!(await isSafeUrl(url))) {
    throw new Error(`SSRF 拦截：目标域名解析到内网/元数据地址（${url}）`)
  }
}

/** 用 Playwright headless 渲染页面并提取正文（静默，不弹浏览器面板） */
async function fetchWithBrowser(url: string, timeoutMs: number): Promise<PageContent> {
  // withPage 互斥锁：与其他浏览器调用（deepSearch/工具操作）串行，避免并发争抢单例页面
  return browserManager.withPage(async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 30000) })
    // 等 SPA/懒加载内容
    await page.waitForTimeout(1500)
    // 字符串形式：页面上下文执行，避免主进程 TS 编译 DOM API
    // 注意：必须用 IIFE（(() => {...})()），Playwright 把字符串 eval 为表达式，
    // 裸箭头函数字符串（() => {...}）会被 eval 成函数对象不执行 → 返回 undefined
    const result = await page.evaluate(`(() => {
      const pick = (sels) => {
        for (const s of sels) {
          const el = document.querySelector(s)
          if (el) {
            const t = el.innerText
            if (t && t.trim().length >= 100) return t
          }
        }
        return ''
      }
      const text = pick(['article', 'main', '.article-content', '.post-content', '.rich_media_content', '.article_content', '#content', '.content'])
        || document.body.innerText
      return { title: document.title, text: text || '' }
    })()`) as { title: string; text: string }
    const text = sanitizeText(result.text).slice(0, 30000)
    return { title: sanitizeText(result.title), url: page.url(), text, method: 'browser' }
  })
}

export async function fetchPageContent(
  url: string,
  options?: { timeoutMs?: number }
): Promise<PageContent> {
  const timeoutMs = options?.timeoutMs ?? 10000
  // 修复记录（评审 CRITICAL）：入口统一协议/内网校验，双路径共用。
  // 旧实现只在 HTTP 层校验，HTTP 失败降级 Playwright 后 file:// 与内网地址可直通，
  // 成为越权读本地文件/内网页面的旁路——本行确保浏览器渲染路径同样被拦截。
  await assertSafeFetchUrl(url)
  // 1. HTTP 直抓 + 启发式正文提取
  try {
    const html = await fetchText(url, timeoutMs, {
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    })
    const { title, text } = extractMainText(html)
    if (text.length >= 200) {
      return { title, url, text, method: 'http' }
    }
    console.log(`[web-search] HTTP 正文过短(${text.length}字符)，疑似 JS 渲染页，降级浏览器: ${url}`)
  } catch (err) {
    console.log(`[web-search] HTTP 抓取失败，降级浏览器: ${(err as Error).message}`)
  }
  // 2. Playwright 渲染后读取
  return fetchWithBrowser(url, timeoutMs)
}

// ============================================================
// 深度搜索（deepSearch）：Playwright headless 真实浏览器搜索
// ============================================================
// 场景：HTTP 抓取拿不到的——站内搜索（B站/知乎/微博等）、JS 渲染页、强反爬站点。
// 引擎：Playwright headless（browserManager 单例），静默运行不打扰用户。
// 策略：
// 1. 已知站点映射 → 构造站内搜索 URL（B站/知乎/微博/豆瓣/贴吧等）
// 2. 未知站点 → Bing 搜索 + site: 限定
// 3. 提取器：B站视频卡片特化 → 通用搜索结果容器（b_algo/result）→ 全页链接 fallback

/** 已知站点的站内搜索 URL 构造器（域名 → 搜索页 URL） */
const SITE_SEARCH_BUILDERS: Record<string, (q: string) => string> = {
  'bilibili.com': (q) => `https://search.bilibili.com/all?keyword=${encodeURIComponent(q)}`,
  'zhihu.com': (q) => `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(q)}`,
  'weibo.com': (q) => `https://s.weibo.com/weibo?q=${encodeURIComponent(q)}`,
  'douban.com': (q) => `https://www.douban.com/search?q=${encodeURIComponent(q)}`,
  'tieba.baidu.com': (q) => `https://tieba.baidu.com/f/search/res?ie=utf-8&qw=${encodeURIComponent(q)}`,
  'juejin.cn': (q) => `https://juejin.cn/search?query=${encodeURIComponent(q)}`,
  'csdn.net': (q) => `https://so.csdn.net/so/search?q=${encodeURIComponent(q)}`,
  'stackoverflow.com': (q) => `https://stackoverflow.com/search?q=${encodeURIComponent(q)}`,
  'npmjs.com': (q) => `https://www.npmjs.com/search?q=${encodeURIComponent(q)}`
}

/** 搜索结果提取脚本（页面上下文执行）：B站特化 → 通用容器 → 全页链接 fallback */
// 注意：IIFE 形式（(() => {...})()），Playwright 把字符串 eval 为表达式执行；
// 裸箭头函数字符串会被 eval 成函数对象不执行 → 返回 undefined（历史 bug）
const EXTRACT_SEARCH_RESULTS_JS = `(() => {
  const results = []
  const seen = new Set()
  const add = (title, url, snippet) => {
    if (!title || !url || seen.has(url)) return
    seen.add(url)
    results.push({ title: String(title).trim().slice(0, 150), url: String(url), snippet: String(snippet || '').trim().slice(0, 300) })
  }
  // 1. B站搜索页特化：视频卡片
  const cards = document.querySelectorAll('.bili-video-card, .video-list-item, .bili-video-card__wrap')
  for (const c of cards) {
    const a = c.querySelector('a[href]')
    if (!a) continue
    const t = (c.querySelector('.bili-video-card__info--tit, .bili-video-card__info--title, .title, .info-title') || a).innerText
    const d = (c.querySelector('.bili-video-card__info--author, .bili-video-card__info--desc, .desc, .up-name') || {}).innerText || ''
    add(t, a.href, d)
  }
  if (results.length >= 10) return results
  // 2. 通用搜索结果容器（bing b_algo / baidu result / 其他）
  document.querySelectorAll('li.b_algo, div.result, div.search-result, div.repo-list-item, div.article-item, div.content-list__item').forEach((el) => {
    const a = el.querySelector('a[href]')
    if (!a) return
    const t = a.innerText || a.getAttribute('title') || ''
    const d = el.innerText.replace(t, '').trim().slice(0, 300)
    add(t, a.href, d)
  })
  if (results.length >= 8) return results
  // 3. 终极 fallback：全页链接收集（过滤站内导航/协议链接）
  document.querySelectorAll('a[href]').forEach((a) => {
    const href = a.href || ''
    const text = (a.innerText || '').trim()
    if (!href.startsWith('http') || text.length < 8) return
    try {
      const u = new URL(href)
      if (['javascript:', 'mailto:', 'tel:'].includes(u.protocol)) return
      add(text, href, '')
    } catch { /* 忽略无效 URL */ }
  })
  return results
})()`

export async function deepSearch(
  query: string,
  options?: DeepSearchOptions
): Promise<SearchResult[]> {
  const max = options?.maxResults && options.maxResults > 0 ? options.maxResults : 8
  const timeoutMs = options?.timeoutMs ?? 20000

  // 构造搜索 URL：已知站点 → 站内搜索；未知站点 → Bing + site:
  const sites = (options?.sites || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  let searchUrl: string
  if (sites.length > 0) {
    const builder = SITE_SEARCH_BUILDERS[sites[0]]
    searchUrl = builder
      ? builder(query)
      : `https://cn.bing.com/search?q=${encodeURIComponent(`${query} site:${sites[0]}`)}`
  } else {
    searchUrl = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${max}`
  }

  // withPage 互斥锁：与其他浏览器调用（fetchPageContent/工具操作）串行，避免并发争抢单例页面
  return browserManager.withPage(async (page) => {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 30000) })
    // 等渲染稳定：SPA 内容 + 反爬延迟
    await page.waitForTimeout(2000)
    const raw = await page.evaluate(EXTRACT_SEARCH_RESULTS_JS)
    const results: SearchResult[] = (Array.isArray(raw) ? raw : []).slice(0, max).map((r) => ({
      title: String((r as { title?: unknown }).title ?? ''),
      url: String((r as { url?: unknown }).url ?? ''),
      snippet: String((r as { snippet?: unknown }).snippet ?? ''),
      source: sites.length > 0 ? `深度搜索/${sites[0]}` : '深度搜索/Bing'
    }))
    const cleaned = sanitizeResults(results)
    if (cleaned.length > 0) {
      return cleaned
    }
    // 提取为空（反爬/未渲染）：返回页面文本片段供 AI 参考
    const pageText = await page.evaluate(`(() => document.body.innerText)()`) as string
    const snippet = sanitizeText(pageText).slice(0, 500)
    if (snippet) {
      return [{
        title: `【深度搜索】${query}（页面无结构化结果，以下为页面文本片段）`,
        url: page.url(),
        snippet,
        source: '深度搜索'
      }]
    }
    return []
  })
}