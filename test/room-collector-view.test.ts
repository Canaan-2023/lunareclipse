/**
 * ROOM 采集视图（诉求 10「采集什么由 AI 决定」）+ 事件唤醒（`wake`）回归。
 *
 * 覆盖两层：
 * 1. **纯校验** `validateCollectorView`：scope / 字段白名单 fail-closed，越界即拒；
 * 2. **运行时应用**：AI 计划带 `collectorView` → 替换并留痕；非法视图 → 保留旧视图、留原因；
 *    `wake()` 的相位语义（stopped 忽略 / standby 解除并激活）。
 */
import { describe, it, expect } from 'vitest'
import { createRoomRuntime, type RoomRuntimeDeps, type RoomTimers } from '../electron/main/room/runtime'
import {
  COLLECTOR_FIELDS,
  defaultCollectorView,
  validateCollectorView,
  viewIncludes
} from '../electron/main/room/collector-view'

describe('validateCollectorView：scope × 字段白名单（fail-closed）', () => {
  it('默认视图合法且含全部字段', () => {
    const v = validateCollectorView(defaultCollectorView())
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.view.scopes).toEqual(['env', 'system'])
      expect(v.view.fields).toEqual([...COLLECTOR_FIELDS.env, ...COLLECTOR_FIELDS.system])
    }
  })

  it('合法子集：只选 env.cpu + system.network', () => {
    const v = validateCollectorView({ name: '省电', scopes: ['env', 'system'], fields: ['cpu', 'network'] })
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.view.fields).toEqual(['cpu', 'network'])
      expect(viewIncludes(v.view, 'cpu')).toBe(true)
      expect(viewIncludes(v.view, 'disks')).toBe(false)
    }
  })

  it('未知 scope → 拒', () => {
    expect(validateCollectorView({ name: 'x', scopes: ['desktop'], fields: ['cpu'] }).ok).toBe(false)
  })

  it('字段不在所选 scope 白名单内 → 拒（选了 env 却要 processes）', () => {
    expect(validateCollectorView({ name: 'x', scopes: ['env'], fields: ['processes'] }).ok).toBe(false)
  })

  it('空 scope / 空字段 / 超字段数 / 空名 → 拒', () => {
    expect(validateCollectorView({ name: 'x', scopes: [], fields: ['cpu'] }).ok).toBe(false)
    expect(validateCollectorView({ name: 'x', scopes: ['env'], fields: [] }).ok).toBe(false)
    expect(validateCollectorView({ name: 'x', scopes: ['env'], fields: Array.from({ length: 20 }, () => 'cpu') }).ok).toBe(false)
    expect(validateCollectorView({ name: '   ', scopes: ['env'], fields: ['cpu'] }).ok).toBe(false)
  })

  it('重复项去重；schedule 仅作留痕（不参与采集语义）', () => {
    const v = validateCollectorView({
      name: 'x',
      scopes: ['env', 'env'],
      fields: ['cpu', 'cpu'],
      schedule: '每 30s'
    })
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.view.scopes).toEqual(['env'])
      expect(v.view.fields).toEqual(['cpu'])
      expect(v.view.schedule).toBe('每 30s')
    }
  })
})

// ===== 运行时应用 =====

const OK_EXECUTOR: RoomRuntimeDeps['executor'] = {
  execute: async () => ({
    ok: true,
    decision: { allowed: true, tier: 'T2', code: 'allowed', reason: 'ok', auditId: 'a' }
  })
}

/** 假定时器：只记录 handle、永不自动触发（待机到期在别的用例覆盖）。 */
function makeFakeTimers(): RoomTimers {
  const pending: string[] = []
  return {
    setTimeout: () => {
      const id = `t${pending.length}`
      pending.push(id)
      return id
    },
    clearTimeout: (h: string) => {
      const i = pending.indexOf(h)
      if (i >= 0) pending.splice(i, 1)
    }
  }
}

function makeRt(reply: string) {
  const collects: string[] = []
  /** 每轮规划用的会话 id（断言「上下文来源」选路用） */
  const planSessions: string[] = []
  const rt = createRoomRuntime({
    collect: async () => {
      collects.push('c')
      return { ok: true, text: '平台 win32' }
    },
    plan: async (_prompt, sid) => {
      planSessions.push(sid)
      return reply
    },
    executor: OK_EXECUTOR,
    allowedTools: () => ['read'],
    timers: makeFakeTimers(),
    sessionId: 'room-base'
  })
  return { rt, collects, planSessions }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 25))

