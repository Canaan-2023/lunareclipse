import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { NngSync, isNngFile } from '../electron/main/monitor/nng-sync'
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
  // 作用域根：NNG/AI1/U1（scopeRootFor 正则要求 NNG/AI\d+/U\d+ 形态）
  const nngRoot = join(root, 'NNG', 'AI1', 'U1').replace(/\\/g, '/')
  const nngRootJson = `${nngRoot}/root.json`
  const level1Dir = `${nngRoot}/root`
  mkdirSync(level1Dir, { recursive: true })
  writeJson(nngRootJson, { version: '1.0', updated_at: '', total_nodes: 0, nodes: [] })

  const marker = new Set<string>()
  const corruptedDir = join(root, 'corrupted').replace(/\\/g, '/')
  const orphan = new OrphanCheck(corruptedDir, marker)
  const errorLog = new ErrorLog(join(root, 'error-log.json').replace(/\\/g, '/'))
  const sync = new NngSync(nngRoot, nngRootJson, orphan, errorLog, marker)
  return { nngRoot, nngRootJson, level1Dir, sync, marker, corruptedDir }
}

/** 一级 NNG：直接放 level1Dir，文件名带正确层级前缀（1xxx_nng.json 老格式，ensureLevelPrefix 不改名） */
function makeLevel1Nng(root: string, name: string, desc = '描述') {
  const nngPath = `${root}/1${name}_nng.json`
  writeJson(nngPath, {
    自身路径: nngPath,
    描述: desc,
    关联记忆: [],
    上级NNG: [],
    下级NNG: [],
    归档记录: []
  })
  return nngPath
}

