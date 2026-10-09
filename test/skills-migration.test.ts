/**
 * skills-migration.test.ts — 遗留数据迁移 + 便携版分发路径一致性（2026-10-01）
 *
 * 背景：① 旧版 path-context 在未登录（uid=null）时回退顶层 {root}/{domain}，
 * 导致便携版把技能/配置写到顶层（{root}/skills/{name}、{root}/config/.skills.json），
 * 而登录后扫描路径是分层目录 → 已安装技能列表不显示；
 * ② 分层曾用裸数字 {uid}/{aiId}（{root}/skills/1/1），与 memory/NNG/cache 的
 * U/AI 字面前缀约定不一致，已统一为 {root}/{domain}/U{uid}/AI{aiId}（唯一真源
 * paths.ts 的 scopedDomainPath）。
 *
 * 覆盖：
 * 1. migrateLegacyScopedData 全量迁移（用户级/领域级技能 + config 三件套 + 旧裸数字分层）
 * 2. 幂等：重复 load 不重复搬移、目标存在跳过
 * 3. 跳过其他用户的旧裸数字分层目录（迁移只处理当前作用域）
 * 4. 未登录时 migrate 强制抛错（系统强制登录后才可用，禁止静默 no-op）
 * 5. 分发路径一致性：buildDataPaths 根目录与 getScopedPath 分层前缀对齐
 * 6. getScopedPath 产物 = {root}/{domain}/U{uid}/AI{aiId}；aiId 缺失抛错
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setPathContext, getScopedPath } from '../electron/main/models/path-context'
import { buildDataPaths, resolveDataDir, DATA_DIR_MARKER } from '../electron/main/models/paths'
import { SkillLoader, migrateLegacyScopedData } from '../electron/main/skills/loader'

const UID = 7
const AI_ID = 1

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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skills-migrate-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('migrateLegacyScopedData 遗留数据全量迁移', () => {
  it('把顶层用户级/领域级技能 + config 三件套全部迁到 U{uid}/AI{aiId} 分层', () => {
    setPathContext(root, () => UID, () => AI_ID)

    // 旧版错位数据（顶层）：
    writeSkill(join(root, 'skills'), 'alpha', 'alpha-skill')
    writeSkill(join(root, 'skills'), 'beta', 'beta-skill')
    writeSkill(join(root, 'skills_domains'), 'code', 'fmt-skill')
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(join(root, 'config', '.skills.json'), JSON.stringify({ skills: { alpha: { enabled: true } } }), 'utf-8')
    writeFileSync(join(root, 'config', '.skills-usage.json'), JSON.stringify({ alpha: { useCount: 3 } }), 'utf-8')
    writeFileSync(join(root, 'config', '.workspaces.json'), JSON.stringify({ workspaces: [], activeWorkspaceId: null }), 'utf-8')

    migrateLegacyScopedData()

    // 用户级：已迁入分层，顶层清空
    expect(existsSync(join(root, 'skills', `U${UID}`, `AI${AI_ID}`, 'alpha', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(root, 'skills', `U${UID}`, `AI${AI_ID}`, 'beta', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(root, 'skills', 'alpha'))).toBe(false)
    expect(existsSync(join(root, 'skills', 'beta'))).toBe(false)

    // 领域级同样迁移
    expect(existsSync(join(root, 'skills_domains', `U${UID}`, `AI${AI_ID}`, 'code', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(root, 'skills_domains', 'code'))).toBe(false)

    // config 三件套：搬到 config/U{uid}/AI{aiId}/，内容保持一致
    const scopedCfg = join(root, 'config', `U${UID}`, `AI${AI_ID}`)
    expect(existsSync(join(scopedCfg, '.skills.json'))).toBe(true)
    expect(existsSync(join(scopedCfg, '.skills-usage.json'))).toBe(true)
    expect(existsSync(join(scopedCfg, '.workspaces.json'))).toBe(true)
    expect(existsSync(join(root, 'config', '.skills.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(scopedCfg, '.skills.json'), 'utf-8')).skills.alpha.enabled).toBe(true)
    expect(JSON.parse(readFileSync(join(scopedCfg, '.skills-usage.json'), 'utf-8')).alpha.useCount).toBe(3)
  })

  it('跳过其他用户的旧裸数字分层目录：迁移只处理当前作用域', () => {
    setPathContext(root, () => UID, () => AI_ID)
    // 其他 uid 的旧裸数字分层数据（不是遗留、也不是当前作用域，不动）：
    writeSkill(join(root, 'skills', '9', '2'), 'kept', 'kept-skill')
    // 遗留：顶层散落技能
    writeSkill(join(root, 'skills'), 'legacy', 'legacy-skill')

    migrateLegacyScopedData()

    // 其他作用域数字目录原地不动（migrateSkillEntries 跳过纯数字 uid 层）
    expect(existsSync(join(root, 'skills', '9', '2', 'kept', 'SKILL.md'))).toBe(true)
    // 遗留迁到当前 U{uid}/AI{aiId}
    expect(existsSync(join(root, 'skills', `U${UID}`, `AI${AI_ID}`, 'legacy', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(root, 'skills', 'legacy'))).toBe(false)
  })

  it('旧裸数字分层 {uid}/{aiId} → U{uid}/AI{aiId}：历史分层整体搬入新前缀', () => {
    setPathContext(root, () => UID, () => AI_ID)
    // 模拟旧 getScopedPath 产物（{root}/{domain}/{uid}/{aiId} 裸数字分层）：
    writeSkill(join(root, 'skills', String(UID), String(AI_ID)), 'legacy2', 'legacy2-skill')
    writeSkill(join(root, 'skills_domains', String(UID), String(AI_ID)), 'code', 'fmt2-skill')
    mkdirSync(join(root, 'config', String(UID), String(AI_ID)), { recursive: true })
    writeFileSync(
      join(root, 'config', String(UID), String(AI_ID), '.skills.json'),
      JSON.stringify({ skills: { legacy2: { enabled: true } } }),
      'utf-8'
    )

    migrateLegacyScopedData()

    // 三域全部搬到 U/AI 前缀分层
    expect(existsSync(join(root, 'skills', `U${UID}`, `AI${AI_ID}`, 'legacy2', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(root, 'skills', String(UID), String(AI_ID)))).toBe(false)
    expect(existsSync(join(root, 'skills_domains', `U${UID}`, `AI${AI_ID}`, 'code', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(root, 'skills_domains', String(UID), String(AI_ID)))).toBe(false)
    expect(existsSync(join(root, 'config', `U${UID}`, `AI${AI_ID}`, '.skills.json'))).toBe(true)
    expect(existsSync(join(root, 'config', String(UID), String(AI_ID)))).toBe(false)
    // 内容保持
    expect(
      JSON.parse(readFileSync(join(root, 'config', `U${UID}`, `AI${AI_ID}`, '.skills.json'), 'utf-8')).skills.legacy2.enabled
    ).toBe(true)
  })

  it('旧裸数字分层目标已存在时不覆盖（幂等：优先级留给 U/AI 前缀版）', () => {
    setPathContext(root, () => UID, () => AI_ID)
    // 旧裸数字分层残留旧版本
    writeSkill(join(root, 'skills', String(UID), String(AI_ID)), 'dup', 'dup-skill', 'version: 1.0.0')
    // 新 U/AI 前缀分层已有新版本
    writeSkill(join(root, 'skills', `U${UID}`, `AI${AI_ID}`), 'dup', 'dup-skill', 'version: 3.0.0')

    migrateLegacyScopedData()

    // 目标存在 → 跳过不覆盖；新前缀版保持
    const scoped = readFileSync(join(root, 'skills', `U${UID}`, `AI${AI_ID}`, 'dup', 'SKILL.md'), 'utf-8')
    expect(scoped).toContain('version: 3.0.0')
    expect(existsSync(join(root, 'skills', String(UID), String(AI_ID), 'dup'))).toBe(true)
  })

  it('目标已存在（非空 uid 分层目录）时跳过，不覆盖', () => {
    setPathContext(root, () => UID, () => AI_ID)
    // 分层目录已有同名技能（新装版本）
    writeSkill(join(root, 'skills', `U${UID}`, `AI${AI_ID}`), 'dup', 'dup-skill', 'version: 2.0.0')
    // 顶层残留旧版本
    const legacyFile = writeSkill(join(root, 'skills'), 'dup', 'dup-skill', 'version: 1.0.0')
    // 记录旧文件用于断言其仍未被搬走（幂等：目标存在 → 跳过不覆盖也不删除）
    expect(existsSync(legacyFile)).toBe(true)

    migrateLegacyScopedData()

    // 分层版本未被覆盖
    const scoped = readFileSync(join(root, 'skills', `U${UID}`, `AI${AI_ID}`, 'dup', 'SKILL.md'), 'utf-8')
    expect(scoped).toContain('version: 2.0.0')
  })

  it('正确分层骨架 U{uid} 已存在时不被误当遗留条目搬移（防自嵌套 EPERM）', () => {
    setPathContext(root, () => UID, () => AI_ID)
    // 登录态已建好正确分层骨架（U{uid}/AI{aiId}，AI1 内已有技能）+ 顶级确实存在遗留技能：
    writeSkill(join(root, 'skills', `U${UID}`, `AI${AI_ID}`), 'keep', 'keep-skill')
    writeSkill(join(root, 'skills'), 'legacy', 'legacy-skill')

    migrateLegacyScopedData()

    // ① 分层骨架原样保留（曾 bug：把 U{uid} 当遗留，rename 进自身后代 → Windows EPERM）
    expect(existsSync(join(root, 'skills', `U${UID}`, `AI${AI_ID}`, 'keep', 'SKILL.md'))).toBe(true)
    // ② 遗留技能正常迁入分层
    expect(existsSync(join(root, 'skills', `U${UID}`, `AI${AI_ID}`, 'legacy', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(root, 'skills', 'legacy'))).toBe(false)
  })

  it('未登录（uid=null）时强制抛错：禁止静默 no-op', () => {
    setPathContext(root, () => null, () => AI_ID)
    writeSkill(join(root, 'skills'), 'legacy', 'legacy-skill')
    // 未登录没有可写入的分层目标：系统强制登录后才可用，未登录调用即程序错误
    expect(() => migrateLegacyScopedData()).toThrow(/登录态/)
  })
})

describe('登录后 load() 触发迁移 → 旧技能立即可见（端到端回归）', () => {
  it('顶层遗留技能经 load() 迁移并被扫描注册', () => {
    setPathContext(root, () => UID, () => AI_ID)
    writeSkill(join(root, 'skills'), 'legacy', 'legacy-skill')
    writeSkill(join(root, 'skills_domains'), 'general', 'legacy-domain')

    const loader = new SkillLoader(
      () => join(root, 'skills_domains', `U${UID}`, `AI${AI_ID}`),
      join(root, 'config', `U${UID}`, `AI${AI_ID}`, '.skills.json')
    )
    const res = loader.load()

    // 迁移后按分层路径扫描 → 两个技能都可见（此前 bug：装在顶层、扫分层 → 空列表）
    expect(res.metadatas.map((m) => m.name).sort()).toEqual(['legacy-domain', 'legacy-skill'])
    // 顶层残留已清
    expect(existsSync(join(root, 'skills', 'legacy'))).toBe(false)
    expect(existsSync(join(root, 'skills_domains', 'general'))).toBe(false)
  })
})

describe('便携版分发路径一致性（buildDataPaths ↔ getScopedPath）', () => {
  it('{dataDir}/abyssac_data 下 skills 分层前缀与 buildDataPaths().skills 对齐', () => {
    // 便携版数据根：{anchor}/data/abyssac_data（resolveDataDir 锚点相对标记同理）；
    // 路径上下文注入的 dataRoot 正是 buildDataPaths().root（abyssac_data 目录）
    const anchor = resolve(root, 'app')
    const dataDir = resolve(anchor, 'data')
    const base = buildDataPaths(dataDir)
    setPathContext(base.root, () => UID, () => AI_ID)
    // getScopedPath('skills') = {root}/skills/U{uid}/AI{aiId}，其父链前缀必须等于 buildDataPaths().skills
    expect(getScopedPath('skills')).toBe(join(base.skills, `U${UID}`, `AI${AI_ID}`))
    expect(getScopedPath('skills_domains')).toBe(join(base.root, 'skills_domains', `U${UID}`, `AI${AI_ID}`))
    expect(getScopedPath('config')).toBe(join(base.root, 'config', `U${UID}`, `AI${AI_ID}`))
  })

  it('getScopedPath 未登录（uid=null）与 aiId=null 均强制抛错，禁止回退', () => {
    setPathContext(root, () => UID, () => AI_ID)
    // 登录态：正常解析
    expect(getScopedPath('skills')).toBe(join(root, 'skills', `U${UID}`, `AI${AI_ID}`))
    // uid=null（未登录）→ 抛错
    setPathContext(root, () => null, () => AI_ID)
    expect(() => getScopedPath('skills')).toThrow(/未登录/)
    expect(() => getScopedPath('config')).toThrow(/未登录/)
    // aiId=null → 抛错（uid/aiId 必须同时存在，无单层回退）
    setPathContext(root, () => UID, () => null)
    expect(() => getScopedPath('skills')).toThrow(/aiId/)
    expect(() => getScopedPath('skills_domains')).toThrow(/aiId/)
    // 恢复登录态（避免影响后续用例）
    setPathContext(root, () => UID, () => AI_ID)
  })

  it('resolveDataDir 相对标记解析到锚点旁 data/（便携可整体搬迁）', () => {
    const anchor = join(resolve(root), 'app')
    const r = resolveDataDir(DATA_DIR_MARKER, anchor)
    expect(r.dir).toBe(resolve(anchor, 'data'))
    expect(r.shouldMigrateToMarker).toBe(false)
    // 便携版实际结构：{anchor}/data/abyssac_data/skills/U{uid}/AI{aiId}
    const base = buildDataPaths(r.dir)
    expect(base.skills).toBe(join(r.dir, 'abyssac_data', 'skills'))
  })
})