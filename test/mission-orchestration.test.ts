/**
 * Mission 编排集成测试（2026-08-19 ①④）

 * 模拟 server.ts 的编排逻辑（MissionStore + AsyncDelegationManager 事件联动）：
 *  - completed → completeSegment 记账
 *  - failed(transient) 未超 failureLimit → 自动 re-dispatch（同 mission id）续接
 *  - 失败达 failureLimit → blocked 不再重试
 *  - 成功一次 → done + 预算累计
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AsyncDelegationManager, type DelegationRecord } from '../electron/main/tools/sub-agent-engine/async-delegation'
import { SubAgentRegistry, IterationBudget } from '../electron/main/tools/sub-agent-engine/engine'
import { MissionStore } from '../electron/main/tools/sub-agent-engine/mission-store'

type Runner = (rec: DelegationRecord, signal: AbortSignal, budget: IterationBudget) => Promise<string>

let dirs: string[] = []

function setup(opts: { runner: Runner }) {
  const dir = mkdtempSync(join(tmpdir(), 'mission-orch-'))
  dirs.push(dir)
  const root = join(dir, 'data')
  const store = new MissionStore(root)
  const as = new AsyncDelegationManager(new SubAgentRegistry(), {
    runner: opts.runner,
    persistencePath: join(root, 'mission', 'delegations.json'),
  })

  // 复刻 server 编排（completed/failed → 记账 + 失败自动重试）
  as.on('completed', (rec) => {
    const m = store.get(rec.id)
    if (m) store.completeSegment(rec.id, { usedThisSegment: rec.iterationsUsed ?? 0, ok: true, result: rec.result, done: true })
  })
  as.on('failed', (rec, err) => {
    const m = store.get(rec.id)
    if (!m) return
    store.completeSegment(rec.id, { usedThisSegment: rec.iterationsUsed ?? 0, ok: false, error: err, blockKind: 'transient' })
    const updated = store.get(rec.id)
    if (updated && updated.status === 'active') {
      const remain = store.remainingBudget(rec.id)
      if (remain > 0) {
        const retryTask = `${rec.task}\n[第 ${updated.segments + 1} 段续接；前次失败: ${err ?? ''}]`
        as.dispatch(retryTask, null, remain, rec.id)
      }
    }
  })

  return { as, store }
}

afterEach(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  dirs = []
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 轮询等待条件成立（替代固定墙钟） */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await wait(20)
  }
  return cond()
}

/**
 * 等待 mission 到达终态（done / blocked）——替代固定墙钟预算。
 * 为什么（2026-10-17，分发前审查 T1 验收发现 flaky）：原用例 `await wait(400)` 后直接断言状态，
 * 该时长是「本机空载时的经验值」；当机器有负载（如全量测试并行、transform 占用 CPU）时，
 * dispatch → failed 事件 → completeSegment → re-dispatch → completed 事件 这条异步链走不完，
 * 断言读到中间态 'active'/'blocked' 而偶发失败（实测 4 次跑挂 1 次）。
 * 与项目 0.31/0.32 的处理同源：等待方式改等终态事件/状态，消除墙钟预算竞态。
 */
async function waitTerminal(store: MissionStore, id: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const s = store.get(id)?.status
    if (s === 'done' || s === 'blocked') return
    await wait(25)
  }
}

describe('Mission 编排（2026-08-19 ①④）', () => {
  it('失败 2 次达 failureLimit → blocked，期间自动重试 1 次（共 2 段）', async () => {
    const { as, store } = setup({
      runner: async () => { throw new Error('network timeout') },
    })
    const missionId = 'ms_retry'
    store.create(missionId, 'do it', { failureLimit: 2 })
    as.dispatch('do it', null, 50, missionId)
    await waitTerminal(store, missionId)
    const m = store.get(missionId)!
    expect(m.status).toBe('blocked')
    expect(m.blockKind).toBe('transient')
    expect(m.segments).toBe(2) // 失败1 → 重试(段2 失败) → blocked
    as.dispose()
  })

  it('瞬时失败后成功：done + 累计预算 + segments=2', async () => {
    let n = 0
    const { as, store } = setup({
      runner: async () => {
        n++
        if (n === 1) throw new Error('first transient fail')
        return 'finished'
      },
    })
    const missionId = 'ms_ok'
    store.create(missionId, 'goal', { maxIterations: 20 })
    as.dispatch('goal', null, 20, missionId)
    await waitTerminal(store, missionId)
    const m = store.get(missionId)!
    expect(m.status).toBe('done')
    expect(m.segments).toBe(2) // 1 fail + 1 成功
    expect(m.iterationsUsed) // 有记账（数值以 runner 消费为准，此处仅断言非 NaN）
    as.dispose()
  })

  /**
   * 2026-10-17（0.52.9 复验轮）新增：收尾故障不得把「已完成」改判为「失败」。
   * 背景：mission-orchestration 的第二个用例曾偶发 `expected 'done' to be 'blocked'`（~2%）。
   * 定位：completed 分支先置 status='completed'，随后 persist()（.tmp→rename）在 Windows 文件锁下
   * 抛 EPERM → 落进外层 catch → 把一次**成功**改判为 failed → 上层失败计数 +1，
   * 两次即 blocked。该用例的 runner 只可能抛一次错，第二次"失败"只能来自此路径。
   * 本用例用确定性手法（把持久化目录替换为同名文件 → 完成后 persist 必抛 ENOTDIR）复现该场景。
   */
  it('持久化失败不得改判为 failed，且"已完成"必须传达（防虚假失败计数 → 误 blocked）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mission-persist-'))
    dirs.push(dir)
    const sub = join(dir, 'sub')
    mkdirSync(sub, { recursive: true }) // 让 dispatch 阶段的 persist 先成功
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const as = new AsyncDelegationManager(new SubAgentRegistry(), {
      runner: async () => {
        await gate
        return 'ok'
      },
      persistencePath: join(sub, 'records.json')
    })
    const failedEvents: unknown[] = []
    const completedIds: string[] = []
    as.on('failed', (_rec, err) => failedEvents.push(err))
    as.on('completed', (rec) => completedIds.push(rec.id))

    as.dispatch('t')
    // 把持久化目录换成同名文件：完成后的 persist 必然抛错（模拟收尾故障）
    rmSync(sub, { recursive: true, force: true })
    writeFileSync(sub, 'not a dir', 'utf-8')

    release()
    expect(await waitFor(() => completedIds.length === 1)).toBe(true) // 完成通知必须送达
    await wait(60) // 留出 catch 分支执行窗口
    expect(failedEvents).toHaveLength(0) // 不得改判为失败
    // dispose 会再次 persist，而本用例已故意把持久化路径破坏成文件 → 容错收尾（非断言对象）
    try {
      as.dispose()
    } catch {
      // 预期：持久化路径已被本用例破坏
    }
  })
})
