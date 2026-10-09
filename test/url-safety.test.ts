/**
 * url-safety.test.ts — url-safety.ts 单测（T6C）
 * 覆盖：IP 分类（IPv4/IPv6/CGNAT/IPv4-mapped）、元数据哨兵、
 * DNS 解析验证（注入 resolver）、fail-closed、敏感查询参数。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  isBlockedIp,
  isSafeUrl,
  isAlwaysBlockedUrl,
  setAllowPrivateUrl,
  sensitiveQueryParamName,
  hasSensitiveQueryParams,
  type DnsResolver,
} from '../electron/main/tools/security-engine/url-safety'

/** 注入式 DNS：主机名 → IP 列表。默认解析失败（空）。 */
function makeResolver(map: Record<string, string[]>): DnsResolver {
  return async (hostname) => map[hostname] ?? []
}

describe('isBlockedIp — IPv4 分类', () => {
  it('拦截私有/回环/链路本地/保留段', () => {
    expect(isBlockedIp('127.0.0.1')).toBe(true)
    expect(isBlockedIp('127.255.255.255')).toBe(true)
    expect(isBlockedIp('10.0.0.1')).toBe(true)
    expect(isBlockedIp('10.255.255.255')).toBe(true)
    expect(isBlockedIp('172.16.0.1')).toBe(true)
    expect(isBlockedIp('172.31.255.255')).toBe(true)
    expect(isBlockedIp('192.168.1.1')).toBe(true)
    expect(isBlockedIp('169.254.169.254')).toBe(true)
    expect(isBlockedIp('0.0.0.0')).toBe(true)
    expect(isBlockedIp('224.0.0.1')).toBe(true) // multicast
    expect(isBlockedIp('240.0.0.1')).toBe(true) // reserved
  })

  it('拦截 CGNAT 100.64.0.0/10（is_private 不覆盖的范围）', () => {
    expect(isBlockedIp('100.64.0.1')).toBe(true)
    expect(isBlockedIp('100.100.100.200')).toBe(true)
    expect(isBlockedIp('100.127.255.255')).toBe(true)
  })

  it('放行公网地址', () => {
    expect(isBlockedIp('8.8.8.8')).toBe(false)
    expect(isBlockedIp('1.1.1.1')).toBe(false)
    expect(isBlockedIp('172.15.0.1')).toBe(false) // 172.16/12 之外
    expect(isBlockedIp('172.32.0.1')).toBe(false)
    expect(isBlockedIp('192.169.1.1')).toBe(false)
    expect(isBlockedIp('100.63.0.1')).toBe(false) // CGNAT 之外
    expect(isBlockedIp('100.128.0.1')).toBe(false)
  })
})

describe('isBlockedIp — IPv6 分类', () => {
  it('拦截回环/未指定/链路本地/ULA/组播/文档段', () => {
    expect(isBlockedIp('::1')).toBe(true)
    expect(isBlockedIp('::')).toBe(true)
    expect(isBlockedIp('fe80::1')).toBe(true)
    expect(isBlockedIp('febf::1')).toBe(true)
    expect(isBlockedIp('fc00::1')).toBe(true)
    expect(isBlockedIp('fdff::1')).toBe(true)
    expect(isBlockedIp('ff02::1')).toBe(true) // multicast
    expect(isBlockedIp('2001:db8::1')).toBe(true) // documentation
  })

  it('拦截 IPv4-mapped IPv6（::ffff:x.x.x.x 按内嵌 IPv4 判）', () => {
    expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true)
    expect(isBlockedIp('::ffff:10.0.0.1')).toBe(true)
    expect(isBlockedIp('::ffff:192.168.1.1')).toBe(true)
    expect(isBlockedIp('::ffff:169.254.169.254')).toBe(true)
    expect(isBlockedIp('::ffff:100.64.0.1')).toBe(true) // CGNAT
    expect(isBlockedIp('::ffff:8.8.8.8')).toBe(false) // 公网放行
  })

  it('放行公网 IPv6', () => {
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false)
    expect(isBlockedIp('2001:4860:4860::8888')).toBe(false)
  })
})

describe('isSafeUrl — 字面 IP 直接判定', () => {
  beforeEach(() => setAllowPrivateUrl(false))

  it('拦截私有/元数据字面 IP', async () => {
    expect(await isSafeUrl('http://127.0.0.1:8080/admin')).toBe(false)
    expect(await isSafeUrl('http://169.254.169.254/latest/meta-data')).toBe(false)
    expect(await isSafeUrl('http://10.0.0.1')).toBe(false)
    expect(await isSafeUrl('http://192.168.1.1')).toBe(false)
    expect(await isSafeUrl('http://100.64.0.1')).toBe(false) // CGNAT
    expect(await isSafeUrl('http://[::1]:3000')).toBe(false)
    expect(await isSafeUrl('http://[fe80::1]')).toBe(false)
    expect(await isSafeUrl('http://[::ffff:10.0.0.1]')).toBe(false)
  })

  it('放行公网字面 IP', async () => {
    expect(await isSafeUrl('http://8.8.8.8')).toBe(true)
    expect(await isSafeUrl('https://[2606:4700:4700::1111]')).toBe(true)
  })

  it('拦截非 http/https scheme 与空 host', async () => {
    expect(await isSafeUrl('ftp://8.8.8.8')).toBe(false)
    expect(await isSafeUrl('file:///etc/passwd')).toBe(false)
    expect(await isSafeUrl('http://')).toBe(false)
  })
})

