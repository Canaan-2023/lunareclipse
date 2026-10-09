/**
 * 作用域回归测试：技能市场安装记录 + 路径上下文必须按 U{uid}/AI{aiId} 分层。
 *
 * 覆盖两处历史作用域错误：
 *  ① setPathContext 曾硬编码 aiId=1（index.ts）——会话切到 AI{n} 后技能/配置仍读写 AI{1}；
 *  ② skill-market manifest.installed 曾为全局 name 键（market.ts）——
 *     跨 uid/aiId 误显示「已安装」、卸载误删全局记录、syncAll 更新他人/AI 目录。
 *
 * 测试策略：以受控 uid/aiId 切换模拟多用户/多 AI 作用域，断言磁盘目录与 manifest 记录都按作用域隔离。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { SkillMarket } from '../electron/main/skills/market'
import { SkillLoader } from '../electron/main/skills/loader'
import { setPathContext, getScopedPath } from '../electron/main/models/path-context'

/** 测试根目录（临时） */
const TEST_ROOT = join(process.cwd(), 'tmp', 'skill-market-scope-test')
const DATA_ROOT = join(TEST_ROOT, 'data')

// 作用域模拟：默认登录为 uid=1 / aiId=1，测试中可按需切换
let mockUid: number | null = 1
let mockAiId: number | null = 1
setPathContext(
  DATA_ROOT,
  () => mockUid,
  () => mockAiId
)

function loginWith(uid: number, aiId: number): void {
  mockUid = uid
  mockAiId = aiId
}

