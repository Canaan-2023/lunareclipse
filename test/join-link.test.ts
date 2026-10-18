import { describe, it, expect } from 'vitest'
import { generateJoinCode, parseJoinLink } from '../electron/main/multi-instance/join-link'

  // 解析夹具用「全 X 占位符」形态：这是 README/登录页 placeholder 的既有通用写法，
// 且出包门禁的 joincode 正则对全 X 形态做负向前瞻豁免（它不可能是一次真实生成的注册码）。
// 改用占位符而非形似真码的字面量（旧夹具是一个顺读的字母组合），使源码包隐私复扫零命中。
// 注意：本注释也不得复述那个旧字面量——门禁对注释同样扫描（实测被自己的注释命中）。
const PLACEHOLDER_CODE = 'XXXX-XXXX-XXXX-XXXX'

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
    const r = parseJoinLink(`http://192.0.2.10:62002/join?code=${PLACEHOLDER_CODE}`)
    expect(r).toEqual({ baseUrl: 'http://192.0.2.10:62002', joinCode: PLACEHOLDER_CODE })
  })

  it('parseJoinLink 补全缺失协议（裸 ip:port）', () => {
    const r = parseJoinLink(`192.0.2.10:62002/join?code=${PLACEHOLDER_CODE}`)
    expect(r).toEqual({ baseUrl: 'http://192.0.2.10:62002', joinCode: PLACEHOLDER_CODE })
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