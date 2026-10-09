import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PathSyncMonitor } from '../electron/main/monitor/path-sync-monitor'
import { buildDataPaths, normalizePath } from '../electron/main/models/paths'

// ============================================================
// path-sync 真风暴判定净化（根因修复）白盒测试
// ------------------------------------------------------------
// 根因：start() 曾订阅 {root} 全树递归——system-catalog 落档、.file_monitor 配置
//   写入、skills 等一切无关目录都进入 enqueueEvents，而 handler 对它们全部静默
//   return（no-op），却仍被计入 batch 触发风暴判定 → 启动期连打两条
//   『事件风暴 68/83 条』并多跑一轮全量校准（selfWriteMarker 在风暴分支不生效，
//   写回→事件→再校准乒乓）。
// 修复（两层，均与 handler 语义同源）：
//   1. 订阅收窄（源头）：只订阅 memory / NNG / cache 三个作用域根——
//      handler 处理的四类文件（NNG/cache/memory/索引）全部落在三者内，
//      无关目录从源头不产生事件。
//   2. 入队过滤（纵深）：enqueueEvents 用 handler.isTrackedEvent() 过滤——
//      injection 目录、selfWriteMarker 自身写回、非目标类型事件不入队；
//      仍到达订阅回调的无关事件在入队前被剔除，不计入风暴判定。
// 风暴判定本身不动：>50 条真实文件事件仍合并为全量校准——不隐瞒、不负优化。
// 本套测试 mock @parcel/watcher，捕获各订阅回调手动触发事件，验证：
//   - 订阅范围 = [memory, NNG, cache] 三个目录，不含 {root} 全树
//   - 60 条无关事件（system-catalog 落档，模拟越过订阅层直灌回调）：
//     入队前被过滤，无风暴日志、不触发全量校准、eventStats 不增
//   - 60 条真实 NNG 文件事件：仍是真风暴，合并为全量校准（不掩盖）
//   - selfWriteMarker 命中（各路径独立标记）的自身写回：标记被消费、不入队、不风暴
//   - injection 目录事件：不入队
//   - memory delete（handler 无动作）不入队；NNG/cache 深层 delete 照常入队处理
// ============================================================

// @parcel/watcher 的 subscribe 捕获：{ path, cb }，测试手动触发 cb(null, events)
const mockWatcher = vi.hoisted(() => {
  const captured: Array<{
    path: string
    cb: (err: unknown, events: Array<{ path: string; type: string }>) => void
  }> = []
  return { captured }
})

vi.mock('@parcel/watcher', () => ({
  subscribe: vi.fn(
    async (_path: string, cb: (err: unknown, events: Array<{ path: string; type: string }>) => void) => {
      mockWatcher.captured.push({ path: String(_path), cb })
      return { unsubscribe: vi.fn(async () => {}) }
    }
  )
}))

