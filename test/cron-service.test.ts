import { describe, it, expect } from 'vitest'
import { parseCron, matchesCron, CronParseError } from '../electron/main/services/cron-service'

describe('cron 表达式解析', () => {
  it('解析 5 字段基本表达式', () => {
    const c = parseCron('0 9 * * 1-5')
    expect(c.minutes.has(0)).toBe(true)
    expect(c.hours.has(9)).toBe(true)
    expect(c.days.has(15)).toBe(true) // * 全匹配
    expect(c.months.has(8)).toBe(true)
    expect(c.weekdays.has(1)).toBe(true)
    expect(c.weekdays.has(5)).toBe(true)
    expect(c.weekdays.has(0)).toBe(false)
  })

  it('支持步进 */n', () => {
    const c = parseCron('*/15 * * * *')
    expect(c.minutes.has(0)).toBe(true)
    expect(c.minutes.has(15)).toBe(true)
    expect(c.minutes.has(30)).toBe(true)
    expect(c.minutes.has(45)).toBe(true)
    expect(c.minutes.has(10)).toBe(false)
  })

  it('支持列表 a,b,c', () => {
    const c = parseCron('0 9,12,18 * * *')
    expect(c.hours.has(9)).toBe(true)
    expect(c.hours.has(12)).toBe(true)
    expect(c.hours.has(18)).toBe(true)
    expect(c.hours.has(10)).toBe(false)
  })

  it('支持区间 a-b', () => {
    const c = parseCron('0 8-10 * * *')
    expect(c.hours.has(8)).toBe(true)
    expect(c.hours.has(9)).toBe(true)
    expect(c.hours.has(10)).toBe(true)
    expect(c.hours.has(11)).toBe(false)
  })

  it('周 7 归一化为 0（周日别名）', () => {
    const c = parseCron('0 0 * * 7')
    expect(c.weekdays.has(0)).toBe(true)
    expect(c.weekdays.has(7)).toBe(false)
  })

  it('字段数不对抛错', () => {
    expect(() => parseCron('0 9 * *')).toThrow(CronParseError)
    expect(() => parseCron('0 9 * * 1 2')).toThrow(CronParseError)
  })

  it('越界抛错', () => {
    expect(() => parseCron('60 * * * *')).toThrow(CronParseError) // 分 0-59
    expect(() => parseCron('0 24 * * *')).toThrow(CronParseError) // 时 0-23
    expect(() => parseCron('0 9 * 13 *')).toThrow(CronParseError) // 月 1-12
    expect(() => parseCron('0 9 * * 8')).toThrow(CronParseError) // 周 0-7
  })

  it('非法字符抛错', () => {
    expect(() => parseCron('abc * * * *')).toThrow(CronParseError)
  })
})

describe('cron 匹配', () => {
  it('精确时刻匹配', () => {
    const d = new Date(2026, 7, 10, 9, 0) // 2026-08-10 09:00
    expect(matchesCron('0 9 * * *', d)).toBe(true)
    expect(matchesCron('30 9 * * *', d)).toBe(false)
    expect(matchesCron('0 8 * * *', d)).toBe(false)
  })

  it('工作日 9 点：周一匹配、周日不匹配', () => {
    const monday = new Date(2026, 7, 10, 9, 0) // 2026-08-10 是周一
    expect(matchesCron('0 9 * * 1-5', monday)).toBe(true)
    const sunday = new Date(2026, 7, 9, 9, 0) // 2026-08-09 是周日
    expect(matchesCron('0 9 * * 1-5', sunday)).toBe(false)
  })

  it('分钟步进匹配', () => {
    const d = new Date(2026, 7, 10, 9, 30)
    expect(matchesCron('*/15 * * * *', d)).toBe(true)
    const d2 = new Date(2026, 7, 10, 9, 31)
    expect(matchesCron('*/15 * * * *', d2)).toBe(false)
  })

  it('日与周任一匹配即可（标准 cron 语义）', () => {
    const d = new Date(2026, 7, 10, 9, 0) // 8-10 周一
    // 日=10 匹配 → true（即使周=0 不匹配）
    expect(matchesCron('0 9 10 * 0', d)).toBe(true)
    // 日=11 周=1 → 周匹配 → true
    const d2 = new Date(2026, 7, 11, 9, 0) // 8-11 周二
    expect(matchesCron('0 9 10 * 2', d2)).toBe(true)
  })
})
