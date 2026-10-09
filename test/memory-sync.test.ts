import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MemorySync } from '../electron/main/monitor/memory-sync'
import { OrphanCheck } from '../electron/main/monitor/orphan-check'
import { ErrorLog } from '../electron/main/monitor/error-log'

function makeMemory(memPath: string, 关联NNG: string[] = []): void {
  writeFileSync(
    memPath,
    JSON.stringify({ 自身路径: memPath, 内容: '记忆内容', 备注: '', 关联NNG, 关联RAW: [] }, null, 2),
    'utf-8'
  )
}

function makeNng(nngPath: string, memPath: string): void {
  writeFileSync(
    nngPath,
    JSON.stringify(
      { 自身路径: nngPath, 描述: '节点', 关联记忆: [{ 记忆路径: memPath, 描述: '关联' }], 上级NNG: [], 下级NNG: [], 归档记录: [] },
      null,
      2
    ),
    'utf-8'
  )
}

describe('MemorySync 反向回填（记忆侧关联NNG 为空/失效时从 NNG 树反查重建）', () => {
  let root: string
  let nngRoot: string
  let memoryRoot: string
  let sync: MemorySync

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'memory-sync-test-'))
    // 2026-08-15 重构：构造传全局 NNG 根，NNG 文件在工作域一级目录（NNG/AI{aiId}/U{uid}/root/）下
    nngRoot = join(root, 'NNG').replace(/\\/g, '/')
    memoryRoot = join(root, 'memory').replace(/\\/g, '/')
    mkdirSync(join(nngRoot, 'AI1', 'U1', 'root'), { recursive: true })
    mkdirSync(memoryRoot, { recursive: true })

    const marker = new Set<string>()
    const orphan = new OrphanCheck(join(root, 'corrupted'), marker)
    const errorLog = new ErrorLog(join(root, 'error-log.json'))
    sync = new MemorySync(nngRoot, orphan, errorLog, marker)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('记忆关联NNG 为空但 NNG 侧有引用 → 反查回填', () => {
    const memPath = `${memoryRoot}/1记忆.json`
    const nngPath = `${nngRoot}/AI1/U1/root/1节点_nng.json`
    makeMemory(memPath)
    makeNng(nngPath, memPath)

    sync.sync(memPath)

    const mem = JSON.parse(readFileSync(memPath, 'utf-8'))
    expect(mem.关联NNG).toContain(nngPath)
  })

  it('记忆关联NNG 为空且 NNG 侧无引用 → 保持为空', () => {
    const memPath = `${memoryRoot}/1记忆.json`
    makeMemory(memPath)

    sync.sync(memPath)

    const mem = JSON.parse(readFileSync(memPath, 'utf-8'))
    expect(mem.关联NNG).toEqual([])
  })

  it('记忆关联NNG 含失效路径（NNG 已删）→ 清理失效路径并回填有效引用', () => {
    const memPath = `${memoryRoot}/1记忆.json`
    const deadNng = `${nngRoot}/AI1/U1/root/1已删_nng.json`
    const liveNng = `${nngRoot}/AI1/U1/root/2存活_nng.json`
    makeMemory(memPath, [deadNng])
    makeNng(liveNng, memPath)

    sync.sync(memPath)

    const mem = JSON.parse(readFileSync(memPath, 'utf-8'))
    expect(mem.关联NNG).not.toContain(deadNng)
    expect(mem.关联NNG).toContain(liveNng)
  })

  it('记忆关联NNG 非空且全部有效 → 不做反查，保持原样', () => {
    const memPath = `${memoryRoot}/1记忆.json`
    const nngPath = `${nngRoot}/AI1/U1/root/1节点_nng.json`
    makeMemory(memPath, [nngPath])
    makeNng(nngPath, memPath)

    sync.sync(memPath)

    const mem = JSON.parse(readFileSync(memPath, 'utf-8'))
    expect(mem.关联NNG).toEqual([nngPath])
  })

  it('子目录 NNG 的引用也能反查到（递归扫描）', () => {
    const memPath = `${memoryRoot}/1记忆.json`
    const subDir = `${nngRoot}/AI1/U1/root/1父`
    mkdirSync(subDir, { recursive: true })
    const nngPath = `${subDir}/2子节点_nng.json`
    makeMemory(memPath)
    makeNng(nngPath, memPath)

    sync.sync(memPath)

    const mem = JSON.parse(readFileSync(memPath, 'utf-8'))
    expect(mem.关联NNG).toContain(nngPath)
  })

  it('backfill=false（启动扫描/重试）→ 关联NNG 为空也不回填，只做基础校准', () => {
    const memPath = `${memoryRoot}/1记忆.json`
    const nngPath = `${nngRoot}/AI1/U1/root/1节点_nng.json`
    makeMemory(memPath)
    makeNng(nngPath, memPath)

    sync.sync(memPath, false)

    const mem = JSON.parse(readFileSync(memPath, 'utf-8'))
    expect(mem.关联NNG).toEqual([])
  })
})
