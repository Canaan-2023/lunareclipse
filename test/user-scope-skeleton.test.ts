import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { buildDataPaths, resolveScopePaths, scopedDomainPath } from '../electron/main/models/paths'
import { ensureUserScopeSkeleton } from '../electron/main/services/user-scope-skeleton'
import { UserStore } from '../electron/main/models/user-store'
import { readAiRegistry } from '../electron/main/models/ai-registry'
import { registerAiHandlers } from '../electron/main/ipc/handlers/ai'
import { CreateAiTool } from '../electron/main/tools/create-ai'

/**
 * 回归测试：月蚀不止一个 AI，未来会有新 AIID 顺延注册（运行期 registerCustomAi /
 * ai:register / create_ai），新 AI 必须"即插即用"——注册成功的那一刻起，
 * 它的 U{uid}/AI{aiId} 作用域骨架（skills/config/skills_domains/sessions/memory/NNG/cache）
 * 就已存在，装技能/写配置/切会话都不会撞 ENOENT。
 *
 * 覆盖三个接入点 + 幂等性 + 全量遍历（未来 AIID 无需白名单登记）。
 */
describe('user-scope-skeleton：运行期新增 AI 即插即用', () => {
  let root: string
  let paths: ReturnType<typeof buildDataPaths>

  const SKELETON_DIRS = (uid: number, aiId: number): string[] => {
    const scoped = resolveScopePaths(paths, { uid, aiId })
    return [
      ...['skills', 'skills_domains', 'config'].map((d) => scopedDomainPath(paths.root, d, uid, aiId)),
      scoped.sessions,
      scoped.memoryScope!, // U{uid}/AI{aiId}
      scoped.rawMemory,
      scoped.memoryNormal,
      scoped.memoryMeta,
      scoped.memoryHigh,
      scoped.calendar!,
      scoped.diary!,
      scoped.nngLevel1Dir,
      scoped.cacheLevel1Dir,
      scoped.cacheInjectionRoot
    ]
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'scope-skeleton-'))
    paths = buildDataPaths(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('登录骨架：为一个用户补建全部已注册 AI 的骨架（含 AI{3} 等新 AIID）', () => {
    // 注册表默认 [1,2]，模拟未来又顺延注册了 AI 3、4 —— 无需任何白名单，全量遍历
    // （registerCustomAi 是 "现有最大 id + 1"，这里直接写盘模拟已发生的注册）
    mkdirSync(dirname(paths.aiRegistryJson), { recursive: true })
    writeFileSync(
      paths.aiRegistryJson,
      JSON.stringify({
        version: 1,
        updated_at: new Date().toISOString(),
        ais: [
          { id: 1, name: '月蚀', agent: 'frontend', kind: 'system' },
          { id: 2, name: '莉莉丝', agent: 'lilith', kind: 'system' },
          { id: 3, name: '织梦', agent: 'custom-3', kind: 'custom' },
          { id: 4, name: '晨星', agent: 'custom-4', kind: 'custom' }
        ]
      }),
      'utf-8'
    )

    ensureUserScopeSkeleton(paths, 7)

    for (const aiId of [1, 2, 3, 4]) {
      for (const dir of SKELETON_DIRS(7, aiId)) {
        expect(existsSync(dir), `uid=7 aiId=${aiId} 缺目录 ${dir}`).toBe(true)
      }
      // 索引文件：NNG root.json + cache index.json
      const scoped = resolveScopePaths(paths, { uid: 7, aiId })
      expect(existsSync(scoped.nngRootJson)).toBe(true)
      expect(existsSync(scoped.cacheIndexJson)).toBe(true)
    }
  })

  it('运行期注册新 AI：注册表写入后再次补建，新 AI 骨架立即可用（旧 AI 不动）', () => {
    // 先建基础骨架（注册表只有 1、2）
    ensureUserScopeSkeleton(paths, 7)
    expect(existsSync(resolveScopePaths(paths, { uid: 7, aiId: 2 }).sessions)).toBe(true)
    expect(existsSync(resolveScopePaths(paths, { uid: 7, aiId: 3 }).sessions)).toBe(false)

    // 运行期新注册 AI 3（模拟 ai:register / create_ai 写入注册表后）
    mkdirSync(dirname(paths.aiRegistryJson), { recursive: true })
    const reg = readAiRegistry(paths.aiRegistryJson)
    reg.ais.push({ id: 3, name: '新分身', agent: 'custom-3', kind: 'custom' })
    writeFileSync(paths.aiRegistryJson, JSON.stringify(reg), 'utf-8')

    ensureUserScopeSkeleton(paths, 7)

    for (const dir of SKELETON_DIRS(7, 3)) {
      expect(existsSync(dir), `新 AI3 缺目录 ${dir}`).toBe(true)
    }
  })

  it('ai:register IPC：面板新建 AI 成功即触发骨架补建（uid 取自当前登录用户）', async () => {
    const store = new UserStore(paths.usersJson)
    const regUser = store.register('测试员', 'pass-1')
    expect(regUser.ok).toBe(true)
    if (!regUser.ok) return
    // 与 index.ts 相同的注入方式：UserStore.ensureScope → ensureUserScopeSkeleton
    store.setScopeInitializer((uid: number) => ensureUserScopeSkeleton(paths, uid))

    // 注册 IPC（mock ipcMain.handle，只收 ai:register）
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerAiHandlers(
      { handle: (ch: string, cb: (...a: unknown[]) => unknown) => handlers.set(ch, cb) } as never,
      () => paths,
      undefined,
      () => store
    )

    const r = await (handlers.get('ai:register') as (...a: unknown[]) => Promise<unknown>)({}, { name: '新AI' })
    const rr = r as { ok: boolean; record?: { id: number } }
    expect(rr.ok).toBe(true)
    const newId = rr.record!.id
    expect(newId).toBeGreaterThan(2) // 默认注册表 [1,2]，顺延到 3

    // 新 AI 骨架立即可见（不用等重启/下次登录）
    const uid = store.getCurrentUser()!.UID
    for (const dir of SKELETON_DIRS(uid, newId)) {
      expect(existsSync(dir), `ai:register 后新 AI${newId} 缺目录 ${dir}`).toBe(true)
    }
  })

  it('create_ai 工具：AI 自建 AI 成功即补建新 AI 骨架', async () => {
    const store = new UserStore(paths.usersJson)
    const regUser = store.register('测试员', 'pass-1')
    expect(regUser.ok).toBe(true)
    if (!regUser.ok) return
    store.setScopeInitializer((uid: number) => ensureUserScopeSkeleton(paths, uid))

    const tool = new CreateAiTool()
    const r = await tool.execute(
      { name: '分身甲', description: '运行期自建', systemPrompt: '你是分身。' },
      {
        paths,
        sessionId: 'sess-1',
        getSessionAiId: () => 1,
        requestPermission: async () => ({ allowed: true }),
        user: { UID: store.getCurrentUser()!.UID, 用户名: '测试员' }
      }
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const newId = (r as { ok: true; data: { record: { id: number } } }).data.record.id
    expect(newId).toBeGreaterThan(2)

    const uid = store.getCurrentUser()!.UID
    for (const dir of SKELETON_DIRS(uid, newId)) {
      expect(existsSync(dir), `create_ai 后新 AI${newId} 缺目录 ${dir}`).toBe(true)
    }
  })

  it('幂等：重复补建安全（已存在目录跳过，不抛错）', () => {
    ensureUserScopeSkeleton(paths, 7)
    expect(() => ensureUserScopeSkeleton(paths, 7)).not.toThrow()
    // 会话目录等关键目录仍完好
    expect(existsSync(resolveScopePaths(paths, { uid: 7, aiId: 1 }).sessions)).toBe(true)
  })

  it('注册表损坏/缺失：降级不抛错（其他 AI 骨架不受影响）', () => {
    expect(() => ensureUserScopeSkeleton(paths, 7)).not.toThrow()
    // 缺失注册表时返回默认 [1,2]，骨架照建
    expect(existsSync(resolveScopePaths(paths, { uid: 7, aiId: 2 }).sessions)).toBe(true)
  })
})