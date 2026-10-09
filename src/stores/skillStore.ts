/**
 * 为什么存在：SKILL 面板需要列表/正文/启停/运行时监控一份可订阅的前端状态，
 * 且与主 appStore 域无关，独立 store 承载（对齐 MCP 系统架构）。
 * 作用：持有 SKILL 列表与正文、per-skill 启用状态和运行时状态，经 preload 调用
 * SkillLoader（启用写入 .skills.json 触发热重载）。
 */
import { create } from 'zustand'
import { useSyncExternalStore } from 'react'
import type { SkillMetadata, Skill, SkillRuntimeStatus } from '../../electron/main/skills'

/**
 * SKILL 前端 store（对齐 MCP 系统架构）

 * 职责：
 * 1. 持有 SKILL 列表（元数据）和当前查看的 SKILL 正文
 * 2. 管理 per-skill 启用/禁用状态（写入 .skills.json，触发热重载）
 * 3. 监控运行时状态（使用次数、最后使用时间、加载错误）
 * 4. 通过 preload API 调用主进程 SkillLoader

 * 不做的事：
 * - 不缓存正文（每次 loadSkill 都重新请求， Skills 数量少且按需查看）
 * - 不监听文件变化（SkillLoader 内部热重载后，前端 reload 即可拿到最新列表）
 */

interface SkillState {
  /** SKILL 元数据列表 */
  skills: SkillMetadata[]
  /** 当前查看的 SKILL 正文（null 表示未选中任何 SKILL） */
  currentSkill: Skill | null
  /** 运行时状态（监控用） */
  statuses: SkillRuntimeStatus[]
  /** 加载错误列表 */
  loadErrors: Array<{ filePath: string; error: string }>
  /** 错误信息（UI 提示用） */
  error: string | null
  /** 是否正在加载 */
  loading: boolean
  /** 最近一次技能变更事件时间戳（主进程热重载完成广播；市场等组件订阅它自动重载） */
  skillsChangedAt: number

  // ===== Actions =====
  /** 初始化：加载 SKILL 列表（与 refresh 同语义，供面板挂载时调用） */
  init: () => Promise<void>
  /** 刷新 SKILL 列表（强制重新加载） */
  refresh: () => Promise<void>
  /** 账号切换/登出时清空跨用户残留数据（避免显示上一账号的 SKILL） */
  reset: () => void
  /** 加载指定 SKILL 的正文 */
  loadSkill: (name: string) => Promise<void>
  /** 清除当前查看的 SKILL（返回列表视图） */
  clearCurrent: () => void
  /** 清除错误 */
  clearError: () => void
  /** 启用/禁用 SKILL */
  toggleSkill: (name: string, enabled: boolean) => Promise<void>
  /** 删除 SKILL（仅限 user / project 来源） */
  deleteSkill: (name: string) => Promise<boolean>
  /** 手动重载所有 SKILL */
  reloadSkills: () => Promise<void>
  /** 加载运行时状态 */
  loadStatuses: () => Promise<void>
  /** 加载错误列表 */
  fetchErrors: () => Promise<void>
}

