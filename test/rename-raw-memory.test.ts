import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { RenameRawMemoryTool, parseRawSeqFromName, findRawMemoryFileBySeq } from '../electron/main/tools/rename-raw-memory'
import { getNextRawMemoryBatch } from '../electron/main/services/raw-memory-next-batch'
import { readLatestRawMemory } from '../electron/main/api/visualization-data'
import type { DataPaths } from '../electron/main/models/paths'

function makePaths(tmpDir: string): DataPaths {
  const rawMemory = join(tmpDir, 'raw_memory')
  return {
    rawMemory,
    rawMemoryCounter: join(tmpDir, 'raw_memory_计数器.json'),
    rawMemoryProgress: join(tmpDir, '进度.json'),
    // 其余字段测试不涉及
  } as unknown as DataPaths
}

describe('parseRawSeqFromName', () => {
  it('纯序号 20.md → 20', () => {
    expect(parseRawSeqFromName('20.md')).toBe(20)
  })

  it('序号_关键词 20_记忆整理_重点回顾.md → 20', () => {
    expect(parseRawSeqFromName('20_记忆整理_重点回顾.md')).toBe(20)
  })

  it('英文关键词 20_user_auth_flow.md → 20', () => {
    expect(parseRawSeqFromName('20_user_auth_flow.md')).toBe(20)
  })

  it('非法格式返回 null', () => {
    expect(parseRawSeqFromName('abc.md')).toBeNull()
    expect(parseRawSeqFromName('20.txt')).toBeNull()
    expect(parseRawSeqFromName('.md')).toBeNull()
  })
})

