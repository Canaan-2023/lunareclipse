/**
 * tokensEqual（令牌常量时间比较）契约测试。
 * 为什么存在：server.ts 中 Bearer 头 / /reports/ query / WS 握手三处令牌判定
 * 统一走 server-utils.tokensEqual；测试锁定三态契约——等长相等 / 等长不等 /
 * 长度不同（长度不同直接判不等，不进入 timingSafeEqual 的等长 Buffer 约束）。
 */
import { describe, it, expect } from 'vitest'
import { tokensEqual } from '../electron/main/api/server-utils'

describe('tokensEqual', () => {
  it('等长且值相等 → true（与实际令牌一致放行）', () => {
    expect(tokensEqual('a1b2c3d4e5', 'a1b2c3d4e5')).toBe(true)
    expect(tokensEqual('abc', 'abc')).toBe(true)
  })

  it('等长但值不等 → false（错误令牌拒绝）', () => {
    expect(tokensEqual('a1b2c3d4e5', 'a1b2c3d4e6')).toBe(false)
    expect(tokensEqual('abc', 'abd')).toBe(false)
  })

  it('长度不同 → false（直接判不等，不比较内容）', () => {
    expect(tokensEqual('abc', 'abcd')).toBe(false)
    expect(tokensEqual('abcd', 'abc')).toBe(false)
  })

  it('undefined / null → false（缺失令牌拒绝）', () => {
    expect(tokensEqual(undefined, 'abc')).toBe(false)
    expect(tokensEqual(null, 'abc')).toBe(false)
  })
})