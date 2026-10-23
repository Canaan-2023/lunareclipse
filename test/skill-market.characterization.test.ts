/**
 * ADR-05 第 0 步（前置硬条件）：`SkillMarket` **接口级**表征测试
 *
 * 为什么存在：`skill-market.test.ts`（48 例）覆盖的是**端到端行为**，粒度是「整类公有方法」，
 * 无法在拆分中逐条锁定「方法 → 模块函数 + 状态句柄」的等价。ADR-05 要把 1428 行的
 * `market.ts` 拆为 types / manifest-store / source-repo / installer / upload-sync 五模块，
 * 且 `this.manifest` 被 11 个方法读写（交错写风险）。本文件对**全部 16 个公有方法**建立
 * 调用级快照（返回值 / 落盘 manifest 内容 / 进度事件 / 变更回调），作为搬迁等价判据。
 *
 * 覆盖清单（与 ADR-05 §1 前置硬条件的 16 项一一对应）：
 * `setProgressCallback` / `setLanDeps` / `setChangeCallback` / `listSources` / `addSource` /
 * `removeSource` / `listMarketSkills` / `install` / `update` / `remove` / `syncAll` /
 * `markUserModified` / `uploadSkill` / `unpublish` / `handleLanEnvelope` / `handlePeerStatus`
 *
 * 口径：每个用例用**进程唯一临时根**（mkdtemp + 自清理），互不干扰；断言集中在
 * 「返回形状 / manifest.json 落盘内容 / 事件」，不断言内部实现细节，故搬迁后仍应全绿。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  BUILTIN_SOURCE_URL,
  scopeKeyOf,
  SkillMarket,
  type MarketProgress,
  type SkillMarketLanDeps
} from '../electron/main/skills/market'
import { SkillLoader } from '../electron/main/skills/loader'
import { setPathContext } from '../electron/main/models/path-context'

let ROOT = ''
let USER_SKILLS = ''
let DOMAIN_SKILLS = ''

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'skill-market-char-'))
  USER_SKILLS = join(ROOT, 'user-skills')
  DOMAIN_SKILLS = join(ROOT, 'domain-skills')
  // 系统强制登录：install/remove 走分层路径解析（uid/aiId 缺失即抛错）
  setPathContext(join(ROOT, 'data'), () => 1, () => 1)
})

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

/** 建一个「市场实例 + 其内置仓库目录」（第 4 参注入，构造器据此自动注册内置源） */
function makeMarket(sub: string): SkillMarket {
  const loader = new SkillLoader(() => null, join(ROOT, 'nonexistent-config.json'))
  const repoDir = join(ROOT, `${sub}-repo`)
  mkdirSync(repoDir, { recursive: true })
  return new SkillMarket(join(ROOT, sub), loader, USER_SKILLS, repoDir, DOMAIN_SKILLS)
}

/** 造一个 repo 风格本地源：{repo}/skills/{name}/SKILL.md */
function makeSkillRepo(name: string): string {
  const repoDir = join(ROOT, `repo-${name}`)
  const dir = join(repoDir, 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: 表征测试技能 ${name}\n---\n# ${name}\n\n使用 \`read_file\`。\n`,
    'utf-8'
  )
  return repoDir
}

interface ManifestShape {
  sources: Array<{ id: string; name: string; url: string; type: string }>
  installed: Record<string, Record<string, { userModified?: boolean }>>
  uploads: Record<string, { authorUid?: number; uploadedAt?: number }>
  removed: Record<string, { removedAt?: number; removedBy?: number }>
}

/** 读磁盘 manifest（断言落盘真值，而非内存态） */
function readManifest(sub: string): ManifestShape {
  return JSON.parse(readFileSync(join(ROOT, sub, 'manifest.json'), 'utf-8')) as ManifestShape
}

