import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { BaseDataPaths } from '../electron/main/models/paths'
import type { LLMClient } from '../electron/main/api/llm'
import type { ToolContext } from '../electron/main/tools/base-tool'
import type { ErrorLog } from '../electron/main/monitor/error-log'
import type { UserStore } from '../electron/main/models/user-store'
import type { SupervisorCallbacks } from '../electron/main/monitor/supervisor'
import type { MonitorConfig } from '@shared/types'

// 测试替身容器：mock 工厂把每个 new 出来的实例记录到 h.instances[name]
const h = vi.hoisted(() => {
  const instances: Record<string, unknown[]> = {}
  return {
    instances,
    record(name: string, inst: unknown) {
      ;(instances[name] ??= []).push(inst)
    }
  }
})

vi.mock('../electron/main/monitor/dmn-runner', () => ({
  DmnRunner: class {
    isRunning = vi.fn(() => false)
    getLastActivityAt = vi.fn(() => null)
    injectSystemMessage = vi.fn(() => false)
    kill = vi.fn()
    switchModel = vi.fn()
    getCurrentModel = vi.fn(() => undefined)
    getActiveMessages = vi.fn(() => undefined)
    run = vi.fn()
    constructor(..._args: unknown[]) {
      h.record('runner', this)
    }
  }
}))

vi.mock('../electron/main/monitor/mutex', () => ({
  DmnMutex: class {
    isHeartbeatLocked = vi.fn(() => false)
    constructor(..._args: unknown[]) {
      h.record('mutex', this)
    }
  }
}))

vi.mock('../electron/main/monitor/state-store', () => ({
  StateStore: class {
    loadAllFreezes = vi.fn(() => [])
    constructor(..._args: unknown[]) {
      h.record('stateStore', this)
    }
  }
}))

vi.mock('../electron/main/monitor/freeze-manager', () => ({
  FreezeManagerImpl: class {
    unfreeze = vi.fn()
    isFrozen = vi.fn(() => false)
    restoreFrozen = vi.fn()
    getFrozenAt = vi.fn(() => null)
    setCallbacks = vi.fn()
    constructor(..._args: unknown[]) {
      h.record('freezeManager', this)
    }
  }
}))

vi.mock('../electron/main/monitor/memory-workflow-scheduler', () => ({
  MemoryWorkflowScheduler: class {
    start = vi.fn()
    stop = vi.fn()
    updateConfig = vi.fn()
    isEnabled = vi.fn(() => false)
    isRunning = vi.fn(() => false)
    setFrontendIdleProvider = vi.fn()
    setDmnStatusProvider = vi.fn()
    setDiaryPendingProvider = vi.fn()
    setWorkflowManagerProvider = vi.fn()
    setScopeSetter = vi.fn()
    constructor(..._args: unknown[]) {
      h.record('memoryWorkflow', this)
    }
  }
}))

vi.mock('../electron/main/monitor/diary-workflow-scheduler', () => ({
  DiaryWorkflowScheduler: class {
    start = vi.fn()
    stop = vi.fn()
    updateConfig = vi.fn()
    isEnabled = vi.fn(() => false)
    isRunning = vi.fn(() => false)
    hasPendingWork = vi.fn(() => false)
    setMemoryRunningProvider = vi.fn()
    setWorkflowManagerProvider = vi.fn()
    setScopeSetter = vi.fn()
    constructor(..._args: unknown[]) {
      h.record('diaryWorkflow', this)
    }
  }
}))

vi.mock('../electron/main/monitor/watchdog', () => ({
  Watchdog: class {
    start = vi.fn()
    stop = vi.fn()
    updateConfig = vi.fn()
    markIdle = vi.fn()
    markRunning = vi.fn()
    markFrozen = vi.fn()
    getStatus = vi.fn(() => 'idle')
    getRetryCount = vi.fn(() => 0)
    constructor(..._args: unknown[]) {
      h.record('watchdog', this)
    }
  }
}))

