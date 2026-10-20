/**
 * ADR-30 R2：落点（两棵会话树内）+ 树索引注入 + `describeTreeIndex` 回归。
 *
 * 为什么测：落点是「AI 自己决定接着哪条线」的唯一入口——错了不会报错，只会让 AI
 * **静默地接错线**（或落在没被承接的节点上）。另锁三条硬约束：
 * 1. **形状非法 = 丢弃留痕**，绝不把半截落点交给应用点（与 `contextMode` 同处置）；
 * 2. **顺序**：同一轮里 `contextMode` 先换树、`landing` 后落点 → 落在**换后**的那棵树；
 * 3. **两棵树都进提示词**（「自主模式开启时有两个树…会话内的那个树也能看到、也能选择」）。
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
  type RoomTree,
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

/** 造一棵「有两条线」的树索引（供注入断言用） */
function tree(tree: RoomTree, sessionId: string): TreeIndex {
  return {
    tree,
    sessionId,
    activeId: null,
    sessions: [{ id: `is_${tree}`, title: `${tree} 的线`, summary: '', writableTail: true, updatedAt: 1 }]
  }
}

interface LandingCall {
  tree: RoomTree
  sessionId: string
  landing: RoomLanding
}

function makeRt(
  reply: string,
  opts: { landingResult?: { ok: boolean; internalId?: string; error?: string }; withApply?: boolean } = {}
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
    sessionId: 'room-base',
    listTreeSessions: (t, sid) => {
      askedTrees.push(`${t}:${sid}`)
      return tree(t, sid)
    },
    ...(withApply
      ? {
          applyLanding: async (t: RoomTree, sid: string, l: RoomLanding) => {
            landingCalls.push({ tree: t, sessionId: sid, landing: l })
            return opts.landingResult ?? { ok: true, internalId: 'is_new' }
          }
        }
      : {})
  })
  return { rt, prompts, askedTrees, landingCalls }
}

describe('运行时应用 AI 的落点（landing）', () => {
  it('continue → 落到当前主树（房间树）并留痕', async () => {
    const { rt, landingCalls } = makeRt(JSON.stringify({ decisions: [], landing: { action: 'continue', internalId: 'is_a' } }))
    await rt.tick()
    expect(landingCalls).toEqual([
      { tree: 'room', sessionId: 'room-base', landing: { action: 'continue', internalId: 'is_a' } }
    ])
    expect(rt.getState().landing).toEqual({ tree: 'room', internalId: 'is_new' })
    expect(rt.getState().events.some((e) => e.detail?.includes('落点：房间树'))).toBe(true)
  })

  it('形状非法 → 不调应用点 + 留痕（与 contextMode 同处置）', async () => {
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

  it('同一轮 contextMode=session + landing → **先换树再落点**，落在承载会话树', async () => {
    const { rt, landingCalls } = makeRt(
      JSON.stringify({ decisions: [], contextMode: 'session', landing: { action: 'create', title: '新线' } })
    )
    rt.setHostSession('chat-1')
    await rt.tick()
    expect(rt.getState().contextMode).toBe('session')
    expect(landingCalls).toEqual([{ tree: 'host', sessionId: 'chat-1', landing: { action: 'create', title: '新线' } }])
    expect(rt.getState().landing).toEqual({ tree: 'host', internalId: 'is_new' })
  })
})

describe('两棵树的索引都进提示词（「会话内的那个树也能看到」）', () => {
  it('上报过承载会话 → 房间树与承载会话树都被问、都被渲染', async () => {
    const { rt, prompts, askedTrees } = makeRt('{"decisions":[]}')
    rt.setHostSession('chat-1')
    await rt.tick()
    expect(askedTrees).toEqual(['room:room-base', 'host:chat-1'])
    expect(prompts[0]).toContain('房间树')
    expect(prompts[0]).toContain('承载会话树')
  })

  it('未上报承载会话 → 只注入房间树（不凭空造一棵）', async () => {
    const { rt, prompts, askedTrees } = makeRt('{"decisions":[]}')
    await rt.tick()
    expect(askedTrees).toEqual(['room:room-base'])
    expect(prompts[0]).toContain('· 房间树')
    // 契约文本本身会提到「承载会话树」，故按**索引行**判定是否真的注入了那棵树
    expect(prompts[0]).not.toContain('· 承载会话树')
  })

  it('承载会话就是房间会话本身 → 不重复注入', async () => {
    const { rt, askedTrees } = makeRt('{"decisions":[]}')
    rt.setHostSession('room-base')
    await rt.tick()
    expect(askedTrees).toEqual(['room:room-base'])
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
    const idx = describeTreeIndex(store, 'room', 'room-base')
    expect(idx).toEqual({ tree: 'room', sessionId: 'room-base', activeId: null, sessions: [] })
  })

  it('继承后父节点判为**不可写**、子节点可写；落点 = 当前承接指针', () => {
    const parent = store.create('room-base', { title: '父', summary: 'S' })
    const child = store.create('room-base', { title: '子', parentId: parent.id, gen: 2, summary: 'C' })
    store.setActive('room-base', child.id)

    const idx = describeTreeIndex(store, 'room', 'room-base')
    expect(idx?.activeId).toBe(child.id)
    const byId = new Map(idx?.sessions.map((s) => [s.id, s]))
    expect(byId.get(parent.id)?.writableTail).toBe(false)
    expect(byId.get(child.id)?.writableTail).toBe(true)
    expect(byId.get(child.id)?.gen).toBe(2)
    // 只给索引：不带 messages / 正文
    expect(Object.keys(byId.get(child.id) ?? {})).not.toContain('messages')
  })
})
