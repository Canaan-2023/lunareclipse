import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import JSZip from 'jszip'
import { SatelliteStore } from '../electron/main/multi-instance/master/satellite-store'
import { UserStore } from '../electron/main/models/user-store'
import { restoreLocalScope } from '../electron/main/multi-instance/satellite/local-restore'

function yesterday(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

describe('账号管理局：禁用/恢复账号', () => {
  let root: string
  let store: UserStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'as-acct-'))
    store = new UserStore(join(root, 'users.json'))
    store.register('主账号', 'pass-1')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('setUserDisabled 写回 users.json 的禁用字段', () => {
    const uid = store.listUsers()[0].UID
    const r = store.setUserDisabled(uid, true)
    expect(r.ok).toBe(true)
    const saved = JSON.parse(readFileSync(join(root, 'users.json'), 'utf-8'))
    expect(saved.users[0].禁用).toBe(true)
    expect(store.setUserDisabled(uid, false).ok).toBe(true)
    const restored = JSON.parse(readFileSync(join(root, 'users.json'), 'utf-8'))
    expect(restored.users[0].禁用 ?? false).toBe(false)
  })

  it('禁用后登录被拦截，恢复后放行', () => {
    const acc = store.listUsers()[0]
    expect(store.login(acc.用户名, 'pass-1').ok).toBe(true)
    store.setUserDisabled(acc.UID, true)
    const blocked = store.login(acc.用户名, 'pass-1')
    expect(blocked.ok).toBe(false)
    expect(blocked.error).toContain('禁用')
    store.setUserDisabled(acc.UID, false)
    expect(store.login(acc.用户名, 'pass-1').ok).toBe(true)
  })

  it('listUsers 不含敏感字段且带禁用标记', () => {
    const acc = store.listUsers()[0]
    expect(acc).not.toHaveProperty('密码哈希')
    expect(acc).toHaveProperty('禁用')
    expect(acc.禁用).toBeUndefined()
  })
})

describe('备份中心（master）：本机账号日归档 + 本机全量覆盖恢复', () => {
  let root: string
  let store: SatelliteStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'as-local-'))
    store = new SatelliteStore(root)
    // 主系统本机账号 memory/U{uid}/AI{aiId}/...（normal + raw_memory 工作域）
    mkdirSync(join(root, 'memory', 'U1', 'AI1', 'normal'), { recursive: true })
    mkdirSync(join(root, 'memory', 'U1', 'AI1', 'raw_memory'), { recursive: true })
    writeFileSync(join(root, 'memory', 'U1', 'AI1', 'normal', 'a.json'), '{"v":1}')
    writeFileSync(join(root, 'memory', 'U1', 'AI1', 'raw_memory', 'b.md'), '# 记忆')
    // 本机 cache 域 cache/AI{aiId}/U{uid}
    mkdirSync(join(root, 'cache', 'AI1', 'U1', 'index'), { recursive: true })
    writeFileSync(join(root, 'cache', 'AI1', 'U1', 'index', 'a_cache.json'), '{"c":1}')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('maybeArchiveLocalDaily 备份快照并写入水位，无变化时零 IO', () => {
    const first = store.maybeArchiveLocalDaily()
    expect(first.archived).toBe(true)
    expect(first.scopes).toBe(1)
    expect(first.count).toBe(3)
    const list = store.listLocalArchives()
    expect(list).toHaveLength(1)
    const archive = list[0]
    expect(archive.uid).toBe(1)
    expect(archive.date).toBe(yesterday())
    // 同一日期内容未变 → 不重复备份
    const second = store.maybeArchiveLocalDaily()
    expect(second.archived).toBe(false)
    expect(second.count).toBe(0)
  })

  it('inspectLocalArchive 按顶层域（memory/cache）聚合、文件清单与文本预览', () => {
    store.maybeArchiveLocalDaily()
    const detail = store.inspectLocalArchive(1, yesterday())
    expect(detail.count).toBe(3)
    const domains = detail.domains.map((d) => d.domain).sort()
    expect(domains).toEqual(['cache', 'memory'])
    // 文件路径相对备份日期根，带 memory/cache 完整域前缀（与真实工作域一致）
    expect(detail.files.find((f) => f.path === 'memory/U1/AI1/normal/a.json')?.preview).toContain('"v":1')
    expect(detail.files.find((f) => f.path === 'cache/AI1/U1/index/a_cache.json')?.preview).toContain('"c":1')
  })

  it('restoreLocalOverwrite 完全覆盖：本机污染数据被删除，快照重建', () => {
    store.maybeArchiveLocalDaily()
    // 备份后本机又写入新文件（模拟污染/误删恢复场景）
    writeFileSync(join(root, 'memory', 'U1', 'AI1', 'normal', 'new.json'), 'polluted')
    writeFileSync(join(root, 'cache', 'AI1', 'U1', 'index', 'new_cache.json'), 'polluted-cache')
    expect(existsSync(join(root, 'memory', 'U1', 'AI1', 'normal', 'new.json'))).toBe(true)
    expect(existsSync(join(root, 'cache', 'AI1', 'U1', 'index', 'new_cache.json'))).toBe(true)

    const r = store.restoreLocalOverwrite(1, yesterday())
    expect(r.ok).toBe(true)
    expect(r.restored).toBe(3)
    const scopeDir = join(root, 'memory', 'U1', 'AI1')
    // 污染文件被清掉
    expect(existsSync(join(scopeDir, 'normal', 'new.json'))).toBe(false)
    expect(existsSync(join(root, 'cache', 'AI1', 'U1', 'index', 'new_cache.json'))).toBe(false)
    // 快照每个文件都重建回来
    expect(readFileSync(join(scopeDir, 'normal', 'a.json'), 'utf-8')).toBe('{"v":1}')
    expect(readFileSync(join(scopeDir, 'raw_memory', 'b.md'), 'utf-8')).toBe('# 记忆')
    expect(readFileSync(join(root, 'cache', 'AI1', 'U1', 'index', 'a_cache.json'), 'utf-8')).toBe('{"c":1}')
    // 备份目录本身保留（供后续恢复）
    expect(existsSync(join(root, 'backup', 'U1', yesterday()))).toBe(true)
  })

  it('恢复不存在日期返回失败', () => {
    expect(store.restoreLocalOverwrite(1, '2099-01-01').ok).toBe(false)
  })

  it('maybeArchiveLocalDaily 跳过指定中的分系统账号（分系统数据归 maybeArchiveDaily 管）', () => {
    // 构造分系统账号数据 + 本机账号数据
    mkdirSync(join(root, 'memory', 'U7', 'AI1', 'normal'), { recursive: true })
    writeFileSync(join(root, 'memory', 'U7', 'AI1', 'normal', 's.json'), '{"from":"sat"}')
    const r = store.maybeArchiveLocalDaily(new Set([7]))
    expect(r.archived).toBe(true)
    expect(r.scopes).toBe(1)
    expect(existsSync(join(root, 'backup', 'U1'))).toBe(true)
    expect(existsSync(join(root, 'backup', 'U7'))).toBe(false)
  })
})

