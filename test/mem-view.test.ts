import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { getMemoryDirectoryTree, getDirectoryChildren } from '../electron/main/api/visualization-data'
import { buildDataPaths, resolveScopePaths } from '../electron/main/models/paths'
import type { DataPaths } from '../electron/main/models/paths'

// 数据沙箱：临时目录（2026-09-10 修复——此前直写真实 app/data 造成测试数据污染）
let DATA_DIR: string
let SCOPED: DataPaths

beforeAll(() => {
  DATA_DIR = mkdtempSync(join(tmpdir(), 'mem-view-test-'))
  SCOPED = resolveScopePaths(buildDataPaths(DATA_DIR), { uid: 1, aiId: 1 })
  // 造数据：normal 下 2026 年份 + 一条记忆；NNG root 下 1工程开发 文件夹 + 同名 _nng.json
  mkdirSync(join(SCOPED.memoryNormal, '2026', '08', '14'), { recursive: true })
  if (!existsSync(join(SCOPED.memoryNormal, '2026', '08', '14', '1_测试_none.json'))) {
    writeFileSync(
      join(SCOPED.memoryNormal, '2026', '08', '14', '1_测试_none.json'),
      JSON.stringify({ 自身路径: '', 时间戳: '', 内容: { 用户原话: '测试', AI回复: '测试' }, 关联NNG: [], 备注: '', RAW来源: '', 用户: { UID: 1, 用户名: 'Player' } }, null, 2),
      'utf-8'
    )
  }
  mkdirSync(join(SCOPED.nngLevel1Dir, '1工程开发'), { recursive: true })
  if (!existsSync(join(SCOPED.nngLevel1Dir, '1工程开发_nng.json'))) {
    writeFileSync(
      join(SCOPED.nngLevel1Dir, '1工程开发_nng.json'),
      JSON.stringify({ 自身路径: '', 描述: '测试', 关联记忆: [], 上级NNG: [], 下级NNG: [], 归档记录: [] }, null, 2),
      'utf-8'
    )
  }
})

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true })
})

describe('记忆库专用视图（2026-08-14 用户设计，分层后）', () => {
  it('顶层返回六个记忆分类（空分类过滤后），全部懒加载标记', () => {
    const tree = getMemoryDirectoryTree(SCOPED)
    expect(tree.length).toBeGreaterThan(0)
    expect(tree.length).toBeLessThanOrEqual(6)
    const names = tree.map((n) => n.name)
    expect(names).toContain('普通记忆（normal）')
    expect(names).toContain('RAW 记忆')
    // 全部未加载（点开才扫），且非空分类
    for (const n of tree) {
      expect(n.loaded).toBe(false)
      expect(n.children!.length).toBe(0)
    }
  })

  it('普通记忆点开 → 年份文件夹（懒加载单层）', () => {
    const tree = getMemoryDirectoryTree(SCOPED)
    const normal = tree.find((n) => n.name.includes('normal'))!
    const children = getDirectoryChildren(normal.path)
    // 普通记忆下是年份目录（2026/2025…）
    expect(children.length).toBeGreaterThan(0)
    expect(children.every((c) => c.type === 'dir')).toBe(true)
    expect(children.some((c) => /^\d{4}$/.test(c.name))).toBe(true)
  })

  it('NNG root 点开 → 真实文件夹结构（同名文件与文件夹相邻成列）', () => {
    const tree = getMemoryDirectoryTree(SCOPED)
    const nng = tree.find((n) => n.name.includes('NNG'))!
    const children = getDirectoryChildren(nng.path)
    expect(children.length).toBeGreaterThan(0)
    // 真实结构：有文件夹也有同名 _nng.json 文件（并排，不配对、不分组）
    expect(children.some((c) => c.type === 'dir')).toBe(true)
    expect(children.some((c) => c.type === 'file' && c.name.endsWith('_nng.json'))).toBe(true)
    // 同名相邻：目录名按名称排序，其同名文件紧随（1工程开发 后必有 1工程开发_nng.json）
    const idx = children.findIndex((c) => c.name === '1工程开发')
    if (idx >= 0) {
      expect(children[idx + 1]?.name).toBe('1工程开发_nng.json')
    }
  })
})