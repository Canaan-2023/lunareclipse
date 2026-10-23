/**
 * 区树 + `room_note` 工具回归（ADR-30：区 = AI 写给自己用的一叠纸，**逆生树结构、不是会话**）。
 *
 * 为什么测：这一层是「AI 自己决定看什么」的唯一落点——它错了不会报错，只会让 AI
 * 看到错的东西（或看不见自己写过的纸），是典型的**静默失效**。另锁三条硬约束：
 * 1. **区不是会话**：纸落在 `<data>/room/zones/…`，不在 `sessions/` 下 → 不进会话列表、
 *    不进普通对话路由候选（本测试用临时目录断言物理落点，不看实现自述）；
 * 2. **区之间不串**：三个区各一棵树，互不可见；
 * 3. **工具面与用途一致**：`room_note` 只在 `purpose === 'room'` 时被追加，
 *    普通对话拿到空数组（否则普通对话的工具清单会多出用不上的项）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ROOM_ZONES,
  buildRoomNoteExecutor,
  createRoomZoneTrees,
  getRoomExtraToolExecutors,
  isRoomZone,
  setRoomZoneToolProvider,
  type RoomZoneTrees
} from '../electron/main/room/zone-tools'

const OWNER = 'room-autonomous-U1-AI1'

let root = ''
let trees: RoomZoneTrees

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'le-zone-'))
  trees = createRoomZoneTrees({ zonesRoot: root, ownerSessionId: OWNER })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('区树：纸的基本链路（逆生树语义复用 InternalSessionStore）', () => {
  it('空区：无纸、无落点', () => {
    const { papers, activeId } = trees.index('executor')
    expect(papers).toEqual([])
    expect(activeId).toBeNull()
  })

  it('create 开纸即成为落点，read 能读回正文，index 只给索引', () => {
    const p = trees.create('executor', { title: '查内存', summary: '看看内存占用', content: '第一行' })
    expect(p.writableTail).toBe(true)
    expect(p.locked).toBe(false)
    expect(trees.active('executor')).toBe(p.id)

    const r = trees.read('executor', p.id)
    expect(r?.body).toContain('第一行')
    expect(r?.total).toBe(1)

    const { papers } = trees.index('executor')
    expect(papers).toHaveLength(1)
    expect(papers[0].summary).toBe('看看内存占用')
    // 索引带绝对路径（「历史可以回找」：AI 可直接 Read）
    expect(papers[0].filePath).toContain('executor')
  })

  it('append 默认写当前落点；无落点时**不隐式建纸**而是报错', async () => {
    const err = await trees.append('collector', '孤立的一行')
    expect(err.ok).toBe(false)
    if (!err.ok) expect(err.error).toContain('无落点')

    const p = trees.create('collector', { title: '观察' })
    const ok = await trees.append('collector', '看到了什么')
    expect(ok).toEqual({ ok: true, internalId: p.id })
    expect(trees.read('collector', p.id)?.body).toContain('看到了什么')
  })

  it('read 可分段（「不需要全部读取」）', async () => {
    const p = trees.create('executor', { title: '长纸' })
    for (let i = 0; i < 5; i++) await trees.append('executor', `第${i}行`, p.id)
    // create 无 content → 正文只有 append 的 5 行
    const head = trees.read('executor', p.id, 0, 2)
    expect(head?.total).toBe(5)
    expect(head?.body.split('\n')).toHaveLength(2)
    expect(head?.body).toContain('第0行')
    const tail = trees.read('executor', p.id, 4)
    expect(tail?.body.split('\n')).toHaveLength(1)
    expect(tail?.body).toContain('第4行')
  })

  it('discard 丢纸并清落点（「纸可以丢」）', () => {
    const p = trees.create('device', { title: '设备' })
    expect(trees.discard('device', p.id).ok).toBe(true)
    expect(trees.index('device').papers).toEqual([])
    expect(trees.active('device')).toBeNull()
  })
})

describe('区树：区之间不串、房间之间不串', () => {
  it('三个区各自一棵树，互不可见', () => {
    trees.create('executor', { title: 'E' })
    trees.create('collector', { title: 'C' })
    expect(trees.index('executor').papers.map((p) => p.title)).toEqual(['E'])
    expect(trees.index('collector').papers.map((p) => p.title)).toEqual(['C'])
    expect(trees.index('device').papers).toEqual([])
    expect(trees.active('device')).toBeNull()
  })

  it('不同房间（owner）各一堆纸', () => {
    const other = createRoomZoneTrees({ zonesRoot: root, ownerSessionId: 'room-autonomous-U1-AI2' })
    trees.create('executor', { title: 'AI1 的纸' })
    expect(other.index('executor').papers).toEqual([])
    expect(trees.index('executor').papers).toHaveLength(1)
  })

  it('物理落点在 <zonesRoot>/<zone>/<owner>/ai/ 下——**不在 sessions/ 下**（区不是会话）', () => {
    const p = trees.create('executor', { title: '落点检查' })
    expect(p.filePath).toContain(join(root, 'executor', OWNER, 'ai').replace(/\\/g, '/'))
    expect(existsSync(join(root, 'executor', OWNER, 'ai'))).toBe(true)
    expect(readdirSync(join(root, 'executor', OWNER, 'ai')).some((f) => f.endsWith('.json'))).toBe(true)
    // 区根下只允许出现区目录（懒建：只有被用到的区才有目录）——不会有别的域混进来
    expect(readdirSync(root).every((d) => isRoomZone(d))).toBe(true)
  })
})

describe('区树：继承后父纸锁定（只供回读，不能再写）', () => {
  it('从父纸分叉后，父纸被判定锁定，select / append 均被拒，但 read 仍可回读', async () => {
    const parent = trees.create('executor', { title: '父', content: '父的内容' })
    await trees.append('executor', '父的第二行', parent.id)
    const child = trees.create('executor', { title: '子', parentId: parent.id })
    expect(child.gen).toBe(2)

    const idx = trees.index('executor')
    const parentIdx = idx.papers.find((p) => p.id === parent.id)
    const childIdx = idx.papers.find((p) => p.id === child.id)
    expect(parentIdx?.locked).toBe(true)
    expect(parentIdx?.writableTail).toBe(false)
    expect(childIdx?.writableTail).toBe(true)

    const sel = trees.select('executor', parent.id)
    expect(sel.ok).toBe(false)
    const app = await trees.append('executor', '不该写进去', parent.id)
    expect(app.ok).toBe(false)

    // 回读仍可用（「历史可以回找」）
    expect(trees.read('executor', parent.id)?.body).toContain('父的内容')
  })
})

describe('room_note：工具面与调用契约', () => {
  it('未知 action / 缺参数 / 未知区 都返回 ok:false（不抛）', async () => {
    const ex = buildRoomNoteExecutor(trees)
    expect(ex.name).toBe('room_note')
    const bad = JSON.parse(await ex.execute({ action: 'nope' })) as { ok: boolean; error: string }
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('未知 action')

    const noId = JSON.parse(await ex.execute({ action: 'read' })) as { ok: boolean }
    expect(noId.ok).toBe(false)

    const badZone = JSON.parse(await ex.execute({ action: 'list', zone: 'kitchen' })) as { ok: boolean; error: string }
    expect(badZone.ok).toBe(false)
    expect(badZone.error).toContain('未知区')

    const noContent = JSON.parse(await ex.execute({ action: 'append', content: '   ' })) as { ok: boolean }
    expect(noContent.ok).toBe(false)
  })

  it('list / create / append / read / select / discard 走通（工具即 AI 的唯一入口）', async () => {
    const ex = buildRoomNoteExecutor(trees)
    const empty = JSON.parse(await ex.execute({ action: 'list', zone: 'collector' })) as {
      ok: boolean
      count: number
      hint: string
    }
    expect(empty.ok).toBe(true)
    expect(empty.count).toBe(0)
    expect(empty.hint).toContain('create')

    const created = JSON.parse(
      await ex.execute({ action: 'create', zone: 'collector', title: '盯内存', summary: '内存异常时记一笔' })
    ) as { ok: boolean; paper: { id: string } }
    expect(created.ok).toBe(true)

    const appended = JSON.parse(await ex.execute({ action: 'append', zone: 'collector', content: '内存 82%' })) as {
      ok: boolean
      internalId: string
    }
    expect(appended.ok).toBe(true)
    expect(appended.internalId).toBe(created.paper.id)

    const read = JSON.parse(
      await ex.execute({ action: 'read', zone: 'collector', internalId: created.paper.id })
    ) as { ok: boolean; body: string }
    expect(read.body).toContain('内存 82%')

    const listed = JSON.parse(await ex.execute({ action: 'list', zone: 'collector' })) as {
      activeId: string
      papers: Array<{ summary: string }>
    }
    expect(listed.activeId).toBe(created.paper.id)
    expect(listed.papers[0].summary).toBe('内存异常时记一笔')

    const discarded = JSON.parse(
      await ex.execute({ action: 'discard', zone: 'collector', internalId: created.paper.id })
    ) as { ok: boolean }
    expect(discarded.ok).toBe(true)
  })
})

describe('工具面与用途一致：room_note 只进房间轮', () => {
  afterEach(() => setRoomZoneToolProvider(null))

  it('非 room 用途 / 未登记 provider → 空数组（普通对话工具面零变化）', () => {
    expect(getRoomExtraToolExecutors('chat')).toEqual([])
    expect(getRoomExtraToolExecutors(undefined)).toEqual([])
    expect(getRoomExtraToolExecutors('room')).toEqual([]) // 尚未登记 provider
  })

  it('登记 provider 后只在 room 用途下产出 room_note', () => {
    setRoomZoneToolProvider((_p, aiId) => (aiId === 1 ? [buildRoomNoteExecutor(trees)] : []))
    expect(getRoomExtraToolExecutors('chat')).toEqual([])
    const room = getRoomExtraToolExecutors('room', 1)
    expect(room.map((t) => t.name)).toEqual(['room_note'])
    expect(getRoomExtraToolExecutors('room', 2)).toEqual([])
  })

  it('provider 抛错时返回空数组并留痕（工具面故障不打崩本轮）', () => {
    setRoomZoneToolProvider(() => {
      throw new Error('未登录')
    })
    expect(getRoomExtraToolExecutors('room', 1)).toEqual([])
  })
})

describe('区枚举', () => {
  it('三个区：executor / collector / device', () => {
    expect([...ROOM_ZONES]).toEqual(['executor', 'collector', 'device'])
    expect(isRoomZone('executor')).toBe(true)
    expect(isRoomZone('kitchen')).toBe(false)
    expect(isRoomZone(1)).toBe(false)
  })
})