vi.mock('../electron/main/monitor/tool-call-logger', () => ({
  ToolCallLogger: class {
    log = vi.fn()
    reset = vi.fn()
    clearAll = vi.fn()
    constructor() {
      h.record('logger', this)
    }
  }
}))

vi.mock('../electron/main/monitor/sub-agent-launcher', () => ({
  SubAgentLauncher: class {
    launch = vi.fn()
    constructor(..._args: unknown[]) {
      h.record('subAgentLauncher', this)
    }
  }
}))

vi.mock('../electron/main/monitor/monitor-config', async () => {
  const actual = await vi.importActual<typeof import('../electron/main/monitor/monitor-config')>(
    '../electron/main/monitor/monitor-config'
  )
  return {
    ...actual,
    loadMonitorConfig: vi.fn(() => structuredClone(actual.DEFAULT_MONITOR_CONFIG)),
    saveMonitorConfig: vi.fn()
  }
})

// --- 受测模块（在所有 vi.mock 之后 import） ---
import { Supervisor } from '../electron/main/monitor/supervisor'
import * as monitorConfigModule from '../electron/main/monitor/monitor-config'

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

/** 受测模块 mock 出的子组件实例形状：每个成员都是 vi.fn() */
type MockedModule = Record<string, ReturnType<typeof vi.fn>>

/**
 * 取出最近一次构造的 mock 实例。
 * 泛型 T 描述该实例对外断言需要暴露的成员类型（默认空对象，
 * 需要访问成员时显式传入如 `{ start: mock }` 之类的形状）。
 */
function latest<T = Record<string, unknown>>(name: string): T {
  const arr = h.instances[name]
  if (!arr || arr.length === 0) throw new Error(`no mocked instance recorded for "${name}"`)
  return arr[arr.length - 1] as T
}

let root: string
let supervisor: Supervisor

function buildSupervisor(callbacks: Partial<SupervisorCallbacks> = {}): Supervisor {
  const userStore = { getCurrentUser: () => null } as unknown as UserStore
  const llm = {} as unknown as LLMClient
  const ctx = {} as unknown as ToolContext
  const errorLog = {} as unknown as ErrorLog
  return new Supervisor(
    makePaths(root),
    llm,
    [],
    ctx,
    join(root, 'config'),
    errorLog,
    userStore,
    callbacks,
    undefined
  )
}

