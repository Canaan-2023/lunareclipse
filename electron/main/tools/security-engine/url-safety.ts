/**
 * url-safety.ts — SSRF 防护引擎

 * 为什么存在：AI 会按网页/技能中出现的 URL 发起请求，恶意内容可诱导其抓取云元数据或内网
 * 服务，造成内部信息泄露；本模块是 web 抓取类路径的 SSRF 闸门。
 * SSRF 防护：拦截到私有/内网地址的请求（云元数据端点 169.254.169.254、
 * localhost 服务、私有网段主机）。防止恶意提示词或技能诱导 agent
 * 抓取内部资源。

 * 环境适配说明：
 * - DNS 解析用 node:dns/promises（异步），isSafeUrl / isAlwaysBlockedUrl
 * 均为 async——原版是同步 socket.getaddrinfo。
 * - allow_private_urls 开关用模块级 allowPrivateUrl（setAllowPrivateUrl），
 * 原版读 config.yaml + env。云元数据主机名/IP 即使在开关打开时也**总是**拦截。
 * - 原版的 httpx transport 连接时挂载（防 DNS rebinding 的 TCP 层 pin IP）
 * 不移植——月蚀 web 抓取用 Node 原生 http/https，此处做预检式拦截。

 * 限制（同原版）：DNS rebinding（TOCTOU）无法在预检层完全消除——攻击者
 * 控制的 DNS 在检查时返回公网 IP、连接时返回内网 IP。彻底解决需要
 * 在 TCP connect 前把域名 pin 到已验证 IP，超出本文件范围。


 */

import { isIP } from 'node:net'
import dns from 'node:dns/promises'

// =========================================================================
// 常量
// =========================================================================

/** 无论 IP 解析结果如何都**总是**拦截的主机名——云元数据端点。 */
const BLOCKED_HOSTNAMES = new Set(['metadata.google.internal', 'metadata.goog'])

/** 无论 allow_private_urls 开关如何都**总是**拦截的 IP（云元数据/凭据端点）。 */
const ALWAYS_BLOCKED_IPS = new Set([
  '169.254.169.254', // AWS/GCP/Azure/DO/Oracle metadata
  '169.254.170.2', // AWS ECS task metadata（task IAM 凭据）
  '169.254.169.253', // Azure IMDS wire server
  'fd00:ec2::254', // AWS metadata (IPv6)
  '100.100.100.200', // Alibaba Cloud metadata
  // IPv4-mapped IPv6 变体——同端点经 ::ffff:x.x.x.x 可达
  '::ffff:169.254.169.254',
  '::ffff:169.254.170.2',
  '::ffff:169.254.169.253',
  '::ffff:100.100.100.200',
])

/** 精确 HTTPS 主机名允许解析到私有/benchmark 段 IP（QQ 媒体下载可合法落在 198.18/15）。 */
const TRUSTED_PRIVATE_IP_HOSTS = new Set(['multimedia.nt.qq.com.cn'])

/** 100.64.0.0/10（CGNAT / 共享地址空间，RFC 6598）——不在 IPv4 isPrivate 范围内，需显式拦。 */
const CGNAT_NETWORK_MIN = 0x64400000 // 100.64.0.0
const CGNAT_NETWORK_MAX = 0x647fffff // 100.127.255.255

const MAX_SSRF_CONNECT_IPS = 8

// =========================================================================
// 全局开关
// =========================================================================

let allowPrivateUrl = false

/** 设置是否放行私有/内网 IP 解析。 */
export function setAllowPrivateUrl(v: boolean): void {
  allowPrivateUrl = v
}

export function isAllowPrivateUrl(): boolean {
  return allowPrivateUrl
}

// =========================================================================
// IP 分类
// =========================================================================

/** IPv4 段解析为 32 位无符号整数；非法返回 null。 */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let out = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    out = (out << 8) | n
  }
  return out >>> 0
}

