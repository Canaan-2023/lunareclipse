/**
 * 会话选择工具（session_select）与 InternalSessionStore active 承接指针契约测试。
 *
 * 为什么存在：v0.25 起会话选择权交给主 AI（用户诉求「会话选择是 AI 自己路由的」）——
 * 选择结果经 store.activeByOwner 持久化到 aiDir/.active（无 .json 扩展名，不参与会话
 * 索引），下一轮 resolveStreamSessionContext 据此直接装载。本文件钉住两层契约：
 * - store 层：active 指针 get/set/clear 的磁盘持久化（跨实例重读）、setActive 的
 *   存在性校验、delete/deleteByOwner 的同步清理、.active 不污染 scanAndIndex；
 * - 工具层：SessionSelectTool 的 list（逆生树三边摆放渲染：继承/时间实线 + 新话题虚线 + 可写尾端过滤）、select\n *   （锁定会话 / 被压缩父会话拒绝）、create（缺省=从可写尾端分叉出原样继承其内容的新会话并承接\n *   实线延续；newTopic=true=AI 判定话题新开的虚线分支，空白承接不复制）、release（恢复自动路由）。
 * 关键口径（与生产代码同源，勿在测试内重写第二份）：可写尾端 = 自身无 timeBranchId
 * 且 无继承子；锁定 = 已向时间下级延续；被压缩 = 有 parentId 引用的父会话。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { InternalSessionStore } from '../electron/main/services/internal-session-store'
import { SessionSelectTool } from '../electron/main/tools/session-select'
import type { ToolContext } from '../electron/main/tools/base-tool'

const OWNER = 'sess_tool_owner'
const TEST_DIR = join(tmpdir(), `session-select-test-${process.pid}-${Date.now()}`)

function makeStore(): InternalSessionStore {
  return new InternalSessionStore(() => join(TEST_DIR, 'sessions'))
}

function makeCtx(store: InternalSessionStore, sessionId: string = OWNER): ToolContext {
  return { sessionId, getInternalSessionStore: () => store } as unknown as ToolContext
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

/* ============================ 1. store 层：active 承接指针 ============================ */

describe('InternalSessionStore.active 承接指针', () => {
  it('默认无指针；setActive 后 get 命中且落盘 .active（新实例重读一致）', () => {
    const store = makeStore()
    expect(store.getActive(OWNER)).toBeNull()
    const s = store.create(OWNER, { title: '会话一' })
    expect(store.setActive(OWNER, s.id)).toBe(true)
    expect(store.getActive(OWNER)).toBe(s.id)
    // 关键：选择必须跨请求/跨轮次持久 → 新 store 实例从磁盘重读
    expect(makeStore().getActive(OWNER)).toBe(s.id)
  })

  it('setActive 拒绝不存在的会话（不落无效指针）', () => {
    const store = makeStore()
    expect(store.setActive(OWNER, 'is_none')).toBe(false)
    expect(store.getActive(OWNER)).toBeNull()
  })

  it('clearActive 清指针并删除 .active 文件', () => {
    const store = makeStore()
    const s = store.create(OWNER, { title: '会话一' })
    store.setActive(OWNER, s.id)
    const activePath = join(join(TEST_DIR, 'sessions'), OWNER, 'ai', '.active')
    expect(existsSync(activePath)).toBe(true)
    store.clearActive(OWNER)
    expect(store.getActive(OWNER)).toBeNull()
    expect(existsSync(activePath)).toBe(false)
  })

  it('损坏的 .active → 视为无选择（不抛错）', () => {
    const store = makeStore()
    const aiDir = join(join(TEST_DIR, 'sessions'), OWNER, 'ai')
    mkdirSync(aiDir, { recursive: true })
    writeFileSync(join(aiDir, '.active'), '{ not json', 'utf-8')
    expect(store.getActive(OWNER)).toBeNull()
  })

  it('.active 不参与会话索引（scanAndIndex 只认 .json）', () => {
    const store = makeStore()
    const s = store.create(OWNER, { title: '会话一' })
    store.setActive(OWNER, s.id)
    expect(store.list(OWNER).map((x) => x.id)).toEqual([s.id])
  })

  it('delete 正指向的会话 → 同步清指针', () => {
    const store = makeStore()
    const s = store.create(OWNER, { title: '会话一' })
    store.setActive(OWNER, s.id)
    store.delete(OWNER, s.id)
    expect(store.getActive(OWNER)).toBeNull()
  })

  it('delete 非指向的会话 → 指针保持', () => {
    const store = makeStore()
    const a = store.create(OWNER, { title: 'A' })
    const b = store.create(OWNER, { title: 'B' })
    store.setActive(OWNER, a.id)
    store.delete(OWNER, b.id)
    expect(store.getActive(OWNER)).toBe(a.id)
  })

  it('deleteByOwner → 级联清指针', () => {
    const store = makeStore()
    const s = store.create(OWNER, { title: '会话一' })
    store.setActive(OWNER, s.id)
    store.deleteByOwner(OWNER)
    expect(store.getActive(OWNER)).toBeNull()
  })
})

