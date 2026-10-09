/**
 * 为什么存在：分系统加入主系统需要人工可读可传的准入凭证，接入码须避让易混字符（I/O/0/1），并可从完整链接还原参数。
 * 作用：generateJoinCode 生成 16 位分组随机接入码，parseJoinLink 把链接解析为 baseUrl + joinCode。
 */

import { randomBytes } from 'crypto'

// 接入链接格式：http://{ip}:{port}/join?code=XXXX-XXXX-XXXX-XXXX
// 地址与接入码二合一：分系统注册页粘贴此链接即为分系统；留空即主系统。

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 去除易混字符 I O 0 1

export interface ParsedJoinLink {
  baseUrl: string
  joinCode: string
}

export type ParseJoinLinkResult = ParsedJoinLink | { error: string }

export function generateJoinCode(): string {
  const bytes = randomBytes(16)
  const chars: string[] = []
  for (let i = 0; i < 16; i++) {
    chars.push(ALPHABET[bytes[i] % ALPHABET.length])
  }
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12), chars.slice(12, 16)]
    .map((g) => g.join(''))
    .join('-')
}

/** 解析接入链接 → { baseUrl, joinCode }；格式不符返回 error */
export function parseJoinLink(input: string): ParseJoinLinkResult {
  const trimmed = input.trim()
  if (!trimmed) return { error: '请粘贴主系统接入链接' }
  // 自带 scheme 但非 http/https（如 ftp://、file://）直接拒绝；未带 scheme 视为裸地址补 http
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    return { error: '仅支持 http/https 接入链接' }
  }
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`)
  } catch {
    return { error: '链接格式不正确，请粘贴主系统分享的接入链接' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: '仅支持 http/https 接入链接' }
  const joinCode = url.searchParams.get('code') ?? ''
  if (!joinCode) return { error: '接入链接缺少接入码（?code=）' }
  return { baseUrl: `${url.protocol}//${url.host}`, joinCode }
}