/** 10/8、127/8、172.16/12、192.168/16、169.254/16、100.64/10、组播、保留段。 */
function isBlockedIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip)
  if (n === null) return false
  const a = (n >>> 24) & 0xff
  const b = (n >>> 16) & 0xff
  // 0.0.0.0/8（unspecified）、10/8（private）、127/8（loopback）
  if (a === 0 || a === 10 || a === 127) return true
  // 100.64.0.0/10 CGNAT
  if (n >= CGNAT_NETWORK_MIN && n <= CGNAT_NETWORK_MAX) return true
  // 169.254.0.0/16 link-local
  if (a === 169 && b === 254) return true
  // 172.16.0.0/12 private
  if (a === 172 && b >= 16 && b <= 31) return true
  // 192.168.0.0/16 private
  if (a === 192 && b === 168) return true
  // 224.0.0.0/4 multicast、240.0.0.0/4 reserved
  if (a >= 224) return true
  return false
}

/** IPv6 分类：unspecified/loopback/link-local/ULA/multicast/documentation/IPv4-mapped。 */
function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  // 剥 scope id（fe80::1%eth0）
  const addr = lower.includes('%') ? lower.slice(0, lower.indexOf('%')) : lower
  // IPv4-mapped ::ffff:x.x.x.x → 按内嵌 IPv4 判断
  const v4mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (v4mapped) return isBlockedIPv4(v4mapped[1])
  // unspecified :: / loopback ::1
  if (addr === '::' || addr === '0:0:0:0:0:0:0:0') return true
  if (addr === '::1' || addr === '0:0:0:0:0:0:0:1') return true
  // link-local fe80::/10（fe80-febf）
  if (/^fe[89ab][0-9a-f]{0,3}:/i.test(addr)) return true
  // ULA fc00::/7（fc00-fdff）
  if (/^f[cd][0-9a-f]{0,3}:/i.test(addr)) return true
  // multicast ff00::/8
  if (/^ff[0-9a-f]{0,3}:/i.test(addr)) return true
  // documentation 2001:db8::/32（reserved）
  if (/^2001:db8:/i.test(addr)) return true
  return false
}

/**
 * 判断 IP 是否属于应拦截的私有/内网/保留地址。
 * 对应原版 _is_blocked_ip（含 IPv4-mapped 拆解与 CGNAT 显式判断）。
 */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) return isBlockedIPv4(ip)
  if (v === 6) return isBlockedIPv6(ip)
  return false // 无法识别——由调用方按 fail-closed 处理
}

/** 是否命中 always-blocked 网络（169.254.0.0/16 及其 IPv4-mapped 变体）。 */
function inAlwaysBlockedNetworks(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) {
    const n = ipv4ToInt(ip)
    if (n === null) return false
    return (n >>> 24) === 169 && ((n >>> 16) & 0xff) === 254
  }
  if (v === 6) {
    const lower = ip.toLowerCase()
    return lower.startsWith('::ffff:169.254.')
  }
  return false
}

// =========================================================================
// DNS 解析
// =========================================================================

/** 注入点（测试用）。默认 node:dns/promises lookup。 */
export type DnsResolver = (hostname: string) => Promise<string[]>

const defaultResolve: DnsResolver = async (hostname) => {
  try {
    const res = await dns.lookup(hostname, { all: true, verbatim: true })
    const seen = new Set<string>()
    const out: string[] = []
    for (const r of res) {
      const addr = r.address.includes('%') ? r.address.slice(0, r.address.indexOf('%')) : r.address
      if (!seen.has(addr) && out.length < MAX_SSRF_CONNECT_IPS) {
        seen.add(addr)
        out.push(addr)
      }
    }
    return out
  } catch {
    return []
  }
}

// =========================================================================
// 公开判定
// =========================================================================

/**
 * URL 是否命中 always-blocked 地板（云元数据端点，无任何合法 agent 用途）。
 * 比 isSafeUrl 窄：只拦哨兵集合，不拦普通私有地址。调用方即使绕过
 * 完整 SSRF 检查（如混合云路由），也必须先过这一层。
 */
export async function isAlwaysBlockedUrl(url: string, resolve: DnsResolver = defaultResolve): Promise<boolean> {
  try {
    const parsed = new URL(url)
    let hostname = (parsed.hostname || '').toLowerCase()
    hostname = hostname.replace(/\.$/, '')
    if (!hostname) return false

    // 主机名命中——无论 DNS 结果如何都拦
    if (BLOCKED_HOSTNAMES.has(hostname)) return true

    // 字面 IP → 直接查哨兵集合
    if (isIP(hostname)) {
      return ALWAYS_BLOCKED_IPS.has(hostname) || inAlwaysBlockedNetworks(hostname)
    }

    // 主机名 → 解析并逐个检查。DNS 失败不算 always-blocked（调用方常规路径处理）。
    const ips = await resolve(hostname)
    for (const ipStr of ips) {
      if (ALWAYS_BLOCKED_IPS.has(ipStr) || inAlwaysBlockedNetworks(ipStr)) return true
    }
    return false
  } catch {
    // 解析失败/意外错误——不断言 always-blocked，调用方决定
    return false
  }
}

