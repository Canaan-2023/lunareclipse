import { describe, it, expect } from 'vitest'
import { SkillLoader, truncateSkillDescription, groupSkillsByCategory, matchSkillPath } from '../electron/main/skills/loader'
import { lintSkill, summarizeLint } from '../electron/main/skills/linter'
import { setPathContext } from '../electron/main/models/path-context'
import type { SkillMetadata } from '../electron/main/skills/types'

/**
 * SKILL 系统测试：
 * - 描述截断 / category 分组 / glob 匹配
 * - linter 规则
 */
describe('SKILL 系统', () => {
  it('listAutoInvocable 条件激活过滤（requires_tools）', () => {
    // 系统强制登录：注入登录态（uid/aiId），load() 才可解析分层路径
    setPathContext('/tmp/skills-global-root', () => 1, () => 1)
    const loader = new SkillLoader(() => null, '/tmp/nonexistent.json')
    loader.load()
    // 无工具池：不过滤
    const all = loader.listAutoInvocable()
    // 传空工具池：requiresTools 的 skill 被过滤
    const filtered = loader.listAutoInvocable([])
    expect(filtered.length).toBeLessThanOrEqual(all.length)
  })

  it('描述截断到 60 字符', () => {
    const long = '这是一段非常长的描述'.repeat(10)
    const truncated = truncateSkillDescription(long)
    expect(truncated.length).toBeLessThanOrEqual(61) // 60 + '…'
    expect(truncated.endsWith('…')).toBe(true)
    // 短描述不截断
    expect(truncateSkillDescription('短描述')).toBe('短描述')
  })

  it('category 分组', () => {
    const skills = [
      { name: 'a', category: '软件工程' },
      { name: 'b', category: '软件工程' },
      { name: 'c', category: '写作' },
      { name: 'd' } // 无 category → 通用
    ] as unknown as SkillMetadata[]
    const groups = groupSkillsByCategory(skills)
    expect(groups.get('软件工程')?.length).toBe(2)
    expect(groups.get('写作')?.length).toBe(1)
    expect(groups.get('通用')?.length).toBe(1)
  })

  it('glob 匹配（paths 自动激活）', () => {
    const meta = {
      name: 'test',
      paths: ['*.tsx', 'src/**/*.ts']
    } as unknown as SkillMetadata
    expect(matchSkillPath(meta, 'App.tsx')).toBe(true) // basename 匹配 *.tsx
    expect(matchSkillPath(meta, 'index.js')).toBe(false)
    expect(matchSkillPath(meta, 'src/components/Button.ts')).toBe(true) // 匹配 src/**/*.ts
    expect(matchSkillPath(meta, 'src/App.tsx')).toBe(true) // basename 匹配 *.tsx
    expect(matchSkillPath(meta, 'other/App.tsx')).toBe(true) // basename 匹配 *.tsx（跨目录）
    expect(matchSkillPath(meta, 'src/App.ts')).toBe(true) // 匹配 src/**/*.ts
  })

  it('linter：裸命令/营销词/危险模式检测', () => {
    const clean = lintSkill({ name: 'ok-skill', description: '好描述', body: '使用 `Read` 读取文件，然后分析。' })
    expect(summarizeLint(clean).errors).toBe(0)

    const dirty = lintSkill({
      name: 'bad skill',
      description: '',
      body: 'run grep foo; eval(x); rm -rf /; unleash the power'
    })
    const summary = summarizeLint(dirty)
    expect(summary.errors).toBeGreaterThanOrEqual(2) // name 非法 + description 空
    expect(summary.warnings).toBeGreaterThanOrEqual(2) // grep + eval + rm -rf
  })
})
