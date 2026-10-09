import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ErrorLog, DEFAULT_ERROR_LOG_CONFIG } from '../electron/main/monitor/error-log'
import type { ErrorLogTask } from '../electron/main/monitor/error-log'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('ErrorLog', () => {
  let tmpDir: string
  let logPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'errorlog-test-'))
    logPath = join(tmpDir, '错误日志.jsonl')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const makeTask = (): ErrorLogTask => ({ type: 'custom', path: '/test', detail: 'unit-test' })

  it('add 创建条目并持久化到 JSONL 文件', () => {
    const log = new ErrorLog(logPath, { retry_interval_ms: 60000, max_retry: 3 })
    const entry = log.add('test error', makeTask())
    expect(entry.id).toBeTruthy()
    expect(entry.error).toBe('test error')
    expect(entry.retry_count).toBe(0)
    expect(entry.permanent_failure).toBe(false)
    expect(existsSync(logPath)).toBe(true)
    const raw = readFileSync(logPath, 'utf-8').trim()
    expect(JSON.parse(raw).error).toBe('test error')
  })

  it('list 返回所有条目', () => {
    const log = new ErrorLog(logPath, { retry_interval_ms: 60000, max_retry: 3 })
    log.add('err1', makeTask())
    log.add('err2', makeTask())
    expect(log.list()).toHaveLength(2)
  })

  it('remove 删除指定条目并重写文件', () => {
    const log = new ErrorLog(logPath, { retry_interval_ms: 60000, max_retry: 3 })
    const e1 = log.add('err1', makeTask())
    log.add('err2', makeTask())
    log.remove(e1.id)
    expect(log.list()).toHaveLength(1)
    expect(log.list()[0].error).toBe('err2')
  })

  it('retryPending 成功时删除条目', async () => {
    const log = new ErrorLog(logPath, { retry_interval_ms: 60000, max_retry: 3 })
    log.setRetryHandler(async () => true)
    log.add('retryable', makeTask())
    await log.retryPending()
    expect(log.list()).toHaveLength(0)
  })

  it('retryPending 失败时递增 retry_count', async () => {
    const log = new ErrorLog(logPath, { retry_interval_ms: 60000, max_retry: 3 })
    log.setRetryHandler(async () => false)
    log.add('will-fail', makeTask())
    await log.retryPending()
    const entries = log.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].retry_count).toBe(1)
    expect(entries[0].permanent_failure).toBe(false)
    expect(entries[0].last_retry_at).not.toBeNull()
  })

  it('retry_count 达到 max_retry 时标记 permanent_failure', async () => {
    const log = new ErrorLog(logPath, { retry_interval_ms: 60000, max_retry: 2 })
    log.setRetryHandler(async () => false)
    log.add('permanent', makeTask())
    await log.retryPending() // retry_count → 1
    await log.retryPending() // retry_count → 2 → permanent
    const entries = log.list()
    expect(entries[0].retry_count).toBe(2)
    expect(entries[0].permanent_failure).toBe(true)
  })

  it('permanent_failure 条目不再重试', async () => {
    const log = new ErrorLog(logPath, { retry_interval_ms: 60000, max_retry: 1 })
    const handler = vi.fn(async () => false)
    log.setRetryHandler(handler)
    log.add('once', makeTask())
    await log.retryPending() // → permanent
    handler.mockClear()
    await log.retryPending() // 应跳过 permanent 条目
    expect(handler).not.toHaveBeenCalled()
  })

  it('从已有文件加载条目', () => {
    // 第一次实例写入
    const log1 = new ErrorLog(logPath, { retry_interval_ms: 60000, max_retry: 3 })
    log1.add('persisted', makeTask())
    // 新实例读取
    const log2 = new ErrorLog(logPath, { retry_interval_ms: 60000, max_retry: 3 })
    const entries = log2.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].error).toBe('persisted')
  })

  it('文件不存在时 list 返回空数组', () => {
    const log = new ErrorLog(join(tmpDir, 'nonexistent.jsonl'), DEFAULT_ERROR_LOG_CONFIG)
    expect(log.list()).toHaveLength(0)
  })

  it('stop 清理重试定时器不报错', () => {
    const log = new ErrorLog(logPath, { retry_interval_ms: 100, max_retry: 3 })
    log.start()
    log.stop()
    // 不抛异常即通过
  })
})
