import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { CacheSync } from '../electron/main/monitor/cache-sync'
import { OrphanCheck } from '../electron/main/monitor/orphan-check'
import { ErrorLog } from '../electron/main/monitor/error-log'

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
}

function makeSetup(root: string) {
  const nngRoot = join(root, 'NNG', 'AI1', 'U1', 'root').replace(/\\/g, '/')
  const cacheRoot = join(root, 'cache', 'AI1', 'U1').replace(/\\/g, '/')
  const cacheIndexJson = join(root, 'cache', 'AI1', 'U1', 'index.json').replace(/\\/g, '/')
  mkdirSync(nngRoot, { recursive: true })
  mkdirSync(join(cacheRoot, 'index'), { recursive: true })
  writeJson(cacheIndexJson, { version: '1.0', cache_list: [] })

  const marker = new Set<string>()
  const orphan = new OrphanCheck(join(root, 'corrupted'), marker)
  const errorLog = new ErrorLog(join(root, 'error-log.json'))
  const sync = new CacheSync(nngRoot, cacheRoot, cacheIndexJson, orphan, errorLog, marker)
  return { nngRoot, cacheRoot, cacheIndexJson, sync, marker }
}

function makeNng(root: string, rel: string, desc: string, 关联记忆: Array<{ 记忆路径: string }> = []) {
  const nngPath = `${root}/${rel}_nng.json`
  // 子目录 rel 形如 'a/b' 时展开
  const full = rel.includes('/') ? `${root}/${rel.split('/')[0]}` : root
  writeJson(nngPath, {
    自身路径: nngPath,
    描述: desc,
    关联记忆,
    上级NNG: [],
    下级NNG: [],
    归档记录: []
  })
  void full
  return nngPath
}

function makeMemory(memPath: string, 用户原话: string, 关联NNG: string[] = []): void {
  writeJson(memPath, {
    自身路径: memPath,
    备注: '',
    内容: { 用户原话, AI回复: '' },
    关联文件: [],
    关联NNG
  })
}

describe('CacheSync NNG 事件 → 缓存镜像同步', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cache-sync-evt-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('handleNngModified：新建 NNG → cache 镜像生成 + index 条目 upsert', () => {
    const { nngRoot, cacheRoot, cacheIndexJson, sync } = makeSetup(root)
    const nngPath = makeNng(nngRoot, '1事件', '事件描述')

    sync.handleNngModified(nngPath)

    const cachePath = `${cacheRoot}/index/1事件_cache.json`
    expect(existsSync(cachePath)).toBe(true)
    const cache = readJson(cachePath) as { 描述: string }
    expect(cache.描述).toBe('事件描述')
    const idx = readJson(cacheIndexJson) as { cache_list: Array<{ name: string; path: string }> }
    expect(idx.cache_list).toContainEqual(expect.objectContaining({ name: '1事件', path: cachePath }))
  })

  it('handleNngModified：NNG 更新 → cache 镜像同步更新描述', () => {
    const { nngRoot, cacheRoot, sync } = makeSetup(root)
    const nngPath = makeNng(nngRoot, '1事件', '初始描述')
    sync.handleNngModified(nngPath)
    // 修改 NNG 描述
    writeJson(nngPath, {
      自身路径: nngPath,
      描述: '更新后的描述',
      关联记忆: [],
      上级NNG: [],
      下级NNG: [],
      归档记录: []
    })
    sync.handleNngModified(nngPath)

    const cachePath = `${cacheRoot}/index/1事件_cache.json`
    const cache = readJson(cachePath) as { 描述: string }
    expect(cache.描述).toBe('更新后的描述')
  })

  it('handleNngModified：NNG 关联记忆 → cache 关联记忆展开为内容快照', () => {
    const { nngRoot, cacheRoot, sync } = makeSetup(root)
    const memPath = `${cacheRoot.slice(0, cacheRoot.indexOf('/cache'))}/memory/U1/AI1/normal/1记忆.json`
    makeMemory(memPath, '用户说过的话')
    const nngPath = makeNng(nngRoot, '1事件', '描述', [{ 记忆路径: memPath }])

    sync.handleNngModified(nngPath)

    const cachePath = `${cacheRoot}/index/1事件_cache.json`
    const cache = readJson(cachePath) as { 关联记忆: Array<{ 记忆路径: string; 用户原话: string }> }
    expect(cache.关联记忆).toHaveLength(1)
    expect(cache.关联记忆[0]).toMatchObject({ 记忆路径: memPath, 用户原话: '用户说过的话' })
  })

  it('handleNngModified：子目录 NNG → 子目录 cache 镜像（不进一级 index）', () => {
    const { nngRoot, cacheRoot, cacheIndexJson, sync } = makeSetup(root)
    const dir = `${nngRoot}/1父`
    mkdirSync(dir, { recursive: true })
    const nngPath = `${dir}/2子_nng.json`
    writeJson(nngPath, {
      自身路径: nngPath,
      描述: '子级描述',
      关联记忆: [],
      上级NNG: [],
      下级NNG: [],
      归档记录: []
    })

    sync.handleNngModified(nngPath)

    const cachePath = `${cacheRoot}/index/1父/2子_cache.json`
    expect(existsSync(cachePath)).toBe(true)
    const idx = readJson(cacheIndexJson) as { cache_list: unknown[] }
    expect(idx.cache_list).toHaveLength(0)
  })

  it('selfWriteMarker：镜像写 cache 与 index 后打 marker（防 watcher 回环）', () => {
    const { nngRoot, cacheRoot, marker, sync } = makeSetup(root)
    const nngPath = makeNng(nngRoot, '1事件', '描述')

    sync.handleNngModified(nngPath)

    const cachePath = `${cacheRoot}/index/1事件_cache.json`
    const indexJson = `${cacheRoot}/index.json`
    expect(marker.has(cachePath)).toBe(true)
    expect(marker.has(indexJson)).toBe(true)
  })

  it('handleNngCreated：非 _nng.json 扩展名 → 忽略', () => {
    const { nngRoot, sync } = makeSetup(root)
    const other = `${nngRoot}/1说明.txt`
    writeFileSync(other, '不相关', 'utf-8')
    sync.handleNngCreated(other)
    expect(existsSync(other)).toBe(true)
  })
})

