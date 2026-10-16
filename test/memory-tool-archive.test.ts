import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { MemoryTool } from '../electron/main/tools/memory'
import type { ToolContext } from '../electron/main/tools/base-tool'

/**
 * 回归：归档 NNG 节点时，节点文件与同名子节点文件夹必须一并归档。
 * NNG 层级靠文件夹表达（子节点在 父节点名/ 下），只移 xxx_nng.json 会让子节点成孤儿。
 */
describe('MemoryTool archive（节点文件 + 同名子节点文件夹一并归档）', () => {
  let tmpDir: string
  let ctx: ToolContext
  let root: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mem-archive-test-'))
    root = join(tmpDir, 'NNG')
    mkdirSync(root, { recursive: true })
    // execute 会校验 ctx.paths 存在（archive 本身不读它）
    ctx = { paths: { root: tmpDir } } as unknown as ToolContext
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('归档 xxx_nng.json 时同名文件夹 xxx/ 一并进 archive，子节点不成孤儿', async () => {
    const nodeFile = join(root, '工程排障_nng.json')
    const childDir = join(root, '工程排障')
    mkdirSync(childDir, { recursive: true })
    writeFileSync(nodeFile, JSON.stringify({ name: '工程排障' }), 'utf-8')
    writeFileSync(join(childDir, '子节点_nng.json'), JSON.stringify({ name: '子节点' }), 'utf-8')

    const res = await new MemoryTool().execute({ action: 'archive', archive_path: nodeFile }, ctx)

    expect(res.ok).toBe(true)
    // 节点文件与同名文件夹都进了 archive/
    expect(existsSync(join(root, 'archive', '工程排障_nng.json'))).toBe(true)
    expect(existsSync(join(root, 'archive', '工程排障', '子节点_nng.json'))).toBe(true)
    // 原位置清空（不再留孤儿文件夹）
    expect(existsSync(nodeFile)).toBe(false)
    expect(existsSync(childDir)).toBe(false)
    // 返回值声明了随迁的文件夹
    expect((res.data as { 一并归档子节点文件夹?: string[] }).一并归档子节点文件夹?.length).toBe(1)
  })

  it('节点文件无同名文件夹时正常归档，返回值不带随迁字段', async () => {
    const nodeFile = join(root, '孤立_nng.json')
    writeFileSync(nodeFile, '{}', 'utf-8')

    const res = await new MemoryTool().execute({ action: 'archive', archive_path: nodeFile }, ctx)

    expect(res.ok).toBe(true)
    expect(existsSync(join(root, 'archive', '孤立_nng.json'))).toBe(true)
    expect((res.data as { 一并归档子节点文件夹?: string[] }).一并归档子节点文件夹).toBeUndefined()
  })

  it('archive/ 已有同名节点文件时拒绝归档，且源文件夹/文件原地不动（不留半归档孤儿）', async () => {
    const nodeFile = join(root, '工程排障_nng.json')
    const childDir = join(root, '工程排障')
    mkdirSync(childDir, { recursive: true })
    writeFileSync(nodeFile, JSON.stringify({ name: '工程排障' }), 'utf-8')
    writeFileSync(join(childDir, '子节点_nng.json'), JSON.stringify({ name: '子节点' }), 'utf-8')
    // 预置同名旧档，制造归档目标冲突
    const archiveDir = join(root, 'archive')
    mkdirSync(archiveDir, { recursive: true })
    writeFileSync(join(archiveDir, '工程排障_nng.json'), JSON.stringify({ name: '旧档' }), 'utf-8')

    const res = await new MemoryTool().execute({ action: 'archive', archive_path: nodeFile }, ctx)

    expect(res.ok).toBe(false)
    // 关键：冲突在搬文件夹之前校验，源文件夹与节点文件都必须原地不动
    expect(existsSync(nodeFile)).toBe(true)
    expect(existsSync(childDir)).toBe(true)
    expect(existsSync(join(childDir, '子节点_nng.json'))).toBe(true)
    // archive/ 不应混入搬了一半的文件夹
    expect(existsSync(join(archiveDir, '工程排障'))).toBe(false)
  })

  it('直接传文件夹 → 整个文件夹归档', async () => {
    const dir = join(root, '父节点')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a_nng.json'), '{}', 'utf-8')

    const res = await new MemoryTool().execute({ action: 'archive', archive_path: dir }, ctx)

    expect(res.ok).toBe(true)
    expect(existsSync(join(root, 'archive', '父节点', 'a_nng.json'))).toBe(true)
    expect(existsSync(dir)).toBe(false)
  })

  it('归档目标恰为 archive 目录自身 → 拒绝（防自嵌套 EPERM）', async () => {
    // archive_path 传 archive 目录本身：srcPath === {root}/archive，
    // destDir = {root}/archive/archive 落在源内部，Windows rename 必然 EPERM
    const archiveDir = join(root, 'archive')
    mkdirSync(archiveDir, { recursive: true })
    writeFileSync(join(archiveDir, '历史档_nng.json'), '{}', 'utf-8')

    const res = await new MemoryTool().execute({ action: 'archive', archive_path: archiveDir }, ctx)

    expect(res.ok).toBe(false)
    expect((res.error ?? '').includes('自嵌套')).toBe(true)
    // 源目录必须原地不动，不允许在 archive 内部再套 archive
    expect(existsSync(join(archiveDir, '历史档_nng.json'))).toBe(true)
    expect(existsSync(join(archiveDir, 'archive'))).toBe(false)
  })

  it('节点名恰为 archive（archive_nng.json 且存在同名文件夹）→ 拒绝（防自嵌套 EPERM）', async () => {
    // nodeName = 'archive' 时 folderPath = {root}/archive = archiveDir 自身，
    // folderDest = {root}/archive/archive 落在源内部——同理拒绝
    const archiveDir = join(root, 'archive')
    mkdirSync(archiveDir, { recursive: true })
    writeFileSync(join(archiveDir, '历史档_nng.json'), '{}', 'utf-8')
    const nodeFile = join(root, 'archive_nng.json')
    writeFileSync(nodeFile, '{}', 'utf-8')

    const res = await new MemoryTool().execute({ action: 'archive', archive_path: nodeFile }, ctx)

    expect(res.ok).toBe(false)
    expect((res.error ?? '').includes('自嵌套')).toBe(true)
    // 父节点节点文件与其同名文件夹（即 archive 目录自身）都不得被移动
    expect(existsSync(nodeFile)).toBe(true)
    expect(existsSync(join(archiveDir, '历史档_nng.json'))).toBe(true)
    expect(existsSync(join(archiveDir, 'archive'))).toBe(false)
  })
})
