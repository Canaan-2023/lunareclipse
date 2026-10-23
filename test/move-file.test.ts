/**
 * move-file.test.ts — MoveFileTool 回归（2026-10-02）
 *
 * 背景：loader.ts 修复「目标=源路径后代（自嵌套）时 Windows renameSync 必 EPERM」后，
 * 全库评审发现通用工具 MoveFileTool 是自己构造 src/dst 的入口（AI 自由传入），
 * 却只有 src === dst 检查、没有自嵌套防御——若 AI 把目录 A 移到 A/B，会先 mkdir
 * 在源内部建目录再 rename 抛 EPERM。
 *
 * 覆盖：正常移动（文件/目录）、src===dst、源不存在、自嵌套拒绝且源目录不被污染。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { MoveFileTool } from '../electron/main/tools/move-file'

describe('MoveFileTool', () => {
  let tmpDir: string
  const tool = new MoveFileTool()

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'move-file-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('同目录内文件改名', async () => {
    const src = join(tmpDir, 'a.txt')
    const dst = join(tmpDir, 'b.txt')
    writeFileSync(src, 'hello', 'utf-8')

    const res = await tool.execute({ source_path: src, target_path: dst })

    expect(res.ok).toBe(true)
    expect(existsSync(src)).toBe(false)
    expect(existsSync(dst)).toBe(true)
  })

  it('跨目录移动目录（自动创建目标父目录）', async () => {
    const src = join(tmpDir, 'src', 'sdir')
    const dst = join(tmpDir, 'dst', 'nested', 'sdir')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'f.txt'), 'x', 'utf-8')

    const res = await tool.execute({ source_path: src, target_path: dst })

    expect(res.ok).toBe(true)
    expect(existsSync(src)).toBe(false)
    expect(existsSync(join(dst, 'f.txt'))).toBe(true)
  })

  it('src === dst 时返回 moved:false 且不报错', async () => {
    const src = join(tmpDir, 'same.txt')
    writeFileSync(src, 'x', 'utf-8')

    const res = await tool.execute({ source_path: src, target_path: src })

    expect(res.ok).toBe(true)
    expect((res.data as { moved: boolean }).moved).toBe(false)
    expect((res.data as { reason: string }).reason).toBe('same path')
  })

  it('源路径不存在时报错', async () => {
    const res = await tool.execute({ source_path: join(tmpDir, 'nope'), target_path: join(tmpDir, 'x') })

    expect(res.ok).toBe(false)
    expect((res.error ?? '').includes('源路径不存在')).toBe(true)
  })

  it('目标位于源目录内部（自嵌套）时拒绝，且不污染源目录', async () => {
    const src = join(tmpDir, 'node')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'keep.txt'), 'keep', 'utf-8')
    // 把 node 移到 node/sub——目标在源内部，Windows renameSync 必 EPERM
    const dst = join(src, 'sub')

    const res = await tool.execute({ source_path: src, target_path: dst })

    expect(res.ok).toBe(false)
    expect((res.error ?? '').includes('自嵌套')).toBe(true)
    // 源目录与内容必须原地不动（不能先 mkdir 出残留的 sub/）
    expect(existsSync(src)).toBe(true)
    expect(existsSync(join(src, 'keep.txt'))).toBe(true)
    expect(existsSync(dst)).toBe(false)
    expect(readdirSync(src)).toEqual(['keep.txt'])
  })
})