describe('运行时应用 AI 的采集视图', () => {
  it('计划带合法 collectorView → 替换并留痕', async () => {
    const reply = JSON.stringify({ decisions: [], collectorView: { name: '省电', scopes: ['env'], fields: ['cpu'] } })
    const { rt } = makeRt(reply)
    await rt.tick()
    expect(rt.getState().collectorView?.name).toBe('省电')
    expect(rt.getState().collectorView?.fields).toEqual(['cpu'])
    expect(rt.getState().events.some((e) => e.detail?.includes('采集视图：省电'))).toBe(true)
  })

  it('非法 collectorView → 保留旧视图 + 留原因（不打崩循环）', async () => {
    const bad = JSON.stringify({ decisions: [], collectorView: { name: 'x', scopes: ['env'], fields: ['processes'] } })
    const { rt } = makeRt(bad)
    await rt.tick()
    expect(rt.getState().collectorView?.name).toBe('默认感官')
    expect(rt.getState().events.some((e) => e.detail?.includes('采集视图未更新'))).toBe(true)
  })

  it('不带 collectorView → 保持默认', async () => {
    const { rt } = makeRt('{"decisions":[]}')
    await rt.tick()
    expect(rt.getState().collectorView).toEqual(defaultCollectorView())
  })
})

describe('AI 自决上下文来源（contextMode：房间自持 / 跟随当前会话）', () => {
  it('默认（未声明）用房间自持会话', async () => {
    const { rt, planSessions } = makeRt('{"decisions":[]}')
    await rt.tick()
    expect(planSessions).toEqual(['room-base'])
    expect(rt.getState().contextMode).toBe('room')
  })

  it('声明 session + 已上报承载会话 → 下一轮起跟随该会话', async () => {
    const { rt, planSessions } = makeRt('{"decisions":[],"contextMode":"session"}')
    rt.setHostSession('chat-1')
    await rt.tick() // 本轮仍在 room 模式（声明在本轮生效）
    await rt.tick() // 本轮起跟随 chat-1
    expect(planSessions).toEqual(['room-base', 'chat-1'])
    expect(rt.getState().contextMode).toBe('session')
    expect(rt.getState().events.some((e) => e.detail?.includes('上下文来源：跟随当前会话'))).toBe(true)
  })

  it('声明 session 但未上报承载会话 → 回退自持（不崩、不空转）', async () => {
    const { rt, planSessions } = makeRt('{"decisions":[],"contextMode":"session"}')
    await rt.tick()
    await rt.tick()
    expect(planSessions).toEqual(['room-base', 'room-base'])
    expect(rt.getState().contextMode).toBe('session')
  })

  it('非法值 → 保留旧模式并留痕', async () => {
    const { rt, planSessions } = makeRt('{"decisions":[],"contextMode":"global"}')
    await rt.tick()
    await rt.tick()
    expect(planSessions).toEqual(['room-base', 'room-base'])
    expect(rt.getState().contextMode).toBe('room')
    expect(rt.getState().events.some((e) => e.detail?.includes('上下文来源未更新'))).toBe(true)
  })

  it('切回 room → 恢复自持（两种来源可来回切）', async () => {
    const { rt, planSessions } = makeRt('{"decisions":[],"contextMode":"session"}')
    rt.setHostSession('chat-1')
    await rt.tick()
    await rt.tick()
    expect(planSessions[1]).toBe('chat-1')
    // 换一份「切回 room」的计划再跑一轮，其后应回自持
    const back = makeRt('{"decisions":[],"contextMode":"room"}')
    back.rt.setHostSession('chat-9')
    await back.rt.tick()
    await back.rt.tick()
    expect(back.planSessions).toEqual(['room-base', 'room-base'])
    expect(back.rt.getState().contextMode).toBe('room')
  })
})

describe('wake：事件唤醒的相位语义', () => {
  it('stopped（用户关停）→ 忽略，不自动拉起', () => {
    const { rt, collects } = makeRt('{"decisions":[]}')
    rt.wake('user-present')
    expect(rt.getState().phase).toBe('stopped')
    expect(collects).toHaveLength(0)
  })

  it('standby → 解除待机并重新激活（静默期被事件叫醒）', async () => {
    const { rt } = makeRt('{"decisions":[]}')
    rt.start()
    await settle()
    rt.standby(60_000)
    expect(rt.getState().phase).toBe('standby')
    rt.wake('monitor')
    expect(rt.getState().phase).not.toBe('standby')
    expect(rt.getState().standbyUntil).toBeUndefined()
    expect(rt.getState().events.some((e) => e.detail?.includes('唤醒（monitor / 监控事件）'))).toBe(true)
    rt.stop()
  })
})
