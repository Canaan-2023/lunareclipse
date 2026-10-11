import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MemoryWorkflowScheduler } from '../electron/main/monitor/memory-workflow-scheduler'
import { TimerRegistry } from '../electron/main/monitor/timer-registry'
import type { BaseDataPaths } from '../electron/main/models/paths'

function makePaths(root: string): BaseDataPaths {
  return {
    root,
    skills: join(root, 'skills'),
    memory: join(root, 'memory'),
    nng: join(root, 'nng'),
    nngRoot: join(root, 'nng', 'root'),
    nngRootJson: join(root, 'nng', 'root.json'),
    cache: join(root, 'cache'),
    cacheIndex: join(root, 'cache', 'index'),
    cacheIndexJson: join(root, 'cache', 'index.json'),
    cacheInjectionRoot: join(root, 'cache', 'injection'),
    users: join(root, 'users'),
    usersJson: join(root, 'users.json'),
    aiRegistryJson: join(root, 'ai-registry.json'),
    workflowPending: join(root, 'workflows', 'pending'),
    sessions: join(root, 'sessions'),
    fileMonitor: join(root, 'file-monitor'),
    fileMonitorErrorLog: join(root, 'file-monitor', 'error.log'),
    fileMonitorCorrupted: join(root, 'file-monitor', 'corrupted'),
    fileMonitorState: join(root, 'file-monitor', 'state.json'),
    taskDetails: join(root, 'task-details'),
    workflows: join(root, 'workflows'),
    workflowTemplates: join(root, 'workflows', 'templates'),
    workflowInstances: join(root, 'workflows', 'instances'),
    frontend: join(root, 'frontend'),
    plugins: join(root, 'plugins'),
    cron: join(root, 'cron'),
    sandboxEnv: join(root, 'sandbox-env.json'),
    sandboxRuntimes: join(root, 'sandbox-runtimes'),
    abyss: join(root, 'ABYSS')
  }
}

describe('MemoryWorkflowScheduler start/stop 生命周期与状态迁移', () => {
  let root: string
  let registry: TimerRegistry
  let scheduler: MemoryWorkflowScheduler

  beforeEach(() => {
    vi.useFakeTimers()
    root = mkdtempSync(join(tmpdir(), 'mws-lc-'))
    registry = new TimerRegistry()
    scheduler = new MemoryWorkflowScheduler(makePaths(root), {}, registry)
  })

  afterEach(() => {
    scheduler.stop()
    void registry.stopAll()
    vi.useRealTimers()
    rmSync(root, { recursive: true, force: true })
  })

  it('start → 注册检查定时器（100ms 首轮），isEnabled=true', () => {
    expect(registry.size()).toBe(0)
    scheduler.start()
    expect(registry.size()).toBe(1)
    expect(scheduler.isEnabled()).toBe(true)
  })

  it('start 幂等：重复 start 不叠加定时器', () => {
    scheduler.start()
    scheduler.start()
    scheduler.start()
    expect(registry.size()).toBe(1)
  })

  it('stop → shouldStop 置位（isEnabled=false）并清理定时器', () => {
    scheduler.start()
    expect(registry.size()).toBe(1)
    scheduler.stop()
    expect(scheduler.isEnabled()).toBe(false)
    expect(registry.size()).toBe(0)
    // 停止后即使时间推进也不再触发检查/重排
    vi.advanceTimersByTime(10_000)
    expect(registry.size()).toBe(0)
  })

  it('stop 后再 start → 恢复调度（shouldStop 复位）', () => {
    scheduler.start()
    scheduler.stop()
    expect(scheduler.isEnabled()).toBe(false)
    scheduler.start()
    expect(scheduler.isEnabled()).toBe(true)
    expect(registry.size()).toBe(1)
  })

  it('enabled=false 时 start 不注册定时器，isEnabled=false', () => {
    scheduler.updateConfig({ enabled: false })
    scheduler.start()
    expect(registry.size()).toBe(0)
    expect(scheduler.isEnabled()).toBe(false)
  })

  it('isRunning 初始为 false（未进入流水线）', () => {
    expect(scheduler.isRunning()).toBe(false)
  })
})

describe('MemoryWorkflowScheduler 运行条件不满足时重排', () => {
  let root: string
  let registry: TimerRegistry
  let scheduler: MemoryWorkflowScheduler

  beforeEach(() => {
    vi.useFakeTimers()
    root = mkdtempSync(join(tmpdir(), 'mws-wait-'))
    registry = new TimerRegistry()
    scheduler = new MemoryWorkflowScheduler(makePaths(root), {}, registry)
  })

  afterEach(() => {
    scheduler.stop()
    void registry.stopAll()
    vi.useRealTimers()
    rmSync(root, { recursive: true, force: true })
  })

  it('首轮触发时工作流管理器未就绪 → onConditionWait 回调 + 按周期重排', () => {
    const reasons: string[] = []
    scheduler = new MemoryWorkflowScheduler(
      makePaths(root),
      { onConditionWait: (reason) => reasons.push(reason) },
      registry
    )
    scheduler.start()
    expect(registry.size()).toBe(1)
    // 推进首轮 100ms：checkAndProcess → workflowManagerProvider 未注入 → 等待原因回调
    vi.advanceTimersByTime(100)
    expect(reasons).toContain('workflow_manager_not_ready')
    // 已按默认周期 60s 重排（定时器仍在，1 个）
    expect(registry.size()).toBe(1)
    vi.advanceTimersByTime(60_000)
    expect(reasons.filter((r) => r === 'workflow_manager_not_ready').length).toBeGreaterThanOrEqual(2)
  })

  it('frontendIdle=false（前端 AI 忙碌）→ 让路重排，不触发处理', () => {
    const reasons: string[] = []
    scheduler = new MemoryWorkflowScheduler(
      makePaths(root),
      { onConditionWait: (reason) => reasons.push(reason) },
      registry
    )
    scheduler.setFrontendIdleProvider(() => false)
    scheduler.start()
    vi.advanceTimersByTime(100)
    // 条件不满足 → 让路回调 + 周期重排，定时器保持
    expect(reasons).toContain('frontend_ai_busy')
    expect(registry.size()).toBe(1)
    expect(scheduler.isEnabled()).toBe(true)
  })
})