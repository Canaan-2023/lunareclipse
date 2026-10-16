import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setPathContext } from '../electron/main/models/path-context'
import { SkillLoader } from '../electron/main/skills/loader'
import { getMarketRoot, SkillMarket } from '../electron/main/skills/market'

function writeSkill(root: string, relPath: string, name: string, extra = ''): string {
  const dir = join(root, relPath)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'SKILL.md')
  writeFileSync(
    filePath,
    `---
name: ${name}
description: ${name} 的描述
${extra}
---
正文
`,
    'utf-8'
  )
  return filePath
}

let root: string
let dataRoot: string
/** 模拟登录态：uid=1 / aiId=1（系统强制登录，未登录无分层路径可解析） */
const TEST_UID = 1
const TEST_AI_ID = 1

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skills-scan-'))
  dataRoot = mkdtempSync(join(tmpdir(), 'skills-root-'))
  setPathContext(dataRoot, () => TEST_UID, () => TEST_AI_ID)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(dataRoot, { recursive: true, force: true })
})

describe('SkillLoader 目录扫描与优先级', () => {
  it('扫描用户级扁平目录：子目录含 SKILL.md 即注册', () => {
    // 登录态分层：{root}/skills/U{uid}/AI{aiId}/{name}
    const skillsDir = join(dataRoot, 'skills', `U${TEST_UID}`, `AI${TEST_AI_ID}`)
    writeSkill(skillsDir, 'alpha', 'alpha-skill')
    writeSkill(skillsDir, 'beta', 'beta-skill')
    const loader = new SkillLoader(() => null, join(root, 'config.json'))
    const res = loader.load()
    expect(res.metadatas.map((m) => m.name).sort()).toEqual(['alpha-skill', 'beta-skill'])
    expect(res.errors).toHaveLength(0)
  })

  it('领域级：文件夹即领域真源，frontmatter 声明不参与判定', () => {
    const domainDir = join(dataRoot, 'skills_domains', `U${TEST_UID}`, `AI${TEST_AI_ID}`)
    // 未声明 domain：文件夹名 code 即领域
    writeSkill(join(domainDir, 'code'), 'fmt', 'fmt-skill')
    // 物理上在 code 目录但自我声明 ui：以目录为准，声明被忽略
    writeSkill(join(domainDir, 'code'), 'widget', 'widget-skill', 'domain: ui')
    const loader = new SkillLoader(() => domainDir, join(root, 'config.json'))
    const res = loader.load()
    const fmt = res.metadatas.find((m) => m.name === 'fmt-skill')
    const widget = res.metadatas.find((m) => m.name === 'widget-skill')
    expect(fmt?.source).toBe('domain')
    expect(fmt?.domain).toBe('code')
    expect(widget?.domain).toBe('code')
  })

  it('领域级：支持任意数量领域与多级递归（a/b/c），目录即领域链', () => {
    const domainDir = join(dataRoot, 'skills_domains', `U${TEST_UID}`, `AI${TEST_AI_ID}`)
    writeSkill(join(domainDir, 'code'), 'lint', 'lint-skill')
    writeSkill(join(domainDir, 'ui'), 'grid', 'grid-skill')
    writeSkill(join(domainDir, 'design', 'web'), 'palette', 'palette-skill')
    writeSkill(join(domainDir, 'design', 'print'), 'poster', 'poster-skill')
    const loader = new SkillLoader(() => domainDir, join(root, 'config.json'))
    const res = loader.load()
    expect(res.errors).toHaveLength(0)
    expect(res.metadatas.find((m) => m.name === 'lint-skill')?.domain).toBe('code')
    expect(res.metadatas.find((m) => m.name === 'grid-skill')?.domain).toBe('ui')
    // 多级领域：领域 = 相对领域级根的父路径链
    expect(res.metadatas.find((m) => m.name === 'palette-skill')?.domain).toBe('design/web')
    expect(res.metadatas.find((m) => m.name === 'poster-skill')?.domain).toBe('design/print')
    // 同名领域合并：design 下两个子领域各自独立，不互相覆盖
    expect(res.metadatas.filter((m) => m.domain?.startsWith('design'))).toHaveLength(2)
  })

  it('领域级根下扁平技能：领域为空按未分类展示', () => {
    const domainDir = join(dataRoot, 'skills_domains', `U${TEST_UID}`, `AI${TEST_AI_ID}`)
    writeSkill(join(domainDir), 'flat', 'flat-skill')
    const loader = new SkillLoader(() => domainDir, join(root, 'config.json'))
    const res = loader.load()
    const flat = res.metadatas.find((m) => m.name === 'flat-skill')
    expect(flat?.source).toBe('domain')
    expect(flat?.domain).toBeUndefined()
  })

  it('优先级：领域级覆盖同名用户级（后扫描覆盖）', () => {
    // 用户级 skills/U1/AI1/dup
    writeSkill(join(dataRoot, 'skills', `U${TEST_UID}`, `AI${TEST_AI_ID}`), 'dup', 'dup-skill', 'version: 1.0.0')
    // 领域级 skills_domains/U1/AI1/general/dup
    writeSkill(join(dataRoot, 'skills_domains', `U${TEST_UID}`, `AI${TEST_AI_ID}`, 'general'), 'dup', 'dup-skill', 'version: 2.0.0')
    const loader = new SkillLoader(
      () => join(dataRoot, 'skills_domains', `U${TEST_UID}`, `AI${TEST_AI_ID}`),
      join(root, 'config.json')
    )
    const res = loader.load()
    const dup = res.metadatas.find((m) => m.name === 'dup-skill')
    expect(res.metadatas).toHaveLength(1)
    expect(dup?.version).toBe('2.0.0')
    expect(dup?.source).toBe('domain')
  })

  it('非法 SKILL.md 不阻断其他 skill，错误进 errors', () => {
    const skillsDir = join(dataRoot, 'skills', `U${TEST_UID}`, `AI${TEST_AI_ID}`)
    writeSkill(skillsDir, 'bad', 'bad-skill', 'platforms:\n  - dos\n')
    writeSkill(skillsDir, 'good', 'good-skill')
    const loader = new SkillLoader(() => null, join(root, 'config.json'))
    const res = loader.load()
    expect(res.metadatas.map((m) => m.name)).toEqual(['good-skill'])
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0].filePath).toBe(join(skillsDir, 'bad', 'SKILL.md'))
    expect(loader.getErrors()).toHaveLength(1)
  })

  it('getDomainSkillsDir 返回 null 时跳过领域扫描', () => {
    writeSkill(join(dataRoot, 'skills', `U${TEST_UID}`, `AI${TEST_AI_ID}`), 'only', 'only-user')
    const loader = new SkillLoader(() => null, join(root, 'config.json'))
    const res = loader.load()
    expect(res.metadatas.map((m) => m.name)).toEqual(['only-user'])
  })

  it('listAutoInvocable 条件激活：requires_tools / fallback_for_tools / 平台门控', () => {
    const skillsDir = join(dataRoot, 'skills', `U${TEST_UID}`, `AI${TEST_AI_ID}`)
    writeSkill(skillsDir, 'needs', 'needs-run', 'requires-tools:\n  - run_command\n')
    writeSkill(skillsDir, 'fallback', 'fallback-skill', 'fallback-for-tools:\n  - read_file\n')
    writeSkill(skillsDir, 'plain', 'plain-skill')
    const loader = new SkillLoader(() => null, join(root, 'config.json'))
    loader.load()
    // 不传工具池：全部可自动触发
    expect(loader.listAutoInvocable().map((m) => m.name).sort()).toEqual([
      'fallback-skill',
      'needs-run',
      'plain-skill'
    ])
    // 传入工具池：needs-run 缺工具被隐；fallback-skill 主工具在池中被隐
    const filtered = loader.listAutoInvocable(['read_file'])
    expect(filtered.map((m) => m.name)).toEqual(['plain-skill'])
    // 传入 run_command：needs-run 合格；fallback-skill 主工具不在池中 → 保留
    const filtered2 = loader.listAutoInvocable(['run_command'])
    expect(filtered2.map((m) => m.name).sort()).toEqual(['fallback-skill', 'needs-run', 'plain-skill'])
  })

  it('loadBody 更新使用统计（lastUsedAt + useCount）', () => {
    const skillsDir = join(dataRoot, 'skills', `U${TEST_UID}`, `AI${TEST_AI_ID}`)
    const fp = writeSkill(skillsDir, 'stats', 'stats-skill')
    const loader = new SkillLoader(() => null, join(root, configName()))
    loader.load()
    const skill = loader.loadBody('stats-skill')
    expect(skill?.body).toBe('正文')
    expect(loader.loadBody('nonexistent')).toBeNull()
    const status = loader.getStatuses().find((s) => s.name === 'stats-skill')
    expect(status?.useCount).toBe(1)
    expect(status?.lastUsedAt).toBeGreaterThan(0)
    void fp
  })

  it('setEnabled / deleteSkill 修改运行时状态', () => {
    const skillsDir = join(dataRoot, 'skills', `U${TEST_UID}`, `AI${TEST_AI_ID}`)
    writeSkill(skillsDir, 'toggle', 'toggle-skill')
    const loader = new SkillLoader(() => null, join(root, configName()))
    loader.load()
    expect(loader.listAutoInvocable().map((m) => m.name)).toEqual(['toggle-skill'])
    loader.setEnabled('toggle-skill', false)
    expect(loader.listAutoInvocable()).toHaveLength(0)
    loader.setEnabled('toggle-skill', true)
    expect(loader.listAutoInvocable().map((m) => m.name)).toEqual(['toggle-skill'])
    const del = loader.deleteSkill('toggle-skill')
    expect(del.ok).toBe(true)
    expect(existsSync(join(skillsDir, 'toggle'))).toBe(false)
    expect(loader.findMetadata('toggle-skill')).toBeNull()
  })
})

