/**
 * sessions 分层整改回归测试（裸数字 → U{uid}/AI{aiId} 字面前缀）。
 *
 * 为什么存在——sessions 曾是唯一保留裸数字分层 {root}/sessions/{uid}/{aiId} 的作用域，
 * 与 memory/NNG/cache 的 U/AI 前缀不一致（历史欠账）。整改后的语义约定：
 *   1. 路径真源 resolveScopePaths.sessions = {root}/sessions/U{uid}/AI{aiId}；
 *   2. 同步域（SatelliteStore）对 sessions key 的镜像落地/合法性校验/账号提取全部对齐 U/AI；
 *   3. 旧裸数字目录由 ensureUserScopeSkeleton 幂等迁移（登录/注册/建新 AI 均经此入口）；
 *   4. session_search 按 scoped 作用域扫描（分片目录形态 + 旧单文件兼容，多账号隔离）。
 *
 * 覆盖：路径解析 / 迁移幂等 / 同步语义 / 检索命中与隔离。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { buildDataPaths, resolveScopePaths } from '../electron/main/models/paths'
import { ensureUserScopeSkeleton } from '../electron/main/services/user-scope-skeleton'
import { SatelliteStore } from '../electron/main/multi-instance/master/satellite-store'
import { SessionSearchTool } from '../electron/main/tools/session-search'
import type { OpEntry } from '../electron/main/multi-instance/types'
import type { ToolContext } from '../electron/main/tools/base-tool'

describe('sessions 分层整改：U{uid}/AI{aiId} 前缀', () => {
  let root: string
  let paths: ReturnType<typeof buildDataPaths>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sessions-prefix-'))
    paths = buildDataPaths(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('路径真源：resolveScopePaths.sessions 产出 U{uid}/AI{aiId}', () => {
    const scoped = resolveScopePaths(paths, { uid: 7, aiId: 3 })
    expect(scoped.sessions).toBe(join(paths.root, 'sessions', 'U7', 'AI3'))
    // 不同 uid/aiId 相互隔离
    const other = resolveScopePaths(paths, { uid: 8, aiId: 3 })
    expect(other.sessions).toBe(join(paths.root, 'sessions', 'U8', 'AI3'))
    expect(other.sessions).not.toBe(scoped.sessions)
    // 旧裸数字形态不再出现在真源
    expect(scoped.sessions).not.toBe(join(paths.root, 'sessions', '7', '3'))
  })

  it('迁移幂等：旧 {uid}/{aiId} 目录+文件迁到 U/AI，旧父目录清空，重跑不重复搬', () => {
    const uid = 1
    const aiId = 2
    // 构造旧裸数字分层下的会话（模拟历史数据）
    const legacy = join(paths.root, 'sessions', String(uid), String(aiId), 'user')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'meta.json'), JSON.stringify({ id: 's_l1', title: '旧会话', shardCount: 0 }), 'utf-8')
    writeFileSync(join(legacy, '0.json'), JSON.stringify([{ role: 'user', content: '历史内容' }]), 'utf-8')

    ensureUserScopeSkeleton(paths, uid)

    const scoped = resolveScopePaths(paths, { uid, aiId })
    expect(existsSync(scoped.sessions)).toBe(true)
    // 文件随目录整体迁入新作用域
    expect(existsSync(join(scoped.sessions, 'user', 'meta.json'))).toBe(true)
    expect(existsSync(join(scoped.sessions, 'user', '0.json'))).toBe(true)
    expect(readFileSync(join(scoped.sessions, 'user', 'meta.json'), 'utf-8')).toContain('旧会话')
    // 旧目录本体与空父目录被清理
    expect(existsSync(join(paths.root, 'sessions', String(uid), String(aiId)))).toBe(false)
    expect(existsSync(join(paths.root, 'sessions', String(uid)))).toBe(false)
    // 幂等：再次进入不报错、不移除已迁移内容
    ensureUserScopeSkeleton(paths, uid)
    expect(existsSync(join(scoped.sessions, 'user', 'meta.json'))).toBe(true)
  })

  it('迁移幂等（目标已存在即跳过）：新分层数据不被旧目录覆盖干扰', () => {
    const uid = 1
    const aiId = 1
    const scoped = resolveScopePaths(paths, { uid, aiId })
    // 新分层已有数据
    mkdirSync(join(scoped.sessions, 'user'), { recursive: true })
    writeFileSync(join(scoped.sessions, 'user', 'meta.json'), JSON.stringify({ id: 's_new', title: '新会话' }), 'utf-8')
    // 旧目录也存在（异常残留）
    const legacy = join(paths.root, 'sessions', String(uid), String(aiId))
    mkdirSync(legacy, { recursive: true })

    ensureUserScopeSkeleton(paths, uid)

    // 目标已存在 → 不覆盖，新数据保留
    expect(readFileSync(join(scoped.sessions, 'user', 'meta.json'), 'utf-8')).toContain('新会话')
    expect(existsSync(join(scoped.sessions, 'user', 'meta.json'))).toBe(true)
  })

  it('同步域：SatelliteStore 对 sessions/U{uid}/AI{aiId} key 合法校验 + 镜像落地 + delete 幂等重放', () => {
    const store = new SatelliteStore(paths.root)
    const instanceId = 'inst-2'
    // 新形态 key 合法
    expect(SatelliteStore.isValidKey('sessions/U1/AI2/user/meta.json')).toBe(true)
    expect(SatelliteStore.isValidKey('sessions/U8/AI9/rest.txt')).toBe(true)
    // 旧裸数字 key 不再合法
    expect(SatelliteStore.isValidKey('sessions/1/2/user/meta.json')).toBe(false)
    // 缺 uid/aiId / 反序都不合法
    expect(SatelliteStore.isValidKey('sessions/U1/2/x.json')).toBe(false)
    expect(SatelliteStore.isValidKey('sessions/AI2/U1/x.json')).toBe(false)
    // 非 sessions 域不受影响
    expect(SatelliteStore.isValidKey('memory/U1/AI2/diary.md')).toBe(true)

    // 镜像落地：sessions 独立归集到 sessions_satellite/{instanceId}/U{uid}/AI{aiId}/...
    // upsert 一律 staged：实体先落 sync_staging，applyPush 读回验 size/hash 后落镜像
    const stagedKey = 'sessions/U1/AI2/s_abc/user/0.json'
    const stagedRaw = Buffer.from('[{"role":"user","content":"同步内容"}]', 'utf-8')
    const stagedPath = SatelliteStore.stagingPathFor(paths.root, 1, instanceId, stagedKey)
    mkdirSync(dirname(stagedPath), { recursive: true })
    writeFileSync(stagedPath, stagedRaw)
    const entries: OpEntry[] = [
      {
        instanceId,
        uid: 1,
        aiId: 2,
        op: 'upsert',
        key: stagedKey,
        size: stagedRaw.length,
        staged: true,
        hash: 'sha256:' + createHash('sha256').update(stagedRaw).digest('hex'),
        seq: 1
      }
    ]
    const res = store.applyPush(1, instanceId, entries)
    expect(res.ok).toBe(true)
    expect(res.ackedSeq).toBe(1)
    const mirrored = join(paths.root, 'sessions_satellite', instanceId, 'U1', 'AI2', 's_abc', 'user', '0.json')
    expect(existsSync(mirrored)).toBe(true)
    expect(readFileSync(mirrored, 'utf-8')).toContain('同步内容')

    // delete 幂等重放：低 seq 的旧 delete 不复活新内容，高 seq delete 生效
    store.applyPush(1, instanceId, [
      {
        instanceId,
        uid: 1,
        aiId: 2,
        op: 'delete',
        key: 'sessions/U1/AI2/s_abc/user/0.json',
        seq: 2
      }
    ])
    expect(existsSync(mirrored)).toBe(false)
    // 重放 seq<=水位 的旧 upsert 不再写回
    store.applyPush(1, instanceId, entries)
    expect(existsSync(mirrored)).toBe(false)
    // 重放 seq=3 的 upsert 正常收敛（实体需重新落 staging——新 seq 走 staging 读回校验）
    const resumeRaw = Buffer.from('[{"role":"user","content":"重放补齐"}]', 'utf-8')
    const resumePath = SatelliteStore.stagingPathFor(paths.root, 1, instanceId, 'sessions/U1/AI2/s_abc/user/0.json')
    mkdirSync(dirname(resumePath), { recursive: true })
    writeFileSync(resumePath, resumeRaw)
    store.applyPush(1, instanceId, [
      {
        instanceId,
        uid: 1,
        aiId: 2,
        op: 'upsert',
        key: 'sessions/U1/AI2/s_abc/user/0.json',
        size: resumeRaw.length,
        staged: true,
        hash: 'sha256:' + createHash('sha256').update(resumeRaw).digest('hex'),
        seq: 3
      }
    ])
    expect(existsSync(mirrored)).toBe(true)
    expect(readFileSync(mirrored, 'utf-8')).toContain('重放补齐')
  })

  it('session_search：分片目录形态命中 + 旧单文件兼容 + sessionId 限定', async () => {
    const scoped = resolveScopePaths(paths, { uid: 5, aiId: 1 })
    const sessionsDir = scoped.sessions
    mkdirSync(join(sessionsDir, 's_dir1', 'user'), { recursive: true })
    writeFileSync(
      join(sessionsDir, 's_dir1', 'user', 'meta.json'),
      JSON.stringify({ id: 's_dir1', title: '分片会话', shardCount: 2 }),
      'utf-8'
    )
    writeFileSync(
      join(sessionsDir, 's_dir1', 'user', '1.json'),
      JSON.stringify([{ role: 'user', content: '上午聊了量子力学' }]),
      'utf-8'
    )
    writeFileSync(
      join(sessionsDir, 's_dir1', 'user', '2.json'),
      JSON.stringify([{ role: 'assistant', content: '量子纠缠的总结' }]),
      'utf-8'
    )
    // 旧单文件形态（遗留兼容）
    writeFileSync(
      join(sessionsDir, 's_legacy.json'),
      JSON.stringify({ id: 's_legacy', title: '旧单文件会话', messages: [{ role: 'user', content: '量子隧穿回顾' }] }),
      'utf-8'
    )
    // 干扰项：无 meta.json 的非会话目录（如 # 锁目录/ai 目录）不得被当会话
    mkdirSync(join(sessionsDir, 'not-a-session'), { recursive: true })

    const tool = new SessionSearchTool()
    const ctx = { paths: { sessions: sessionsDir } } as unknown as ToolContext

    const r = await tool.execute({ query: '量子' }, ctx)
    expect(r.ok).toBe(true)
    const data = r.data as { hits: { sessionId: string; sessionTitle: string; snippet: string }[]; scanned: number }
    expect(data.hits.length).toBeGreaterThanOrEqual(3)
    const ids = data.hits.map((h) => h.sessionId)
    expect(ids).toContain('s_dir1')
    expect(ids).toContain('s_legacy')
    // 非会话目录未被扫描（scanned 只含两种会话源）
    expect(ids).not.toContain('not-a-session')

    // sessionId 限定：只扫单会话
    const r2 = await tool.execute({ query: '量子', sessionId: 's_dir1' }, ctx)
    expect(r2.ok).toBe(true)
    const data2 = r2.data as { hits: { sessionId: string }[] }
    expect(data2.hits.length).toBeGreaterThanOrEqual(1)
    expect(data2.hits.every((h) => h.sessionId === 's_dir1')).toBe(true)

    // 限定不存在的会话：明确报错
    const r3 = await tool.execute({ query: '量子', sessionId: 'ghost' }, ctx)
    expect(r3.ok).toBe(false)
  })

  it('session_search：多账号隔离——uid1/uid2 同 aiId 互不串', async () => {
    const s1 = resolveScopePaths(paths, { uid: 1, aiId: 9 }).sessions
    const s2 = resolveScopePaths(paths, { uid: 2, aiId: 9 }).sessions
    mkdirSync(join(s1, 's_a', 'user'), { recursive: true })
    writeFileSync(join(s1, 's_a', 'user', 'meta.json'), JSON.stringify({ id: 's_a', title: '甲账号', shardCount: 1 }), 'utf-8')
    writeFileSync(join(s1, 's_a', 'user', '1.json'), JSON.stringify([{ role: 'user', content: '甲账号的秘密标记 XYCORP' }]), 'utf-8')
    mkdirSync(join(s2, 's_b', 'user'), { recursive: true })
    writeFileSync(join(s2, 's_b', 'user', 'meta.json'), JSON.stringify({ id: 's_b', title: '乙账号', shardCount: 1 }), 'utf-8')
    writeFileSync(join(s2, 's_b', 'user', '1.json'), JSON.stringify([{ role: 'user', content: '乙账号的秘密标记 ABCXYZ' }]), 'utf-8')

    const tool = new SessionSearchTool()
    // uid=1 作用域搜 XYCORP 命中、搜 ABCXYZ 不命中
    const r1 = await tool.execute({ query: 'XYCORP' }, { paths: { sessions: s1 } } as unknown as ToolContext)
    expect(r1.ok).toBe(true)
    expect(((r1.data as { hits: unknown[] }).hits).length).toBe(1)
    const r1b = await tool.execute({ query: 'ABCXYZ' }, { paths: { sessions: s1 } } as unknown as ToolContext)
    expect(((r1b.data as { hits: unknown[] }).hits).length).toBe(0)
    // 反向：uid=2 作用域恰好相反
    const r2 = await tool.execute({ query: 'ABCXYZ' }, { paths: { sessions: s2 } } as unknown as ToolContext)
    expect(((r2.data as { hits: unknown[] }).hits).length).toBe(1)
    const r2b = await tool.execute({ query: 'XYCORP' }, { paths: { sessions: s2 } } as unknown as ToolContext)
    expect(((r2b.data as { hits: unknown[] }).hits).length).toBe(0)
  })

  it('session_search：作用域目录不存在时给出明确错误（不误伤其它目录）', async () => {
    const tool = new SessionSearchTool()
    const ghostDir = join(paths.root, 'sessions', 'U99', 'AI99')
    const r = await tool.execute({ query: '任意' }, { paths: { sessions: ghostDir } } as unknown as ToolContext)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('不存在')
  })
})