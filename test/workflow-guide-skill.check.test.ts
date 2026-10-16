import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { parseSkillFile } from '../electron/main/skills/frontmatter'
import { lintSkill, summarizeLint } from '../electron/main/skills/linter'

const SKILL = resolve(__dirname, '../data/abyssac_data/skills/U1/AI1/workflow-guide/SKILL.md')

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