describe('SkillLoader 热重载', () => {
  it('startWatching 后修改 SKILL.md → 防抖后 load() 重新扫描', async () => {
    const skillsDir = join(dataRoot, 'skills', `U${TEST_UID}`, `AI${TEST_AI_ID}`)
    writeSkill(skillsDir, 'reload', 'reload-skill', 'version: 1.0.0')
    const loader = new SkillLoader(() => null, join(root, configName()))
    loader.load()
    expect(loader.findMetadata('reload-skill')?.version).toBe('1.0.0')
    loader.startWatching()

    // 修改文件内容后等待防抖 + watcher 事件
    const fp = join(skillsDir, 'reload', 'SKILL.md')
    writeFileSync(fp, `---
name: reload-skill
description: reload-skill 的描述
version: 2.0.0
---
正文v2
`, 'utf-8')

    await vi.waitFor(
      () => {
        expect(loader.findMetadata('reload-skill')?.version).toBe('2.0.0')
      },
      { timeout: 3000, interval: 100 }
    )
    loader.stopWatching()
  })

  it('stopWatching 清理 watcher', () => {
    const skillsDir = join(dataRoot, 'skills', `U${TEST_UID}`, `AI${TEST_AI_ID}`)
    writeSkill(skillsDir, 'watch', 'watch-skill')
    const loader = new SkillLoader(() => null, join(root, configName()))
    loader.load()
    loader.startWatching()
    loader.stopWatching()
    // 不抛错即通过
    expect(true).toBe(true)
  })
})

