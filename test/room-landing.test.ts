/**
 * ADR-30 R2（0.53.18 修订）：落点（承载会话树内）+ 树索引注入 + `describeTreeIndex` 回归。
 *
 * 为什么测：落点是「AI 自己决定接着哪条线」的唯一入口——错了不会报错，只会让 AI
 * **静默地接错线**（或落在没被承接的节点上）。另锁三条硬约束：
 * 1. **形状非法 = 丢弃留痕**，绝不把半截落点交给应用点；
 * 2. **只有一棵树**：自主模式继承「开启自主的那个会话」的树，规划 / 落点都落在它身上；
 * 3. **未绑定承载会话 = 不规划**（不再回落到房间自持会话，否则又会长出旧房间树）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createRoomRuntime,
  type RoomLanding,
  type RoomRuntimeDeps,
  type RoomTimers,
  type TreeIndex
} from '../electron/main/room/runtime'
import { describeTreeIndex } from '../electron/main/bootstrap/room-runtime'
import { InternalSessionStore } from '../electron/main/services/internal-session-store'

const OK_EXECUTOR: RoomRuntimeDeps['executor'] = {
  execute: async () => ({
    ok: true,
    decision: { allowed: true, tier: 'T2', code: 'allowed', reason: 'ok', auditId: 'a' }
  })
}

function makeFakeTimers(): RoomTimers {
  return { setTimeout: () => 't0', clearTimeout: () => undefined }
}

/** 造一棵树索引（供注入断言用）；0.53.18 起只有承载会话这一棵 */
function tree(sessionId: string): TreeIndex {
  return {
    sessionId,
    activeId: null,
    sessions: [{ id: `is_${sessionId}`, title: '一条线', summary: '', writableTail: true, updatedAt: 1 }]
  }
}

interface LandingCall {
  sessionId: string
  landing: RoomLanding
}

function makeRt(
  reply: string,
  opts: {
    landingResult?: { ok: boolean; internalId?: string; error?: string }
    withApply?: boolean
    bindHost?: boolean
  } = {}
) {
  const prompts: string[] = []
  const askedTrees: string[] = []
  const landingCalls: LandingCall[] = []
  const withApply = opts.withApply !== false
  const rt = createRoomRuntime({
    collect: async () => ({ ok: true, text: '平台 win32' }),
    plan: async (prompt) => {
      prompts.push(prompt)
      return reply
    },
    executor: OK_EXECUTOR,
    allowedTools: () => ['read'],
    timers: makeFakeTimers(),
    listTreeSessions: (sid) => {
      askedTrees.push(sid)
      return tree(sid)
    },
    ...(withApply
      ? {
          applyLanding: async (sid: string, l: RoomLanding) => {
            landingCalls.push({ sessionId: sid, landing: l })
            return opts.landingResult ?? { ok: true, internalId: 'is_new' }
          }
        }
      : {})
  })
  // 默认绑定宿主：正常路径是「在会话视图里开启自主」时绑定（`room:start-loop`）
  if (opts.bindHost !== false) rt.setHostSession('chat-1')
  return { rt, prompts, askedTrees, landingCalls }
}

