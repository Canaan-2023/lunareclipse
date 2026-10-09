/**
 * systemSlice 账号动作 → skillStore 接线单测（T6 补）
 *
 * 为什么存在：T1 修复技能列表不刷新的另一半是「账号切换时旧账号的 SKILL 数据不能
 * 残留到新账号」。SKILL 在磁盘按 {uid}/{aiId} 分层，内存侧必须同步：login/register
 * 先 reset 清空上一账号数据再加载本账号；logout/deleteAccount/switchUser 必须清空；
 * login/register 成功后还要 refresh() 重新拉取本账号技能列表。
 *
 * 覆盖：
 * 1. login 成功：skillStore 预置垃圾数据被 reset 清空，随后 refresh() 重新拉取
 * 2. login 失败：不 reset 不 refresh（当前账号数据保持，不上污染）
 * 3. register 成功：同 login 语义
 * 4. logout：reset 清空 + currentUser 置空
 * 5. deleteAccount：reset 清空 + 会话/AI 状态归零
 * 6. switchUser：reset 清空、且不调用 authLogout（保留 last_login_uid）
 *    —— 这是「未登录回到登录页后，再登录新账号不会看到旧账号技能」的防线
 *
 * 环境：vitest node 环境，不依赖 React 渲染（zustand vanilla store 直接操作；
 * useAppStore 是 create() 装配的完整 store，账号动作是纯 store 方法）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useAppStore } from '../src/stores/appStore'
import { useSkillStore } from '../src/stores/skillStore'
import type { SkillMetadata, SkillRuntimeStatus } from '../electron/main/skills'

const meta = (name: string): SkillMetadata => ({
  name,
  description: `desc-${name}`,
  source: 'user',
  filePath: `/skills/${name}/SKILL.md`,
  dirPath: `/skills/${name}`,
  runtime: { enabled: true },
  platforms: []
})

const runtimeStatus = (name: string): SkillRuntimeStatus => ({
  name, enabled: true, autoInvocable: true, userInvocable: true,
  source: 'user', domain: null, lastUsedAt: null, useCount: 0, loadError: null
})

/** 最小可用 lunareclipse API 面：只包含账号动作链会触达的调用 */
function makeApi(overrides: Record<string, unknown> = {}) {
  return {
    authLogin: vi.fn(async () => ({ ok: true, user: { UID: 7, name: 'u7' } })),
    authRegister: vi.fn(async () => ({ ok: true, user: { UID: 8, name: 'u8' } })),
    authLogout: vi.fn(async () => ({ ok: true })),
    authDeleteAccount: vi.fn(async () => ({ ok: true })),
    // login/register → loadSessions：空列表 → createSession 兜底建会话 → dmnSetActiveSession 通知后端
    listSessions: vi.fn(async () => []),
    createSession: vi.fn(async () => ({ id: 's-new', aiId: 1, title: '', messages: [] })),
    dmnSetActiveSession: vi.fn(async () => undefined),
    // login/register → loadAis
    aiList: vi.fn(async () => ({ ok: true, ais: [{ id: 1, name: 'moon', deactivated: false }] })),
    // skillStore.refresh → skill 域
    skill: {
      list: vi.fn(async (): Promise<SkillMetadata[]> => []),
      get: vi.fn(async (): Promise<{ name: string } | null> => null),
      toggle: vi.fn(async () => ({ ok: true })),
      delete: vi.fn(async () => ({ ok: true })),
      reload: vi.fn(async () => ({ ok: true, count: 0 })),
      status: vi.fn(async (): Promise<SkillRuntimeStatus[]> => []),
      errors: vi.fn(async (): Promise<Array<{ filePath: string; error: string }>> => [])
    },
    ...overrides
  }
}

/** 预置"上一账号残留"的 skillStore 状态，供 reset 断言清空（await 保证 refresh 已完成再断言） */
async function seedSkillStore(api: ReturnType<typeof makeApi>) {
  api.skill.list.mockResolvedValueOnce([meta('leftover')])
  api.skill.status.mockResolvedValueOnce([runtimeStatus('leftover')])
  await useSkillStore.getState().refresh()
}