describe('NngSync created/modified 全链路', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nng-sync-evt-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('sync created：一级 NNG → root.json 条目 upsert + 上级指向 root.json（不回链）', () => {
    const { nngRootJson, level1Dir, sync, marker } = makeSetup(root)
    const nngPath = makeLevel1Nng(level1Dir, '事件')

    sync.sync(nngPath, 'created')

    const idx = readJson(nngRootJson) as { nodes: Array<{ name: string; path: string; 描述: string }> }
    expect(idx.nodes).toContainEqual(
      expect.objectContaining({ name: '1事件', path: nngPath, 描述: '描述' })
    )
    // 防回环：写 root.json 前打 marker
    expect(marker.has(nngRootJson)).toBe(true)
    // 单个一级点 上级NNG 应指向 root.json（索引文件），且 root.json 无 下级NNG 回链
    const nng = readJson(nngPath) as { 上级NNG: string[]; 下级NNG: string[] }
    expect(nng.上级NNG).toContain(nngRootJson)
    expect(nng.下级NNG).toEqual([])
  })

  it('sync created：cacheSyncHook 收到 created 事件', () => {
    const { level1Dir, sync } = makeSetup(root)
    const nngPath = makeLevel1Nng(level1Dir, '事件')
    const hook = vi.fn()
    sync.setCacheSyncHook(hook)

    sync.sync(nngPath, 'created')

    expect(hook).toHaveBeenCalledWith(nngPath, 'created')
  })

  it('sync modified：cacheSyncHook 收到 modified 事件', () => {
    const { level1Dir, sync } = makeSetup(root)
    const nngPath = makeLevel1Nng(level1Dir, '事件')
    const hook = vi.fn()
    sync.setCacheSyncHook(hook)

    sync.sync(nngPath, 'modified')

    expect(hook).toHaveBeenCalledWith(nngPath, 'modified')
  })

  it('sync accessed：不触发 cacheSyncHook，仅兜底同步 root.json 描述', () => {
    const { nngRootJson, level1Dir, sync } = makeSetup(root)
    const nngPath = makeLevel1Nng(level1Dir, '事件')
    const hook = vi.fn()
    sync.setCacheSyncHook(hook)

    sync.sync(nngPath, 'accessed')

    expect(hook).not.toHaveBeenCalled()
    const idx = readJson(nngRootJson) as { nodes: Array<{ 描述: string }> }
    expect(idx.nodes).toContainEqual(expect.objectContaining({ 描述: '描述' }))
  })

  it('sync accessed：索引与 NNG 一致时不写盘、不刷新 last_modified（访问不污染修改时间）', () => {
    const { nngRootJson, level1Dir, sync } = makeSetup(root)
    const nngPath = makeLevel1Nng(level1Dir, '事件')
    sync.sync(nngPath, 'created')
    const before = (readJson(nngRootJson) as { nodes: Array<{ last_modified: string }> }).nodes[0]
      .last_modified
    expect(before).toBeTruthy()

    // 等待超过 nowIso 精度窗口，若重复写盘 last_modified 必然变化
    const p = new Promise<void>((r) => setTimeout(r, 20))
    return p.then(() => {
      sync.sync(nngPath, 'accessed')
      const after = (readJson(nngRootJson) as { nodes: Array<{ last_modified: string }> }).nodes[0]
        .last_modified
      expect(after).toBe(before)
    })
  })

  it('sync accessed：描述与索引不一致时兜底更新描述（modified 事件漏触发场景）', () => {
    const { nngRootJson, level1Dir, sync } = makeSetup(root)
    const nngPath = makeLevel1Nng(level1Dir, '事件')
    sync.sync(nngPath, 'created')

    // 直接改 NNG 文件描述（模拟绕过 watcher 的写入），再 accessed 兜底
    const nng = readJson(nngPath) as Record<string, unknown>
    nng.描述 = '新描述'
    writeFileSync(nngPath, JSON.stringify(nng, null, 2), 'utf-8')
    sync.sync(nngPath, 'accessed')

    const idx = readJson(nngRootJson) as { nodes: Array<{ name: string; 描述: string }> }
    expect(idx.nodes).toContainEqual(expect.objectContaining({ name: '1事件', 描述: '新描述' }))
  })

  it('sync：缺字段补齐（自身路径/关联记忆/上级NNG/下级NNG/归档记录）并写回', () => {
    const { nngRootJson, level1Dir, sync } = makeSetup(root)
    const nngPath = `${level1Dir}/1缺字段_nng.json`
    writeJson(nngPath, { 描述: '缺字段' })

    sync.sync(nngPath, 'modified')

    const nng = readJson(nngPath) as {
      自身路径: string
      关联记忆: unknown[]
      上级NNG: unknown[]
      下级NNG: unknown[]
      归档记录: unknown[]
    }
    expect(nng.自身路径).toBe(nngPath)
    expect(nng.关联记忆).toEqual([])
    expect(nng.上级NNG).toContain(`${nngRootJson}`)
    expect(nng.下级NNG).toEqual([])
    expect(nng.归档记录).toEqual([])
  })

  it('sync：二级 NNG → 父 NNG 双向链入（上级/下级）', () => {
    const { level1Dir, sync } = makeSetup(root)
    const parentPath = makeLevel1Nng(level1Dir, '父')
    const childDir = `${level1Dir}/1父`
    mkdirSync(childDir, { recursive: true })
    const childPath = `${childDir}/2子_nng.json`
    writeJson(childPath, {
      自身路径: childPath,
      描述: '子描述',
      关联记忆: [],
      上级NNG: [],
      下级NNG: [],
      归档记录: []
    })

    sync.sync(childPath, 'modified')

    const child = readJson(childPath) as { 上级NNG: string[] }
    expect(child.上级NNG).toContain(parentPath)
    const parent = readJson(parentPath) as { 下级NNG: string[] }
    expect(parent.下级NNG).toContain(childPath)
  })

  it('sync：sibling 文件夹子 NNG → 链入自身 下级NNG，子 NNG 上级指向自身', () => {
    const { level1Dir, sync } = makeSetup(root)
    const nngPath = makeLevel1Nng(level1Dir, '父')
    const siblingDir = `${level1Dir}/1父`
    mkdirSync(siblingDir, { recursive: true })
    const childPath = `${siblingDir}/2子_nng.json`
    writeJson(childPath, {
      自身路径: childPath,
      描述: '子',
      关联记忆: [],
      上级NNG: [],
      下级NNG: [],
      归档记录: []
    })

    sync.sync(nngPath, 'modified')

    const parent = readJson(nngPath) as { 下级NNG: string[] }
    expect(parent.下级NNG).toContain(childPath)
    const child = readJson(childPath) as { 上级NNG: string[] }
    expect(child.上级NNG).toContain(nngPath)
  })

  it('sync：NNG 关联记忆 → memory 文件 关联NNG 反向回写', () => {
    const { nngRoot, level1Dir, sync } = makeSetup(root)
    const memPath = `${nngRoot.slice(0, nngRoot.indexOf('/NNG'))}/memory/U1/AI1/normal/1记忆.json`
    writeJson(memPath, {
      自身路径: memPath,
      备注: '',
      内容: { 用户原话: '原话', AI回复: '' },
      关联文件: [],
      关联NNG: []
    })
    const nngPath = `${level1Dir}/1事件_nng.json`
    writeJson(nngPath, {
      自身路径: nngPath,
      描述: '事件',
      关联记忆: [{ 记忆路径: memPath, 描述: '相关' }],
      上级NNG: [],
      下级NNG: [],
      归档记录: []
    })

    sync.sync(nngPath, 'modified')

    const mem = readJson(memPath) as { 关联NNG: string[] }
    expect(mem.关联NNG).toContain(nngPath)
  })

  it('sync：解析失败（损坏 JSON）→ errorLog + quarantine 移动文件', () => {
    const { level1Dir, sync, corruptedDir } = makeSetup(root)
    const nngPath = `${level1Dir}/1损坏_nng.json`
    writeFileSync(nngPath, '{{{ 不是 JSON', 'utf-8')

    sync.sync(nngPath, 'modified')

    expect(existsSync(nngPath)).toBe(false)
    // corrupted 目录应有隔离备份
    expect(existsSync(corruptedDir) && readdirSync(corruptedDir).some((f) => f.includes('1损坏'))).toBe(
      true
    )
  })

  it('sync：非 _nng.json 或不存在路径 → 忽略', () => {
    const { nngRootJson, level1Dir, sync } = makeSetup(root)
    sync.sync(`${level1Dir}/说明.txt`, 'created')
    sync.sync(`${level1Dir}/不存在的_nng.json`, 'created')

    const idx = readJson(nngRootJson) as { nodes: unknown[] }
    expect(idx.nodes).toHaveLength(0)
  })
})

