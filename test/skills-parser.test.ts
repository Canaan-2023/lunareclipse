import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import {
  parseSkillFile,
  truncateSkillDescription,
  groupSkillsByCategory,
  matchSkillPath
} from '../electron/main/skills/loader'
import { SkillValidationError } from '../electron/main/skills/types'
import type { SkillMetadata } from '../electron/main/skills/types'

const TMP = join(process.cwd(), 'tmp', 'skills-parser-test')

function writeSkill(relative: string, content: string): string {
  const dir = join(TMP, relative)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'SKILL.md')
  writeFileSync(filePath, content, 'utf-8')
  return filePath
}

function makeMeta(over: Partial<SkillMetadata> = {}): SkillMetadata {
  return {
    name: 'demo-skill',
    description: '测试技能',
    source: 'user',
    filePath: join(TMP, 'demo-skill', 'SKILL.md'),
    dirPath: join(TMP, 'demo-skill'),
    runtime: { enabled: true },
    ...over
  }
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true })
})

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('parseSkillFile frontmatter 解析', () => {
  it('解析标准字段 + kebab-case 映射', () => {
    const filePath = writeSkill('kebab', `---
name: my-skill
description: 描述文本
disable-model-invocation: true
user-invocable: false
context: fork
allowed-tools:
  - Read
  - Write
paths:
  - "*.tsx"
platforms:
  - windows
dependencies:
  - other-skill
related-skills:
  - sibling-skill
tags:
  - tag1
requires-tools:
  - run_command
fallback-for-tools:
  - read_file
version: 1.2.3
author: tester
license: MIT
homepage: https://example.com
category: code
---
正文内容
`)
    const meta = parseSkillFile(filePath, 'user')
    expect(meta.name).toBe('my-skill')
    expect(meta.description).toBe('描述文本')
    expect(meta.disableModelInvocation).toBe(true)
    expect(meta.userInvocable).toBe(false)
    expect(meta.context).toBe('fork')
    expect(meta.allowedTools).toEqual(['Read', 'Write'])
    expect(meta.paths).toEqual(['*.tsx'])
    expect(meta.platforms).toEqual(['windows'])
    expect(meta.dependencies).toEqual(['other-skill'])
    expect(meta.relatedSkills).toEqual(['sibling-skill'])
    expect(meta.tags).toEqual(['tag1'])
    expect(meta.requiresTools).toEqual(['run_command'])
    expect(meta.fallbackForTools).toEqual(['read_file'])
    expect(meta.version).toBe('1.2.3')
    expect(meta.author).toBe('tester')
    expect(meta.license).toBe('MIT')
    expect(meta.homepage).toBe('https://example.com')
    expect(meta.category).toBe('code')
    expect(meta.source).toBe('user')
    expect(meta.runtime.enabled).toBe(true)
  })

  it('布尔字段宽松解析（字符串 true/false）', () => {
    const filePath = writeSkill('bool', `---
name: bool-skill
description: 布尔解析
disable-model-invocation: "true"
user-invocable: "false"
---
`)
    const meta = parseSkillFile(filePath, 'domain')
    expect(meta.disableModelInvocation).toBe(true)
    expect(meta.userInvocable).toBe(false)
    expect(meta.source).toBe('domain')
  })

  it('context 非法值被忽略（保持 undefined）', () => {
    const filePath = writeSkill('ctx', `---
name: ctx-skill
description: ctx
context: weird
---
`)
    const meta = parseSkillFile(filePath, 'user')
    expect(meta.context).toBeUndefined()
  })

  it('未知字段进 extraFields，已知字段不进', () => {
    const filePath = writeSkill('extra', `---
name: extra-skill
description: extra 字段
metadata:
  provider: x
custom-key: custom-value
---
`)
    const meta = parseSkillFile(filePath, 'user')
    expect(meta.extraFields).toBeDefined()
    expect(meta.extraFields!['custom-key']).toBe('custom-value')
  })

  it('标量数组字段：字符串包装为单元素数组', () => {
    const filePath = writeSkill('scalar-array', `---
name: scalar-array-skill
description: 标量数组
tags: solo
---
`)
    const meta = parseSkillFile(filePath, 'user')
    expect(meta.tags).toEqual(['solo'])
  })

  it('缺少 name / description 抛 SkillValidationError', () => {
    const noName = writeSkill('no-name', `---
description: only desc
---
`)
    expect(() => parseSkillFile(noName, 'user')).toThrow(SkillValidationError)
    const noDesc = writeSkill('no-desc', `---
name: no-desc
---
`)
    expect(() => parseSkillFile(noDesc, 'user')).toThrow(SkillValidationError)
  })

  it('name 校验：kebab-case / 超长 / 保留词 / XML 标签', () => {
    const bad = [
      ['UPPER-name', 'name: UPPER-name\ndescription: x\n'],
      [`name: ${'a'.repeat(65)}\ndescription: x\n`, null],
      ['lunareclipse-skill', 'name: lunareclipse-skill\ndescription: x\n'],
      ['tag<evil>', 'name: tag<evil>\ndescription: x\n']
    ]
    for (const [, body] of bad) {
      if (!body) continue
      const filePath = writeSkill(`bad-${Math.random()}`, `---\n${body}---\n`)
      expect(() => parseSkillFile(filePath, 'user')).toThrow(SkillValidationError)
    }
    // 单独测第一个（name 大写开头非法）
    const upper = writeSkill('bad-upper', '---\nname: UPPER-name\ndescription: x\n---\n')
    expect(() => parseSkillFile(upper, 'user')).toThrow(SkillValidationError)
  })

  it('description 校验：空 / 超长 / XML 标签', () => {
    const empty = writeSkill('desc-empty', '---\nname: desc-empty\ndescription:   \n---\n')
    expect(() => parseSkillFile(empty, 'user')).toThrow(SkillValidationError)
    const long = writeSkill('desc-long', `---\nname: desc-long\ndescription: ${'x'.repeat(1025)}\n---\n`)
    expect(() => parseSkillFile(long, 'user')).toThrow(SkillValidationError)
    const xml = writeSkill('desc-xml', '---\nname: desc-xml\ndescription: 有<b>标签</b>\n---\n')
    expect(() => parseSkillFile(xml, 'user')).toThrow(SkillValidationError)
  })

  it('frontmatter 未闭合 / YAML 非法 / 空对象抛错', () => {
    const unclosed = writeSkill('unclosed', '---\nname: unclosed\ndescription: x\n')
    expect(() => parseSkillFile(unclosed, 'user')).toThrow(/闭合/)
    const badYaml = writeSkill('bad-yaml', '---\nname: [unclosed\n---\n')
    expect(() => parseSkillFile(badYaml, 'user')).toThrow(/YAML/)
    const bare = writeSkill('bare', '没有 frontmatter\n')
    expect(() => parseSkillFile(bare, 'user')).toThrow(SkillValidationError)
  })

  it('platforms 非法值 / config 缺字段 / version 非法', () => {
    const badPlat = writeSkill('bad-plat', '---\nname: bad-plat\ndescription: x\nplatforms:\n  - dos\n---\n')
    expect(() => parseSkillFile(badPlat, 'user')).toThrow(/platforms/)
    const badConfig = writeSkill('bad-config', '---\nname: bad-config\ndescription: x\nconfig:\n  - key: only-key\n---\n')
    expect(() => parseSkillFile(badConfig, 'user')).toThrow(/config/)
    const badVersion = writeSkill('bad-ver', '---\nname: bad-ver\ndescription: x\nversion: "a b"\n---\n')
    expect(() => parseSkillFile(badVersion, 'user')).toThrow(/version/)
  })
})

