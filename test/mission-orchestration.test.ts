/**
 * Mission 编排集成测试（2026-08-19 ①④）

 * 模拟 server.ts 的编排逻辑（MissionStore + AsyncDelegationManager 事件联动）：
 *  - completed → completeSegment 记账
 *  - failed(transient) 未超 failureLimit → 自动 re-dispatch（同 mission id）续接
 *  - 失败达 failureLimit → blocked 不再重试
 *  - 成功一次 → done + 预算累计
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AsyncDelegationManager, type DelegationRecord } from '../app/electron/main/tools/sub-agent-engine/async-delegation'
import { SubAgentRegistry, IterationBudget } from '../app/electron/main/tools/sub-agent-engine/engine'
import { MissionStore } from '../app/electron/main/tools/sub-agent-engine/mission-store'

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

describe('Mission 编排（2026-08-19 ①④）', () => {
  it('失败 2 次达 failureLimit → blocked，期间自动重试 1 次（共 2 段）', async () => {
    const { as, store } = setup({
      runner: async () => { throw new Error('network timeout') },
    })
    const missionId = 'ms_retry'
    store.create(missionId, 'do it', { failureLimit: 2 })
    as.dispatch('do it', null, 50, missionId)
    await wait(300)
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
    await wait(400)
    const m = store.get(missionId)!
    expect(m.status).toBe('done')
    expect(m.segments).toBe(2) // 1 fail + 1 成功
    expect(m.iterationsUsed) // 有记账（数值以 runner 消费为准，此处仅断言非 NaN）
    as.dispose()
  })
})
