import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CacheSync } from '../electron/main/monitor/cache-sync'
import { OrphanCheck } from '../electron/main/monitor/orphan-check'
import { ErrorLog } from '../electron/main/monitor/error-log'

function makeCache(cachePath: string, desc = '缓存'): void {
  writeFileSync(
    cachePath,
    JSON.stringify({ 自身路径: cachePath, 描述: desc, 关联记忆: [], 上级缓存: [], 下级缓存: [], 归档记录: [] }),
    'utf-8'
  )
}

describe('CacheSync 孤儿缓存清理（缓存存在但对应 NNG 不存在）', () => {
  let root: string
  let nngRoot: string
  let cacheRoot: string
  let cacheIndexJson: string
  let sync: CacheSync

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cache-sync-test-'))
    // 2026-08-15 重构：构造传全局根（NNG / cache），作用域由路径正则推导
    nngRoot = join(root, 'NNG').replace(/\\/g, '/')
    cacheRoot = join(root, 'cache').replace(/\\/g, '/')
    cacheIndexJson = join(root, 'cache/index.json').replace(/\\/g, '/')
    mkdirSync(nngRoot, { recursive: true })
    mkdirSync(cacheRoot, { recursive: true })
    // 作用域一级目录（NNG/AI{aiId}/U{uid}/root 与 cache/AI{aiId}/U{uid}/index）
    mkdirSync(join(nngRoot, 'AI1', 'U1', 'root'), { recursive: true })
    mkdirSync(join(cacheRoot, 'AI1', 'U1', 'index'), { recursive: true })
    writeFileSync(cacheIndexJson, JSON.stringify({ version: '1.0', cache_list: [] }, null, 2), 'utf-8')

    const marker = new Set<string>()
    const orphan = new OrphanCheck(join(root, 'corrupted'), marker)
    const errorLog = new ErrorLog(join(root, 'error-log.json'))
    sync = new CacheSync(nngRoot, cacheRoot, cacheIndexJson, orphan, errorLog, marker)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('一级缓存存在但对应 NNG 不存在 → 删除缓存文件与 index 条目', () => {
    const cachePath = `${cacheRoot}/AI1/U1/index/1孤儿_cache.json`
    const scopeIndexJson = `${cacheRoot}/AI1/U1/index.json`
    makeCache(cachePath, '孤儿缓存')
    writeFileSync(
      scopeIndexJson,
      JSON.stringify(
        { version: '1.0', cache_list: [{ name: '1孤儿', path: cachePath, 描述: '孤儿缓存', last_modified: 'x' }] },
        null,
        2
      ),
      'utf-8'
    )

    sync.sync(cachePath)

    expect(existsSync(cachePath)).toBe(false)
    const idx = JSON.parse(readFileSync(scopeIndexJson, 'utf-8'))
    expect(idx.cache_list).toHaveLength(0)
  })

  it('一级缓存存在且对应 NNG 存在 → 保留缓存', () => {
    const nngPath = `${nngRoot}/AI1/U1/root/1正常_nng.json`
    writeFileSync(
      nngPath,
      JSON.stringify({ 自身路径: nngPath, 描述: '正常', 关联记忆: [], 上级NNG: [], 下级NNG: [], 归档记录: [] }),
      'utf-8'
    )
    const cachePath = `${cacheRoot}/AI1/U1/index/1正常_cache.json`
    makeCache(cachePath, '正常缓存')

    sync.sync(cachePath)

    expect(existsSync(cachePath)).toBe(true)
  })

  it('子目录缓存存在但对应 NNG 不存在 → 删除缓存文件', () => {
    const subCacheDir = `${cacheRoot}/AI1/U1/index/1父`
    mkdirSync(subCacheDir, { recursive: true })
    const cachePath = `${subCacheDir}/2子_cache.json`
    makeCache(cachePath, '子孤儿缓存')

    sync.sync(cachePath)

    expect(existsSync(cachePath)).toBe(false)
  })

  it('损坏缓存 + 对应 NNG 不存在 → 走隔离路径而非删除', () => {
    const cachePath = `${cacheRoot}/AI1/U1/index/1损坏_cache.json`
    writeFileSync(cachePath, '{ 不是合法 JSON', 'utf-8')

    sync.sync(cachePath)

    // 损坏文件被隔离（移走），原路径不存在
    expect(existsSync(cachePath)).toBe(false)
    const corruptedDir = join(root, 'corrupted')
    expect(existsSync(corruptedDir)).toBe(true)
  })

  it('缓存文件缺失但对应 NNG 存在 → 从 NNG 镜像重建', () => {
    const nngPath = `${nngRoot}/AI1/U1/root/1镜像_nng.json`
    writeFileSync(
      nngPath,
      JSON.stringify({ 自身路径: nngPath, 描述: '镜像源', 关联记忆: [], 上级NNG: [], 下级NNG: [], 归档记录: [] }),
      'utf-8'
    )
    const cachePath = `${cacheRoot}/AI1/U1/index/1镜像_cache.json`

    sync.sync(cachePath)

    // 缓存文件缺失 + NNG 存在 → 重建（非删除）
    expect(existsSync(cachePath)).toBe(true)
  })
})
