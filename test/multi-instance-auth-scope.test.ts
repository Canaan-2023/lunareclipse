/**
 * 分系统认证与主系统代注册的运行期骨架补建回归测试（多账号/多开审计修复）。
 *
 * 为什么存在：审计发现两个"运行期接入不建骨架"缺口——
 *   C) SatelliteAuth.applySession（register/login/restore 统一收口）只缓存令牌+setCurrentUser，
 *      不触 userStore.ensureScope。首次接入（运行期拿到 UID）或登录时该 UID 目录尚未创建，
 *      会造成首次写记忆/技能/会话前目录缺失，直到下次重启启动兜底才补。
 *   D) master-router /auth/register 用 silent=true 代注册（不写登录态、不 ensureScope），
 *      运行期新接入的分系统账号在 master 侧重启前无 memory/U{uid}/AI{aiId} 骨架。
 * 修复：两端注册/登录/恢复成功后立即 ensureScope（幂等，scopeInitializer 未注入时 no-op 安全）。
 *
 * 覆盖：
 *  1. SatelliteAuth.register：主系统发放 UID 后立即 ensureScope(UID)
 *  2. SatelliteAuth.login（缓存令牌免密）：ensureScope(缓存 UID)
 *  3. SatelliteAuth.restoreSatellite：刷新成功路径 ensureScope(缓存 UID)
 *  4. master-router POST /auth/register：静默注册成功后 ensureScope(新 UID)
 *  5. 对照：master-router 登录/刷新（既有账号）不重复建骨架也无副作用（ensureScope 未被额外触发）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import express from 'express'
import { SatelliteAuth } from '../electron/main/multi-instance/auth/auth-service'
import { SatelliteTokenCache } from '../electron/main/multi-instance/auth/satellite-token'
import { InstanceConfigStore } from '../electron/main/multi-instance/instance-config'
import { SatelliteClient } from '../electron/main/multi-instance/satellite/satellite-client'
import { MasterRegistry } from '../electron/main/multi-instance/master/master-registry'
import { SatelliteStore } from '../electron/main/multi-instance/master/satellite-store'
import { createMasterRouter } from '../electron/main/multi-instance/master/master-router'
import { UserStore } from '../electron/main/models/user-store'
import { buildDataPaths, resolveScopePaths, scopedDomainPath } from '../electron/main/models/paths'
import { ensureUserScopeSkeleton } from '../electron/main/services/user-scope-skeleton'
import { writeAiRegistry } from '../electron/main/models/ai-registry'
import type { AuthIssued } from '../electron/main/multi-instance/satellite/satellite-client'

function makeUserStore(root: string): UserStore & { ensureScope: ReturnType<typeof vi.fn> } {
  const store = new UserStore(join(root, 'users', 'users.json'))
  // spyOn 的副作用（打桩）即所需，返回值不消费——只注册不引用，
  // 避免未使用变量 lint
  vi.spyOn(store, 'ensureScope')
  return store as UserStore & { ensureScope: ReturnType<typeof vi.fn> }
}

function makeSatelliteEnv(root: string) {
  const config = new InstanceConfigStore(root)
  config.becomeSatellite({ baseUrl: 'http://127.0.0.1:39999', instanceId: 'master-1', accessToken: 't0' })
  const tokenCache = new SatelliteTokenCache(join(root, 'satellite-token.json'))
  return { config, tokenCache }
}

describe('SatelliteAuth：运行期接入/登录/恢复即补建本机骨架', () => {
  let root: string
  const issuedUid = 42

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sat-auth-scope-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('register：主系统发放 UID 后 ensureScope(UID) 立即触发（运行期首个账号骨架）', async () => {
    const userStore = makeUserStore(root)
    const { config, tokenCache } = makeSatelliteEnv(root)
    // SatelliteAuth 构造器内部 new SatelliteClient(master.baseUrl)，mock 原型以拦截远端调用
    vi.spyOn(SatelliteClient.prototype, 'register').mockResolvedValue({
      ok: true,
      uid: issuedUid,
      instanceId: 'sat-1',
      token: 'tk'
    } as AuthIssued)
    const auth = new SatelliteAuth(userStore, config, tokenCache)

    const result = await auth.register('分机一号', 'pass1234')

    expect(result.ok).toBe(true)
    expect(userStore.ensureScope).toHaveBeenCalledWith(issuedUid)
  })

  it('register：ensureScope 真实落盘 U{uid}/AI{aiId} 骨架（skills/config/memory/sessions 齐全）', async () => {
    // 注入 scopeInitializer（等价 index.ts 启动装配）→ applySession 的 ensureScope 真实建目录
    vi.spyOn(SatelliteClient.prototype, 'register').mockResolvedValue({
      ok: true,
      uid: issuedUid,
      instanceId: 'sat-1',
      token: 'tk'
    } as AuthIssued)
    const paths = buildDataPaths(root)
    writeAiRegistry(paths.aiRegistryJson, { version: 1, updated_at: '', ais: [{ id: 1, name: '月蚀', agent: 'moon', deactivated: false }] })
    const userStore = makeUserStore(root)
    userStore.setScopeInitializer((uid) => ensureUserScopeSkeleton(paths, uid))
    const { config, tokenCache } = makeSatelliteEnv(root)
    const auth = new SatelliteAuth(userStore, config, tokenCache)

    await auth.register('分机一号', 'pass1234')

    const scoped = resolveScopePaths(paths, { uid: issuedUid, aiId: 1 })
    const expectDirs = [
      scoped.sessions,
      scoped.rawMemory,
      scoped.memoryNormal,
      scoped.memoryHigh,
      scoped.nngLevel1Dir,
      scoped.cacheLevel1Dir,
      scoped.cacheInjectionRoot,
      scopedDomainPath(paths.root, 'skills', issuedUid, 1),
      scopedDomainPath(paths.root, 'skills_domains', issuedUid, 1),
      scopedDomainPath(paths.root, 'config', issuedUid, 1)
    ]
    for (const dir of expectDirs) {
      expect(existsSync(dir), `骨架目录缺失: ${dir}`).toBe(true)
    }
  })

  it('login：本机有缓存令牌免密登录后 ensureScope(缓存 UID) 触发', async () => {
    const userStore = makeUserStore(root)
    const { config, tokenCache } = makeSatelliteEnv(root)
    tokenCache.save({ UID: issuedUid, 用户名: '分机一号', accessToken: 'tk-cached', exp: Date.now() + 3600_000 })
    const auth = new SatelliteAuth(userStore, config, tokenCache)

    const result = await auth.login('分机一号', 'whatever')

    expect(result.ok).toBe(true)
    expect(userStore.ensureScope).toHaveBeenCalledWith(issuedUid)
  })

  it('restoreSatellite：离线沿用缓存令牌恢复会话后 ensureScope(缓存 UID) 触发', async () => {
    const userStore = makeUserStore(root)
    const { config, tokenCache } = makeSatelliteEnv(root)
    tokenCache.save({ UID: issuedUid, 用户名: '分机一号', accessToken: 'tk-old', exp: Date.now() + 3600_000 })
    // 主系统不可达 → 刷新抛错走离线沿用分支
    vi.spyOn(SatelliteClient.prototype, 'refresh').mockRejectedValue(new Error('ECONNREFUSED'))
    const auth = new SatelliteAuth(userStore, config, tokenCache)

    const user = await auth.restoreSatellite()

    expect(user?.UID).toBe(issuedUid)
    expect(userStore.ensureScope).toHaveBeenCalledWith(issuedUid)
  })

  it('ensureScope 未注入 scopeInitializer 时为 no-op（不抛错、不影响认证）', async () => {
    // 测试环境 UserStore 未 setScopeInitializer → ensureScope 内部空调用
    const userStore = makeUserStore(root)
    const { config, tokenCache } = makeSatelliteEnv(root)
    tokenCache.save({ UID: issuedUid, 用户名: '分机一号', accessToken: 'tk', exp: Date.now() + 3600_000 })
    const auth = new SatelliteAuth(userStore, config, tokenCache)

    const result = await auth.login('分机一号', 'pw')
    expect(result.ok).toBe(true)
    expect(userStore.getCurrentUser()?.UID).toBe(issuedUid)
  })
})

describe('master-router /auth/register：silent 代注册后立即补建 master 侧骨架', () => {
  let root: string
  let server: ReturnType<typeof import('http').createServer> | null = null
  let port = 0

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'master-router-scope-'))
    port = 0
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = null
    }
    rmSync(root, { recursive: true, force: true })
  })

  /** 起一个真实 http server 承载 master router（loopback 校验需要真实 socket 地址） */
  async function startMasterRouter(): Promise<{ url: string; userStore: ReturnType<typeof makeUserStore>; joinCode: string }> {
    const userStore = makeUserStore(root)
    const config = new InstanceConfigStore(root)
    config.becomeMaster()
    const joinCode = config.getJoinCode()!
    const registry = new MasterRegistry(root)
    const satelliteStore = new SatelliteStore(root)
    const router = createMasterRouter({ registry, satelliteStore, userStore, instanceConfig: config })
    const app = express()
    app.use(express.json())
    app.use('/api/v1', router)
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server!.address()
    if (!address || typeof address === 'string') throw new Error('server address unavailable')
    port = address.port
    return { url: `http://127.0.0.1:${port}/api/v1`, userStore, joinCode }
  }

  it('silent 注册成功 → ensureScope(新 UID) 触发，且不污染本机登录态', async () => {
    const { url, userStore, joinCode } = await startMasterRouter()
    const res = await fetch(`${url}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 用户名: '分机一号', password: 'pass1234', joinCode })
    })
    const body = (await res.json()) as { ok: boolean; uid?: number; error?: string }
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(typeof body.uid).toBe('number')
    // 修复点：代注册成功立即补建 master 侧骨架
    expect(userStore.ensureScope).toHaveBeenCalledWith(body.uid)
    // silent 语义保持：不 setCurrent、不写 last_login_uid（本机登录态零污染）
    expect(userStore.getCurrentUser()).toBeNull()
  })

  it('joinCode 缺失/错误 → 拒绝注册且不触发 ensureScope', async () => {
    const { url, userStore } = await startMasterRouter()
    const res = await fetch(`${url}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 用户名: '分机二号', password: 'pass1234', joinCode: 'WRONG' })
    })
    expect(res.status).toBe(403)
    expect(userStore.ensureScope).not.toHaveBeenCalled()
  })
})