describe('运行时应用 AI 的落点（landing）', () => {
  it('continue → 落到承载会话树并留痕', async () => {
    const { rt, landingCalls } = makeRt(JSON.stringify({ decisions: [], landing: { action: 'continue', internalId: 'is_a' } }))
    await rt.tick()
    expect(landingCalls).toEqual([{ sessionId: 'chat-1', landing: { action: 'continue', internalId: 'is_a' } }])
    expect(rt.getState().landing).toEqual({ internalId: 'is_new' })
    expect(rt.getState().events.some((e) => e.detail?.includes('落点：会话树'))).toBe(true)
  })

  it('形状非法 → 不调应用点 + 留痕', async () => {
    const { rt, landingCalls } = makeRt(JSON.stringify({ decisions: [], landing: { action: 'select' } }))
    await rt.tick()
    expect(landingCalls).toEqual([])
    expect(rt.getState().landing).toBeUndefined()
    expect(rt.getState().events.some((e) => e.detail?.includes('落点未更新：形状非法'))).toBe(true)
  })

  it('应用点拒绝（如节点已锁定）→ 状态不变 + 留痕原因', async () => {
    const { rt } = makeRt(JSON.stringify({ decisions: [], landing: { action: 'continue', internalId: 'is_x' } }), {
      landingResult: { ok: false, error: '节点已锁定（只供回读）' }
    })
    await rt.tick()
    expect(rt.getState().landing).toBeUndefined()
    expect(rt.getState().events.some((e) => e.detail?.includes('落点未更新：节点已锁定'))).toBe(true)
  })

  it('未接线应用点 → 留痕「未接线」（不静默、不打崩）', async () => {
    const { rt } = makeRt(JSON.stringify({ decisions: [], landing: { action: 'continue', internalId: 'is_a' } }), {
      withApply: false
    })
    await rt.tick()
    expect(rt.getState().events.some((e) => e.detail?.includes('落点未更新：未接线'))).toBe(true)
  })

  it('不带 landing → 状态里没有落点（零回归）', async () => {
    const { rt, landingCalls } = makeRt('{"decisions":[]}')
    await rt.tick()
    expect(landingCalls).toEqual([])
    expect(rt.getState().landing).toBeUndefined()
  })

  it('未绑定承载会话 → **不调模型**，状态留痕（不回落房间树）', async () => {
    const { rt, prompts, askedTrees } = makeRt(JSON.stringify({ decisions: [] }), { bindHost: false })
    await rt.tick()
    expect(prompts).toEqual([])
    expect(askedTrees).toEqual([])
    expect(rt.getState().lastPlan?.note).toContain('未绑定会话')
    expect(rt.getState().hostSessionId).toBeUndefined()
  })
})

describe('承载会话的树索引进提示词（只有一棵）', () => {
  it('绑定承载会话 → 只问承载会话，提示词只渲染一棵树', async () => {
    const { rt, prompts, askedTrees } = makeRt('{"decisions":[]}')
    await rt.tick()
    expect(askedTrees).toEqual(['chat-1'])
    expect(prompts[0]).toContain('【会话树】')
    expect(prompts[0]).toContain('· 会话树（当前会话的逆生树）')
    expect(prompts[0]).not.toContain('房间树')
  })

  it('树为空 → 索引段显式说明「空」，仍保留落点用法', async () => {
    const rt = createRoomRuntime({
      collect: async () => ({ ok: true, text: '平台 win32' }),
      plan: async (prompt) => {
        expect(prompt).toContain('（空——可用 landing 的 create 开第一条线）')
        return '{"decisions":[]}'
      },
      executor: OK_EXECUTOR,
      allowedTools: () => ['read'],
      timers: makeFakeTimers(),
      listTreeSessions: () => ({ sessionId: 'chat-1', activeId: null, sessions: [] })
    })
    rt.setHostSession('chat-1')
    await rt.tick()
  })

  it('运行中不接受重新绑定（避免同一轮上下文突然换树）', async () => {
    const { rt } = makeRt('{"decisions":[]}')
    rt.start()
    expect(rt.isRunning()).toBe(true)
    rt.setHostSession('chat-2')
    expect(rt.getState().hostSessionId).toBe('chat-1')
    rt.stop()
  })
})

describe('describeTreeIndex：只给索引（不给正文）+ 可写尾端判定与 session_select 同口径', () => {
  let root = ''
  let store: InternalSessionStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'le-tree-'))
    // root 解析器返回临时目录；owner 段由 store 自行追加（与线上 `sessions/U{uid}/AI{aiId}` 同形）
    store = new InternalSessionStore(() => root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('空树：无会话、无落点', () => {
    const idx = describeTreeIndex(store, 'room-base')
    expect(idx).toEqual({ sessionId: 'room-base', activeId: null, sessions: [] })
  })

  it('继承后父节点判为**不可写**、子节点可写；落点 = 当前承接指针', () => {
    const parent = store.create('room-base', { title: '父', summary: 'S' })
    const child = store.create('room-base', { title: '子', parentId: parent.id, gen: 2, summary: 'C' })
    store.setActive('room-base', child.id)

    const idx = describeTreeIndex(store, 'room-base')
    expect(idx?.activeId).toBe(child.id)
    const byId = new Map(idx?.sessions.map((s) => [s.id, s]))
    expect(byId.get(parent.id)?.writableTail).toBe(false)
    expect(byId.get(child.id)?.writableTail).toBe(true)
    expect(byId.get(child.id)?.gen).toBe(2)
    // 只给索引：不带 messages / 正文
    expect(Object.keys(byId.get(child.id) ?? {})).not.toContain('messages')
  })
})