describe('RenameRawMemoryTool', () => {
  let tmpDir: string
  let paths: DataPaths
  let rawRoot: string
  let dayDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rename-raw-test-'))
    paths = makePaths(tmpDir)
    rawRoot = paths.rawMemory
    dayDir = join(rawRoot, '2026', '08', '06')
    mkdirSync(dayDir, { recursive: true })
    writeFileSync(join(dayDir, '20.md'), '# RAW 记忆 #20\n\n- 时间戳：2026-08-06T10:00:00.000Z\n\n## 用户\n\n记忆已整理\n\n## AI\n\n已清空记忆库', 'utf-8')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('基本重命名：20.md → 20_关键词.md，序号不变', async () => {
    const tool = new RenameRawMemoryTool()
    const result = await tool.execute(
      { 路径: join(dayDir, '20.md'), 关键词: '记忆整理_重点回顾' },
      { paths, resolvePath: (p) => p }
    )
    expect(result.ok).toBe(true)
    const data = result.data as { 新路径: string; 序号: number; 关键词: string }
    expect(data.序号).toBe(20)
    expect(data.关键词).toBe('记忆整理_重点回顾')
    expect(data.新路径.endsWith('20_记忆整理_重点回顾.md')).toBe(true)
    expect(existsSync(data.新路径)).toBe(true)
    expect(existsSync(join(dayDir, '20.md'))).toBe(false)
  })

  it('路径不在 rawMemory 下 → 拒绝', async () => {
    const tool = new RenameRawMemoryTool()
    const outside = join(tmpDir, 'outside.md')
    writeFileSync(outside, 'x', 'utf-8')
    const result = await tool.execute(
      { 路径: outside, 关键词: '非法' },
      { paths, resolvePath: (p) => p }
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('不在 rawMemory')
  })

  it('文件名非法 → 拒绝', async () => {
    const tool = new RenameRawMemoryTool()
    const bad = join(dayDir, 'abc.md')
    writeFileSync(bad, 'x', 'utf-8')
    const result = await tool.execute(
      { 路径: bad, 关键词: '非法' },
      { paths, resolvePath: (p) => p }
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('不是合法 RAW 格式')
  })

  it('关键词清洗：非法字符替换为下划线 + 去首尾下划线', async () => {
    const tool = new RenameRawMemoryTool()
    const result = await tool.execute(
      { 路径: join(dayDir, '20.md'), 关键词: '  记忆 整理!@#' },
      { paths, resolvePath: (p) => p }
    )
    expect(result.ok).toBe(true)
    const data = result.data as { 新路径: string }
    expect(data.新路径.endsWith('20_记忆_整理.md')).toBe(true)
  })

  it('关键词全非法字符 → 拒绝', async () => {
    const tool = new RenameRawMemoryTool()
    const result = await tool.execute(
      { 路径: join(dayDir, '20.md'), 关键词: '!!!@@@' },
      { paths, resolvePath: (p) => p }
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('关键词清洗后为空')
  })

  it('防覆盖：目标已存在 → 拒绝', async () => {
    const tool = new RenameRawMemoryTool()
    writeFileSync(join(dayDir, '20_已存在.md'), 'existing', 'utf-8')
    const result = await tool.execute(
      { 路径: join(dayDir, '20.md'), 关键词: '已存在' },
      { paths, resolvePath: (p) => p }
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('已存在')
  })

  it('重复重命名幂等：已是 序号_关键词 再重命名', async () => {
    const tool = new RenameRawMemoryTool()
    const first = await tool.execute(
      { 路径: join(dayDir, '20.md'), 关键词: '记忆整理' },
      { paths, resolvePath: (p) => p }
    )
    expect(first.ok).toBe(true)
    const newPath = (first.data as { 新路径: string }).新路径
    const second = await tool.execute(
      { 路径: newPath, 关键词: '记忆整理_重点回顾' },
      { paths, resolvePath: (p) => p }
    )
    expect(second.ok).toBe(true)
    expect((second.data as { 新路径: string }).新路径.endsWith('20_记忆整理_重点回顾.md')).toBe(true)
  })
})

describe('getNextRawMemoryBatch 兼容重命名文件', () => {
  let tmpDir: string
  let paths: DataPaths

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'batch-rename-test-'))
    paths = makePaths(tmpDir)
    const dayDir = join(paths.rawMemory, '2026', '08', '06')
    mkdirSync(dayDir, { recursive: true })
    writeFileSync(join(dayDir, '1.md'), '# RAW #1\n\n- 时间戳：2026-08-06T10:00:00.000Z\n\n## 用户\n\na\n\n## AI\n\nb', 'utf-8')
    writeFileSync(join(dayDir, '2_记忆整理_重点回顾.md'), '# RAW #2\n\n- 时间戳：2026-08-06T11:00:00.000Z\n\n## 用户\n\nc\n\n## AI\n\nd', 'utf-8')
    writeFileSync(join(dayDir, '3.md'), '# RAW #3\n\n- 时间戳：2026-08-06T12:00:00.000Z\n\n## 用户\n\ne\n\n## AI\n\nf', 'utf-8')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('批次扫描同时识别纯序号与带关键词文件，seq 正确', () => {
    const result = getNextRawMemoryBatch(paths, 5)
    expect(result.batch.length).toBe(3)
    const seqs = result.batch.map((e) => e.seq).sort((a, b) => a - b)
    expect(seqs).toEqual([1, 2, 3])
    expect(result.nextProgress).toEqual({ 最后处理日期: '2026-08-06', 最后处理序号: 3 })
  })

  it('findRawMemoryFileBySeq 兼容两种格式', () => {
    expect(findRawMemoryFileBySeq(paths.rawMemory, '2026/08/06', 1)?.endsWith('1.md')).toBe(true)
    const f2 = findRawMemoryFileBySeq(paths.rawMemory, '2026/08/06', 2)
    expect(f2?.endsWith('2_记忆整理_重点回顾.md')).toBe(true)
  })
})

describe('readLatestRawMemory 兼容重命名文件', () => {
  let tmpDir: string
  let paths: DataPaths

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'viz-rename-test-'))
    paths = makePaths(tmpDir)
    const dayDir = join(paths.rawMemory, '2026', '08', '06')
    mkdirSync(dayDir, { recursive: true })
    writeFileSync(join(dayDir, '5_记忆整理_重点回顾.md'), '# RAW 记忆 #5\n\n- 时间戳：2026-08-06T10:00:00.000Z\n\n## 用户\n\n记忆已整理\n\n## AI\n\n已清空记忆库', 'utf-8')
    writeFileSync(paths.rawMemoryCounter, JSON.stringify({ 当前日期: '2026-08-06', 当前序号: 5, 更新时间: 'x' }), 'utf-8')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('计数器指向 5，能读到 5_关键词.md 内容', () => {
    const latest = readLatestRawMemory(paths)
    expect(latest).not.toBeNull()
    expect(latest!.seq).toBe(5)
    expect(latest!.userText).toContain('记忆已整理')
    expect(latest!.path.endsWith('5_记忆整理_重点回顾.md')).toBe(true)
  })
})
