import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { parseSkillFile } from '../electron/main/skills/frontmatter'
import { lintSkill, summarizeLint } from '../electron/main/skills/linter'

// 规范自检对象取仓库内随包分发的内置技能副本（electron/main/skills/market-repo/…）：
// 该文件在版本控制内、随 app/ 整体搬移，任意放置位置可跑；
// 不指向 data/（运行时用户数据目录，gitignored，干净树不存在，会破坏可移植性）。
const SKILL = resolve(__dirname, '../electron/main/skills/market-repo/skills/workflow-guide/SKILL.md')

function extractBody(raw: string): string {
  const idx = raw.indexOf('---', 3)
  return idx >= 0 ? raw.slice(idx + 3) : raw
}

describe('workflow-guide SKILL 规范自检', () => {
  it('frontmatter 解析合法', () => {
    const meta = parseSkillFile(SKILL, 'user')
    expect(meta.name).toBe('workflow-guide')
    expect(meta.description.length).toBeGreaterThan(0)
    expect(meta.description.length).toBeLessThanOrEqual(1024)
    expect(meta.context).toBe('inline')
    expect(meta.category).toBe('automation')
  })

  it('lint 零 error', () => {
    const raw = readFileSync(SKILL, 'utf-8')
    const issues = lintSkill({
      name: 'workflow-guide',
      description: '运行、创建或修改月蚀工作流（模板查询、启动、等待结果、定义/编辑模板）时使用。',
      body: extractBody(raw)
    })
    const { errors, warnings } = summarizeLint(issues)
    expect(errors).toBe(0)
    console.log('[lint]', JSON.stringify(summarizeLint(issues)))
    expect(warnings).toBe(0)
  })

  it('正文包含关键语义（等待终态/无硬截断/轮询兜底）', () => {
    const raw = readFileSync(SKILL, 'utf-8')
    expect(raw).toContain('默认等待实例跑到终态')
    expect(raw).toContain('没有被中断')
    expect(raw).toContain('workflow_status')
    expect(raw).toContain('workflow_define')
  })
})