describe('SkillLoader 未登录守卫', () => {
  it('未登录时 load()/startWatching() 强制抛错，禁止静默兜底', () => {
    // 未登录路径上下文：getScopedPath 抛错，load/startWatching 不再有守卫拦截
    setPathContext(dataRoot, () => null, () => TEST_AI_ID)
    const loader = new SkillLoader(() => join(dataRoot, 'skills_domains', 'U1', 'AI1'), join(root, 'config.json'))
    expect(() => loader.load()).toThrow(/登录态/)
    expect(() => loader.startWatching()).toThrow(/登录态/)
  })
})

describe('SkillMarket 本地目录源端到端', () => {
  it('dir 源：扫描根 SKILL.md + skills/ 子目录条目', async () => {
    const repo = join(root, 'repo')
    writeSkill(repo, '.', 'root-skill')
    writeSkill(join(repo, 'skills'), 'sub', 'sub-skill')
    const loader = new SkillLoader(() => null, join(root, 'lc.json'))
    const market = new SkillMarket(getMarketRoot(root), loader, join(root, 'user-skills'))
    market.addSource('本地', repo)
    const items = await market.listMarketSkills()
    const names = items.map((i) => i.name).sort()
    expect(names).toEqual(['root-skill', 'sub-skill'])
    expect(items.find((i) => i.name === 'root-skill')?.repo).toBe(repo)
    expect(items.find((i) => i.name === 'sub-skill')?.subdir).toBe('skills/sub')
  })

  it('listMarketSkills 标记 installed / hasUpdate', async () => {
    const repo = join(root, 'repo2')
    writeSkill(repo, '.', 'updated-skill', 'version: 1.0.0')
    const loader = new SkillLoader(() => null, join(root, 'lc2.json'))
    const market = new SkillMarket(getMarketRoot(root), loader, join(root, 'user-skills2'))
    market.addSource('本地2', repo)
    const before = await market.listMarketSkills()
    expect(before[0].installed).toBe(false)
    expect(before[0].hasUpdate).toBe(false)

    const installRes = await market.install('updated-skill')
    expect(installRes.ok).toBe(true)
    // 已安装到注入的用户级目录
    expect(existsSync(join(root, 'user-skills2', 'updated-skill', 'SKILL.md'))).toBe(true)

    const afterInstall = await market.listMarketSkills()
    expect(afterInstall[0].installed).toBe(true)
    expect(afterInstall[0].hasUpdate).toBe(false)

    // 改变 source 的 SKILL.md → sha 变化 → hasUpdate=true（entry 无 version 字段，靠 sha 对比）
    writeSkill(repo, '.', 'updated-skill', 'version: 2.0.0')
    const afterBump = await market.listMarketSkills()
    expect(afterBump[0].hasUpdate).toBe(true)
    expect(afterBump[0].sha).not.toBe(before[0].sha)
  })

  it('remove 清理用户级目录与锁定记录', async () => {
    const repo = join(root, 'repo3')
    writeSkill(repo, '.', 'rm-skill')
    const loader = new SkillLoader(() => null, join(root, 'lc3.json'))
    const market = new SkillMarket(getMarketRoot(root), loader, join(root, 'user-skills3'))
    market.addSource('本地3', repo)
    await market.install('rm-skill')
    expect(existsSync(join(root, 'user-skills3', 'rm-skill'))).toBe(true)
    const r = market.remove('rm-skill')
    expect(r.ok).toBe(true)
    expect(existsSync(join(root, 'user-skills3', 'rm-skill'))).toBe(false)
  })
})

