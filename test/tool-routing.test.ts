import { describe, it, expect } from 'vitest'
import { createToolRegistry } from '../electron/main/tools/index'
import { getFrontendTools, isToolEnabled } from '../shared/tools/registry'

/**
 * 工具注册与路由诊断（onDemand 两步机制已退役，2026-08-08：
 * 统一直接注入模式，所有启用工具的 schema 直接进 prompt）
 */
describe('工具注册与路由诊断', () => {
  it('直接注入模式：toolExecutors 包含所有启用工具，且无 call_tool/tool_info 机制入口', () => {
    const reg = createToolRegistry({}, {
      toolsPolicy: {}
    })
    const names = Array.from(reg.tools.keys()).sort()
    console.log('toolExecutors:', names)
    // 机制入口已退役，不应出现
    expect(names).not.toContain('call_tool')
    expect(names).not.toContain('tool_info')
    // 应该直接包含 web_search, Read 等启用工具
    expect(names).toContain('web_search')
    expect(names).toContain('Read')
  })

  it('defaultEnabled=false 的工具默认不注册', () => {
    const reg = createToolRegistry({}, {
      toolsPolicy: {}
    })
    const names = Array.from(reg.tools.keys())
    console.log('默认禁用的工具未注册:', [
      'DeleteFile', 'run_command', 'launch_app', 'system_setting', 'clipboard'
    ].filter(n => !names.includes(n)))
    expect(names).not.toContain('DeleteFile')
    expect(names).not.toContain('run_command')
  })

  it('visible 条件：webSearchEnabled=false 时 web_search 不注入（关闭联网后 AI 完全看不到）', () => {
    const reg = createToolRegistry({}, {
      toolsPolicy: {},
      config: { webSearchEnabled: false }
    })
    const names = Array.from(reg.tools.keys())
    expect(names).not.toContain('web_search')
    // 其他工具不受影响
    expect(names).toContain('Read')
  })

  it('visible 条件：默认（未配置或 webSearchEnabled=true）web_search 可见', () => {
    const reg = createToolRegistry({}, {
      toolsPolicy: {},
      config: { webSearchEnabled: true }
    })
    const names = Array.from(reg.tools.keys())
    expect(names).toContain('web_search')
  })

  it('system prompt 列出的工具数 == toolExecutors 实际数（直接注入无差距）', () => {
    // 工具池实际注入数（createToolRegistry 应用了 visible 条件：webSearchEnabled/imageGen 等）
    const reg = createToolRegistry({}, { toolsPolicy: {} })
    const executorCount = reg.tools.size

    // system prompt 会列出的工具数（getFrontendTools 过滤后 + visible 条件，机制工具不再列出）
    const promptTools = getFrontendTools().filter(t => {
      if (t.isMechanism) return false // 机制工具已退役，不列出
      if (!isToolEnabled(t.id, {})) return false
      // 与 createToolRegistry 一致：visible 条件不满足时不暴露
      if (t.visible && !t.visible(undefined)) return false
      return true
    })

    console.log('toolExecutors 数:', executorCount)
    console.log('system prompt 列出数:', promptTools.length)
    console.log('差距:', promptTools.length - executorCount, '（应为 0：AI 看到的都能调）')
    expect(promptTools.length).toBe(executorCount)
  })
})
