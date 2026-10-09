/**
 * prompts/abyss-md.ts — USER.md / AI.md 读取端单测
 * 覆盖：文件存在/不存在/空白三种情况；UI 级 USER.md 与 AI 级 AI.md（按 aiId 定位）的包装格式。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildDataPaths, type BaseDataPaths } from '../electron/main/models/paths'
import { readUserMdContent, readAiMdContent } from '../electron/main/prompts/abyss-md'

let tmpDir: string
let paths: BaseDataPaths

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'abyss-md-test-'))
  paths = buildDataPaths(tmpDir)
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('readUserMdContent（用户级 USER.md）', () => {
  it('文件存在且有内容：返回带包装前缀的完整文本', () => {
    mkdirSync(join(paths.abyss, 'U1'), { recursive: true })
    writeFileSync(join(paths.abyss, 'U1', 'USER.md'), '# 用户个人资料卡\n| 姓名 | 张三 |', 'utf-8')
    const out = readUserMdContent(paths, 1)
    expect(out).not.toBeNull()
    expect(out).toContain('[用户个人资料卡（ABYSS/U1/USER.md')
    expect(out).toContain('| 姓名 | 张三 |')
  })

  it('文件不存在：返回 null（不注入该段）', () => {
    expect(readUserMdContent(paths, 1)).toBeNull()
  })

  it('文件存在但内容为空：返回 null', () => {
    mkdirSync(join(paths.abyss, 'U2'), { recursive: true })
    writeFileSync(join(paths.abyss, 'U2', 'USER.md'), '   ', 'utf-8')
    expect(readUserMdContent(paths, 2)).toBeNull()
  })
})

describe('readAiMdContent（AI 级 AI.md，按 aiId 定位）', () => {
  it('文件存在且有内容：返回带包装前缀的完整文本（路径含 AI2）', () => {
    mkdirSync(join(paths.abyss, 'U1', 'AI2'), { recursive: true })
    writeFileSync(join(paths.abyss, 'U1', 'AI2', 'AI.md'), '我是莉莉丝，陪伴型角色。', 'utf-8')
    const out = readAiMdContent(paths, 1, 2)
    expect(out).not.toBeNull()
    expect(out).toContain('[你的自我认知（ABYSS/U1/AI2/AI.md')
    expect(out).toContain('我是莉莉丝')
  })

  it('按 aiId 隔离：U1/AI1 与 U1/AI2 各自独立', () => {
    mkdirSync(join(paths.abyss, 'U1', 'AI1'), { recursive: true })
    writeFileSync(join(paths.abyss, 'U1', 'AI1', 'AI.md'), '月蚀的认知', 'utf-8')
    expect(readAiMdContent(paths, 1, 1)).toContain('月蚀的认知')
    expect(readAiMdContent(paths, 1, 2)).toBeNull()
  })

  it('文件不存在：返回 null', () => {
    expect(readAiMdContent(paths, 1, 2)).toBeNull()
  })

  it('文件存在但内容为空：返回 null', () => {
    mkdirSync(join(paths.abyss, 'U1', 'AI3'), { recursive: true })
    writeFileSync(join(paths.abyss, 'U1', 'AI3', 'AI.md'), '\n\n', 'utf-8')
    expect(readAiMdContent(paths, 1, 3)).toBeNull()
  })
})