describe('isSafeUrl — 主机名 DNS 解析验证（注入 resolver）', () => {
  beforeEach(() => setAllowPrivateUrl(false))

  it('解析到公网 IP → 放行', async () => {
    const resolve = makeResolver({ 'example.com': ['93.184.216.34'] })
    expect(await isSafeUrl('https://example.com', { resolve })).toBe(true)
  })

  it('解析到私有/元数据 IP → 拦截（DNS rebinding 预检）', async () => {
    const resolve = makeResolver({ 'evil.example': ['169.254.169.254'] })
    expect(await isSafeUrl('https://evil.example', { resolve })).toBe(false)
    const resolve2 = makeResolver({ 'evil.example': ['10.0.0.5'] })
    expect(await isSafeUrl('https://evil.example', { resolve: resolve2 })).toBe(false)
  })

  it('多个解析结果中任一命中私有 → 拦截', async () => {
    const resolve = makeResolver({ 'mixed.example': ['93.184.216.34', '192.168.1.1'] })
    expect(await isSafeUrl('https://mixed.example', { resolve })).toBe(false)
  })

  it('DNS 解析失败 → fail-closed 拦截', async () => {
    const resolve = makeResolver({}) // 默认空
    expect(await isSafeUrl('https://nxdomain.example', { resolve })).toBe(false)
  })

  it('allowPrivateUrls=true 时放行私有，但云元数据仍拦', async () => {
    const resolve = makeResolver({ 'internal.example': ['10.0.0.5'] })
    expect(await isSafeUrl('https://internal.example', { resolve, allowPrivateUrls: true })).toBe(true)
    const resolve2 = makeResolver({ 'evil.example': ['169.254.169.254'] })
    expect(await isSafeUrl('https://evil.example', { resolve: resolve2, allowPrivateUrls: true })).toBe(false)
  })

  it('模块开关 setAllowPrivateUrl 生效', async () => {
    setAllowPrivateUrl(true)
    const resolve = makeResolver({ 'internal.example': ['10.0.0.5'] })
    expect(await isSafeUrl('https://internal.example', { resolve })).toBe(true)
    setAllowPrivateUrl(false)
    expect(await isSafeUrl('https://internal.example', { resolve })).toBe(false)
  })

  it('拦截云元数据主机名（无论 DNS 解析到哪）', async () => {
    const resolve = makeResolver({ 'metadata.google.internal': ['8.8.8.8'] })
    expect(await isSafeUrl('http://metadata.google.internal', { resolve })).toBe(false)
    expect(await isSafeUrl('http://metadata.google.internal', { resolve, allowPrivateUrls: true })).toBe(false)
  })

  it('trusted 私有主机名（HTTPS）放行', async () => {
    const resolve = makeResolver({ 'multimedia.nt.qq.com.cn': ['10.0.0.5'] })
    expect(await isSafeUrl('https://multimedia.nt.qq.com.cn/x', { resolve })).toBe(true)
    // 非 HTTPS 不享受 trusted 豁免
    expect(await isSafeUrl('http://multimedia.nt.qq.com.cn/x', { resolve })).toBe(false)
  })
})

describe('isAlwaysBlockedUrl — 安全地板', () => {
  it('拦截云元数据主机名与哨兵 IP（比 isSafeUrl 窄）', async () => {
    expect(await isAlwaysBlockedUrl('http://169.254.169.254')).toBe(true)
    expect(await isAlwaysBlockedUrl('http://metadata.google.internal')).toBe(true)
    expect(await isAlwaysBlockedUrl('http://[fd00:ec2::254]')).toBe(true)
    expect(await isAlwaysBlockedUrl('http://100.100.100.200')).toBe(true)
    expect(await isAlwaysBlockedUrl('http://[::ffff:169.254.169.254]')).toBe(true)
  })

  it('普通私有/公网地址不算 always-blocked（留给 isSafeUrl）', async () => {
    expect(await isAlwaysBlockedUrl('http://127.0.0.1')).toBe(false)
    expect(await isAlwaysBlockedUrl('http://10.0.0.1')).toBe(false)
    expect(await isAlwaysBlockedUrl('http://8.8.8.8')).toBe(false)
    expect(await isAlwaysBlockedUrl('http://example.com')).toBe(false)
  })

  it('主机名解析到哨兵 IP → 拦截', async () => {
    const resolve = makeResolver({ 'evil.example': ['169.254.169.254'] })
    expect(await isAlwaysBlockedUrl('http://evil.example', resolve)).toBe(true)
    const resolve2 = makeResolver({ 'ok.example': ['93.184.216.34'] })
    expect(await isAlwaysBlockedUrl('http://ok.example', resolve2)).toBe(false)
  })
})

describe('敏感查询参数', () => {
  it('识别显式凭据参数名', () => {
    expect(sensitiveQueryParamName('https://a.com/?token=abc123')).toBe('token')
    expect(sensitiveQueryParamName('https://a.com/?api_key=abc')).toBe('api_key')
    expect(sensitiveQueryParamName('https://a.com/?x-amz-signature=xyz')).toBe('x-amz-signature')
    expect(sensitiveQueryParamName('https://a.com/?q=hello&password=secret')).toBe('password')
    expect(hasSensitiveQueryParams('https://a.com/?jwt=eyJ')).toBe(true)
  })

  it('忽略空值、普通参数、非 http 链接', () => {
    expect(sensitiveQueryParamName('https://a.com/?token=')).toBe(null) // 空值不算
    expect(sensitiveQueryParamName('https://a.com/?code=abc')).toBe(null) // code 刻意排除
    expect(sensitiveQueryParamName('https://a.com/?q=hello')).toBe(null)
    expect(sensitiveQueryParamName('https://a.com/')).toBe(null)
    expect(sensitiveQueryParamName('ftp://a.com/?token=x')).toBe(null)
    expect(hasSensitiveQueryParams('https://a.com/?q=hello')).toBe(false)
  })
})
