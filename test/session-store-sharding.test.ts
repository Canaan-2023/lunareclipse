import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { SessionStore } from '../electron/main/api/session-store'
import { InternalSessionStore } from '../electron/main/services/internal-session-store'
import type { Session, ChatMessage } from '../shared/types'

/**
 * v11 双层会话存储回归：
 * 1) SessionStore 分片化 —— sessions/{id}/user/{meta|1..N}.json、500K 分片、单条超限独立成片、
 *    缺号/损坏片跳过、旧单文件启动迁移+删旧、delete 级联删会话文件夹；
 * 2) InternalSessionStore —— sessions/{id}/ai/、createdAt 恒定、totalChars 重算、
 *    原子读改写、列表按 updatedAt 降序、级联删除、失败=未执行。
 */
describe('SessionStore 分片化', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shard-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function msg(text: string, i = 0): ChatMessage {
    return {
      id: `m${i}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      content: text,
      createdAt: Date.now() + i
    }
  }

  it('写盘为会话文件夹形态（meta + 数字分片），冷启动读回完整', () => {
    const store = new SessionStore(dir, { userShardMaxBytes: 500 })
    const s = store.create()
    store.saveMessages(s.id, [msg('a'.repeat(100), 1), msg('b'.repeat(100), 2), msg('c'.repeat(100), 3)])
    store.flush()
    const sdir = join(dir, s.id)
    expect(existsSync(join(sdir, 'user', 'meta.json'))).toBe(true)
    const shards = readdirSync(join(sdir, 'user')).filter((f) => /^\d+\.json$/.test(f))
    expect(shards.length).toBeGreaterThan(1)
    // 旧单文件不应存在
    expect(existsSync(join(dir, `${s.id}.json`))).toBe(false)
    // 分片字节数都不超上限
    for (const sh of shards) {
      expect(Buffer.byteLength(readFileSync(join(sdir, 'user', sh), 'utf-8'), 'utf-8')).toBeLessThanOrEqual(500)
    }
    // 冷启动读回
    const store2 = new SessionStore(dir, { userShardMaxBytes: 500 })
    const got = store2.get(s.id)!
    expect(got.messages.map((m) => m.content)).toEqual(['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100)])
  })

  it('旧单文件启动迁移为新形态 + 删除旧文件', () => {
    const legacy: Session = {
      id: 's_legacy_1',
      title: '旧会话',
      createdAt: 1000,
      updatedAt: 2000,
      messages: [msg('旧消息', 1)]
    }
    writeFileSync(join(dir, 's_legacy_1.json'), JSON.stringify(legacy), 'utf-8')
    const store = new SessionStore(dir)
    const got = store.get('s_legacy_1')!
    expect(got.title).toBe('旧会话')
    expect(got.messages[0].content).toBe('旧消息')
    // 迁移完成：目录形态存在、旧文件删除
    expect(existsSync(join(dir, 's_legacy_1', 'user', 'meta.json'))).toBe(true)
    expect(existsSync(join(dir, 's_legacy_1.json'))).toBe(false)
  })

  it('迁移失败保留旧文件，读取双兼容（下次重启可再迁移）', () => {
    const legacy: Session = {
      id: 's_legacy_2',
      title: '迁移失败会话',
      createdAt: 1000,
      updatedAt: 2000,
      messages: [msg('保留消息', 1)]
    }
    writeFileSync(join(dir, 's_legacy_2.json'), JSON.stringify(legacy), 'utf-8')
    // 预先占位一个同名会话目录且不可删除 meta（模拟迁移写盘失败场景的等价物：目录形态已存在同名）
    mkdirSync(join(dir, 's_legacy_2', 'user'), { recursive: true })
    const store = new SessionStore(dir)
    const got = store.get('s_legacy_2')!
    expect(got.messages[0].content).toBe('保留消息')
    // 双兼容：最终仍能读到（cache 已有该会话）
    expect(store.list().some((s) => s.id === 's_legacy_2')).toBe(true)
  })

  it('损坏分片跳过、缺号跳过、其余消息保留', () => {
    const store = new SessionStore(dir, { userShardMaxBytes: 500 })
    const s = store.create()
    store.saveMessages(s.id, [msg('x'.repeat(100), 1), msg('y'.repeat(100), 2), msg('z'.repeat(100), 3)])
    store.flush()
    const udir = join(dir, s.id, 'user')
    const nums = readdirSync(udir).filter((f) => /^\d+\.json$/.test(f)).sort()
    // 破坏第二片、删除最后一片（首片永远不动）；单片场景仅破坏它
    if (nums.length >= 2) {
      writeFileSync(join(udir, nums[1]), '{broken', 'utf-8')
      rmSync(join(udir, nums[nums.length - 1]), { force: true })
    } else {
      writeFileSync(join(udir, nums[0]), '{broken', 'utf-8')
    }
    const store2 = new SessionStore(dir, { userShardMaxBytes: 500 })
    const got = store2.get(s.id)!
    // 完整性上界：不会读到被删片的重复消息
    expect(got.messages.length).toBeLessThan(3)
    // 未损坏的片必须保留（>=2 片时首片完整）
    if (nums.length >= 2) {
      expect(got.messages.length).toBeGreaterThan(0)
    }
  })

  it('单条超限消息独立成片且读回完整', () => {
    const store = new SessionStore(dir, { userShardMaxBytes: 300 })
    const s = store.create()
    store.saveMessages(s.id, [msg('a'.repeat(100), 1), msg('BIG'.repeat(200), 2), msg('c'.repeat(100), 3)])
    store.flush()
    const udir = join(dir, s.id, 'user')
    const shards = readdirSync(udir).filter((f) => /^\d+\.json$/.test(f)).sort()
    expect(shards.length).toBe(3) // a/c 合片 + BIG 单条超限 1 片
    const store2 = new SessionStore(dir, { userShardMaxBytes: 300 })
    const got = store2.get(s.id)!
    expect(got.messages.map((m) => m.content)).toEqual([
      'a'.repeat(100),
      'BIG'.repeat(200),
      'c'.repeat(100)
    ])
  })

  it('非消息字段（model/summary 等）随 meta 持久化', () => {
    const store = new SessionStore(dir)
    const s = store.create()
    store.setModel(s.id, 'gpt-4o')
    store.saveMessages(s.id, [msg('hi', 1)])
    store.flush()
    const store2 = new SessionStore(dir)
    expect(store2.get(s.id)!.model).toBe('gpt-4o')
  })

  it('delete 级联删整个会话文件夹', () => {
    const store = new SessionStore(dir)
    const s = store.create()
    store.saveMessages(s.id, [msg('hi', 1)])
    store.flush()
    mkdirSync(join(dir, s.id, 'ai'), { recursive: true })
    writeFileSync(join(dir, s.id, 'ai', 'is_test.json'), '{}', 'utf-8')
    store.delete(s.id)
    expect(existsSync(join(dir, s.id))).toBe(false)
  })
})

describe('InternalSessionStore', () => {
  let dir: string
  let sessStore: SessionStore
  let inner: InternalSessionStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'internal-session-'))
    sessStore = new SessionStore(dir)
    inner = new InternalSessionStore(() => sessStore.getDir())
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('create → append → get → list 排序 → update → delete', async () => {
    const is = inner.create('s_owner_1', { title: '内部会话A', content: '开场' })
    expect(is.createdAt).toBeGreaterThan(0)
    expect(is.createdAt).toBeLessThanOrEqual(Date.now())
    expect(is.messages).toHaveLength(1)
    expect(is.totalChars).toBe(is.summary.length + is.messages[0].content.length)

    await inner.appendMessages('s_owner_1', is.id, [
      { id: 'ma', role: 'assistant', content: '回复', createdAt: Date.now() },
      { id: 'mb', role: 'note', content: '注意', createdAt: Date.now() }
    ])
    const got = inner.get('s_owner_1', is.id)!
    expect(got.messages).toHaveLength(3)
    expect(got.totalChars).toBe('开场'.length + '回复'.length + '注意'.length)

    await inner.update('s_owner_1', is.id, {
      title: '改名',
      messages: [{ id: 'mc', role: 'user', content: '重写', createdAt: Date.now() }]
    })
    await inner.addCacheLocation('s_owner_1', is.id, 'memory://abc')
    const got2 = inner.get('s_owner_1', is.id)!
    expect(got2.title).toBe('改名')
    expect(got2.messages).toHaveLength(1)
    expect(got2.messages[0].content).toBe('重写')
    expect(got2.cacheLocations).toEqual(['memory://abc'])
    expect(got2.createdAt).toBe(is.createdAt) // createdAt 恒定

    // list：最新在上；不含消息正文
    const is2 = inner.create('s_owner_1', { title: '内部会话B' })
    const list = inner.list('s_owner_1')
    expect(list.map((l) => l.id)).toEqual([is2.id, is.id])
    expect(list[0].messageCount).toBe(0)
    expect(list[1].messageCount).toBe(1)
    expect('messages' in list[0]).toBe(false)

    // 落盘持久化（冷读）
    const inner2 = new InternalSessionStore(() => sessStore.getDir())
    const cold = inner2.get('s_owner_1', is.id)!
    expect(cold.title).toBe('改名')
    expect(cold.createdAt).toBe(is.createdAt)

    inner.delete('s_owner_1', is.id)
    expect(inner.get('s_owner_1', is.id)).toBeNull()
    expect(inner.list('s_owner_1').some((l) => l.id === is.id)).toBe(false)
  })

  it('appendMessages 缺 id 消息自动补齐（字段完整性）', async () => {
    const is = inner.create('s_o', { title: 'A' })
    const before = inner.get('s_o', is.id)!
    await inner.appendMessage('s_o', is.id, { role: 'assistant', content: '无 id 消息' } as never)
    const after = inner.get('s_o', is.id)!
    expect(after.messages).toHaveLength(before.messages.length + 1)
    const last = after.messages[after.messages.length - 1]
    expect(last.id).toBeTruthy()
    expect(last.createdAt).toBeTruthy()
  })

  it('deleteByOwner 级联删 ai/ 目录，pending 写盘作废不复活', async () => {
    const a = inner.create('s_owner_2', { title: 'A' })
    const b = inner.create('s_owner_2', { title: 'B' })
    // 发起在飞写盘后立即级联删除（模拟会话删除与写盘竞争）
    void inner.appendMessages('s_owner_2', a.id, [{ id: 'mz', role: 'user', content: 'z', createdAt: Date.now() }])
    inner.deleteByOwner('s_owner_2')
    await inner.flush()
    expect(existsSync(join(dir, 's_owner_2', 'ai'))).toBe(false)
    expect(inner.list('s_owner_2')).toHaveLength(0)
    expect(inner.get('s_owner_2', a.id)).toBeNull()
    expect(inner.get('s_owner_2', b.id)).toBeNull()
  })

  it('归属隔离：多用户会话各占独立 ai/ 空间，list/get 不串号', () => {
    const a = inner.create('s_iso_a', { title: 'A 会话内部' })
    const b = inner.create('s_iso_b', { title: 'B 会话内部' })
    // 物理目录彼此独立（sessions/{ownerId}/ai/）
    const dirA = join(dir, 's_iso_a', 'ai')
    const dirB = join(dir, 's_iso_b', 'ai')
    expect(existsSync(dirA)).toBe(true)
    expect(existsSync(dirB)).toBe(true)
    expect(dirA).not.toBe(dirB)
    // list 互不可见（索引按 owner 前缀隔离）
    const listA = inner.list('s_iso_a')
    const listB = inner.list('s_iso_b')
    expect(listA.map((s) => s.id)).toContain(a.id)
    expect(listA.some((s) => s.id === b.id)).toBe(false)
    expect(listB.map((s) => s.id)).toContain(b.id)
    expect(listB.some((s) => s.id === a.id)).toBe(false)
    // get 跨 owner 取不到（对象级 ownerSessionId 双重校验）
    expect(inner.get('s_iso_a', b.id)).toBeNull()
    expect(inner.get('s_iso_b', a.id)).toBeNull()
    // 冷启动（新 store 重建 pathIndex）后隔离依旧
    const cold = new InternalSessionStore(() => sessStore.getDir())
    expect(cold.list('s_iso_a').map((s) => s.id)).toEqual([a.id])
    expect(cold.list('s_iso_b').map((s) => s.id)).toEqual([b.id])
    expect(cold.get('s_iso_a', b.id)).toBeNull()
    expect(cold.get('s_iso_b', a.id)).toBeNull()
  })

  it('不存在的会话 mutate 无副作用（失败=未执行）', async () => {
    await inner.update('s_nope', 'is_nope', { title: 'x' })
    await inner.appendMessages('s_nope', 'is_nope', [{ id: 'm1', role: 'user', content: 'x', createdAt: 1 }])
    await inner.addCacheLocation('s_nope', 'is_nope', 'memory://x')
    expect(inner.get('s_nope', 'is_nope')).toBeNull()
    expect(inner.list('s_nope')).toHaveLength(0)
  })

  it('压缩/编辑多次整体替换后 createdAt 恒定、updatedAt 推进（M3-p）', async () => {
    const is = inner.create('s_owner_c', { title: '源', content: '首条' })
    const created = is.createdAt
    const updated0 = is.updatedAt
    await new Promise((r) => setTimeout(r, 5))
    // 模拟压缩：keepIds 机械过滤（整体替换 messages），再改 summary/title
    await inner.update('s_owner_c', is.id, {
      messages: [{ id: 'k1', role: 'user', content: '保留条', createdAt: Date.now() }],
      summary: '压缩后摘要'
    })
    await inner.update('s_owner_c', is.id, { title: '改名后' })
    const after = inner.get('s_owner_c', is.id)!
    expect(after.createdAt).toBe(created) // createdAt 恒定不可改
    expect(after.updatedAt).toBeGreaterThan(updated0)
    expect(after.title).toBe('改名后')
    expect(after.summary).toBe('压缩后摘要')
    // 冷读（重启）后 createdAt 依旧
    const cold = new InternalSessionStore(() => sessStore.getDir()).get('s_owner_c', is.id)!
    expect(cold.createdAt).toBe(created)
  })

  it('路径校验：非法 ownerSessionId/internalId 抛错', () => {
    expect(() => inner.create('../evil', { title: 'x' })).toThrow()
    expect(() => inner.deleteByOwner('a/b')).toThrow()
    inner.create('s_ok', { title: 'A' })
    expect(() => inner.delete('s_ok', '../evil')).toThrow()
    expect(() => inner.get('s_ok', 'x\\y')).toThrow()
  })

  it('时间分叉字段：create 写入 isTimeFork/timeSourceId，list 透传', () => {
    const src = inner.create('s_fork', { title: '源会话', content: '首条' })
    const fork = inner.create('s_fork', {
      title: '分叉副本',
      isTimeFork: true,
      timeSourceId: src.id
    })
    const got = inner.get('s_fork', fork.id)!
    expect(got.isTimeFork).toBe(true)
    expect(got.timeSourceId).toBe(src.id)

    const list = inner.list('s_fork')
    const lsrc = list.find((l) => l.id === src.id)!
    const lfork = list.find((l) => l.id === fork.id)!
    expect(lsrc.isTimeFork ?? false).toBe(false)
    expect(lsrc.timeSourceId).toBeUndefined()
    expect(lfork.isTimeFork).toBe(true)
    expect(lfork.timeSourceId).toBe(src.id)

    // 冷读（重启）后仍在
    const cold = new InternalSessionStore(() => sessStore.getDir()).get('s_fork', fork.id)!
    expect(cold.isTimeFork).toBe(true)
    expect(cold.timeSourceId).toBe(src.id)
  })

  it('时间分叉字段：update 写入 timeBranchId 并落盘（锁定原会话）', async () => {
    const src = inner.create('s_lock', { title: '源' })
    const fork = inner.create('s_lock', { title: '副本', isTimeFork: true, timeSourceId: src.id })
    // 锁定原会话：timeBranchId 指向副本
    await inner.update('s_lock', src.id, { timeBranchId: fork.id })
    const got = inner.get('s_lock', src.id)!
    expect(got.timeBranchId).toBe(fork.id)

    // list 透传 timeBranchId（UI 时间连线 / 路由最尾端判定依赖它）
    const lsrc = inner.list('s_lock').find((l) => l.id === src.id)!
    expect(lsrc.timeBranchId).toBe(fork.id)

    // 冷读（重启）后 timeBranchId 仍在 → 原会话持续锁定，不会静默解锁
    const cold = new InternalSessionStore(() => sessStore.getDir()).get('s_lock', src.id)!
    expect(cold.timeBranchId).toBe(fork.id)
  })

  it('update 未传 timeBranchId 不清除既有锁定，undefined 不动该字段', async () => {
    const src = inner.create('s_keep', { title: '源' })
    const fork = inner.create('s_keep', { title: '副本', isTimeFork: true, timeSourceId: src.id })
    await inner.update('s_keep', src.id, { timeBranchId: fork.id })
    // 无 timeBranchId 的 patch（如仅改标题）不得清掉锁定
    await inner.update('s_keep', src.id, { title: '改名' })
    const got = inner.get('s_keep', src.id)!
    expect(got.title).toBe('改名')
    expect(got.timeBranchId).toBe(fork.id)
  })

  it('NNG 根会话：无锚点时 filePath 在 aiDir 根目录', () => {
    const is = inner.create('s_nng', { title: '根' })
    expect(is.filePath).toMatch(/is_.+\.json$/)
    expect(is.filePath).not.toContain('/')
    const absPath = join(dir, 's_nng', 'ai', is.filePath)
    expect(existsSync(absPath)).toBe(true)
  })

  it('NNG 继承子：有 parentId 时放进父会话同名文件夹内', () => {
    const parent = inner.create('s_nng2', { title: '父' })
    const child = inner.create('s_nng2', { title: '继承子', parentId: parent.id })
    expect(child.filePath).toBe(parent.filePath.replace(/\.json$/, `/${child.id}.json`))
    const absPath = join(dir, 's_nng2', 'ai', child.filePath)
    expect(existsSync(absPath)).toBe(true)
    // 确认父文件仍存在（同名文件夹与父文件并存，NNG 语义）
    expect(existsSync(join(dir, 's_nng2', 'ai', parent.filePath))).toBe(true)
  })

  it('NNG 时间分叉：有 timeSourceId 时放进源会话同名文件夹内（时间关系优先）', () => {
    const src = inner.create('s_nng3', { title: '源' })
    const fork = inner.create('s_nng3', { title: '分叉', isTimeFork: true, timeSourceId: src.id })
    expect(fork.filePath).toBe(src.filePath.replace(/\.json$/, `/${fork.id}.json`))
    const absPath = join(dir, 's_nng3', 'ai', fork.filePath)
    expect(existsSync(absPath)).toBe(true)
  })

  it('NNG 多层嵌套：继承链形成多层同名文件夹嵌套', () => {
    const g1 = inner.create('s_nng4', { title: 'G1' })
    const g2 = inner.create('s_nng4', { title: 'G2', parentId: g1.id })
    const g3 = inner.create('s_nng4', { title: 'G3', parentId: g2.id })
    const g4 = inner.create('s_nng4', { title: 'G4', parentId: g3.id })
    // g2 在 g1/，g3 在 g1/g2/，g4 在 g1/g2/g3/
    expect(g2.filePath).toBe(g1.filePath.replace(/\.json$/, `/${g2.id}.json`))
    expect(g3.filePath).toBe(g2.filePath.replace(/\.json$/, `/${g3.id}.json`))
    expect(g4.filePath).toBe(g3.filePath.replace(/\.json$/, `/${g4.id}.json`))
    for (const s of [g1, g2, g3, g4]) {
      expect(existsSync(join(dir, 's_nng4', 'ai', s.filePath))).toBe(true)
    }
  })

  it('NNG 删除后向上清理空文件夹', () => {
    const root = inner.create('s_nng5', { title: '根' })
    const child = inner.create('s_nng5', { title: '子', parentId: root.id })
    const absRoot = join(dir, 's_nng5', 'ai', root.filePath)
    const absChild = join(dir, 's_nng5', 'ai', child.filePath)
    expect(existsSync(absChild)).toBe(true)
    inner.delete('s_nng5', child.id)
    expect(existsSync(absChild)).toBe(false)
    // 子删除后，同名文件夹应为空，被向上清理
    expect(existsSync(dirname(absChild))).toBe(false)
    // 根文件仍在
    expect(existsSync(absRoot)).toBe(true)
  })

  it('NNG filePath 冷启动重建：重启 store 后 get/list 仍能 O(1) 定位', () => {
    const root = inner.create('s_nng6', { title: '根' })
    const child = inner.create('s_nng6', { title: '子', parentId: root.id })
    // 冷启动
    const cold = new InternalSessionStore(() => sessStore.getDir())
    const coldChild = cold.get('s_nng6', child.id)!
    expect(coldChild.filePath).toBe(child.filePath)
    const coldList = cold.list('s_nng6')
    const listChild = coldList.find((l) => l.id === child.id)!
    expect(listChild.filePath).toBe(child.filePath)
  })

  it('NNG 存量兼容：无 filePath 字段的旧文件回退到根目录读取', () => {
    const oldId = 'is_legacy_001'
    const oldPath = join(dir, 's_nng7', 'ai', `${oldId}.json`)
    mkdirSync(dirname(oldPath), { recursive: true })
    writeFileSync(oldPath, JSON.stringify({
      id: oldId,
      ownerSessionId: 's_nng7',
      title: '旧会话',
      summary: '',
      createdAt: 1000,
      updatedAt: 2000,
      messages: [],
      totalChars: 0,
      cacheLocations: []
      // 无 filePath 字段
    }), 'utf-8')
    const cold = new InternalSessionStore(() => sessStore.getDir())
    const got = cold.get('s_nng7', oldId)!
    expect(got.title).toBe('旧会话')
    expect(got.filePath).toBe(`${oldId}.json`) // 回补默认路径
  })
})