describe('机制辅助纯函数', () => {
  it('truncateSkillDescription：超长截断到 60 + …，短描述不动', () => {
    const long = 'x'.repeat(80)
    const t = truncateSkillDescription(long)
    expect(t.length).toBe(61)
    expect(t.endsWith('…')).toBe(true)
    expect(truncateSkillDescription('short')).toBe('short')
  })

  it('groupSkillsByCategory：按 category 分组，无 category 归 通用', () => {
    const a = makeMeta({ name: 'a', category: 'code' })
    const b = makeMeta({ name: 'b', category: 'code' })
    const c = makeMeta({ name: 'c' })
    const groups = groupSkillsByCategory([a, b, c])
    expect(groups.get('code')!.map((s) => s.name)).toEqual(['a', 'b'])
    expect(groups.get('通用')!.map((s) => s.name)).toEqual(['c'])
  })

  it('matchSkillPath：单星/双星/问号/无路径返回 false', () => {
    const meta = makeMeta({ paths: ['*.tsx', 'src/**/*.ts', 'test/?.spec.ts'] })
    expect(matchSkillPath(meta, '/a/b/App.tsx')).toBe(true)
    expect(matchSkillPath(meta, '/a/b/main.js')).toBe(false)
    expect(matchSkillPath(meta, 'src/deep/nested/util.ts')).toBe(true)
    expect(matchSkillPath(meta, 'src/util.ts')).toBe(true)
    expect(matchSkillPath(meta, 'test/a.spec.ts')).toBe(true)
    expect(matchSkillPath(meta, 'test/ab.spec.ts')).toBe(false)
    const noPath = makeMeta()
    expect(matchSkillPath(noPath, '/a/b/App.tsx')).toBe(false)
  })

  it('matchSkillPath：反斜杠路径归一化 + 无斜杠模式匹配 basename', () => {
    const meta = makeMeta({ paths: ['*.tsx'] })
    expect(matchSkillPath(meta, 'C:\\project\\App.tsx')).toBe(true)
  })
})