describe('SkillLoader 遗留数据迁移（顶层 → 分层）', () => {
  it('把顶层遗留技能/config 迁到当前 U{uid}/AI{aiId} 分层目录', () => {
    // 模拟旧版错位数据：顶层 skills/{name}、顶层 config/.skills.json
    writeSkill(join(dataRoot, 'skills'), 'legacy', 'legacy-skill')
    writeSkill(join(dataRoot, 'skills_domains'), 'general', 'legacy-domain', 'version: 1.0.0')
    mkdirSync(join(dataRoot, 'config', 'U1', 'AI1'), { recursive: true })
    // 配置已存在于分层目录 → 顶层 .skills.json 不应覆盖迁移（幂等语义由目标存在跳过）
    const scopedConfigPath = join(dataRoot, 'config', 'U1', 'AI1', '.skills.json')
    writeFileSync(scopedConfigPath, JSON.stringify({ skills: { keep: { enabled: false } } }), 'utf-8')

    const loader = new SkillLoader(
      () => join(dataRoot, 'skills_domains', 'U1', 'AI1'),
      join(dataRoot, 'config', 'U1', 'AI1', '.skills.json')
    )
    const res = loader.load()

    // 顶层遗留已迁移进分层 → 可扫描到
    expect(res.metadatas.map((m) => m.name).sort()).toEqual(['legacy-domain', 'legacy-skill'])
    expect(existsSync(join(dataRoot, 'skills', 'U1', 'AI1', 'legacy'))).toBe(true)
    expect(existsSync(join(dataRoot, 'skills', 'legacy'))).toBe(false)
    // 分层配置未被顶层覆盖
    const cfg = JSON.parse(readFileSync(scopedConfigPath, 'utf-8'))
    expect(cfg.skills.keep.enabled).toBe(false)
  })

  it('迁移幂等：重复 load 不重复搬移', () => {
    writeSkill(join(dataRoot, 'skills'), 'once', 'once-skill')
    const loader = new SkillLoader(() => null, join(root, 'config.json'))
    loader.load()
    loader.load()
    loader.load()
    expect(existsSync(join(dataRoot, 'skills', 'U1', 'AI1', 'once'))).toBe(true)
    expect(existsSync(join(dataRoot, 'skills', 'once'))).toBe(false)
  })
})

function configName(): string {
  return 'skills.json'
}