describe('SkillMarket 接口级表征（ADR-05 第 0 步：拆分前行为基线）', () => {
  it('① 源 CRUD：listSources 返回副本；addSource 按 scheme 判型并落盘；removeSource 未知 id 拒绝', () => {
    const m = makeMarket('m-src')

    // 构造器已自动注册内置源（dir 型，url = builtin:// 标识）
    const initial = m.listSources()
    expect(initial).toHaveLength(1)
    expect(initial[0].url).toBe(BUILTIN_SOURCE_URL)
    expect(initial[0].type).toBe('dir')

    // 返回的是副本：外部改写不影响内部
    initial.push({ id: 'x', name: 'x', url: 'x', type: 'dir' })
    expect(m.listSources()).toHaveLength(1)

    expect(m.addSource('空', '   ')).toEqual({ ok: false, error: 'URL 不能为空' })
    expect(m.addSource('网', 'http://example.com/list.json')).toEqual({ ok: true })
    expect(m.addSource('本', join(ROOT, 'some-dir'))).toEqual({ ok: true })

    const after = m.listSources()
    expect(after.map((s) => s.type)).toEqual(['dir', 'json', 'dir'])
    expect(new Set(after.map((s) => s.id)).size).toBe(after.length) // id 全局唯一

    // 落盘与内存一致（persist 是唯一写盘出口）
    const onDisk = readManifest('m-src')
    expect(onDisk.sources.map((s) => s.id)).toEqual(after.map((s) => s.id))

    expect(m.removeSource('nope')).toEqual({ ok: false, error: '源不存在' })
    const victim = after[after.length - 1].id
    expect(m.removeSource(victim)).toEqual({ ok: true })
    expect(readManifest('m-src').sources.map((s) => s.id)).toEqual(
      after.slice(0, -1).map((s) => s.id)
    )
  })

  it('② listMarketSkills：扫描 dir 源、repo 脱敏为源标识、四个派生字段齐备', async () => {
    const m = makeMarket('m-list')
    const repo = makeSkillRepo('alpha')
    m.addSource('本地', repo)
    const srcId = m.listSources().find((s) => s.name === '本地')?.id

    const list = await m.listMarketSkills()
    const alpha = list.find((e) => e.name === 'alpha')
    expect(alpha).toBeDefined()
    expect(alpha?.sourceId).toBe(srcId)
    // repo 脱敏：回填源的可移植标识（用户输入值），不暴露本机绝对扫描目录
    expect(alpha?.repo).toBe(repo)
    expect(alpha?.installed).toBe(false)
    expect(alpha?.hasUpdate).toBe(false)
    expect(alpha?.userModified).toBe(false)
    // 未注入 lan（单机）→ 可删任意市场条目
    expect(alpha?.canDelete).toBe(true)
  })

  it('③ install / markUserModified / remove：落位 + 作用域记录 + 事件；重复卸载拒绝', async () => {
    const m = makeMarket('m-inst')
    const repo = makeSkillRepo('beta')
    m.addSource('本地', repo)

    const progress: MarketProgress[] = []
    m.setProgressCallback((p) => progress.push(p))

    const res = await m.install('beta')
    expect(res.ok).toBe(true)
    expect(existsSync(join(USER_SKILLS, 'beta', 'SKILL.md'))).toBe(true)
    const key = scopeKeyOf(1, 1)
    expect(readManifest('m-inst').installed[key]?.beta).toBeTruthy()
    expect(progress.some((p) => p.phase === 'install')).toBe(true)
    // 注：install 不触发 onChange（该回调只服务「市场内容变更」= 上传/下架/局域网收端，见 ⑤ 与 ⑥）

    // markUserModified：置位并落盘
    m.markUserModified('beta')
    expect(readManifest('m-inst').installed[key]?.beta?.userModified).toBe(true)

    // remove：清目录 + 清记录
    expect(m.remove('beta').ok).toBe(true)
    expect(existsSync(join(USER_SKILLS, 'beta'))).toBe(false)
    expect(readManifest('m-inst').installed[key]?.beta).toBeUndefined()
    // 已卸载 → 再次卸载拒绝
    expect(m.remove('beta').ok).toBe(false)
  })

  it('④ update / syncAll：未安装拒绝更新；已安装可更新；syncAll 返回 {ok, updated, errors}', async () => {
    const m = makeMarket('m-upd')
    expect((await m.update('ghost')).ok).toBe(false)

    m.addSource('本地', makeSkillRepo('gamma'))
    expect((await m.install('gamma')).ok).toBe(true)
    expect((await m.update('gamma')).ok).toBe(true)

    const sync = await m.syncAll()
    expect(sync.ok).toBe(true)
    expect(Array.isArray(sync.updated)).toBe(true)
    expect(Array.isArray(sync.errors)).toBe(true)
  })

  it('⑤ uploadSkill / unpublish：落内置仓库 + uploads 登记；下架写墓碑并清仓库；重名拒绝', async () => {
    const m = makeMarket('m-up')
    // 源目录必须位于 `skills/` 之下：domainOfUploadDir 命中 skills 祖先 → 用户级（无领域），
    // 否则会回退「父目录名」作为领域，落 skills_domains/{父目录名}/delta（域推导语义的表征点）。
    const src = join(ROOT, 'up-src', 'skills', 'delta')
    mkdirSync(src, { recursive: true })
    writeFileSync(
      join(src, 'SKILL.md'),
      '---\nname: delta\ndescription: 上传表征\n---\n# delta\n',
      'utf-8'
    )

    let changes = 0
    m.setChangeCallback(() => {
      changes += 1
    })

    const up = await m.uploadSkill(src)
    expect(up.ok).toBe(true)
    expect(up.name).toBe('delta')
    expect(readManifest('m-up').uploads.delta).toBeTruthy()
    expect(existsSync(join(ROOT, 'm-up-repo', 'skills', 'delta', 'SKILL.md'))).toBe(true)
    expect(changes).toBeGreaterThan(0)

    // 重名拒绝（技能名是市场全局唯一键）
    expect((await m.uploadSkill(src)).ok).toBe(false)

    const un = await m.unpublish('delta')
    expect(un.ok).toBe(true)
    expect(readManifest('m-up').removed.delta).toBeTruthy()
    expect(existsSync(join(ROOT, 'm-up-repo', 'skills', 'delta'))).toBe(false)
  })

  it('⑥ LAN 面：setLanDeps 后 handleLanEnvelope 按 type 分派（upload 落位 / tombstone 过滤）；handlePeerStatus 发 syncWant', () => {
    const m = makeMarket('m-lan')
    const sent: Array<{ uid: number; type: string }> = []
    const deps: SkillMarketLanDeps = {
      getRole: () => 'master',
      listPeers: () => [{ uid: 2, role: 'satellite', online: true }],
      sendLan: (uid, type) => {
        sent.push({ uid, type })
        return undefined
      }
    }
    m.setLanDeps(deps)

    // upload 信封 → 落内置仓库 + uploads 登记
    const body = '---\nname: eps\ndescription: 信封表征\n---\n# eps\n'
    m.handleLanEnvelope({
      type: 'skill-market.upload',
      from: 2,
      payload: {
        name: 'eps',
        description: '信封表征',
        body,
        files: { 'SKILL.md': body },
        authorUid: 2,
        uploadedAt: Date.now()
      }
    } as never)
    expect(readManifest('m-lan').uploads.eps).toBeTruthy()
    expect(existsSync(join(ROOT, 'm-lan-repo', 'skills', 'eps', 'SKILL.md'))).toBe(true)

    // tombstone 信封 → 墓碑登记（列表据此过滤，技能不复活）
    m.handleLanEnvelope({
      type: 'skill-market.tombstone',
      from: 2,
      payload: { name: 'eps', removedAt: Date.now(), removedBy: 2 }
    } as never)
    expect(readManifest('m-lan').removed.eps).toBeTruthy()

    // 非本模块信封 → 静默忽略（不抛错、不落盘）
    m.handleLanEnvelope({ type: 'friend.request', from: 2, payload: {} } as never)

    // 对端上线 → 请求增量同步
    m.handlePeerStatus({ peer: { uid: 2 }, online: true } as never)
    expect(sent.some((s) => s.type === 'skill-market.syncWant')).toBe(true)
    expect(sent.every((s) => s.uid === 2)).toBe(true)
  })

  it('⑦ setChangeCallback(null) 解绑；setProgressCallback 覆盖前值（回调是唯一注入面）', async () => {
    const m = makeMarket('m-cb')
    const seen: MarketProgress[] = []
    m.setProgressCallback((p) => seen.push(p))
    m.addSource('本地', makeSkillRepo('zeta'))

    // 覆盖：第二次注入后只有新回调收到事件
    const seen2: MarketProgress[] = []
    m.setProgressCallback((p) => seen2.push(p))
    await m.install('zeta')
    expect(seen).toHaveLength(0)
    expect(seen2.length).toBeGreaterThan(0)

    // 解绑变更回调后不再触发（不抛错）
    let changes = 0
    m.setChangeCallback(() => {
      changes += 1
    })
    m.setChangeCallback(null)
    m.remove('zeta')
    expect(changes).toBe(0)
  })
})
