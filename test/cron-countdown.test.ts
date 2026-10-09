import { describe, it, expect } from 'vitest'
import { formatCountdown } from '../src/components/Cron/CronPanel'

describe('formatCountdown（AI 倒计时格式化）', () => {
  const NOW = 1_000_000_000_000

  it('剩余 30 秒显示秒', () => {
    expect(formatCountdown(NOW + 30_000, NOW)).toBe('30秒')
  })

  it('剩余 1 分 5 秒显示分秒', () => {
    expect(formatCountdown(NOW + 65_000, NOW)).toBe('1分5秒')
  })

  it('剩余 2 小时 3 分 4 秒显示时分秒', () => {
    expect(formatCountdown(NOW + 2 * 3_600_000 + 3 * 60_000 + 4_000, NOW)).toBe('2时3分4秒')
  })

  it('到期/超时归零而不为负：old snapshots 与已过 fireAt 必须显示 0 秒', () => {
    expect(formatCountdown(NOW - 1, NOW)).toBe('0秒')
    expect(formatCountdown(NOW - 120_000, NOW)).toBe('0秒')
  })
})