describe('CacheSync 删除链路（handleDeleted / sync 孤儿）', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cache-sync-del-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('handleDeleted：删除 cache 文件 + 移除 index 条目 + 空 sibling 目录清理', () => {
    const { nngRoot, cacheRoot, cacheIndexJson, sync } = makeSetup(root)
    const nngPath = makeNng(nngRoot, '1事件', '描述')
    sync.handleNngModified(nngPath)
    const cachePath = `${cacheRoot}/index/1事件_cache.json`
    expect(existsSync(cachePath)).toBe(true)
    // 构造空 sibling 目录（handleNngModified 只建 2子 的 sibling？无则跳过）
    const sibling = `${cacheRoot}/index/1事件`
    if (!existsSync(sibling)) mkdirSync(sibling, { recursive: true })

    sync.handleDeleted(cachePath)

    expect(existsSync(cachePath)).toBe(false)
    expect(existsSync(sibling)).toBe(false)
    const idx = readJson(cacheIndexJson) as { cache_list: unknown[] }
    expect(idx.cache_list).toHaveLength(0)
  })

  it('handleDeleted：非 cache 文件 → 忽略', () => {
    const { nngRoot, cacheRoot, sync } = makeSetup(root)
    const nngPath = makeNng(nngRoot, '1事件', '描述')
    sync.handleNngModified(nngPath)
    const other = `${cacheRoot}/index/说明.txt`
    writeFileSync(other, 'x', 'utf-8')
    sync.handleDeleted(other)
    expect(existsSync(other)).toBe(true)
  })

  it('triggerRewriteForMemory：记忆修改 → 关联 NNG 的 cache 重写', () => {
    const { nngRoot, cacheRoot, sync } = makeSetup(root)
    const memPath = `${nngRoot.slice(0, nngRoot.indexOf('/NNG'))}/memory/U1/AI1/normal/1记忆.json`
    const nngPath = makeNng(nngRoot, '1事件', '描述', [{ 记忆路径: memPath }])
    makeMemory(memPath, '原始内容', [nngPath])
    sync.handleNngModified(nngPath)
    const cachePath = `${cacheRoot}/index/1事件_cache.json`
    const cache = readJson(cachePath) as { 关联记忆: Array<{ 用户原话: string }> }
    expect(cache.关联记忆[0].用户原话).toBe('原始内容')

    // 修改记忆内容 → triggerRewriteForMemory 应重写关联 cache
    writeJson(memPath, {
      自身路径: memPath,
      备注: '',
      内容: { 用户原话: '更新后的内容', AI回复: '' },
      关联文件: [],
      关联NNG: [nngPath]
    })
    sync.triggerRewriteForMemory(memPath)

    const after = readJson(cachePath) as { 关联记忆: Array<{ 用户原话: string }> }
    expect(after.关联记忆[0].用户原话).toBe('更新后的内容')
  })
})