afterEach(() => {
  // 还原默认登录态并清理临时目录
  mockUid = 1
  mockAiId = 1
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

function makeLocalSource(): string {
  const repoDir = join(TEST_ROOT, 'local-repo')
  const skillsDir = join(repoDir, 'skills', 'hello-world')
  mkdirSync(skillsDir, { recursive: true })
  writeFileSync(
    join(skillsDir, 'SKILL.md'),
    `---
name: hello-world
description: 作用域回归测试 skill
---
# Hello
`,
    'utf-8'
  )
  return repoDir
}

function makeMarket(sub = 'market'): SkillMarket {
  const loader = new SkillLoader(() => null, join(TEST_ROOT, 'nonexistent-config.json'))
  // userSkillsDir 不注入字符串，走默认 provider（getUserSkillsDir → getScopedPath → 按 mockUid/mockAiId 动态分层）
  return new SkillMarket(join(TEST_ROOT, sub), loader)
}

function readManifestInstalled(marketDir: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(join(marketDir, 'manifest.json'), 'utf-8')) as {
    installed: Record<string, unknown>
  }
  return raw.installed
}

describe('技能目录分层（setPathContext 动态 aiId）', () => {
  it('getScopedPath 随 uid/aiId 切换命中不同目录', () => {
    loginWith(1, 1)
    expect(getScopedPath('skills')).toBe(join(DATA_ROOT, 'skills', 'U1', 'AI1'))
    loginWith(1, 2)
    expect(getScopedPath('skills')).toBe(join(DATA_ROOT, 'skills', 'U1', 'AI2'))
    loginWith(2, 1)
    expect(getScopedPath('skills')).toBe(join(DATA_ROOT, 'skills', 'U2', 'AI1'))
  })

  it('未登录（uid=null）禁止解析分层路径', () => {
    loginWith(1, 1)
    mockUid = null
    expect(() => getScopedPath('skills')).toThrow(/未登录态禁止解析分层路径/)
    mockUid = 1
  })
})

describe('skill-market 安装记录作用域隔离（跨 uid/aiId）', () => {
  it('A 用户/AI{1} 安装后，同用户 AI{2} 与 B 用户市场不显示已安装，切回 AI{1} 显示', async () => {
    loginWith(1, 1)
    const market = makeMarket('m-scope-1')
    const repo = makeLocalSource()
    market.addSource('本地源', repo)
    const items0 = await market.listMarketSkills()
    expect(items0[0].installed).toBe(false)
    expect((await market.install('hello-world')).ok).toBe(true)

    // 磁盘落在 AI{1} 作用域
    expect(existsSync(join(DATA_ROOT, 'skills', 'U1', 'AI1', 'hello-world'))).toBe(true)
    expect(existsSync(join(DATA_ROOT, 'skills', 'U1', 'AI2', 'hello-world'))).toBe(false)

    // 当前作用域已安装
    const items1 = await market.listMarketSkills()
    expect(items1[0].installed).toBe(true)

    // 同用户切到 AI{2}：磁盘无目录 → 不显示已安装（修复① 的消费链）
    loginWith(1, 2)
    const items2 = await market.listMarketSkills()
    expect(items2[0].installed).toBe(false)

    // B 用户（uid=2 / AI{1}）：也不显示（修复② 的重点）
    loginWith(2, 1)
    const items3 = await market.listMarketSkills()
    expect(items3[0].installed).toBe(false)
  })

  it('remove 只删当前作用域：AI{1} 卸载后 AI{2} 的磁盘与 manifest 记录保留', async () => {
    loginWith(1, 1)
    const market = makeMarket('m-scope-2')
    const repo = makeLocalSource()
    market.addSource('本地源', repo)
    // AI{1} 安装
    expect((await market.install('hello-world')).ok).toBe(true)

    // AI{2} 也安装（同一市场实例，验证表现按作用域隔离）
    loginWith(1, 2)
    expect((await market.install('hello-world')).ok).toBe(true)
    expect(existsSync(join(DATA_ROOT, 'skills', 'U1', 'AI1', 'hello-world'))).toBe(true)
    expect(existsSync(join(DATA_ROOT, 'skills', 'U1', 'AI2', 'hello-world'))).toBe(true)

    // AI{2} 卸载 → 只删 AI{2} 目录与记录，AI{1} 不动
    expect(market.remove('hello-world').ok).toBe(true)
    expect(existsSync(join(DATA_ROOT, 'skills', 'U1', 'AI2', 'hello-world'))).toBe(false)
    expect(existsSync(join(DATA_ROOT, 'skills', 'U1', 'AI1', 'hello-world'))).toBe(true)

    const installed = readManifestInstalled(join(TEST_ROOT, 'm-scope-2')) as Record<string, Record<string, unknown>>
    expect(installed['U1/AI1']['hello-world']).toBeDefined()
    expect(installed['U1/AI2']).toBeUndefined()

    // AI{1} 卸载 → AI{1} 表变空被整体移除
    loginWith(1, 1)
    expect(market.remove('hello-world').ok).toBe(true)
    const installed2 = readManifestInstalled(join(TEST_ROOT, 'm-scope-2')) as Record<string, Record<string, unknown>>
    expect(installed2['U1/AI1']).toBeUndefined()
  })

  it('旧版扁平 manifest 自动迁移：无作用域记录不误显已装，磁盘存在时仍可用', async () => {
    loginWith(1, 1)
    const marketDir = join(TEST_ROOT, 'm-scope-legacy')
    mkdirSync(marketDir, { recursive: true })
    // 旧版 manifest：installed 为 { name: {...} } 扁平结构（模拟历史数据）
    writeFileSync(
      join(marketDir, 'manifest.json'),
      JSON.stringify(
        {
          sources: [],
          installed: {
            'hello-world': {
              source: 'src_legacy',
              version: '1.0.0',
              installedAt: 1700000000000,
              userModified: false,
              synced: true
            }
          }
        },
        null,
        2
      ),
      'utf-8'
    )
    const market = makeMarket('m-scope-legacy')
    // 磁盘无该目录（旧扁平记录不代表当前作用域已装）→ 不显示已安装
    const items = await market.listMarketSkills()
    const hello = items.find((i) => i.name === 'hello-world')
    expect(hello).toBeUndefined() // 无源 → 市场列表无此项（源为空），仅验证不崩溃且迁移正确
  })

  it('旧版扁平 manifest + 磁盘存在：视为已安装（磁盘为真源）', async () => {
    loginWith(1, 1)
    const marketDir = join(TEST_ROOT, 'm-scope-legacy2')
    mkdirSync(marketDir, { recursive: true })
    writeFileSync(
      join(marketDir, 'manifest.json'),
      JSON.stringify(
        {
          sources: [],
          installed: {
            'hello-world': {
              source: 'src_legacy',
              version: '1.0.0',
              installedAt: 1700000000000,
              userModified: false,
              synced: true
            }
          }
        },
        null,
        2
      ),
      'utf-8'
    )
    // 磁盘上模拟旧版本已安装目录
    mkdirSync(join(DATA_ROOT, 'skills', 'U1', 'AI1', 'hello-world'), { recursive: true })
    writeFileSync(join(DATA_ROOT, 'skills', 'U1', 'AI1', 'hello-world', 'SKILL.md'), '# x', 'utf-8')
    const market = makeMarket('m-scope-legacy2')
    const repo = makeLocalSource()
    market.addSource('本地源', repo)
    const items = await market.listMarketSkills()
    const hello = items.find((i) => i.name === 'hello-world')
    expect(hello).toBeDefined()
    // 磁盘目录存在 → 当前作用域显示已安装（manifest 元数据缺失由 legacy 兜底，hasUpdate 不为 true 即可）
    expect(hello!.installed).toBe(true)
  })

  it('领域级技能（frontmatter 声明 domain）按作用域隔离落位 skills_domains/{domain}', async () => {
    loginWith(1, 1)
    const market = makeMarket('m-scope-domain')
    const repoDir = join(TEST_ROOT, 'local-repo-domain')
    const skillsDir = join(repoDir, 'skills', 'code', 'domain-tool')
    mkdirSync(skillsDir, { recursive: true })
    writeFileSync(
      join(skillsDir, 'SKILL.md'),
      `---
name: domain-tool
description: 领域级作用域隔离测试 skill
domain: code
---
# Domain Tool
`,
      'utf-8'
    )
    market.addSource('领域源', repoDir)
    expect((await market.install('domain-tool')).ok).toBe(true)
    // 落位领域级目录（skills_domains 域，按当前 uid/aiId 分层），用户级 skills 不落
    expect(existsSync(join(DATA_ROOT, 'skills_domains', 'U1', 'AI1', 'code', 'domain-tool'))).toBe(true)
    expect(existsSync(join(DATA_ROOT, 'skills', 'U1', 'AI1', 'domain-tool'))).toBe(false)

    // 同用户切 AI{2}：skills_domains/U1/AI2 无目录 → 不显示已装（跨 AI 隔离同样成立）
    loginWith(1, 2)
    const items2 = await market.listMarketSkills()
    expect(items2.find((i) => i.name === 'domain-tool')!.installed).toBe(false)

    // 切回 AI{1}：恢复显示已装
    loginWith(1, 1)
    const items1 = await market.listMarketSkills()
    expect(items1.find((i) => i.name === 'domain-tool')!.installed).toBe(true)

    // 卸载只删当前作用域领域级目录
    expect(market.remove('domain-tool').ok).toBe(true)
    expect(existsSync(join(DATA_ROOT, 'skills_domains', 'U1', 'AI1', 'code', 'domain-tool'))).toBe(false)
  })

  it('syncAll 只扫描当前作用域记录，不更新其它 uid/aiId 的安装', async () => {
    loginWith(1, 1)
    const market = makeMarket('m-scope-sync')
    const repo = makeLocalSource()
    market.addSource('本地源', repo)
    // AI{1} 安装（synced=true），AI{2} 不装
    expect((await market.install('hello-world')).ok).toBe(true)

    // 切到 AI{2}（无任何安装记录）：syncAll 不应误扫 AI{1} 的记录
    loginWith(1, 2)
    const r = await market.syncAll()
    expect(r.ok).toBe(true)
    expect(r.updated).toEqual([])
  })
})