/**
 * SKILL 自动刷新链路单测（切换 AI 会话 / SKILL 磁盘变动 → 前端列表与市场自动刷新）
 *
 * 覆盖四条可独立验证的触发关系：
 * 1. SkillLoader 作用域感知：切 AI 会话后 listMetadata() 自动重扫当前 U{uid}/AI{aiId}
 *    作用域（「切换 AI 后打开 SKILL 列表仍显示上一 AI」的根因修复）；
 * 2. SkillLoader.setChangeCallback：磁盘 SKILL.md / 配置变化热重载完成后回调触发
 *    （主进程据此广播 'skills:changed' 到渲染侧）；
 * 3. skillStore 事件桥：主进程广播到达后 skillsChangedAt 时间戳更新 + refresh 重拉
 *    （MarketTab 等订阅组件凭时间戳自动重载，去手动刷新）；
 * 4. appStore.chatSlice：selectSession / createSession 切换到不同 AI 归属的会话时
 *    显式调用 useSkillStore.refresh()（无磁盘变动的会话切换路径）。
 *
 * 组件层（MarketTab 的 useEffect 依赖 currentAiId/skillsChangedAt）不在本文件验证：
 * 项目 vitest 环境为 node（无 jsdom），组件 effect 行为无法运行，且本仓库组件测试
 * 一贯只用 react-dom/server 测纯渲染。effect 依赖的正确性由 typecheck 与代码审查保证，
 * 状态源头（skillsChangedAt / currentAiId）的变化契约由本文件第 3、4 组用例钉住。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setPathContext } from '../electron/main/models/path-context'
import { SkillLoader } from '../electron/main/skills/loader'
import { useSkillStore } from '../src/stores/skillStore'
import { useAppStore } from '../src/stores/appStore'
import type { AppState } from '../src/stores/appStore-types'

/* ============================ 工具 ============================ */

function writeSkill(root: string, relPath: string, name: string): string {
  const dir = join(root, relPath)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'SKILL.md')
  writeFileSync(
    filePath,
    `---
name: ${name}
description: ${name} 的描述
---
正文
`,
    'utf-8'
  )
  return filePath
}

const session = (id: string, aiId: number) => ({
  id,
  title: `会话-${id}`,
  messages: [{ id: 'u1', role: 'user', content: '你好', createdAt: Date.now() }],
  model: null,
  aiId
})

/* ============================ 1+2. SkillLoader ============================ */

describe('SkillLoader 作用域感知与变更回调', () => {
  let root: string
  let dataRoot: string
  let mockUid: number | null
  let mockAiId: number | null

  beforeEach(() => {
    mockUid = 1
    mockAiId = 1
    root = mkdtempSync(join(tmpdir(), 'skill-refresh-root-'))
    dataRoot = mkdtempSync(join(tmpdir(), 'skill-refresh-data-'))
    setPathContext(dataRoot, () => mockUid, () => mockAiId)
  })

  afterEach(() => {
    mockUid = null
    mockAiId = null
    rmSync(root, { recursive: true, force: true })
    rmSync(dataRoot, { recursive: true, force: true })
  })

  it('切 AI 会话后 listMetadata 自动重扫新作用域（不显示上一 AI 的列表）', () => {
    // AI{1} 作用域一个技能、AI{2} 作用域另一个技能
    writeSkill(join(dataRoot, 'skills', 'U1', 'AI1'), 'only-ai1', 'only-ai1')
    writeSkill(join(dataRoot, 'skills', 'U1', 'AI2'), 'only-ai2', 'only-ai2')
    const loader = new SkillLoader(() => null, join(root, 'config.json'))
    loader.load()
    expect(loader.listMetadata().map((m) => m.name)).toEqual(['only-ai1'])

    // 切到 AI{2}：listMetadata 检测作用域键变化（1:1 -> 1:2）自动重扫
    mockAiId = 2
    expect(loader.listMetadata().map((m) => m.name)).toEqual(['only-ai2'])
  })

  it('同一作用域内重复 listMetadata 不重扫（缓存命中，行为稳定）', () => {
    writeSkill(join(dataRoot, 'skills', 'U1', 'AI1'), 'stable', 'stable')
    const loader = new SkillLoader(() => null, join(root, 'config.json'))
    const first = loader.listMetadata()
    expect(first.map((m) => m.name)).toEqual(['stable'])
    // 作用域不变：返回同一缓存数组引用（无重复 IO）
    expect(loader.listMetadata()).toBe(first)
  })

  it('setChangeCallback 注册后，磁盘 SKILL.md 变动热重载完成时回调触发', async () => {
    const skillsDir = join(dataRoot, 'skills', 'U1', 'AI1')
    writeSkill(skillsDir, 'cb-skill', 'cb-skill', )
    const loader = new SkillLoader(() => null, join(root, 'config.json'))
    loader.load()
    const cb = vi.fn()
    loader.setChangeCallback(cb)
    loader.startWatching()

    // 修改 SKILL.md（改 frontmatter 版本）→ 防抖后热重载 + 回调
    const fp = join(skillsDir, 'cb-skill', 'SKILL.md')
    writeFileSync(fp, `---
name: cb-skill
description: cb-skill 的描述
version: 2.0.0
---
正文v2
`, 'utf-8')

    await vi.waitFor(
      () => {
        expect(loader.findMetadata('cb-skill')?.version).toBe('2.0.0')
        expect(cb).toHaveBeenCalled()
      },
      { timeout: 3000, interval: 100 }
    )
    loader.stopWatching()
  })
})