function clear(): void {
  for (const key of Object.keys(h.instances)) h.instances[key].length = 0
  vi.clearAllMocks()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sup-lc-'))
  mkdirSync(join(root, 'sessions'))
  clear()
  supervisor = buildSupervisor()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('Supervisor start/stop 生命周期', () => {
  it('构造 → 实例化全部子组件并从 configDir 加载配置', () => {
    expect(latest('runner')).toBeDefined()
    expect(latest('mutex')).toBeDefined()
    expect(latest('stateStore')).toBeDefined()
    expect(latest('freezeManager')).toBeDefined()
    expect(latest('memoryWorkflow')).toBeDefined()
    expect(latest('diaryWorkflow')).toBeDefined()
    expect(latest('watchdog')).toBeDefined()
    expect(latest('logger')).toBeDefined()
    expect(latest('subAgentLauncher')).toBeDefined()
    expect(monitorConfigModule.loadMonitorConfig).toHaveBeenCalledWith(join(root, 'config'))
  })

  it('start() → 委托 watchdog + memoryWorkflow + diaryWorkflow 各 start 一次', () => {
    supervisor.start()
    expect(latest<MockedModule>('watchdog').start).toHaveBeenCalledTimes(1)
    expect(latest<MockedModule>('memoryWorkflow').start).toHaveBeenCalledTimes(1)
    expect(latest<MockedModule>('diaryWorkflow').start).toHaveBeenCalledTimes(1)
  })

  it('start() 幂等：重复 start 不重复委托', () => {
    supervisor.start()
    supervisor.start()
    supervisor.start()
    expect(latest<MockedModule>('watchdog').start).toHaveBeenCalledTimes(1)
    expect(latest<MockedModule>('memoryWorkflow').start).toHaveBeenCalledTimes(1)
    expect(latest<MockedModule>('diaryWorkflow').start).toHaveBeenCalledTimes(1)
  })

  it('stop() → 委托三子组件 stop + logger.clearAll', () => {
    supervisor.start()
    supervisor.stop()
    expect(latest<MockedModule>('memoryWorkflow').stop).toHaveBeenCalledTimes(1)
    expect(latest<MockedModule>('diaryWorkflow').stop).toHaveBeenCalledTimes(1)
    expect(latest<MockedModule>('watchdog').stop).toHaveBeenCalledTimes(1)
    expect(latest<MockedModule>('logger').clearAll).toHaveBeenCalledTimes(1)
  })

  it('stop() 幂等：未 start 或重复 stop 不重复执行', () => {
    supervisor.stop()
    supervisor.stop()
    expect(latest<MockedModule>('watchdog').stop).not.toHaveBeenCalled()
  })

  it('stop 后再 start → 再次委托子组件（生命周期可恢复）', () => {
    supervisor.start()
    supervisor.stop()
    supervisor.start()
    expect(latest<MockedModule>('watchdog').start).toHaveBeenCalledTimes(2)
    expect(latest<MockedModule>('memoryWorkflow').start).toHaveBeenCalledTimes(2)
    expect(latest<MockedModule>('diaryWorkflow').start).toHaveBeenCalledTimes(2)
  })
})

describe('Supervisor 工作流开关与配置下发', () => {
  it('updateMemoryWorkflowEnabled(false) → memoryWorkflow.stop + 配置持久化', () => {
    supervisor.updateMemoryWorkflowEnabled(false)
    expect(latest<MockedModule>('memoryWorkflow').stop).toHaveBeenCalledTimes(1)
    expect(monitorConfigModule.saveMonitorConfig).toHaveBeenCalled()
    expect(supervisor.isMemoryWorkflowEnabled()).toBe(false)
  })

  it('updateMemoryWorkflowEnabled(true) → memoryWorkflow.start', () => {
    supervisor.updateMemoryWorkflowEnabled(true)
    expect(latest<MockedModule>('memoryWorkflow').start).toHaveBeenCalledTimes(1)
  })

  it('updateDiaryWorkflowEnabled(false) → diaryWorkflow.stop；true → diaryWorkflow.start', () => {
    supervisor.updateDiaryWorkflowEnabled(false)
    expect(latest<MockedModule>('diaryWorkflow').stop).toHaveBeenCalledTimes(1)
    supervisor.updateDiaryWorkflowEnabled(true)
    expect(latest<MockedModule>('diaryWorkflow').start).toHaveBeenCalledTimes(1)
  })

  it('updateConfig 用 mergeConfig 深合并：仅改 memoryWorkflow.enabled 不丢 batch_size（回归保护）', () => {
    supervisor.updateConfig({ memoryWorkflow: { enabled: false } })
    // watchdog 收到的是深合并后的完整 config
    const received = latest<MockedModule>('watchdog').updateConfig
    expect(received).toHaveBeenCalledTimes(1)
    const cfg = received.mock.calls[0][0] as MonitorConfig
    expect(cfg.memoryWorkflow.enabled).toBe(false)
    expect(cfg.memoryWorkflow.batch_size).toBeGreaterThan(0)
    expect(cfg.memoryWorkflow.check_interval_seconds).toBeGreaterThan(0)
    expect(monitorConfigModule.saveMonitorConfig).toHaveBeenCalled()
  })

  it('updateConfig 深合并：sessionSummary 子对象字段不丢', () => {
    supervisor.updateConfig({ sessionSummary: { summaryBudgetChars: 5000 } })
    const received = latest<MockedModule>('watchdog').updateConfig
    const cfg = received.mock.calls[0][0] as MonitorConfig
    expect(cfg.sessionSummary.summaryBudgetChars).toBe(5000)
    expect(cfg.sessionSummary.enabled).toBeDefined()
    expect(cfg.sessionSummary.summaryMaxChars).toBeDefined()
  })

  it('setWorkflowManagerProvider / setMemoryWorkflowScopeSetter 双路转发', () => {
    const provider = () => null
    const setter = () => {}
    supervisor.setWorkflowManagerProvider(provider)
    supervisor.setMemoryWorkflowScopeSetter(setter)
    const mw = latest<MockedModule>('memoryWorkflow')
    const dw = latest<MockedModule>('diaryWorkflow')
    expect(mw.setWorkflowManagerProvider).toHaveBeenCalledWith(provider)
    expect(dw.setWorkflowManagerProvider).toHaveBeenCalledWith(provider)
    expect(mw.setScopeSetter).toHaveBeenCalledWith(setter)
    expect(dw.setScopeSetter).toHaveBeenCalledWith(setter)
  })
})

describe('Supervisor DMN 状态迁移', () => {
  it('handleDmnStart → watchdog.markRunning + 当前任务 ID 落位 + onDmnStart 回调', () => {
    const onDmnStart = vi.fn()
    supervisor = buildSupervisor({ onDmnStart })
    supervisor.handleDmnStart('memory-workflow')
    expect(latest<MockedModule>('watchdog').markRunning).toHaveBeenCalledWith('memory-workflow')
    expect(onDmnStart).toHaveBeenCalledWith('memory-workflow')
    const status = supervisor.getStatus('memory-workflow')
    expect(status.currentTaskId).toContain('memory-workflow_')
  })

  it('handleDmnComplete → watchdog.markIdle + taskLog 追加 + 当前任务 ID 清除 + 回调', () => {
    const onDmnComplete = vi.fn()
    supervisor = buildSupervisor({ onDmnComplete })
    supervisor.handleDmnStart('memory-workflow')
    supervisor.handleDmnComplete('memory-workflow')
    expect(latest<MockedModule>('watchdog').markIdle).toHaveBeenCalledWith('memory-workflow')
    expect(supervisor.getStatus('memory-workflow').currentTaskId).toBeNull()
    expect(supervisor.getTaskLog().length).toBe(1)
    expect(supervisor.getTaskLog()[0].dmnId).toBe('memory-workflow')
    expect(onDmnComplete).toHaveBeenCalledWith('memory-workflow')
  })

  it('taskLog 受 task_log_max_entries 上限裁剪（保留最近条目）', () => {
    const s = supervisor as unknown as { config: MonitorConfig }
    s.config.task_log_max_entries = 2
    supervisor.handleDmnComplete('a')
    supervisor.handleDmnComplete('b')
    supervisor.handleDmnComplete('c')
    const log = supervisor.getTaskLog()
    expect(log.length).toBe(2)
    expect(log.map((l) => l.dmnId)).toEqual(['b', 'c'])
  })

  it('handleDmnFrozen → watchdog.markFrozen；unfrozen 且 runner 空闲 → markIdle', () => {
    supervisor.handleDmnFrozen('memory-workflow')
    expect(latest<MockedModule>('watchdog').markFrozen).toHaveBeenCalledWith('memory-workflow')
    supervisor.handleDmnUnfrozen('memory-workflow')
    // runner.isRunning 默认 false → markIdle
    expect(latest<MockedModule>('watchdog').markIdle).toHaveBeenCalledWith('memory-workflow')
  })

  it('handleDmnUnfrozen 且 runner 运行中 → markRunning', () => {
    const runner = latest<MockedModule>('runner')
    runner.isRunning.mockReturnValue(true)
    supervisor.handleDmnUnfrozen('memory-workflow')
    expect(latest<MockedModule>('watchdog').markRunning).toHaveBeenCalledWith('memory-workflow')
  })

  it('getStatus 聚合 watchdog/mutex/runner/taskLog/freeze 信息', () => {
    const watchdog = latest<MockedModule>('watchdog')
    watchdog.getStatus.mockReturnValue('running')
    watchdog.getRetryCount.mockReturnValue(3)
    const runner = latest<MockedModule>('runner')
    runner.getLastActivityAt.mockReturnValue(12345)
    const mutex = latest<MockedModule>('mutex')
    mutex.isHeartbeatLocked.mockReturnValue(true)
    supervisor.handleDmnComplete('memory-workflow')

    const status = supervisor.getStatus('memory-workflow')
    expect(status.status).toBe('running')
    expect(status.retryCount).toBe(3)
    expect(status.lastActivityAt).toBe(12345)
    expect(status.isHeartbeatLocked).toBe(true)
    expect(status.startedAt).toBe(12345)
    expect(status.lastCompleteAt).toBeGreaterThan(0)
  })

  it('answerDmnQuestion / isDmnFrozen 委托 freezeManager', () => {
    supervisor.answerDmnQuestion('memory-workflow', 'yes')
    expect(latest<MockedModule>('freezeManager').unfreeze).toHaveBeenCalledWith('memory-workflow', 'yes')
    supervisor.isDmnFrozen('memory-workflow')
    expect(latest<MockedModule>('freezeManager').isFrozen).toHaveBeenCalledWith('memory-workflow')
  })

  it('setFrontendIdle / setActiveSessionId / setTokenBudgetProvider 状态位', () => {
    supervisor.setFrontendIdle(false)
    expect(supervisor.isFrontendIdle()).toBe(false)
    supervisor.setActiveSessionId('sess-1')
    expect(supervisor.activeSessionId).toBe('sess-1')
    supervisor.setTokenBudgetProvider(() => 42)
    expect((supervisor as unknown as { tokenBudgetProvider: () => number }).tokenBudgetProvider()).toBe(42)
  })
})

describe('Supervisor restoreFrozenStates', () => {
  it('扫描 sessions 下冻结记录并恢复 + 触发 onAskUser 回调', async () => {
    const onAskUser = vi.fn()
    supervisor = buildSupervisor({ onAskUser })
    const freezeRecord = {
      冻结DMN: 'memory-workflow',
      冻结问题: '需要确认',
      冻结原因: '等待用户输入',
      createdAt: '2026-01-01T00:00:00Z'
    }
    const stateStore = latest<MockedModule>('stateStore')
    stateStore.loadAllFreezes.mockReturnValue([freezeRecord])
    mkdirSync(join(root, 'sessions', 'session-1'), { recursive: true })

    supervisor.start()
    await vi.waitFor(() => {
      expect(latest<MockedModule>('freezeManager').restoreFrozen).toHaveBeenCalledWith(
        'memory-workflow',
        freezeRecord
      )
    })
    expect(latest<MockedModule>('watchdog').markFrozen).toHaveBeenCalledWith('memory-workflow')
    expect(onAskUser).toHaveBeenCalledWith('memory-workflow', '需要确认', '等待用户输入', 'session-1')
  })

  it('runner 运行中的 DMN 跳过恢复', async () => {
    const runner = latest<MockedModule>('runner')
    runner.isRunning.mockReturnValue(true)
    const stateStore = latest<MockedModule>('stateStore')
    stateStore.loadAllFreezes.mockReturnValue([{ 冻结DMN: 'memory-workflow' }])
    mkdirSync(join(root, 'sessions', 'session-1'), { recursive: true })

    supervisor.start()
    await new Promise((r) => setTimeout(r, 20))
    expect(latest<MockedModule>('freezeManager').restoreFrozen).not.toHaveBeenCalled()
  })

  it('sessions 目录不存在或扫描异常时不抛错', async () => {
    rmSync(join(root, 'sessions'), { recursive: true, force: true })
    supervisor.start()
    await new Promise((r) => setTimeout(r, 20))
    expect(latest<MockedModule>('freezeManager').restoreFrozen).not.toHaveBeenCalled()
  })
})