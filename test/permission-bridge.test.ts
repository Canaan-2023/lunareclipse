/**
 * 权限桥接（ipc/permission-bridge.ts）契约测试
 *
 * 为什么存在：本模块是从 index.ts 的 baseCtx 字面量里抽出的两段 IPC 往返实现
 *   （工具授权弹窗 / AI 自我重启授权）。抽取前它们是 index.ts 内联闭包，无任何测试覆盖；
 *   而 index.ts 是 0.21 判定「无测试网故停止深拆」的三大巨型之一——本文件是该文件
 *   第一块真正意义上的测试网，也是「把非装配职责移出装配点」的直接收益。
 * 作用：以假 IPC 总线注入依赖，断言对外可观测的契约：绿通直通 / 用户允许 / 用户拒绝 /
 *   超时自动拒绝，以及 AI 重启路径的标记、落盘与失败复位副作用。
 * 不删理由：这些断言守着 fail-closed 语义——删掉即等于「超时不再自动拒绝」「用户拒绝
 *   不再被尊重」「重启失败后绿通标记不复位」这三类回归无人发现。
 *
 * 0.30 增补（权限链路安全加固，详见 ipc/permission-bridge.ts 文件头「安全约束」）：
 *   新增「非主 frame 应答被忽略」「窗口不可用立即 fail-closed」「落定后无残留定时器」
 *   三组断言；其中「非主 frame」与「无窗口」两组是安全断言——前者守「子 frame 不得
 *   冒充用户授权」，后者守「失败语义不再被超时文案掩盖」。不删理由：删掉即等于
 *   Electron 官方 security 指南第 17 条（校验 IPC 发送方）在本项目无人守门。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createPermissionBridge,
  type PermissionIpcBus,
  type PermissionIpcListener,
  type PermissionRespondPayload
} from '../electron/main/ipc/permission-bridge'

/** 弹窗通道（主进程 → 渲染进程），与模块内常量同值 */
const REQUEST_CHANNEL = 'permission:request'
/** 应答通道（渲染进程 → 主进程） */
const RESPOND_CHANNEL = 'permission:respond'

/**
 * 假 IPC 总线：记录监听器、支持手动投递应答、可探测监听器是否已被摘除。
 * 为什么存在：真实 ipcMain 需要 electron 运行时，而本模块的价值正是「可脱离 electron 被验证」。
 */
class FakeIpcBus implements PermissionIpcBus {
  private listeners = new Map<string, Set<PermissionIpcListener>>()

  on(channel: string, listener: PermissionIpcListener): void {
    const set = this.listeners.get(channel) ?? new Set<PermissionIpcListener>()
    set.add(listener)
    this.listeners.set(channel, set)
  }

  removeListener(channel: string, listener: PermissionIpcListener): void {
    this.listeners.get(channel)?.delete(listener)
  }

  /**
   * 模拟渲染进程回传一次应答。
   * event 默认 `{}`（无 senderFrame）——桥接在无法判定来源时按主 frame 放行，
   * 故既有用例无需关心 frame 层级；传 senderFrame 可专门验证子 frame 伪造场景。
   */
  emit(channel: string, payload: PermissionRespondPayload, event: unknown = {}): void {
    for (const listener of [...(this.listeners.get(channel) ?? [])]) listener(event, payload)
  }

  /** 当前挂在通道上的监听器数量（用于断言「应答后已摘除」，防止监听器泄漏） */
  count(channel: string): number {
    return this.listeners.get(channel)?.size ?? 0
  }
}

/** 构造被测桥接及其可观测的副作用记录 */
function setup(opts: { greenlight?: boolean; windowExists?: boolean; writePendingThrows?: boolean } = {}) {
  const bus = new FakeIpcBus()
  const sent: Array<{ channel: string; payload: unknown }> = []
  // 0.30 起桥接只接受单一 getChannel：把「发弹窗」与「收应答」绑定在同一 webContents 上
  // （窗口不在时两者同时不可用 → 立即 fail-closed，不再白等超时）
  const channel = {
    send: (ch: string, payload: unknown): void => {
      sent.push({ channel: ch, payload })
    },
    ipc: bus
  }
  const restartCalls: string[] = []
  const restartResult: { ok: boolean; error?: string } = { ok: true }
  const pendingWrites: string[] = []
  const aiRestartingFlags: boolean[] = []

  const bridge = createPermissionBridge({
    getChannel: () => (opts.windowExists === false ? null : channel),
    isGreenlight: () => opts.greenlight === true,
    setAiRestarting: (restarting) => {
      aiRestartingFlags.push(restarting)
    },
    writePending: (text) => {
      if (opts.writePendingThrows) throw new Error('落盘失败')
      pendingWrites.push(text)
    },
    restartApp: (reason) => {
      restartCalls.push(reason)
      return { ok: restartResult.ok, error: restartResult.error }
    }
  })

  return { bridge, bus, sent, restartCalls, restartResult, pendingWrites, aiRestartingFlags }
}

