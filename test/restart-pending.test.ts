import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  writeRestartPending,
  consumeRestartPending,
  pendingRestartPath,
  recordStartup,
  recordShutdown,
  readLifecycle,
  buildLifecycleInjection,
  lifecyclePath
} from '../electron/main/api/restart-pending'

let base: string
let activationDir: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'restart-pending-test-'))
  activationDir = join(base, '.activation')
  mkdirSync(activationDir, { recursive: true })
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('restart-pending 持久化标记', () => {
  it('写入后标记文件存在且内容含 reason', () => {
    const path = writeRestartPending(activationDir, '重启验证 safety')
    expect(path).toBe(pendingRestartPath(activationDir))
    expect(existsSync(path)).toBe(true)
    const payload = JSON.parse(readFileSync(path, 'utf-8'))
    expect(payload.reason).toBe('重启验证 safety')
    expect(payload.createdAt).toBeTypeOf('number')
  })

  it('消费后返回 reason 且删除标记文件（一次性）', () => {
    writeRestartPending(activationDir, '续接任务 A')
    const reason = consumeRestartPending(activationDir)
    expect(reason).toBe('续接任务 A')
    expect(existsSync(pendingRestartPath(activationDir))).toBe(false)
    // 二次消费幂等：返回 null 不报错
    expect(consumeRestartPending(activationDir)).toBeNull()
  })

  it('无标记时消费返回 null（不报错）', () => {
    expect(consumeRestartPending(activationDir)).toBeNull()
  })

  it('标记文件损坏时消费返回 null 并清理残留', () => {
    writeFileSync(pendingRestartPath(activationDir), '{broken json')
    expect(consumeRestartPending(activationDir)).toBeNull()
    expect(existsSync(pendingRestartPath(activationDir))).toBe(false)
  })
})

describe('lifecycle 生命周期记录', () => {
  it('recordStartup 写入 startedAt/mode，保留上次关闭信息', () => {
    const path = recordStartup(activationDir, 'dev')
    expect(path).toBe(lifecyclePath(activationDir))
    expect(existsSync(path)).toBe(true)
    const payload = JSON.parse(readFileSync(path, 'utf-8'))
    expect(payload.mode).toBe('dev')
    expect(payload.startedAt).toBeTypeOf('number')
    expect(payload.lastShutdownAt).toBeUndefined()
  })

  it('recordShutdown 写入关闭时间与原因', () => {
    recordStartup(activationDir, 'dev')
    const path = recordShutdown(activationDir, 'user-quit')
    expect(path).toBe(lifecyclePath(activationDir))
    const payload = JSON.parse(readFileSync(path, 'utf-8'))
    expect(payload.lastShutdownAt).toBeTypeOf('number')
    expect(payload.lastShutdownReason).toBe('user-quit')
    // 关闭后再次启动：上次关闭信息被继承
    recordStartup(activationDir, 'dev')
    const payload2 = JSON.parse(readFileSync(path, 'utf-8'))
    expect(payload2.lastShutdownAt).toBe(payload.lastShutdownAt)
    expect(payload2.lastShutdownReason).toBe('user-quit')
  })

  it('buildLifecycleInjection 输出含启动与关闭时间', () => {
    recordStartup(activationDir, 'dev')
    recordShutdown(activationDir, 'ai-restart')
    recordStartup(activationDir, 'dev')
    const text = buildLifecycleInjection(activationDir)
    expect(text).not.toBeNull()
    expect(text).toContain('## 系统生命周期')
    expect(text).toContain('本次启动')
    expect(text).toContain('上次关闭')
    expect(text).toContain('AI 自我重启')
  })

  it('首次运行无关闭记录时注入文本标记无记录', () => {
    recordStartup(activationDir, 'packaged')
    const text = buildLifecycleInjection(activationDir)
    expect(text).not.toBeNull()
    expect(text).toContain('无记录')
  })

  it('无文件时 buildLifecycleInjection 返回 null（不报错）', () => {
    expect(buildLifecycleInjection(activationDir)).toBeNull()
    expect(readLifecycle(activationDir)).toBeNull()
  })

  it('文件损坏时 readLifecycle 返回 null（不报错）', () => {
    writeFileSync(lifecyclePath(activationDir), '{broken json')
    expect(readLifecycle(activationDir)).toBeNull()
    // 损坏时重新启动也能覆盖写入
    recordStartup(activationDir, 'dev')
    const payload = JSON.parse(readFileSync(lifecyclePath(activationDir), 'utf-8'))
    expect(payload.mode).toBe('dev')
  })
})