describe('systemSlice 账号动作 → skillStore 接线', () => {
  let api: ReturnType<typeof makeApi>

  beforeEach(() => {
    api = makeApi()
    ;(globalThis as Record<string, unknown>).window = { lunareclipse: api }
    // 每个用例从干净状态开始：账号态与 skillStore 全部复位
    useAppStore.setState({
      currentUser: null, currentSessionId: null, currentMessages: [], sessions: [],
      ais: [], currentAiId: 1, aiPickerOpen: false, status: 'idle', streamingMessageId: null,
      errorMessage: null, todos: []
    })
    useSkillStore.setState({
      skills: [], currentSkill: null, statuses: [], loadErrors: [],
      error: null, loading: false
    })
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window
  })

  it('login 成功：先 reset 清空上一账号残留，再 refresh 拉取本账号技能', async () => {
    await seedSkillStore(api)
    expect(useSkillStore.getState().skills.map((x) => x.name)).toEqual(['leftover'])

    api.skill.list.mockResolvedValueOnce([meta('mine')])
    await useAppStore.getState().login('u', 'p')

    // reset 生效：跨账号残留清空，随后 refresh 拉到的是本账号数据
    const s = useSkillStore.getState()
    expect(s.skills.map((x) => x.name)).toEqual(['mine'])
    expect(s.skills.some((x) => x.name === 'leftover')).toBe(false)
    expect(useAppStore.getState().currentUser?.UID).toBe(7)
    expect(api.listSessions).toHaveBeenCalled()
    expect(api.aiList).toHaveBeenCalled()
  })

  it('login 失败：不 reset 不 refresh，原账号数据保持不上污染', async () => {
    await seedSkillStore(api)
    api.authLogin.mockResolvedValueOnce({ ok: false, error: '密码错误' })

    await expect(useAppStore.getState().login('u', 'wrong')).rejects.toThrow('密码错误')

    expect(useAppStore.getState().currentUser).toBeNull()
    // reset 未触发：skillStore 仍是预置的 leftover（未清空、未重拉）
    expect(useSkillStore.getState().skills.map((x) => x.name)).toEqual(['leftover'])
    expect(api.skill.list).toHaveBeenCalledTimes(1) // 仅 seed 那次
  })

  it('login API 抛异常：向上传播，不吞错', async () => {
    api.authLogin.mockRejectedValueOnce(new Error('ipc broken'))
    await expect(useAppStore.getState().login('u', 'p')).rejects.toThrow('ipc broken')
  })

  it('register 成功：同 login 语义（reset → 加载 → refresh）', async () => {
    api.skill.list.mockResolvedValueOnce([meta('fresh')])
    await useAppStore.getState().register('newu', 'p')

    const s = useSkillStore.getState()
    expect(useAppStore.getState().currentUser?.UID).toBe(8)
    expect(s.skills.map((x) => x.name)).toEqual(['fresh'])
    expect(api.authRegister).toHaveBeenCalledWith('newu', 'p', undefined)
  })

  it('logout：reset 清空技能数据，账号/会话/AI 状态归零', async () => {
    await seedSkillStore(api)
    // 模拟处于登录态
    useAppStore.setState({ currentUser: { UID: 7, name: 'u7' }, currentSessionId: 's1' })

    await useAppStore.getState().logout()

    expect(useAppStore.getState().currentUser).toBeNull()
    expect(useAppStore.getState().currentSessionId).toBeNull()
    expect(useAppStore.getState().sessions).toEqual([])
    expect(useSkillStore.getState().skills).toEqual([])
    expect(useSkillStore.getState().currentSkill).toBeNull()
    // logout 不应触发 refresh（登出后无账号数据域）
    expect(api.skill.list).toHaveBeenCalledTimes(1) // 仅 seed 那次
  })

  it('deleteAccount：reset 清空 + 账号与流状态整体归零', async () => {
    await seedSkillStore(api)
    useAppStore.setState({ currentUser: { UID: 7, name: 'u7' }, status: 'streaming' })

    await useAppStore.getState().deleteAccount()

    expect(useAppStore.getState().currentUser).toBeNull()
    expect(useAppStore.getState().status).toBe('idle')
    expect(useAppStore.getState().streamingMessageId).toBeNull()
    expect(useSkillStore.getState().skills).toEqual([])
    expect(api.authDeleteAccount).toHaveBeenCalledWith(7)
  })

  it('deleteAccount 未登录：直接返回，不调 IPC 不重置', async () => {
    await useAppStore.getState().deleteAccount()
    expect(api.authDeleteAccount).not.toHaveBeenCalled()
  })

  it('deleteAccount IPC 失败：抛错、状态不清空', async () => {
    await seedSkillStore(api)
    useAppStore.setState({ currentUser: { UID: 7, name: 'u7' } })
    api.authDeleteAccount.mockResolvedValueOnce({ ok: false, error: 'user 不存在' })

    await expect(useAppStore.getState().deleteAccount()).rejects.toThrow('user 不存在')
    expect(useAppStore.getState().currentUser?.UID).toBe(7)
    expect(useSkillStore.getState().skills.map((x) => x.name)).toEqual(['leftover'])
  })

  it('switchUser：reset 清空但绝不调 authLogout（保留 last_login_uid）', async () => {
    await seedSkillStore(api)
    useAppStore.setState({ currentUser: { UID: 7, name: 'u7' }, currentSessionId: 's1' })

    await useAppStore.getState().switchUser()

    expect(useAppStore.getState().currentUser).toBeNull()
    expect(useAppStore.getState().currentSessionId).toBeNull()
    expect(useSkillStore.getState().skills).toEqual([])
    expect(api.authLogout).not.toHaveBeenCalled()
    expect(api.skill.list).toHaveBeenCalledTimes(1) // 仅 seed 那次
  })
})