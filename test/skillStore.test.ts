/**
 * skillStore 状态机单测（T6 补）
 *
 * 覆盖：
 * 1. refresh 成功/失败/API 未就绪三分支（loading/error/skills 状态迁移）
 * 2. init === refresh（已删 skillsLoaded 防重复标记：连续两次 init 都重新拉取，
 *    不再"首次加载后永久短路"——这是技能列表不显示的根因之一）
 * 3. reset 账号切换/登出清空全部用户态数据（跨账号残留泄漏防护）
 * 4. loadSkill / toggleSkill / deleteSkill / reloadSkills 各分支
 *
 * 环境：vitest node 环境，不依赖 React 渲染（zustand store 本体可直接操作）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useSkillStore } from '../src/stores/skillStore'
import type { SkillMetadata, Skill, SkillRuntimeStatus } from '../electron/main/skills'

function makeSkillApi(overrides: Record<string, unknown> = {}) {
  return {
    list: vi.fn(async (): Promise<SkillMetadata[]> => []),
    get: vi.fn(async (): Promise<Skill | null> => null),
    toggle: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
    delete: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
    reload: vi.fn(async (): Promise<{ ok: boolean; count?: number; error?: string }> => ({ ok: true, count: 0 })),
    status: vi.fn(async (): Promise<SkillRuntimeStatus[]> => []),
    errors: vi.fn(async (): Promise<Array<{ filePath: string; error: string }>> => []),
    ...overrides
  }
}

const meta = (name: string): SkillMetadata => ({
  name,
  description: `desc-${name}`,
  source: 'user',
  filePath: `/skills/${name}/SKILL.md`,
  dirPath: `/skills/${name}`,
  runtime: { enabled: true },
  platforms: []
})

describe('skillStore 状态机', () => {
  let api: ReturnType<typeof makeSkillApi>

  beforeEach(() => {
    api = makeSkillApi()
    ;(globalThis as Record<string, unknown>).window = {
      lunareclipse: { skill: api }
    }
    // 每个用例从干净状态开始：复位 store 全部字段
    useSkillStore.setState({
      skills: [], currentSkill: null, statuses: [], loadErrors: [],
      error: null, loading: false
    })
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window
  })

  it('refresh 成功：拉取列表、触发状态与错误加载、loading 归位', async () => {
    api.list.mockResolvedValueOnce([meta('a'), meta('b')])
    api.status.mockResolvedValueOnce([{ name: 'a', enabled: true, autoInvocable: true, userInvocable: true, source: 'user', domain: null, lastUsedAt: null, useCount: 0, loadError: null }])

    await useSkillStore.getState().refresh()

    const s = useSkillStore.getState()
    expect(s.skills.map((x) => x.name)).toEqual(['a', 'b'])
    expect(s.loading).toBe(false)
    expect(s.error).toBeNull()
    expect(api.status).toHaveBeenCalled()
    expect(api.errors).toHaveBeenCalled()
  })

  it('refresh 失败：error 置位、skills 保留旧值、loading 归位', async () => {
    api.list.mockResolvedValueOnce([meta('keep')])
    await useSkillStore.getState().refresh()
    api.list.mockRejectedValueOnce(new Error('boom'))

    await useSkillStore.getState().refresh()

    expect(useSkillStore.getState().error).toContain('boom')
    expect(useSkillStore.getState().skills.map((x) => x.name)).toEqual(['keep'])
    expect(useSkillStore.getState().loading).toBe(false)
  })

  it('refresh API 未就绪：error 提示 SKILL API 未就绪', async () => {
    ;(globalThis as Record<string, unknown>).window = { lunareclipse: {} }

    await useSkillStore.getState().refresh()

    expect(useSkillStore.getState().error).toContain('未就绪')
    expect(useSkillStore.getState().loading).toBe(false)
  })

  it('init 与 refresh 等价：连续多次 init 每次都真正拉取（skillsLoaded 已删）', async () => {
    await useSkillStore.getState().init()
    expect(api.list).toHaveBeenCalledTimes(1)

    await useSkillStore.getState().init()
    expect(api.list).toHaveBeenCalledTimes(2)
    expect(useSkillStore.getState().loading).toBe(false)
  })

  it('reset 清空全部用户态数据（跨账号残留泄漏防护）', async () => {
    api.list.mockResolvedValueOnce([meta('a')])
    api.get.mockResolvedValueOnce({ ...meta('a'), body: '# body' })
    await useSkillStore.getState().refresh()
    await useSkillStore.getState().loadSkill('a')
    useSkillStore.setState({ statuses: [{ name: 'a', enabled: true, autoInvocable: true, userInvocable: true, source: 'user', domain: null, lastUsedAt: 1, useCount: 2, loadError: null }], loadErrors: [{ filePath: 'x', error: 'y' }], error: 'zz' })

    useSkillStore.getState().reset()

    const s = useSkillStore.getState()
    expect(s.skills).toEqual([])
    expect(s.currentSkill).toBeNull()
    expect(s.statuses).toEqual([])
    expect(s.loadErrors).toEqual([])
    expect(s.error).toBeNull()
    expect(s.loading).toBe(false)
  })

  it('loadSkill 成功：currentSkill 置位；未找到：error 提示', async () => {
    api.get.mockResolvedValueOnce({ ...meta('a'), body: '# body' })
    await useSkillStore.getState().loadSkill('a')
    expect(useSkillStore.getState().currentSkill?.name).toBe('a')
    expect(useSkillStore.getState().currentSkill?.body).toBe('# body')

    api.get.mockResolvedValueOnce(null)
    await useSkillStore.getState().loadSkill('missing')
    expect(useSkillStore.getState().error).toContain('missing')
  })

  it('toggleSkill 成功：本地 skills 同步 enabled 并刷新状态', async () => {
    api.list.mockResolvedValueOnce([meta('a')])
    await useSkillStore.getState().refresh()

    await useSkillStore.getState().toggleSkill('a', false)

    expect(useSkillStore.getState().skills[0].runtime.enabled).toBe(false)
    expect(api.toggle).toHaveBeenCalledWith('a', false)
    expect(api.status).toHaveBeenCalled()
  })

  it('toggleSkill 失败：error 置位、本地状态不回改', async () => {
    api.toggle.mockResolvedValueOnce({ ok: false, error: '磁盘写入失败' })
    await useSkillStore.getState().toggleSkill('a', false)
    expect(useSkillStore.getState().error).toContain('磁盘写入失败')
  })

  it('deleteSkill 成功：列表移除，currentSkill 命中时清空', async () => {
    api.list.mockResolvedValueOnce([meta('a'), meta('b')])
    api.get.mockResolvedValueOnce({ ...meta('a'), body: '# body' })
    await useSkillStore.getState().refresh()
    await useSkillStore.getState().loadSkill('a')

    const ok = await useSkillStore.getState().deleteSkill('a')

    expect(ok).toBe(true)
    expect(useSkillStore.getState().skills.map((x) => x.name)).toEqual(['b'])
    expect(useSkillStore.getState().currentSkill).toBeNull()
  })

  it('deleteSkill 失败：返回 false 并置 error', async () => {
    api.delete.mockResolvedValueOnce({ ok: false, error: 'builtin 不可删除' })
    const ok = await useSkillStore.getState().deleteSkill('a')
    expect(ok).toBe(false)
    expect(useSkillStore.getState().error).toContain('builtin 不可删除')
  })

  it('reloadSkills：调用 reload 后重新 refresh 拉列表', async () => {
    api.reload.mockResolvedValueOnce({ ok: true, count: 1 })
    api.list.mockResolvedValueOnce([meta('after')])

    await useSkillStore.getState().reloadSkills()

    expect(api.reload).toHaveBeenCalled()
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(useSkillStore.getState().skills[0].name).toBe('after')
  })
})