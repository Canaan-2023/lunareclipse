import { describe, it, expect } from 'vitest'
import { generateJoinCode, parseJoinLink } from '../electron/main/multi-instance/join-link'

describe('join-link 接入码生成与接入链接解析', () => {
  it('generateJoinCode 生成 4-4-4-4 大写字母数字组合（去易混字符）', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateJoinCode()
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    }
  })

  it('generateJoinCode 两次生成不同', () => {
    const a = generateJoinCode()
    const b = generateJoinCode()
    expect(a).not.toBe(b)
  })

  it('parseJoinLink 解析完整链接（http + code）', () => {
    const r = parseJoinLink('http://192.0.2.10:62002/join?code=ABCD-EFGH-JKLM-NPQR')
    expect(r).toEqual({ baseUrl: 'http://192.0.2.10:62002', joinCode: 'ABCD-EFGH-JKLM-NPQR' })
  })

  it('parseJoinLink 补全缺失协议（裸 ip:port）', () => {
    const r = parseJoinLink('192.0.2.10:62002/join?code=ABCD-EFGH-JKLM-NPQR')
    expect(r).toEqual({ baseUrl: 'http://192.0.2.10:62002', joinCode: 'ABCD-EFGH-JKLM-NPQR' })
  })

  it('parseJoinLink 拒绝空输入', () => {
    expect(parseJoinLink('')).toMatchObject({ error: expect.any(String) })
    expect(parseJoinLink('   ')).toMatchObject({ error: expect.any(String) })
  })

  it('parseJoinLink 拒绝无 code 的链接', () => {
    expect(parseJoinLink('http://192.0.2.10:62002/join')).toMatchObject({ error: '接入链接缺少接入码（?code=）' })
  })

  it('parseJoinLink 拒绝非 http/https 协议', () => {
    expect(parseJoinLink('ftp://192.0.2.10/join?code=X')).toMatchObject({ error: expect.any(String) })
    expect(parseJoinLink('file:///c:/x/join?code=X')).toMatchObject({ error: expect.any(String) })
  })

  it('parseJoinLink 拒绝非法 URL', () => {
    expect(parseJoinLink('not a url')).toMatchObject({ error: expect.any(String) })
  })
})