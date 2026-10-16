import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listTopicPrompts } from '../electron/main/prompts/loader'

/** 提示词根目录（模拟 prompts/：frontend/topics + shared/topics） */
function makeRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'topics-'))
  mkdirSync(join(root, 'frontend', 'topics'), { recursive: true })
  mkdirSync(join(root, 'shared', 'topics'), { recursive: true })
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe('listTopicPrompts 按需提示词块扫描（2026-08-26 渐进披露）', () => {
  let ctx: ReturnType<typeof makeRoot>

  beforeEach(() => {
    ctx = makeRoot()
  })

  afterEach(() => {
    ctx.cleanup()
  })

  it('扫描 frontend/topics + shared/topics，按自然数排序', () => {
    writeFileSync(join(ctx.root, 'frontend', 'topics', '02-执行任务.md'), '> 执行软件工程任务时读本块。\n\n## 正文')
    writeFileSync(join(ctx.root, 'frontend', 'topics', '01-系统.md'), '> 系统行为细则。\n\n## 正文')
    writeFileSync(join(ctx.root, 'shared', 'topics', '01-子agent.md'), '> 派子任务前读本块。')

    const list = listTopicPrompts(ctx.root)
    expect(list.map((t) => t.name)).toEqual(['01-系统', '02-执行任务', '01-子agent'])
    // 摘要取首行（剥 > 前缀）
    expect(list[0].summary).toBe('系统行为细则。')
  })

  it('目录不存在返回空数组（不抛错）', () => {
    expect(listTopicPrompts(ctx.root)).toEqual([])
  })

  it('忽略隐藏文件和 .json', () => {
    writeFileSync(join(ctx.root, 'frontend', 'topics', '.hidden.md'), '> 隐藏')
    writeFileSync(join(ctx.root, 'frontend', 'topics', 'data.json'), '{}')
    writeFileSync(join(ctx.root, 'frontend', 'topics', '01-有用.md'), '> 有用块')

    const list = listTopicPrompts(ctx.root)
    expect(list.map((t) => t.name)).toEqual(['01-有用'])
  })
})