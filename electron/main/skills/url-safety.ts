/**
 * URL 安全校验：Skill 市场安装（清单拉取）会访问外部地址，
 * 需要统一拦截私有/回环/内网地址（防 SSRF）与不安全的安装源，
 * 提供公网 HTTP(S) 校验。
 */
/** 判断 host 是否为私有/回环/链路本地地址（IPv4 + IPv6） */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase()
  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0') return true
  if (h.startsWith('169.254.')) return true
  if (h.startsWith('10.') || h.startsWith('192.168.')) return true
  const parts = h.split('.')
  if (parts.length === 4 && parts[0] === '172' && Number(parts[1]) >= 16 && Number(parts[1]) <= 31) return true
  if (h === '::1') return true
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true
  if (h.startsWith('fc') || h.startsWith('fd')) return true
  if (h.startsWith('::ffff:')) return isPrivateHost(h.slice(7))
  return false
}

/** 校验 URL 是否为安全的公网 HTTP(S) 地址（防 SSRF） */
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) return false
    return !isPrivateHost(parsed.hostname)
  } catch {
    return false
  }
}