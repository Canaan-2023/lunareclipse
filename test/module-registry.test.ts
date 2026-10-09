import { describe, it, expect } from 'vitest'
import { MODULE_DEFS, ModuleRegistry } from '../electron/main/monitor/module-registry'

describe('ModuleRegistry 模块注册表', () => {
  it('静态清单覆盖全部架构大类且 id 唯一', () => {
    expect(MODULE_DEFS.length).toBeGreaterThanOrEqual(20)
    const ids = new Set(MODULE_DEFS.map((m) => m.id))
    expect(ids.size).toBe(MODULE_DEFS.length)
    // 六大类都存在
    for (const cat of ['核心', '工具', '记忆系统', '监控', '渲染', '基础设施']) {
      expect(MODULE_DEFS.some((m) => m.category === cat)).toBe(true)
    }
    // 每个模块都有描述和关键文件
    for (const m of MODULE_DEFS) {
      expect(m.description.length).toBeGreaterThan(0)
      expect(m.keyFiles.length).toBeGreaterThan(0)
    }
  })

  it('初始状态全部为 null（未知），无异常上报', () => {
    const reg = new ModuleRegistry()
    const snap = reg.getSnapshot()
    expect(snap).toHaveLength(MODULE_DEFS.length)
    expect(snap.every((s) => s.ok === null && s.error === '' && s.updatedAt === null)).toBe(true)
    expect(reg.failingModuleIds()).toEqual([])
  })

  it('reportIssue 标红对应模块并记录错误摘要', () => {
    const reg = new ModuleRegistry()
    reg.reportIssue('tools', 'npm run typecheck 失败')
    const snap = reg.getSnapshot()
    const tools = snap.find((s) => s.id === 'tools')!
    expect(tools.ok).toBe(false)
    expect(tools.error).toContain('typecheck')
    expect(tools.updatedAt).not.toBeNull()
    expect(reg.failingModuleIds()).toContain('tools')
  })

  it('markRecovered 恢复模块变绿，仅对曾异常的模块生效', () => {
    const reg = new ModuleRegistry()
    reg.reportIssue('main', 'uncaughtException')
    reg.markRecovered('main')
    expect(reg.getSnapshot().find((s) => s.id === 'main')!.ok).toBe(true)

    // 从未异常的模块 markRecovered 不产生状态
    reg.markRecovered('llm')
    expect(reg.getSnapshot().find((s) => s.id === 'llm')!.ok).toBe(null)
  })

  it('未知模块 id 上报被忽略', () => {
    const reg = new ModuleRegistry()
    reg.reportIssue('nonexistent', 'xxx')
    expect(reg.getSnapshot().every((s) => s.ok === null)).toBe(true)
  })

  it('同一模块多次上报保留最近一次错误', () => {
    const reg = new ModuleRegistry()
    reg.reportIssue('ipc', 'err1')
    reg.reportIssue('ipc', 'err2')
    const ipc = reg.getSnapshot().find((s) => s.id === 'ipc')!
    expect(ipc.error).toBe('err2')
    expect(reg.failingModuleIds()).toEqual(['ipc'])
  })
})
