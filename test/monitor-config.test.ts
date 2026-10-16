import { describe, it, expect } from 'vitest'
import { DEFAULT_MONITOR_CONFIG, mergeConfig } from '../electron/main/monitor/monitor-config'

describe('mergeConfig', () => {
  it('partial 顶层缺字段时保留 base 值', () => {
    const merged = mergeConfig(DEFAULT_MONITOR_CONFIG, { abyssac_root: 'custom_root' })
    expect(merged.abyssac_root).toBe('custom_root')
    expect(merged.watchdog.timeout_minutes).toBe(DEFAULT_MONITOR_CONFIG.watchdog.timeout_minutes)
  })

  it('sessionSummary 深合并：只改 summaryBudgetChars 时其余子字段保留', () => {
    const merged = mergeConfig(DEFAULT_MONITOR_CONFIG, {
      sessionSummary: { summaryBudgetChars: 123456 }
    })
    expect(merged.sessionSummary.summaryBudgetChars).toBe(123456)
    expect(merged.sessionSummary.enabled).toBe(DEFAULT_MONITOR_CONFIG.sessionSummary.enabled)
    expect(merged.sessionSummary.summaryMaxChars).toBe(DEFAULT_MONITOR_CONFIG.sessionSummary.summaryMaxChars)
    expect(merged.sessionSummary.routerMaxSessions).toBe(DEFAULT_MONITOR_CONFIG.sessionSummary.routerMaxSessions)
    expect(merged.sessionSummary.userShardMaxBytes).toBe(DEFAULT_MONITOR_CONFIG.sessionSummary.userShardMaxBytes)
  })

  it('memoryWorkflow 深合并：只改 enabled 时 batch_size/check_interval 保留', () => {
    const merged = mergeConfig(DEFAULT_MONITOR_CONFIG, { memoryWorkflow: { enabled: false } })
    expect(merged.memoryWorkflow.enabled).toBe(false)
    expect(merged.memoryWorkflow.batch_size).toBe(DEFAULT_MONITOR_CONFIG.memoryWorkflow.batch_size)
    expect(merged.memoryWorkflow.check_interval_seconds).toBe(DEFAULT_MONITOR_CONFIG.memoryWorkflow.check_interval_seconds)
  })

  it('diaryWorkflow 深合并：只改 check_interval_seconds 时 enabled 保留', () => {
    const merged = mergeConfig(DEFAULT_MONITOR_CONFIG, { diaryWorkflow: { check_interval_seconds: 60 } })
    expect(merged.diaryWorkflow.check_interval_seconds).toBe(60)
    expect(merged.diaryWorkflow.enabled).toBe(DEFAULT_MONITOR_CONFIG.diaryWorkflow.enabled)
  })
})