export interface UrlSafetyOptions {
  /** 放行私有 IP 解析（默认取模块开关 setAllowPrivateUrl） */
  allowPrivateUrls?: boolean
  /** 注入 DNS 解析器（测试用） */
  resolve?: DnsResolver
}

/**
 * URL 是否安全（非私有/内网地址）。fail-closed：DNS 失败和意外错误都拦截。

 * allow_private_urls 打开时跳过私有 IP 拦截，但云元数据端点
 * （169.254.169.254、metadata.google.internal）**始终**拦截。
 */
export async function isSafeUrl(url: string, opts: UrlSafetyOptions = {}): Promise<boolean> {
  const resolve = opts.resolve ?? defaultResolve
  const allowAllPrivate = opts.allowPrivateUrls ?? allowPrivateUrl
  try {
    const parsed = new URL(url)
    let hostname = (parsed.hostname || '').toLowerCase()
    hostname = hostname.replace(/\.$/, '')
    const scheme = (parsed.protocol || '').replace(':', '').toLowerCase()
    if (scheme !== 'http' && scheme !== 'https') return false
    if (!hostname) return false

    // 已知内部主机名——总是拦（开关打开也一样）
    if (BLOCKED_HOSTNAMES.has(hostname)) return false

    const allowPrivateIp = scheme === 'https' && TRUSTED_PRIVATE_IP_HOSTS.has(hostname)

    // 字面 IP：无需 DNS，直接判定
    if (isIP(hostname)) {
      if (ALWAYS_BLOCKED_IPS.has(hostname) || inAlwaysBlockedNetworks(hostname)) return false
      if (!allowAllPrivate && !allowPrivateIp && isBlockedIp(hostname)) return false
      return true
    }

    // 解析并逐个验证
    const ips = await resolve(hostname)
    if (ips.length === 0) {
      // DNS 解析失败——fail-closed 拦截。
      // 注：原版在配置了 HTTP 代理时会把 DNS 委托给代理放行（沙箱/代理环境
      // 可能屏蔽直连 DNS）。月蚀 web 抓取无代理转发概念，保持 fail-closed。
      return false
    }
    for (const ipStr of ips) {
      if (ALWAYS_BLOCKED_IPS.has(ipStr) || inAlwaysBlockedNetworks(ipStr)) return false
      if (!allowAllPrivate && !allowPrivateIp && isBlockedIp(ipStr)) return false
    }
    return true
  } catch {
    // fail-closed：解析边缘情况不能成为 SSRF 绕过向量
    return false
  }
}

// =========================================================================
// 敏感查询参数（交给第三方抓取/浏览器后端前检查）
// =========================================================================

/** 明确携带凭据语义的查询参数名。刻意收窄：普通英文词（code/key/auth/sig）排除。 */
const SENSITIVE_QUERY_PARAM_NAMES = new Set([
  'access_token',
  'api_key',
  'apikey',
  'auth_token',
  'authorization',
  'awsaccesskeyid',
  'client_secret',
  'credential',
  'credentials',
  'jwt',
  'password',
  'passwd',
  'secret',
  'session_id',
  'signature',
  'token',
  'x_amz_security_token',
  'x_amz_signature',
  'x-amz-security-token',
  'x-amz-signature',
])

/** 返回 URL 中第一个敏感查询参数名（无则 null）。 */
export function sensitiveQueryParamName(url: string): string | null {
  if (typeof url !== 'string' || !url.includes('?')) return null
  try {
    const parsed = new URL(url)
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.search) return null
    for (const [key, value] of parsed.searchParams) {
      if (value && SENSITIVE_QUERY_PARAM_NAMES.has(key.toLowerCase())) return key
    }
    return null
  } catch {
    return null
  }
}

/** URL 是否携带疑似凭据的查询参数。 */
export function hasSensitiveQueryParams(url: string): boolean {
  return sensitiveQueryParamName(url) !== null
}
