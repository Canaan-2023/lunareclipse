import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { SatelliteStore } from '../electron/main/multi-instance/master/satellite-store'

function yesterday(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

describe('SatelliteStore 被动日备份（maybeArchiveDaily）', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sat-archive-daily-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function seedPush(instanceId: string, seq: number, key: string, content: string): void {
    // uid/aiId 从 key 解析：与 applyPush 的条目归属校验（entry.uid 必须等于令牌账号 uid）保持一致，
    // 任一 key 形如 memory/U{uid}/AI{aiId}/…、NNG/AI{aiId}/U{uid}/…、cache/AI{aiId}/U{uid}/…
    const uid = Number(/(?:^|\/)U(\d+)\//.exec(key)?.[1] ?? 0)
    const aiId = Number(/AI(\d+)\//.exec(key)?.[1] ?? 0)
    // upsert 一律 staged：实体先落 sync_staging，applyPush 读回验 size/hash 后落镜像
    const raw = Buffer.from(content, 'utf-8')
    const stagedPath = SatelliteStore.stagingPathFor(root, uid, instanceId, key)
    mkdirSync(dirname(stagedPath), { recursive: true })
    writeFileSync(stagedPath, raw)
    new SatelliteStore(root).applyPush(uid, instanceId, [
      { instanceId, uid, aiId, op: 'upsert', key, size: raw.length, staged: true, hash: 'sha256:' + createHash('sha256').update(raw).digest('hex'), seq, ts: 't' }
    ])
  }

  it('有新数据才备份：完整镜像写 backup/U{uid}/{date}，无变化零 IO 不重复备份', () => {
    const store = new SatelliteStore(root)
    seedPush('inst-1', 1, 'memory/U7/AI1/normal/a.json', 'v1')

    // 第一次：有新数据 → 备份（archived=true），域内路径与真实工作域一致
    const r1 = store.maybeArchiveDaily('inst-1')
    const date = yesterday()
    expect(r1.archived).toBe(true)
    expect(r1.date).toBe(date)
    expect(existsSync(join(root, 'backup', 'U7', date, 'memory', 'U7', 'AI1', 'normal', 'a.json'))).toBe(true)

    // 第二次：同日且 maxSeq 未增长 → 水位命中，零 IO 直接返回
    const r2 = store.maybeArchiveDaily('inst-1')
    expect(r2.archived).toBe(false)
    expect(r2.count).toBe(0)

    // 备份未被重写（备份根下仍只有一份日期目录）
    const backupRoot = join(root, 'backup', 'U7')
    expect(readdirSync(backupRoot)).toEqual([date])
  })

  it('seq 增长后再次备份，且旧日期备份被清理（每账号只保留昨天一份）', () => {
    const store = new SatelliteStore(root)
    // 刻意先造一份"更早日期残留"（模拟历史上已不存在的旧备份）
    const oldDate = '2020-01-01'
    const backupRoot = join(root, 'backup', 'U7')
    mkdirSync(join(backupRoot, oldDate, 'memory', 'U7', 'AI1', 'normal'), { recursive: true })
    writeFileSync(join(backupRoot, oldDate, 'memory', 'U7', 'AI1', 'normal', 'old.json'), 'old', 'utf-8')

    seedPush('inst-1', 1, 'memory/U7/AI1/normal/a.json', 'v1')
    const r1 = store.maybeArchiveDaily('inst-1')
    expect(r1.archived).toBe(true)

    // 新数据：seq 增长 → 重新快照
    seedPush('inst-1', 2, 'memory/U7/AI1/normal/b.json', 'v2')
    const r2 = store.maybeArchiveDaily('inst-1')
    expect(r2.archived).toBe(true)

    // 旧备份已被清理，只剩昨天一份日期目录
    const dirs = readdirSync(backupRoot)
    expect(dirs).toEqual([yesterday()])
    expect(existsSync(join(backupRoot, oldDate))).toBe(false)
  })

  it('无任何数据（seq 空）时不产生备份目录，直接跳过', () => {
    const store = new SatelliteStore(root)
    const r = store.maybeArchiveDaily('inst-x')
    expect(r.archived).toBe(false)
    expect(existsSync(join(root, 'backup', 'U99'))).toBe(false)
  })

  it('listArchiveDetails 按 uid 聚合备份明细，按日期降序', () => {
    const store = new SatelliteStore(root)
    seedPush('inst-1', 1, 'memory/U7/AI1/normal/a.json', 'v1')
    seedPush('inst-1', 2, 'memory/U8/AI2/normal/b.json', 'v2')
    store.maybeArchiveDaily('inst-1')

    const details = store.listArchiveDetails('inst-1')
    const date = yesterday()
    expect(details).toHaveLength(2)
    expect(details).toEqual(expect.arrayContaining([
      { uid: 8, date, entryCount: 1 },
      { uid: 7, date, entryCount: 1 }
    ]))
  })

  it('collectArchive 还原 key 为备份日期根完整域前缀（打包恢复包用，可直接落回 memory/U{uid}/AI{aiId}）', () => {
    const store = new SatelliteStore(root)
    seedPush('inst-1', 1, 'memory/U7/AI1/normal/a.json', '{"x":1}')
    store.maybeArchiveDaily('inst-1')

    const date = yesterday()
    const items = store.collectArchive(7, date)
    expect(items).toEqual([{ key: 'memory/U7/AI1/normal/a.json', content: '{"x":1}' }])
    // 备份读的是快照内容，不受后续数据变更影响
    seedPush('inst-1', 2, 'memory/U7/AI1/normal/a.json', '{"x":2}')
    const again = store.collectArchive(7, date)
    expect(again[0].content).toBe('{"x":1}')
  })

  it('NNG 数据纳入备份：NNG key 落 backup/U{uid}/{date}/NNG/AI{aiId}/U{uid}/，明细与 collect 按 NNG/ 前缀还原', () => {
    const store = new SatelliteStore(root)
    seedPush('inst-1', 1, 'NNG/AI2/U7/root/节点.json', '{"n":1}')

    const r = store.maybeArchiveDaily('inst-1')
    const date = yesterday()
    expect(r.archived).toBe(true)
    // NNG 备份为完整域镜像（NNG/AI{aiId}/U{uid}，与真实工作域一字不差）
    expect(existsSync(join(root, 'backup', 'U7', date, 'NNG', 'AI2', 'U7', 'root', '节点.json'))).toBe(true)

    // 明细：scopeFromKey 从 NNG 前缀提取 uid
    const details = store.listArchiveDetails('inst-1')
    expect(details).toEqual([{ uid: 7, date, entryCount: 1 }])

    // collectArchive：key 以 NNG/ 完整域前缀开头（恢复端按前缀分流）
    const items = store.collectArchive(7, date)
    expect(items).toEqual([{ key: 'NNG/AI2/U7/root/节点.json', content: '{"n":1}' }])
  })

  it('同 uid 多 AI 并存备份互不覆盖：内存域与 NNG 域的 AI 层各自独立快照', () => {
    const store = new SatelliteStore(root)
    seedPush('inst-1', 1, 'NNG/AI1/U7/root/a.json', '{"a":1}')
    seedPush('inst-1', 2, 'NNG/AI2/U7/root/b.json', '{"b":1}')

    const r = store.maybeArchiveDaily('inst-1')
    const date = yesterday()
    expect(r.archived).toBe(true)
    expect(existsSync(join(root, 'backup', 'U7', date, 'NNG', 'AI1', 'U7', 'root', 'a.json'))).toBe(true)
    expect(existsSync(join(root, 'backup', 'U7', date, 'NNG', 'AI2', 'U7', 'root', 'b.json'))).toBe(true)
  })

  it('只有 NNG 无 memory 时同样备份（hasNng 单独成立）', () => {
    const store = new SatelliteStore(root)
    seedPush('inst-1', 1, 'NNG/AI1/U9/root/仅节点.json', '{"n":2}')

    const r = store.maybeArchiveDaily('inst-1')
    const date = yesterday()
    expect(r.archived).toBe(true)
    expect(existsSync(join(root, 'backup', 'U9', date, 'NNG', 'AI1', 'U9', 'root', '仅节点.json'))).toBe(true)
  })

  it('cache 数据纳入备份：cache key 落 backup/U{uid}/{date}/cache/AI{aiId}/U{uid}/，collect 按 cache/ 前缀还原', () => {
    const store = new SatelliteStore(root)
    seedPush('inst-1', 1, 'cache/AI2/U7/index/节点_cache.json', '{"c":1}')

    const r = store.maybeArchiveDaily('inst-1')
    const date = yesterday()
    expect(r.archived).toBe(true)
    // cache 备份为完整域镜像（cache/AI{aiId}/U{uid}，与真实工作域一字不差）
    expect(existsSync(join(root, 'backup', 'U7', date, 'cache', 'AI2', 'U7', 'index', '节点_cache.json'))).toBe(true)

    // 明细：scopeFromKey 从 cache 前缀提取 uid
    const details = store.listArchiveDetails('inst-1')
    expect(details).toEqual([{ uid: 7, date, entryCount: 1 }])

    // collectArchive：key 以 cache/ 完整域前缀开头（分系统恢复端按前缀分流）
    const items = store.collectArchive(7, date)
    expect(items).toEqual([{ key: 'cache/AI2/U7/index/节点_cache.json', content: '{"c":1}' }])
  })
})