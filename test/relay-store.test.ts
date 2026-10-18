// 中继存储层（RelayStore）单元测试
// 为什么存在：中继条目的状态机（合法/非法迁移）、多机并发取件隔离（条目目录按 itemId
//   收敛 + 目录穿越整流）与无人确认过期清理是中继存储层三条核心语义，不依赖真实 LAN，
//   用临时目录即可逐条验证。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RelayStore } from '../electron/main/multi-instance/relay/relay-store'
import type { RelayEntry } from '../electron/main/multi-instance/relay/relay-types'

/** 构造合法条目；over 覆盖字段以表达单测场景 */
function makeEntry(over: Partial<RelayEntry> = {}): RelayEntry {
  return {
    itemId: 'item-1',
    senderUid: 1,
    senderName: 'alice',
    receiverUid: 2,
    receiverName: 'bob',
    kind: 'file',
    name: 'a.txt',
    totalBytes: 8,
    files: 1,
    dirs: 0,
    createdAt: Date.now(),
    status: 'uploading',
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    ...over
  }
}

describe('RelayStore 状态机', () => {
  let root: string
  let store: RelayStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'relay-store-test-'))
    store = new RelayStore(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('合法链 uploading → uploaded → notified → downloaded 逐级落盘', () => {
    store.upsert(makeEntry())
    expect(store.transition('item-1', 'uploaded')).toBe(true)
    expect(store.transition('item-1', 'notified')).toBe(true)
    expect(store.transition('item-1', 'downloaded', { downloadedAt: Date.now() })).toBe(true)
    const entry = store.get('item-1')
    expect(entry?.status).toBe('downloaded')
    expect(entry?.downloadedAt).toBeGreaterThan(0)
  })

  it('非法迁移拒绝且不落盘（不得跳过中间态/退回/终态外迁）', () => {
    store.upsert(makeEntry())
    // uploading 直接到 downloaded：跳过 uploaded/notified，拒绝
    expect(store.transition('item-1', 'downloaded')).toBe(false)
    expect(store.transition('item-1', 'uploaded')).toBe(true)
    // 已 uploaded 回退 uploading：拒绝
    expect(store.transition('item-1', 'uploading')).toBe(false)
    // 终态 downloaded 后任何迁移都拒绝
    expect(store.transition('item-1', 'notified')).toBe(true)
    expect(store.transition('item-1', 'downloaded')).toBe(true)
    expect(store.transition('item-1', 'expired')).toBe(false)
    expect(store.get('item-1')?.status).toBe('downloaded')
  })

  it('不存在的条目迁移返回 false', () => {
    expect(store.transition('no-such-item', 'uploaded')).toBe(false)
  })
})

describe('RelayStore 多机并发取件隔离', () => {
  let root: string
  let store: RelayStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'relay-store-test-'))
    store = new RelayStore(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('不同条目文件实体按 itemId 收敛到互不干扰的独立目录', () => {
    const dirA = store.ensureFiles('item-a')
    const dirB = store.ensureFiles('item-b')
    expect(dirA).toBe(join(root, 'relay', 'files', 'item-a'))
    expect(dirB).toBe(join(root, 'relay', 'files', 'item-b'))
    writeFileSync(join(dirA!, 'x.txt'), 'a')
    writeFileSync(join(dirB!, 'y.txt'), 'b')
    // 两间目录互不包含对方文件：多机并发取件各自只读自己的条目目录
    expect(existsSync(join(dirA!, 'y.txt'))).toBe(false)
    expect(existsSync(join(dirB!, 'x.txt'))).toBe(false)
  })

  it('目录穿越/危险 itemId 整流拒绝（不允许实体逃出 {root}/relay/files/）', () => {
    for (const bad of ['../evil', '..', 'a/b', 'a\\b', 'a:b', '.hidden', '']) {
      expect(store.filesRoot(bad)).toBeNull()
      expect(store.ensureFiles(bad)).toBeNull()
    }
  })

  it('remove 删除条目并连带删除文件实体（撤回/过期清理路径）', () => {
    store.upsert(makeEntry())
    const dir = store.ensureFiles('item-1')
    writeFileSync(join(dir!, 'a.txt'), 'content')
    store.remove('item-1', true)
    expect(store.get('item-1')).toBeNull()
    expect(existsSync(dir!)).toBe(false)
  })
})

describe('RelayStore 无人确认过期清理', () => {
  let root: string
  let store: RelayStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'relay-store-test-'))
    store = new RelayStore(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('已过保留期且未下载的条目 → 置 expired 并删除文件实体', () => {
    store.upsert(makeEntry({ status: 'uploaded', expiresAt: Date.now() - 1000 }))
    const dir = store.ensureFiles('item-1')
    writeFileSync(join(dir!, 'a.txt'), 'content')
    expect(store.sweepExpired()).toBe(1)
    expect(store.get('item-1')?.status).toBe('expired')
    expect(existsSync(dir!)).toBe(false)
  })

  it('终态（downloaded/expired）与未过期条目不清理', () => {
    store.upsert(makeEntry({ itemId: 'dl', status: 'downloaded', expiresAt: Date.now() - 1000 }))
    store.upsert(makeEntry({ itemId: 'exp', status: 'expired', expiresAt: Date.now() - 1000 }))
    store.upsert(makeEntry({ itemId: 'fresh', status: 'uploaded', expiresAt: Date.now() + 10000 }))
    expect(store.sweepExpired()).toBe(0)
    expect(store.get('dl')?.status).toBe('downloaded')
    expect(store.get('exp')?.status).toBe('expired')
    expect(store.get('fresh')?.status).toBe('uploaded')
  })

  it('混合场景：只清理过期未下载的，剩余条目与文件彼此隔离', () => {
    store.upsert(makeEntry({ itemId: 'stale', status: 'uploaded', expiresAt: Date.now() - 1 }))
    store.upsert(makeEntry({ itemId: 'keep', status: 'uploaded', expiresAt: Date.now() + 10000 }))
    const staleDir = store.ensureFiles('stale')
    const keepDir = store.ensureFiles('keep')
    writeFileSync(join(staleDir!, 'a.txt'), 'x')
    writeFileSync(join(keepDir!, 'b.txt'), 'y')
    expect(store.sweepExpired()).toBe(1)
    expect(store.get('stale')?.status).toBe('expired')
    expect(existsSync(staleDir!)).toBe(false)
    expect(store.get('keep')?.status).toBe('uploaded')
    expect(existsSync(join(keepDir!, 'b.txt'))).toBe(true)
  })

  it('多次清扫幂等：已 expired 不再重复计数', () => {
    store.upsert(makeEntry({ status: 'uploaded', expiresAt: Date.now() - 1000 }))
    expect(store.sweepExpired()).toBe(1)
    expect(store.sweepExpired()).toBe(0)
  })

  it('条目清单数与文件实体目录数一致（不与其他系统数据混放）', () => {
    store.upsert(makeEntry())
    store.upsert(makeEntry({ itemId: 'item-2', receiverUid: 3 }))
    store.ensureFiles('item-1')
    store.ensureFiles('item-2')
    expect(store.list()).toHaveLength(2)
    const filesRoot = join(root, 'relay', 'files')
    expect(readdirSync(filesRoot).sort()).toEqual(['item-1', 'item-2'])
    // relay 存储只落在 {root}/relay 下，根目录不产生其他系统数据（账号/记忆不混入）
    expect(readdirSync(root).sort()).toEqual(['relay'])
  })
})