/* ============================ 3. skillStore 事件桥 ============================ */

describe('skillStore 技能变更事件桥（skillsChangedAt + 自动重拉）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('主进程广播到达：marks skillsChangedAt 且未在途时自动 refresh', async () => {
    // 动态加载模块：installSkillsChangedBridge 在模块顶层执行且只在 window 就绪时安装，
    // 先注入带 onSkillsChanged 的 window 再 import（静态 import 时序太早，window 不存在会跳过安装）
    vi.resetModules()
    vi.stubGlobal('window', {
      lunareclipse: {
        skill: {
          onSkillsChanged: vi.fn(() => () => {}), // 返回值即取消订阅函数
          list: vi.fn(async () => []),
          status: vi.fn(async () => []),
          errors: vi.fn(async () => [])
        }
      }
    })
    const mod = await import('../src/stores/skillStore')
    const store = mod.useSkillStore
    // 捕获事件桥注册的 handler
    const bridge = (window.lunareclipse.skill.onSkillsChanged as ReturnType<typeof vi.fn>)
    expect(bridge).toHaveBeenCalledTimes(1)
    const handler = bridge.mock.calls[0][0] as () => void

    // 初始时间戳为 0；触发事件 → 时间戳更新 + refresh 被调用（list 重拉）
    expect(store.getState().skillsChangedAt).toBe(0)
    handler()
    await vi.waitFor(() => {
      expect(store.getState().skillsChangedAt).toBeGreaterThan(0)
    })
    await vi.waitFor(() => {
      expect((window.lunareclipse.skill.list as ReturnType<typeof vi.fn>)).toHaveBeenCalled()
    })
  })
})

/* ============================ 4. chatSlice 切 AI 会话 ============================ */

describe('chatSlice：切换不同 AI 归属的会话自动刷新 SKILL 列表', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      lunareclipse: {
        getSession: vi.fn(async (id: string) => session(id, 2)),
        dmnSetActiveSession: vi.fn(),
        todosGet: vi.fn(async () => ({ ok: true, todos: [] })),
        saveMessages: vi.fn(() => Promise.resolve()),
        createSession: vi.fn(async (aiId?: number) => session('new', aiId ?? 1)),
        skill: {
          list: vi.fn(async () => []),
          status: vi.fn(async () => []),
          errors: vi.fn(async () => [])
        }
      }
    })
    // 复位 appStore 到干净基线（currentAiId = 1）
    useAppStore.setState({
      currentSessionId: 's1',
      currentAiId: 1,
      currentMessages: [],
      status: 'idle',
      streamingMessageId: null,
      errorMessage: null,
      sessions: [session('s1', 1)],
      todos: []
    } as Partial<AppState>)
    // 复位 skillStore 状态。不 spy refresh 方法本身（zustand create 组合后属性不可 spy）：
    // 通过观测 refresh 的真实副作用（window.skill.list IPC 是否被调用）验证触发关系。
    useSkillStore.setState({ skills: [], loading: false, error: null, skillsChangedAt: 0 })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('selectSession 切到 AI{2} 归属的会话 → refresh 被调用（列表按新 AI 重拉）', async () => {
    await useAppStore.getState().selectSession('s2')
    // refresh 内部调用 skill.list IPC；切到不同 AI 会话应触发该 IPC
    expect(window.lunareclipse.skill.list).toHaveBeenCalled()
  })

  it('selectSession 切到同一 AI 归属的会话 → 不触发 refresh', async () => {
    ;(window.lunareclipse.getSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(session('s2', 1))
    await useAppStore.getState().selectSession('s2')
    expect(window.lunareclipse.skill.list).not.toHaveBeenCalled()
  })

  it('createSession 指定不同 AI → refresh 被调用', async () => {
    // 先在干净基线验证未触发
    expect(window.lunareclipse.skill.list).not.toHaveBeenCalled()
    ;(window.lunareclipse.createSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(session('new', 2))
    await useAppStore.getState().createSession(2)
    expect(window.lunareclipse.skill.list).toHaveBeenCalled()
  })

  it('createSession 相同 AI（缺省 1）→ 不触发 refresh', async () => {
    await useAppStore.getState().createSession(1)
    expect(window.lunareclipse.skill.list).not.toHaveBeenCalled()
  })
})