/* ============================ 2. 工具层：SessionSelectTool ============================ */

describe('SessionSelectTool（会话选择：AI 自己路由）', () => {
  it('未注入 store（getInternalSessionStore 缺失）→ 明确错误', async () => {
    const t = new SessionSelectTool()
    const res = await t.execute({ action: 'list' }, { sessionId: OWNER } as unknown as ToolContext)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('内部会话存储不可用')
  })

  it('ctx.sessionId 为空 → 明确错误（按用户会话归属）', async () => {
    const t = new SessionSelectTool()
    const res = await t.execute(
      { action: 'list' },
      { getInternalSessionStore: () => makeStore() } as unknown as ToolContext
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain('ctx.sessionId 为空')
  })

  it('未知 action → 明确错误', async () => {
    const t = new SessionSelectTool()
    const res = await t.execute({ action: 'bogus' }, makeCtx(makeStore()))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('未知 action')
  })

  it('list 空存储 → hints 提示 create 或等自动路由建档', async () => {
    const t = new SessionSelectTool()
    const res = await t.execute({ action: 'list' }, makeCtx(makeStore()))
    expect(res.ok).toBe(true)
    expect(res.data.sessions).toEqual([])
    expect(res.data.activeInternalId).toBeNull()
    expect(res.data.hints).toContain('create')
  })

  it('list 渲染逆生树三边：可写尾端 / 锁定 / 承接指针 / 新话题全标记', async () => {
    const store = makeStore()
    const root = store.create(OWNER, { title: '根会话' })
    const fork = store.create(OWNER, { title: '时间副本', isTimeFork: true, timeSourceId: root.id })
    // root 向时间下级延续 → 锁定只读；fork 成为唯一可写尾端
    await store.update(OWNER, root.id, { timeBranchId: fork.id })
    store.setActive(OWNER, fork.id)

    const t = new SessionSelectTool()
    const res = await t.execute({ action: 'list' }, makeCtx(store))
    expect(res.ok).toBe(true)
    const byId = new Map((res.data.sessions as Array<{ id: string }>).map((s) => [s.id, s]))
    const rootRow = byId.get(root.id)!
    const forkRow = byId.get(fork.id)!
    expect(rootRow.writableTail).toBe(false)
    expect(rootRow.locked).toBe(true)
    expect(forkRow.writableTail).toBe(true)
    expect(forkRow.locked).toBe(false)
    expect(forkRow.active).toBe(true)
    // 三边摆放文本：继承轴（代际）+ 时间延续（分叉/锁定，同为向下语义）+ 新话题（虚线）
    expect(rootRow.placement).toContain('代际：第 1 代（根会话')
    expect(rootRow.placement).toContain('时间线')
    expect(rootRow.placement).toContain('已向时间下级')
    expect(forkRow.placement).toContain('时间分叉副本')
    expect(res.data.activeInternalId).toBe(fork.id)
    expect(res.data.writableTails).toEqual([fork.id])
  })

  it('list 渲染新话题边：isNewTopic 会话带「挂接自/虚线/不复制」措辞，仍列可写尾端', async () => {
    const store = makeStore()
    const parent = store.create(OWNER, { title: '父线', content: 'x' })
    const top = store.create(OWNER, {
      title: '新话题线',
      parentId: parent.id,
      gen: (parent.gen ?? 1) + 1,
      isNewTopic: true
    })
    const t = new SessionSelectTool()
    const res = await t.execute({ action: 'list' }, makeCtx(store))
    expect(res.ok).toBe(true)
    const byId = new Map((res.data.sessions as Array<{ id: string }>).map((s) => [s.id, s]))
    const topRow = byId.get(top.id)!
    // 新话题线是虚线分支：措辞明示「挂接自父、AI 判定新话题新开、不复制父内容」，而非「继承自」
    expect(topRow.placement).toContain('挂接自')
    expect(topRow.placement).not.toContain('继承自')
    expect(topRow.placement).toContain('新话题新开')
    expect(topRow.placement).toContain('不复制父会话内容')
    expect(topRow.placement).toContain('虚线')
    // 新话题线自身无子、无 timeBranchId → 仍是可写尾端，可被 AI 选中承接后续
    expect(topRow.writableTail).toBe(true)
    expect(res.data.writableTails).toContain(top.id)
  })

  it('select 可写尾端 → 设承接指针并返回确认消息', async () => {
    const store = makeStore()
    const s = store.create(OWNER, { title: '目标会话' })
    const t = new SessionSelectTool()
    const res = await t.execute({ action: 'select', internalId: s.id }, makeCtx(store))
    expect(res.ok).toBe(true)
    expect(store.getActive(OWNER)).toBe(s.id)
    expect(res.data.message).toContain('设为当前承接会话')
  })

  it('select 锁定会话（有 timeBranchId）→ 拒绝且不设指针', async () => {
    const store = makeStore()
    const root = store.create(OWNER, { title: '根会话' })
    const fork = store.create(OWNER, { title: '副本', isTimeFork: true, timeSourceId: root.id })
    await store.update(OWNER, root.id, { timeBranchId: fork.id })
    const t = new SessionSelectTool()
    const res = await t.execute({ action: 'select', internalId: root.id }, makeCtx(store))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('锁定')
    expect(store.getActive(OWNER)).toBeNull()
  })

  it('select 被压缩的父会话（有继承子）→ 拒绝', async () => {
    const store = makeStore()
    const parent = store.create(OWNER, { title: '父会话' })
    store.create(OWNER, { title: '继承子', parentId: parent.id })
    const t = new SessionSelectTool()
    const res = await t.execute({ action: 'select', internalId: parent.id }, makeCtx(store))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('继承')
    expect(store.getActive(OWNER)).toBeNull()
  })

  it('select 不存在的会话 → 拒绝并提示先 list', async () => {
    const t = new SessionSelectTool()
    const res = await t.execute({ action: 'select', internalId: 'is_gone' }, makeCtx(makeStore()))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('不存在')
  })

  it('select 缺 internalId → 拒绝', async () => {
    const t = new SessionSelectTool()
    const res = await t.execute({ action: 'select' }, makeCtx(makeStore()))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('internalId')
  })

  it('create → 新建空白会话并承接（跨实例可读指针）', async () => {
    const store = makeStore()
    const t = new SessionSelectTool()
    const res = await t.execute({ action: 'create', title: '新主题' }, makeCtx(store))
    expect(res.ok).toBe(true)
    const id = res.data.internalId as string
    expect(store.getActive(OWNER)).toBe(id)
    expect(store.get(OWNER, id)?.title).toBe('新主题')
    // 无既有会话 → 建独立根（不带 parentId），文件落在 ai/ 根目录
    expect(store.get(OWNER, id)?.parentId).toBeUndefined()
    expect(store.get(OWNER, id)?.filePath).toBe(`${id}.json`)
    expect(makeStore().getActive(OWNER)).toBe(id)
  })

  it('create 带 parentId → 分叉出原样继承父内容的新会话（父保持原样）', async () => {
    const store = makeStore()
    const parent = store.create(OWNER, { title: '承接者', content: '已有内容' })
    const t = new SessionSelectTool()
    const res = await t.execute({ action: 'create', title: '子话题', parentId: parent.id }, makeCtx(store))
    expect(res.ok).toBe(true)
    const created = store.get(OWNER, res.data.internalId as string)!
    expect(created.parentId).toBe(parent.id)
    expect(created.gen).toBe(2)
    expect(created.filePath.startsWith(`${parent.id}/`)).toBe(true)
    expect(res.data.message).toContain('分叉')
    // 分支语义：新会话原样继承父会话内容（消息逐字复制、对象不共享引用），父会话保持原样
    expect(created.messages.map((m) => m.content)).toEqual(['已有内容'])
    const parentAfter = store.get(OWNER, parent.id)!
    expect(parentAfter.timeBranchId).toBeUndefined()
    expect(parentAfter.messages.map((m) => m.content)).toEqual(['已有内容'])
    // 只多出这一条新会话（不再另造时间副本）
    expect(store.list(OWNER)).toHaveLength(2)
    expect(store.getActive(OWNER)).toBe(created.id)
  })

  it('create 不带 parentId 且有既有可写尾端 → 自动从最近可写尾端分叉（不另起独立根）', async () => {
    const store = makeStore()
    const tail = store.create(OWNER, { title: '最近尾端', content: 'x' })
    const t = new SessionSelectTool()
    const res = await t.execute({ action: 'create', title: '新分支' }, makeCtx(store))
    expect(res.ok).toBe(true)
    const created = store.get(OWNER, res.data.internalId as string)!
    expect(created.parentId).toBe(tail.id)
    expect(res.data.parentId).toBe(tail.id)
    expect(created.messages.map((m) => m.content)).toEqual(['x']) // 原样继承
    expect(store.list(OWNER)).toHaveLength(2)
    expect(store.get(OWNER, tail.id)?.timeBranchId).toBeUndefined()
  })

  it('create 带 newTopic=true 且有父 → 新话题虚线分支：空白承接、不复制父内容、挂父下端', async () => {
    const store = makeStore()
    const parent = store.create(OWNER, { title: '旧话题', content: '旧内容' })
    const t = new SessionSelectTool()
    const res = await t.execute({ action: 'create', title: '新话题', parentId: parent.id, newTopic: true }, makeCtx(store))
    expect(res.ok).toBe(true)
    const created = store.get(OWNER, res.data.internalId as string)!
    // 虚线新话题：isNewTopic 落盘、空白承接（不复制父消息/摘要/缓存）
    expect(created.isNewTopic).toBe(true)
    expect(created.messages.map((m) => m.content)).toEqual([])
    expect(created.summary).toBe('')
    expect(created.title).toBe('新话题')
    // 树形挂接保留：区别于独立根，虚线从该尾端引出
    expect(created.parentId).toBe(parent.id)
    expect(created.gen).toBe(2)
    expect(created.filePath.startsWith(`${parent.id}/`)).toBe(true)
    expect(res.data.message).toContain('新话题')
    expect(store.list(OWNER)).toHaveLength(2)
    expect(store.getActive(OWNER)).toBe(created.id)
  })

  it('create 带 newTopic=true 且无父 → 新话题独立根（无挂接，isNewTopic 落盘）', async () => {
    const store = makeStore()
    const t = new SessionSelectTool()
    const res = await t.execute({ action: 'create', title: '全新话题', newTopic: true }, makeCtx(store))
    expect(res.ok).toBe(true)
    const created = store.get(OWNER, res.data.internalId as string)!
    expect(created.isNewTopic).toBe(true)
    expect(created.parentId).toBeUndefined()
    expect(created.messages).toEqual([])
    expect(store.getActive(OWNER)).toBe(created.id)
  })

  it('create 缺省（不传 newTopic）→ 延续实线语义：不设 isNewTopic、原样继承父内容', async () => {
    const store = makeStore()
    const parent = store.create(OWNER, { title: '旧话题', content: '旧内容' })
    const t = new SessionSelectTool()
    const res = await t.execute({ action: 'create', title: '延续', parentId: parent.id }, makeCtx(store))
    const created = store.get(OWNER, res.data.internalId as string)!
    expect(created.isNewTopic).toBeUndefined() // 缺省=实线延续
    expect(created.messages.map((m) => m.content)).toEqual(['旧内容'])
  })

  it('create 带 parentId 指向锁定会话 → 拒绝（不能挂在已冻结/已延续父下）', async () => {
    const store = makeStore()
    const locked = store.create(OWNER, { title: '已延续' })
    const fork = store.create(OWNER, { title: '副本', isTimeFork: true, timeSourceId: locked.id })
    await store.update(OWNER, locked.id, { timeBranchId: fork.id })
    const t = new SessionSelectTool()
    const res = await t.execute({ action: 'create', title: 'x', parentId: locked.id }, makeCtx(store))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('可写尾端')
  })

  it('release → 清指针并返回原承接 id；无指针时提示保持自动路由', async () => {
    const store = makeStore()
    const s = store.create(OWNER, { title: '会话一' })
    store.setActive(OWNER, s.id)
    const t = new SessionSelectTool()
    const res = await t.execute({ action: 'release' }, makeCtx(store))
    expect(res.ok).toBe(true)
    expect(res.data.releasedInternalId).toBe(s.id)
    expect(store.getActive(OWNER)).toBeNull()

    const res2 = await t.execute({ action: 'release' }, makeCtx(store))
    expect(res2.ok).toBe(true)
    expect(res2.data.releasedInternalId).toBeNull()
    expect(res2.data.message).toContain('自动路由')
  })
})

/* ===================== 3. 摘要契约：AI 自写自改、选择注入与回注 ===================== */

describe('SessionSelectTool · 摘要契约（AI 写/改/选：顶层唯一 summary 字段）', () => {
  it('create 带 summary → 初始摘要写入新会话顶层字段（独立根路径）', async () => {
    const store = makeStore()
    const t = new SessionSelectTool()
    const res = await t.execute({ action: 'create', title: '新主题', summary: '这条线负责调研内部会话的 NNG 结构' }, makeCtx(store))
    expect(res.ok).toBe(true)
    expect(res.data.summary).toBe('这条线负责调研内部会话的 NNG 结构')
    const created = store.get(OWNER, res.data.internalId as string)!
    // 摘要落顶层唯一字段，且是「AI 写」的初始自述（不是空串等后台占位）
    expect(created.summary).toBe('这条线负责调研内部会话的 NNG 结构')
    expect(store.list(OWNER)[0].summary).toBe('这条线负责调研内部会话的 NNG 结构')
  })

  it('create 带 parentId+summary → 新会话用初始摘要；不带则沿用父会话摘要', async () => {
    const store = makeStore()
    const parent = store.create(OWNER, { title: '承接者', content: '旧内容' })
    await store.update(OWNER, parent.id, { summary: '父自述：AI 路由示例' })
    const t = new SessionSelectTool()
    const res = await t.execute({ action: 'create', title: '子话题', parentId: parent.id, summary: '子线自述：继续做分支' }, makeCtx(store))
    expect(res.ok).toBe(true)
    const created = store.get(OWNER, res.data.internalId as string)!
    expect(created.summary).toBe('子线自述：继续做分支')
    // 不带 summary → 沿用父会话摘要（新线与父同源自述，识别需要时再改写）
    const res2 = await t.execute({ action: 'create', title: '子话题2', parentId: created.id }, makeCtx(store))
    const created2 = store.get(OWNER, res2.data.internalId as string)!
    expect(created2.summary).toBe('子线自述：继续做分支')
  })

  it('create 不带 summary → 新会话顶层 summary 为空（留待后台维护器/update-summary 生成）', async () => {
    const store = makeStore()
    const t = new SessionSelectTool()
    const res = await t.execute({ action: 'create', title: '无摘要话题' }, makeCtx(store))
    expect(res.ok).toBe(true)
    expect(res.data.summary).toBeUndefined()
    const created = store.get(OWNER, res.data.internalId as string)!
    expect(created.summary ?? '').toBe('')
  })

  it('update-summary 可写尾端 → 成功改写摘要并落盘（后端读到的也是新值）', async () => {
    const store = makeStore()
    const s = store.create(OWNER, { title: '会话一' })
    const t = new SessionSelectTool()
    const res = await t.execute({ action: 'update-summary', internalId: s.id, summary: '改后自述：这段专门做摘要维护' }, makeCtx(store))
    expect(res.ok).toBe(true)
    expect(res.data.action).toBe('update-summary')
    expect(res.data.summary).toBe('改后自述：这段专门做摘要维护')
    // 落盘跨实例可读（选择注入依赖的是持久化后的摘要）
    expect(makeStore().get(OWNER, s.id)?.summary).toBe('改后自述：这段专门做摘要维护')
  })

  it('update-summary 锁定会话（有 timeBranchId）→ 拒绝（冻结底稿摘要不可改）', async () => {
    const store = makeStore()
    const root = store.create(OWNER, { title: '根会话', content: 'x' })
    const fork = store.create(OWNER, { title: '副本', isTimeFork: true, timeSourceId: root.id })
    await store.update(OWNER, root.id, { timeBranchId: fork.id })
    const t = new SessionSelectTool()
    const res = await t.execute({ action: 'update-summary', internalId: root.id, summary: '想改写' }, makeCtx(store))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('锁定')
    expect(store.get(OWNER, root.id)?.summary).not.toBe('想改写')
  })

  it('update-summary 被压缩的父会话（有继承子）→ 拒绝（冻结底稿摘要不可改）', async () => {
    const store = makeStore()
    const parent = store.create(OWNER, { title: '父会话' })
    await store.update(OWNER, parent.id, { summary: '父摘要' })
    store.create(OWNER, { title: '继承子', parentId: parent.id })
    const t = new SessionSelectTool()
    const res = await t.execute({ action: 'update-summary', internalId: parent.id, summary: '想改写' }, makeCtx(store))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('继承')
    expect(store.get(OWNER, parent.id)?.summary).toBe('父摘要')
  })

  it('update-summary 不存在的会话 / 缺参数 → 拒绝', async () => {
    const t = new SessionSelectTool()
    const resMissing = await t.execute({ action: 'update-summary', internalId: 'is_gone', summary: 'x' }, makeCtx(makeStore()))
    expect(resMissing.ok).toBe(false)
    expect(resMissing.error).toContain('不存在')
    const resNoId = await t.execute({ action: 'update-summary', summary: 'x' }, makeCtx(makeStore()))
    expect(resNoId.ok).toBe(false)
    expect(resNoId.error).toContain('internalId')
    const resNoSum = await t.execute({ action: 'update-summary', internalId: 'is_gone' }, makeCtx(makeStore()))
    expect(resNoSum.ok).toBe(false)
    expect(resNoSum.error).toContain('summary')
  })

  it('select 回执回显摘要（选择的回注依据）：有摘要回显原文、无摘要提示可补写', async () => {
    const store = makeStore()
    const withSum = store.create(OWNER, { title: '有摘要', summary: '这是会话的身份自述' })
    const noSum = store.create(OWNER, { title: '无摘要' })
    const t = new SessionSelectTool()
    const resWith = await t.execute({ action: 'select', internalId: withSum.id }, makeCtx(store))
    expect(resWith.ok).toBe(true)
    expect(resWith.data.summary).toBe('这是会话的身份自述')
    const resNo = await t.execute({ action: 'select', internalId: noSum.id }, makeCtx(store))
    expect(resNo.ok).toBe(true)
    expect(resNo.data.summary).toContain('无摘要')
    expect(resNo.data.summary).toContain('update-summary')
  })

  it('list 每条候选带 summary 字段（供 AI 依据摘要选择会话）', async () => {
    const store = makeStore()
    const a = store.create(OWNER, { title: 'A', summary: 'A 自述' })
    const b = store.create(OWNER, { title: 'B' })
    const t = new SessionSelectTool()
    const res = await t.execute({ action: 'list' }, makeCtx(store))
    expect(res.ok).toBe(true)
    const byId = new Map((res.data.sessions as Array<{ id: string; summary?: string }>).map((s) => [s.id, s]))
    expect(byId.get(a.id)?.summary).toBe('A 自述')
    expect(byId.get(b.id)?.summary ?? '').toBe('')
    // 选择规则提示：先读摘要再决定 select / update-summary / create
    expect(res.data.hints).toContain('摘要')
  })
})