/** 一条标准的工具授权请求 */
const toolReq = {
  type: 'command' as const,
  description: '执行命令: node --version',
  content: 'node --version',
  risk: 'medium' as const
}

/** 取第一次弹窗载荷里的请求 id */
function firstId(sent: Array<{ channel: string; payload: unknown }>): string {
  const payload = sent[0].payload as { id: string }
  return payload.id
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('requestPermission（工具授权）', () => {
  it('绿通开启时直接放行：不弹窗、不挂监听', async () => {
    const { bridge, bus, sent } = setup({ greenlight: true })

    const resp = await bridge.requestPermission(toolReq)

    expect(resp).toEqual({ allowed: true, scope: 'session', reason: '权限绿通模式开启，自动放行' })
    expect(sent).toHaveLength(0)
    expect(bus.count(RESPOND_CHANNEL)).toBe(0)
  })

  it('非绿通时弹出授权请求，用户允许后放行并摘除监听', async () => {
    const { bridge, bus, sent } = setup()

    const promise = bridge.requestPermission(toolReq)

    expect(sent).toHaveLength(1)
    expect(sent[0].channel).toBe(REQUEST_CHANNEL)
    const payload = sent[0].payload as Record<string, unknown>
    expect(payload.id).toMatch(/^perm_/)
    expect(payload.type).toBe('command')
    expect(payload.description).toBe('执行命令: node --version')
    expect(payload.content).toBe('node --version')
    expect(payload.risk).toBe('medium')
    expect(bus.count(RESPOND_CHANNEL)).toBe(1)

    bus.emit(RESPOND_CHANNEL, { id: firstId(sent), allowed: true, scope: 'once', reason: '同意' })

    await expect(promise).resolves.toEqual({ allowed: true, scope: 'once', reason: '同意' })
    // 应答后必须摘除监听：否则每次授权都会在 ipcMain 上累积一个永不释放的监听器
    expect(bus.count(RESPOND_CHANNEL)).toBe(0)
  })

  it('用户拒绝时返回 allowed=false 并透传原因', async () => {
    const { bridge, bus, sent } = setup()

    const promise = bridge.requestPermission(toolReq)
    bus.emit(RESPOND_CHANNEL, { id: firstId(sent), allowed: false, reason: '用户拒绝执行该命令' })

    await expect(promise).resolves.toEqual({
      allowed: false,
      scope: undefined,
      reason: '用户拒绝执行该命令'
    })
  })

  it('id 不匹配的应答被忽略，正确应答仍能落定', async () => {
    const { bridge, bus, sent } = setup()

    const promise = bridge.requestPermission(toolReq)
    bus.emit(RESPOND_CHANNEL, { id: 'perm_伪造的id', allowed: true })

    // 未落定：同一通道上可能并发挂着多个授权请求，必须按 id 严格过滤
    await expect(Promise.race([promise, Promise.resolve('pending')])).resolves.toBe('pending')

    bus.emit(RESPOND_CHANNEL, { id: firstId(sent), allowed: true, scope: 'session' })
    await expect(promise).resolves.toEqual({ allowed: true, scope: 'session', reason: undefined })
    expect(bus.count(RESPOND_CHANNEL)).toBe(0)
  })

  it('超时自动拒绝（fail-closed），并清掉超时定时器', async () => {
    vi.useFakeTimers()
    const { bridge, bus, sent } = setup()

    const promise = bridge.requestPermission({ ...toolReq, timeoutMs: 5000 })
    expect(sent).toHaveLength(1)

    vi.advanceTimersByTime(5000)

    await expect(promise).resolves.toEqual({ allowed: false, reason: '授权超时（5000ms）自动拒绝' })
    expect(bus.count(RESPOND_CHANNEL)).toBe(0)
  })

  it('主窗口不存在时立即 fail-closed：不弹窗、不挂监听、不等超时（0.30 行为变更）', async () => {
    vi.useFakeTimers()
    const { bridge, bus, sent } = setup({ windowExists: false })

    const resp = await bridge.requestPermission(toolReq)

    // 旧行为是「静默跳过弹窗 + 白等 30s 再报授权超时」，会把「窗口不可用」误导成
    // 「用户没搭理」；0.30 改为立刻拒绝并给出独立 reason
    expect(resp).toEqual({
      allowed: false,
      reason: '授权失败：主窗口不可用（未创建或已销毁），已自动拒绝'
    })
    expect(sent).toHaveLength(0)
    expect(bus.count(RESPOND_CHANNEL)).toBe(0)
    // 没有残留定时器：否则每次无窗口授权都会留下一个 30s 后才回收的 timer
    expect(vi.getTimerCount()).toBe(0)
  })

  it('来自非主 frame（senderFrame.parent 非空）的应答被忽略，主 frame 应答仍有效', async () => {
    vi.useFakeTimers()
    const { bridge, bus, sent } = setup()

    const promise = bridge.requestPermission(toolReq)
    // 子 frame 冒充用户点「允许」——必须忽略（Electron 官方 security 指南第 17 条）
    bus.emit(
      RESPOND_CHANNEL,
      { id: firstId(sent), allowed: true },
      { senderFrame: { parent: { url: 'https://evil.example' } } }
    )

    await expect(Promise.race([promise, Promise.resolve('pending')])).resolves.toBe('pending')
    // 刻意不落定：用户的真实应答仍应有机会到达，监听器不应被摘掉
    expect(bus.count(RESPOND_CHANNEL)).toBe(1)

    bus.emit(RESPOND_CHANNEL, { id: firstId(sent), allowed: true, scope: 'session' })
    await expect(promise).resolves.toEqual({ allowed: true, scope: 'session', reason: undefined })
    expect(bus.count(RESPOND_CHANNEL)).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('应答落定后摘除监听且不留超时定时器（清理对称性）', async () => {
    vi.useFakeTimers()
    const { bridge, bus, sent } = setup()

    const promise = bridge.requestPermission(toolReq)
    expect(vi.getTimerCount()).toBe(1)

    bus.emit(RESPOND_CHANNEL, { id: firstId(sent), allowed: false, reason: '拒绝' })
    await promise

    // 旧实现里工具授权路径 clearTimeout 了、AI 重启路径没有；统一 helper 后两条路径对称
    expect(vi.getTimerCount()).toBe(0)
    expect(bus.count(RESPOND_CHANNEL)).toBe(0)
  })
})

describe('requestAppRestart（AI 自我重启授权）', () => {
  it('绿通开启时直接重启：标记 AI 重启中 + 落盘待办 + 执行重启，且不弹窗', async () => {
    const { bridge, sent, restartCalls, pendingWrites, aiRestartingFlags } = setup({
      greenlight: true
    })

    const result = await bridge.requestAppRestart('测试原因')

    expect(result).toEqual({ ok: true, data: { restarted: true, reason: '测试原因' } })
    expect(aiRestartingFlags).toEqual([true])
    expect(pendingWrites).toEqual(['重启完成，待续接：测试原因'])
    expect(restartCalls).toEqual(['测试原因'])
    expect(sent).toHaveLength(0)
  })

  it('非绿通时请求用户授权，用户允许后重启', async () => {
    const { bridge, bus, sent, restartCalls, aiRestartingFlags } = setup()

    const promise = bridge.requestAppRestart('原因A')

    expect(sent).toHaveLength(1)
    expect(sent[0].channel).toBe(REQUEST_CHANNEL)
    const payload = sent[0].payload as Record<string, unknown>
    expect(payload.id).toMatch(/^restart_/)
    expect(payload.type).toBe('command')
    expect(payload.risk).toBe('medium')
    expect(payload.description).toBe('AI 请求重启应用: 原因A')
    expect(payload.content).toBe('原因A')

    bus.emit(RESPOND_CHANNEL, { id: firstId(sent), allowed: true })

    await expect(promise).resolves.toEqual({ ok: true, data: { restarted: true, reason: '原因A' } })
    expect(restartCalls).toEqual(['原因A'])
    expect(aiRestartingFlags).toEqual([true])
  })

  it('用户拒绝时不重启，且不标记 AI 重启中', async () => {
    const { bridge, bus, sent, restartCalls, pendingWrites, aiRestartingFlags } = setup()

    const promise = bridge.requestAppRestart('原因B')
    bus.emit(RESPOND_CHANNEL, { id: firstId(sent), allowed: false })

    await expect(promise).resolves.toEqual({ ok: false, error: '用户拒绝重启应用' })
    expect(restartCalls).toEqual([])
    expect(pendingWrites).toEqual([])
    expect(aiRestartingFlags).toEqual([])
    expect(bus.count(RESPOND_CHANNEL)).toBe(0)
  })

  it('授权超时自动拒绝（fail-closed）', async () => {
    vi.useFakeTimers()
    const { bridge, bus, sent } = setup()

    const promise = bridge.requestAppRestart('原因C')
    expect(sent).toHaveLength(1)

    vi.advanceTimersByTime(30000)

    await expect(promise).resolves.toEqual({
      ok: false,
      error: '重启授权超时（30000ms）自动拒绝'
    })
    expect(bus.count(RESPOND_CHANNEL)).toBe(0)
  })

  it('重启执行失败时复位 AI 重启标记（否则用户后续关闭会被误判为 AI 重启而保留绿通）', async () => {
    const { bridge, restartResult, aiRestartingFlags } = setup({ greenlight: true })
    restartResult.ok = false
    restartResult.error = 'relaunch 失败'

    const result = await bridge.requestAppRestart('原因D')

    expect(result).toEqual({ ok: false, error: 'relaunch 失败' })
    expect(aiRestartingFlags).toEqual([true, false])
  })

  it('重启待办落盘失败不阻断重启（仅记录错误）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { bridge, restartCalls } = setup({ greenlight: true, writePendingThrows: true })

    const result = await bridge.requestAppRestart('原因E')

    expect(result).toEqual({ ok: true, data: { restarted: true, reason: '原因E' } })
    expect(restartCalls).toEqual(['原因E'])
    expect(errorSpy).toHaveBeenCalledWith('[restart-pending] 写入重启待办标记失败:', expect.any(Error))
  })

  it('主窗口不存在时立即 fail-closed，且不执行重启（0.30 行为变更）', async () => {
    vi.useFakeTimers()
    const { bridge, bus, sent, restartCalls, aiRestartingFlags } = setup({ windowExists: false })

    const result = await bridge.requestAppRestart('原因F')

    expect(result).toEqual({
      ok: false,
      error: '重启授权失败：主窗口不可用（未创建或已销毁），已自动拒绝'
    })
    expect(sent).toHaveLength(0)
    expect(restartCalls).toEqual([])
    expect(aiRestartingFlags).toEqual([])
    expect(bus.count(RESPOND_CHANNEL)).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('来自非主 frame 的重启授权应答被忽略', async () => {
    vi.useFakeTimers()
    const { bridge, bus, sent, restartCalls } = setup()

    const promise = bridge.requestAppRestart('原因G')
    bus.emit(
      RESPOND_CHANNEL,
      { id: firstId(sent), allowed: true },
      { senderFrame: { parent: {} } }
    )

    await expect(Promise.race([promise, Promise.resolve('pending')])).resolves.toBe('pending')
    expect(restartCalls).toEqual([])

    bus.emit(RESPOND_CHANNEL, { id: firstId(sent), allowed: true })
    await expect(promise).resolves.toEqual({ ok: true, data: { restarted: true, reason: '原因G' } })
  })

  it('用户允许后重启，清理定时器与监听（与工具授权路径对称）', async () => {
    vi.useFakeTimers()
    const { bridge, bus, sent } = setup()

    const promise = bridge.requestAppRestart('原因H')
    expect(vi.getTimerCount()).toBe(1)

    bus.emit(RESPOND_CHANNEL, { id: firstId(sent), allowed: false })
    await promise

    expect(vi.getTimerCount()).toBe(0)
    expect(bus.count(RESPOND_CHANNEL)).toBe(0)
  })
})