const skillStore = create<SkillState>((set, get) => ({
  skills: [],
  currentSkill: null,
  statuses: [],
  loadErrors: [],
  error: null,
  loading: false,
  skillsChangedAt: 0,

  init: async () => {
    // 为什么删掉 skillsLoaded 防重复标记：
    // 原实现 init 在 skillsLoaded=true 后永久短路，市场安装/更新/卸载、账号切换后
    // 列表数据与磁盘/主进程脱节，界面永远不刷新（列表不显示的根因之一）。
    // 面板每次挂载重新拉取列表，量小且与主进程保持权威一致，无需防重复。
    await get().refresh()
  },

  refresh: async () => {
    set({ loading: true, error: null })
    try {
      if (!window.lunareclipse?.skill?.list) {
        set({ error: 'SKILL API 未就绪' })
        return
      }
      const skills = await window.lunareclipse.skill.list()
      set({ skills })
      void get().loadStatuses()
      void get().fetchErrors()
    } catch (err) {
      set({ error: `加载 SKILL 列表失败: ${(err as Error).message}` })
    } finally {
      set({ loading: false })
    }
  },

  reset: () => {
    // 账号登出/切换/注销时置空全部用户态数据；SKILL 数据按 {uid}/{aiId} 分层，
    // 不随账号动作重置会导致上一账号的技能列表泄漏到下一账号界面。
    set({ skills: [], currentSkill: null, statuses: [], loadErrors: [], error: null, loading: false, skillsChangedAt: 0 })
  },

  loadSkill: async (name: string) => {
    set({ loading: true, error: null })
    try {
      const skill = await window.lunareclipse.skill.get(name)
      if (!skill) {
        set({ error: `未找到 SKILL: ${name}` })
        return
      }
      set({ currentSkill: skill })
    } catch (err) {
      set({ error: `加载 SKILL 正文失败: ${(err as Error).message}` })
    } finally {
      set({ loading: false })
    }
  },

  clearCurrent: () => set({ currentSkill: null }),

  clearError: () => set({ error: null }),

  toggleSkill: async (name: string, enabled: boolean) => {
    try {
      const result = await window.lunareclipse.skill.toggle(name, enabled)
      if (!result.ok) {
        set({ error: `切换 SKILL 状态失败: ${result.error ?? '未知错误'}` })
        return
      }
      // 更新本地状态
      set((state) => ({
        skills: state.skills.map((s) =>
          s.name === name
            ? { ...s, runtime: { ...s.runtime, enabled } }
            : s
        )
      }))
      // 刷新状态
      void get().loadStatuses()
    } catch (err) {
      set({ error: `切换 SKILL 状态失败: ${(err as Error).message}` })
    }
  },

  deleteSkill: async (name: string) => {
    try {
      const result = await window.lunareclipse.skill.delete(name)
      if (!result.ok) {
        set({ error: `删除 SKILL 失败: ${result.error ?? '未知错误'}` })
        return false
      }
      // 从列表中移除
      set((state) => ({
        skills: state.skills.filter((s) => s.name !== name),
        currentSkill: state.currentSkill?.name === name ? null : state.currentSkill
      }))
      void get().loadStatuses()
      return true
    } catch (err) {
      set({ error: `删除 SKILL 失败: ${(err as Error).message}` })
      return false
    }
  },

  reloadSkills: async () => {
    set({ loading: true, error: null })
    try {
      const result = await window.lunareclipse.skill.reload()
      if (!result.ok) {
        set({ error: `重载失败: ${result.error ?? '未知错误'}` })
        return
      }
      // 重新加载列表
      await get().refresh()
    } catch (err) {
      set({ error: `重载 SKILL 失败: ${(err as Error).message}` })
    } finally {
      set({ loading: false })
    }
  },

  loadStatuses: async () => {
    try {
      const statuses = await window.lunareclipse.skill.status()
      set({ statuses })
    } catch (err) {
      console.warn('[skillStore] 加载状态失败:', err)
    }
  },

  fetchErrors: async () => {
    try {
      const errors = await window.lunareclipse.skill.errors()
      set({ loadErrors: errors })
    } catch (err) {
      console.warn('[skillStore] 加载错误列表失败:', err)
    }
  }
}))

// 绕开 zustand useStore 的 useCallback（React 19 组合 bug，
// areHookInputsEqual 收到 undefined deps 崩溃——见 appStore 同款注释）
const useSkillStoreHook = <T>(selector: (s: SkillState) => T): T =>
  useSyncExternalStore(
    skillStore.subscribe,
    () => selector(skillStore.getState()),
    () => selector(skillStore.getInitialState())
  )
export const useSkillStore = Object.assign(useSkillStoreHook, skillStore)

// ===== 技能变更事件桥（主进程热重载完成 → 前端自动刷新） =====
// 主进程 SkillLoader 在磁盘 SKILL 变动（SKILL.md/.skills.json 变化、市场安装/更新/卸载/同步、
// AI 工具经 IPC 写盘等）完成热重载后广播 'skills:changed'；本模块级订阅接收后：
// 1. 更新 skillsChangedAt 时间戳 → 市场 Tab 等订阅组件自动重载；
// 2. 重拉技能列表（refresh 内部先经 skill:list，主进程会按当前 uid/aiId 作用域返回最新数据）。
// 模块级一次注册（guard 防 HMR/重复 import 重复订阅）；preload 未就绪时静默跳过——
// 面板打开时 init() 仍会拉取一次，兜底保证数据一致。
let skillsBridgeInstalled = false
function installSkillsChangedBridge(): void {
  if (skillsBridgeInstalled) return
  if (typeof window === 'undefined') return
  const skillApi = window.lunareclipse?.skill as { onSkillsChanged?: (handler: () => void) => () => void } | undefined
  if (!skillApi?.onSkillsChanged) return
  skillsBridgeInstalled = true
  try {
    skillApi.onSkillsChanged(() => {
      skillStore.setState({ skillsChangedAt: Date.now() })
      // loading 中（疲劳刷新竞态）跳过本次：在途请求返回后数据即最新
      if (!skillStore.getState().loading) void skillStore.getState().refresh()
    })
  } catch (err) {
    console.warn('[skillStore] 注册技能变更监听失败:', err)
  }
}
installSkillsChangedBridge()