describe('path-sync 真风暴判定净化', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    mockWatcher.captured.length = 0
    vi.restoreAllMocks()
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  interface MonitorHarness {
    m: PathSyncMonitor
    paths: ReturnType<typeof buildDataPaths>
    anyCb: (err: unknown, events: Array<{ path: string; type: string }>) => void
  }

  async function makeMonitor(opts: { async?: boolean } = {}): Promise<MonitorHarness> {
    const tmp = mkdtempSync(join(tmpdir(), 'ps-filter-'))
    tmpDirs.push(tmp)
    const paths = buildDataPaths(tmp)
    const m = new PathSyncMonitor(paths, { startup_check_async: opts.async ?? false })
    await m.start()
    // 任意订阅回调都进 enqueueEvents；取第一个捕获的回调用于手动触发事件
    return { m, paths, anyCb: mockWatcher.captured[0].cb }
  }

  /** 生成 n 条「handler 不处理」的无关事件（system-catalog 落档等，模拟越过订阅层直达回调） */
  function makeIrrelevantEvents(n: number, root: string): Array<{ path: string; type: string }> {
    const out: Array<{ path: string; type: string }> = []
    for (let i = 0; i < n; i++) {
      out.push({ path: join(root, 'system-catalog', `entry-${i}.json`), type: 'create' })
    }
    return out
  }

  /** 生成 n 条真实 NNG 深层文件 delete 事件（非一级：handler 处理但无索引写回副作用，幂等） */
  function makeNngDeleteEvents(n: number, nngRoot: string): Array<{ path: string; type: string }> {
    const out: Array<{ path: string; type: string }> = []
    for (let i = 0; i < n; i++) {
      out.push({ path: join(nngRoot, 'AI1', 'U1', 'root', 'sub', `topic-${i}_nng.json`), type: 'delete' })
    }
    return out
  }

  // 通过 as unknown 访问编译后仍为普通属性的私有字段（白盒单测）
  const priv = (m: PathSyncMonitor) =>
    m as unknown as {
      selfWriteMarker: Set<string>
      pendingEvents: Map<string, { path: string; type: string; priority: number }>
      processingCount: number
      startupCheck: { runFullCheck: () => Promise<void> }
      eventStats: { create: number; modify: number; delete: number; move: number }
    }

  /**
   * 轮询等待直到事件处理真正结束。
   * 注意：flushPendingEvents 每条之间会归还 processingCount（await setTimeout(0) 间隙），
   * 瞬时空闲不代表批量处理完成——必须「空闲持续 ≥50ms（稳定窗口）」才判定结束，
   * 否则会在间隙中误判提前返回（曾导致 30 条只处理 3 条）。
   */
  async function waitIdle(m: PathSyncMonitor, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let stableSince = -1
    for (;;) {
      const p = priv(m)
      if (p.pendingEvents.size === 0 && p.processingCount === 0) {
        if (stableSince === -1) stableSince = Date.now()
        else if (Date.now() - stableSince >= 50) return
      } else {
        stableSince = -1
      }
      if (Date.now() > deadline) throw new Error('waitIdle timeout: 事件处理未在限时内结束')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  it('订阅范围收窄：只订阅 memory/NNG/cache 三个作用域根，不含 {root} 全树', async () => {
    const { paths } = await makeMonitor()
    // subscribePath 内部会 normalizePath（正斜杠），断言也按 normalize 后的路径对比
    const subscribedPaths = mockWatcher.captured.map((c) => normalizePath(c.path))
    expect(subscribedPaths).toHaveLength(3)
    expect(subscribedPaths).toContain(normalizePath(paths.memory))
    expect(subscribedPaths).toContain(normalizePath(paths.nngRoot))
    expect(subscribedPaths).toContain(normalizePath(paths.cacheIndex))
    expect(subscribedPaths).not.toContain(normalizePath(paths.root))
  })

  it('60 条无关事件（system-catalog 落档，模拟直达回调）：入队前过滤，无风暴、不校准、统计不增', async () => {
    const { m, paths, anyCb } = await makeMonitor()
    const logSpy = vi.spyOn(console, 'log')
    const fullCheckSpy = vi.spyOn(priv(m).startupCheck, 'runFullCheck')

    anyCb(null, makeIrrelevantEvents(60, paths.root))
    await waitIdle(m)

    expect(priv(m).pendingEvents.size).toBe(0)
    expect(priv(m).eventStats.create).toBe(0)
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('事件风暴'))
    expect(fullCheckSpy).not.toHaveBeenCalled()
  })

  it('60 条真实 NNG 文件事件：仍是真风暴，合并为全量校准（不掩盖）', async () => {
    const { m, paths, anyCb } = await makeMonitor()
    const logSpy = vi.spyOn(console, 'log')
    const fullCheckSpy = vi.spyOn(priv(m).startupCheck, 'runFullCheck')

    anyCb(null, makeNngDeleteEvents(60, paths.nngRoot))
    await waitIdle(m)

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('事件风暴'))
    expect(fullCheckSpy).toHaveBeenCalledTimes(1)
  })

  it('selfWriteMarker 命中（各路径独立标记）的自身写回：标记被消费、不入队、不产生风暴', async () => {
    const { m, paths, anyCb } = await makeMonitor()
    // 60 个不同 NNG 路径，写回前各自打 marker（真实代码中 marker 存 normalize 后的路径）
    const paths60 = Array.from({ length: 60 }, (_, i) =>
      normalizePath(join(paths.nngRoot, 'AI1', 'U1', 'root', 'sub', `self-${i}_nng.json`))
    )
    for (const p of paths60) priv(m).selfWriteMarker.add(p)

    const logSpy = vi.spyOn(console, 'log')
    const fullCheckSpy = vi.spyOn(priv(m).startupCheck, 'runFullCheck')

    anyCb(null, paths60.map((p) => ({ path: p, type: 'create' })))
    await waitIdle(m)

    for (const p of paths60) {
      expect(priv(m).selfWriteMarker.has(p)).toBe(false) // 标记被消费（不泄漏）
    }
    expect(priv(m).pendingEvents.size).toBe(0)
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('事件风暴'))
    expect(fullCheckSpy).not.toHaveBeenCalled()
  })

  it('injection 目录事件：入队前过滤，不入队', async () => {
    const { m, paths, anyCb } = await makeMonitor()
    const injectionPath = join(paths.cacheInjectionRoot, 'AI1', 'inject_cache.json')

    anyCb(null, [
      { path: injectionPath, type: 'create' },
      { path: injectionPath, type: 'update' }
    ])
    await waitIdle(m)

    expect(priv(m).pendingEvents.size).toBe(0)
    expect(priv(m).eventStats.create + priv(m).eventStats.modify).toBe(0)
  })

  it('memory delete（handler 无动作）不入队；NNG/cache delete 照常入队处理', async () => {
    const { m, paths, anyCb } = await makeMonitor()
    const memoryDelete = join(paths.memory, 'U1', 'AI1', 'normal', '1_记忆.json')
    const nngDelete = join(paths.nngRoot, 'AI1', 'U1', 'root', 'sub', 'a_nng.json')
    const cacheDelete = join(paths.cacheIndex, 'AI1', 'U1', 'index', 'sub', 'a_cache.json')

    anyCb(null, [
      { path: memoryDelete, type: 'delete' },
      { path: nngDelete, type: 'delete' },
      { path: cacheDelete, type: 'delete' }
    ])
    await waitIdle(m)

    // memory delete 不入队（handler 无 delete 动作）；nng/cache delete 已处理
    expect(priv(m).eventStats.delete).toBe(2)
  })

  it('混合：60 无关 + 30 真实 → 只按真实事件入队处理，不触发风暴', async () => {
    const { m, paths, anyCb } = await makeMonitor()
    const logSpy = vi.spyOn(console, 'log')
    const fullCheckSpy = vi.spyOn(priv(m).startupCheck, 'runFullCheck')

    anyCb(null, [
      ...makeIrrelevantEvents(60, paths.root),
      ...makeNngDeleteEvents(30, paths.nngRoot)
    ])
    await waitIdle(m)

    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('事件风暴'))
    expect(fullCheckSpy).not.toHaveBeenCalled()
    // 真实事件仍被处理：30 条 NNG delete 逐条执行（无风暴分支）
    expect(priv(m).eventStats.delete).toBe(30)
  })
})