describe('备份中心（satellite）：从主系统提取 zip 后在分系统本机完全覆盖恢复', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'as-sat-'))
    // 分系统本机账号 memory/U{uid}/AI{aiId}/...（先有旧数据）
    mkdirSync(join(root, 'memory', 'U7', 'AI1', 'normal'), { recursive: true })
    writeFileSync(join(root, 'memory', 'U7', 'AI1', 'normal', 'old.json'), 'stale')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('restoreLocalScope 用 zip 完全覆盖本机该账号工作域（key 带 memory/NNG/cache 完整域前缀，与真实路径一致）', async () => {
    // 主系统侧打包的 zip：key 为备份日期根下的完整域路径（memory/U{uid}/AI{aiId}/...、NNG/AI{aiId}/U{uid}/...、cache/AI{aiId}/U{uid}/...）
    const zip = new JSZip()
    zip.file('memory/U7/AI1/normal/a.json', '{"v":1}')
    zip.file('memory/U7/AI1/raw_memory/b.md', '# 记忆')
    zip.file('NNG/AI1/U7/root/节点.json', '{"n":1}')
    zip.file('cache/AI1/U7/index/节点_cache.json', '{"c":1}')
    const bytes = await zip.generateAsync({ type: 'uint8array' })

    const restored = await restoreLocalScope(root, 7, bytes)
    expect(restored).toBe(4)
    // memory 域：旧数据被覆盖清除，快照重建
    const scopeDir = join(root, 'memory', 'U7', 'AI1')
    expect(existsSync(join(scopeDir, 'normal', 'old.json'))).toBe(false)
    expect(readFileSync(join(scopeDir, 'normal', 'a.json'), 'utf-8')).toBe('{"v":1}')
    expect(readFileSync(join(scopeDir, 'raw_memory', 'b.md'), 'utf-8')).toBe('# 记忆')
    // NNG 域：按 NNG/AI{aiId}/U{uid} 归位
    expect(readFileSync(join(root, 'NNG', 'AI1', 'U7', 'root', '节点.json'), 'utf-8')).toBe('{"n":1}')
    // cache 域：按 cache/AI{aiId}/U{uid} 归位
    expect(readFileSync(join(root, 'cache', 'AI1', 'U7', 'index', '节点_cache.json'), 'utf-8')).toBe('{"c":1}')
  })

  it('restoreLocalScope 路径穿越防御：任何条目名都不会写出该 uid 的 memory/NNG/cache 域外', async () => {
    // 断言不变量：无法识别的域、跨账号 uid、resolve 出域外的条目一律跳过。
    const zip = new JSZip()
    zip.file('../escape.txt', 'hack') // 无域前缀，直接跳过
    zip.file('memory/U1/AI1/other.json', 'x') // 别的账号 uid，跳过
    zip.file('NNG/AI1/U8/root/y.json', 'y') // NNG 域别的账号，跳过
    zip.file('cache/AI1/U8/index/z_cache.json', 'z') // cache 域别的账号，跳过
    zip.file('memory/U7/../../root.txt', 'w') // resolve 后出 memory 域，跳过
    zip.file('memory/U7/AI1/normal/ok.json', '{"ok":1}') // 合法条目正常写入
    const bytes = await zip.generateAsync({ type: 'uint8array' })

    const restored = await restoreLocalScope(root, 7, bytes)
    expect(restored).toBe(1)
    expect(existsSync(join(root, 'escape.txt'))).toBe(false)
    expect(existsSync(join(root, 'memory', 'U1', 'AI1', 'other.json'))).toBe(false)
    expect(existsSync(join(root, 'NNG', 'AI1', 'U8', 'root', 'y.json'))).toBe(false)
    expect(existsSync(join(root, 'cache', 'AI1', 'U8', 'index', 'z_cache.json'))).toBe(false)
    expect(existsSync(join(root, 'root.txt'))).toBe(false)
    expect(readFileSync(join(root, 'memory', 'U7', 'AI1', 'normal', 'ok.json'), 'utf-8')).toBe('{"ok":1}')
  })
})