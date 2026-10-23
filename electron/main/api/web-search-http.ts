// ===== web-search HTTP 基础设施（域拆分自 web-search.ts）=====
// 为什么存在：多搜索源抓取要反爬伪装、按源限速并防 SSRF 打到内网，
// 集中到一层基础设施供所有 provider 复用——
// 反爬伪装 UA 轮换、全局速率限制、SSRF 防护、GET/POST 抓取原语。

import https from 'https'
import http from 'http'
import {
  isBlockedIp,
  isSafeUrl,
  setAllowPrivateUrl as setSsrfAllowPrivateUrl,
} from '../tools/security-engine/url-safety'

// ============================================================
// 反爬伪装：UA 轮换池 + 全局速率限制（每源最小间隔，避免触发风控）
// ============================================================
// 策略：
// 1. 每次请求随机选一个真实浏览器 UA（PC + 移动端混合）
// 2. 每个搜索源维护独立 lastCall 时间戳，间隔不足则等待
// 3. auto 多源并行时，源之间天然分散，单源串行间隔保证 ≥ 1.2s
const UA_POOL = [
  // Chrome PC
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  // Edge PC
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
  // Firefox PC
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  // Safari Mac
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  // 移动端（微博/贴吧等移动 API 用移动 UA 更稳）
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36'
]

/** 每个源对应是否优先用移动 UA（m.weibo.cn / tieba 移动版 等移动 API 更友好） */
const MOBILE_PREFERRED_SOURCES = new Set(['weibo', 'tieba', 'zhihu'])

/** 每个源的最小请求间隔（毫秒），低于此值会等待 */
const SOURCE_MIN_INTERVAL_MS: Record<string, number> = {
  baike: 1500,
  moegirl: 1500,
  bilibili: 1200,
  tieba: 2000,    // 贴吧风控较严
  weibo: 1500,
  duckduckgo: 2000,
  zhihu: 1800,    // 知乎风控较严
  douban: 1500,
  baidu: 2000,    // 百度综合搜索风控严
  bing: 1200,
  gushiwen: 1500,
  bocha: 800,     // 正式 API，限制较松
  custom: 0
}

/** 每个源上次请求时间戳 */
const lastCallTs: Map<string, number> = new Map()

function pickUA(source: string): string {
  if (MOBILE_PREFERRED_SOURCES.has(source)) {
    // 移动端优先，但偶尔混入 PC UA 模拟真实用户
    return Math.random() < 0.7
      ? UA_POOL[6 + Math.floor(Math.random() * 2)]
      : UA_POOL[Math.floor(Math.random() * 5)]
  }
  return UA_POOL[Math.floor(Math.random() * 5)]
}

/** 等待到满足速率限制（按源 key 计算距离上次调用的时间） */
export async function respectRateLimit(source: string): Promise<void> {
  const minInterval = SOURCE_MIN_INTERVAL_MS[source] ?? 1000
  if (minInterval <= 0) return
  const now = Date.now()
  const last = lastCallTs.get(source) ?? 0
  const elapsed = now - last
  if (elapsed < minInterval) {
    const wait = minInterval - elapsed
    await new Promise<void>((resolve) => setTimeout(resolve, wait))
  }
  lastCallTs.set(source, Date.now())
}

/** 随机抖动 200~600ms，模拟人类操作不规则性 */
export function humanJitter(): Promise<void> {
  const ms = 200 + Math.floor(Math.random() * 400)
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/**
 * SSRF 防护（完整移植）：
 * 拦截内网/回环地址（127.0.0.0/8、10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、
 * 169.254.0.0/16、100.64.0.0/10 CGNAT、IPv6 回环/ULA/链路本地、IPv4-mapped）、
 * 云元数据哨兵（169.254.169.254、metadata.google.internal 等无条件拦截）。
 * allowPrivate=true 时可放行私有段（配置开关，默认拦截；云元数据即使开开关也拦）。
 */
let allowPrivateUrl = false
export function setAllowPrivateUrl(v: boolean): void {
  allowPrivateUrl = v
  setSsrfAllowPrivateUrl(v) // 同步到 url-safety 引擎
}

/** 同步字面 IP/主机名检查（不发 DNS 请求）；完整 DNS 解析验证走 isSafeUrl。 */
export function isPrivateUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    // localhost / .local / 0.0.0.0
    if (host === 'localhost' || host.endsWith('.local') || host === '0.0.0.0') return true
    // 字面 IP（IPv4/IPv6/IPv4-mapped）→ url-safety 完整分类
    return isBlockedIp(host)
  } catch {
    return false // 无法解析的 URL 放行（由后续请求报错）
  }
}

/**
 * 通用 HTTP GET 文本抓取
 * @param source 搜索源 key（用于 UA 选择和速率限制），如 'baike'/'weibo'
 */
export async function fetchText(url: string, timeoutMs = 5000, extraHeaders?: Record<string, string>, source = 'common'): Promise<string> {
  // SSRF 防护（升级版）：先字面检查（快），再 DNS 解析验证（防域名指向内网）
  if (!allowPrivateUrl && isPrivateUrl(url)) {
    throw new Error(`SSRF 拦截：目标地址是内网/回环地址（${url}）`)
  }
  if (!allowPrivateUrl && !(await isSafeUrl(url))) {
    throw new Error(`SSRF 拦截：目标域名解析到内网/元数据地址（${url}）`)
  }
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http
    const req = lib.get(
      url,
      {
        headers: {
          // 没显式传 UA 则按源轮换
          'User-Agent': extraHeaders?.['User-Agent'] ?? pickUA(source),
          Accept: 'text/html,application/xhtml+xml,application/json',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          ...extraHeaders
        },
        timeout: timeoutMs
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, url).toString()
          res.resume()
          fetchText(next, timeoutMs, extraHeaders, source).then(resolve, reject)
          return
        }
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          res.resume()
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
        res.on('error', reject)
      }
    )
    req.on('timeout', () => {
      req.destroy(new Error('timeout'))
    })
    req.on('error', reject)
  })
}

/**
 * 通用 HTTP POST（博查 API 用）
 */
export function postJson(url: string, body: Record<string, unknown>, headers: Record<string, string> = {}, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body)
    const urlObj = new URL(url)
    const lib = urlObj.protocol === 'https:' ? https : http
    const req = lib.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          'User-Agent': 'LunarEclipse/1.0',
          ...headers
        },
        timeout: timeoutMs
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, url).toString()
          res.resume()
          postJson(next, body, headers, timeoutMs).then(resolve, reject)
          return
        }
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          res.resume()
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
        res.on('error', reject)
      }
    )
    req.on('timeout', () => {
      req.destroy(new Error('timeout'))
    })
    req.on('error', reject)
    req.write(bodyStr)
    req.end()
  })
}