describe('NngSync 删除 & 层级修正', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nng-sync-del-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('handleDeleted：一级 NNG → root.json 移除条目 + marker 打点', () => {
    const { nngRootJson, level1Dir, sync, marker } = makeSetup(root)
    const nngPath = makeLevel1Nng(level1Dir, '事件')
    sync.sync(nngPath, 'created')
    let idx = readJson(nngRootJson) as { nodes: unknown[] }
    expect(idx.nodes).toHaveLength(1)
    marker.clear()

    sync.handleDeleted(nngPath)

    idx = readJson(nngRootJson) as { nodes: unknown[] }
    expect(idx.nodes).toHaveLength(0)
    expect(marker.has(nngRootJson)).toBe(true)
  })

  it('handleDeleted：非一级 NNG → 不动 root.json', () => {
    const { nngRootJson, level1Dir, sync } = makeSetup(root)
    makeLevel1Nng(level1Dir, '父')
    const childPath = `${level1Dir}/1父/2子_nng.json`
    writeJson(childPath, { 描述: '子' })

    sync.handleDeleted(childPath)

    const idx = readJson(nngRootJson) as { nodes: unknown[] }
    expect(idx.nodes).toHaveLength(0)
  })

  it('ensureLevelPrefix：层级前缀与目录不符 → 重命名修正', () => {
    const { level1Dir, sync } = makeSetup(root)
    // 二级目录下放个错误前缀 1xxx_nng.json → 应修正为 2xxx_nng.json
    const childDir = `${level1Dir}/1父`
    mkdirSync(childDir, { recursive: true })
    const wrongPath = `${childDir}/1子_nng.json`
    writeJson(wrongPath, {
      自身路径: wrongPath,
      描述: '子',
      关联记忆: [],
      上级NNG: [],
      下级NNG: [],
      归档记录: []
    })

    sync.sync(wrongPath, 'modified')

    const fixedPath = `${childDir}/2子_nng.json`
    expect(existsSync(fixedPath)).toBe(true)
    expect(existsSync(wrongPath)).toBe(false)
  })
})

describe('isNngFile 纯函数', () => {
  it('_nng.json 且在 NNG 根内 → true', () => {
    expect(isNngFile('/base/NNG/AI1/U1/root/1事件_nng.json', '/base/NNG')).toBe(true)
  })
  it('非 _nng.json → false', () => {
    expect(isNngFile('/base/NNG/AI1/U1/root/1事件.txt', '/base/NNG')).toBe(false)
  })
  it('_nng.json 但不在 NNG 根内 → false', () => {
    expect(isNngFile('/base/elsewhere/1事件_nng.json', '/base/NNG')).toBe(false)
  })
})

