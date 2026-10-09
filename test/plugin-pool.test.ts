import { describe, it, expect, afterEach } from 'vitest'
import { createToolRegistry } from '../electron/main/tools/index'
import { clearDynamicToolMetas, registerPluginToolMetas } from '../shared/tools/registry'

/**
 * 插件工具并入前池测试（2026-08-18 修复）：插件工具由【插件 enabled】整体控制——
 * pluginTools 里的工具不再被 defaultEnabled 二次过滤（否则插件开了、工具仍不可用，如 computer-use）。
 * agents 归属仍生效。
 */
describe('插件工具由插件 enabled 整体控制', () => {
  afterEach(() => clearDynamicToolMetas())

  it('defaultEnabled=false 的插件工具也进入 frontend pool（修复：不被二次过滤）', () => {
    // 模拟 computer-use 插件的 meta 注册（PluginLoader 加载时 registerPluginToolMetas）+ tools
    registerPluginToolMetas([
      { id: 'screen_capture', name: '截屏', category: 'computer', description: 'x', defaultEnabled: false, riskLevel: 'medium', agents: ['frontend'], caps: ['system:input'], source: 'plugin', plugin: 'computer-use' }
    ])
    const fakeTool = {
      name: 'screen_capture',
      description: '截屏',
      parameters: [],
      execute: async () => ({ ok: true, data: { imagePath: 'x.png' } })
    }
    const reg = createToolRegistry({} as never, { pluginTools: [fakeTool as never], agent: 'frontend' })
    expect(reg.tools.has('screen_capture')).toBe(true) // defaultEnabled=false 也进池（修复前 false）
  })

  it('插件工具对 frontend 进池、对 dmn 不进（agents 归属仍生效）', () => {
    registerPluginToolMetas([
      { id: 'mouse_move', name: '移动', category: 'computer', description: 'x', defaultEnabled: false, riskLevel: 'medium', agents: ['frontend'], caps: ['system:input'], source: 'plugin', plugin: 'computer-use' }
    ])
    const fake = { name: 'mouse_move', description: 'x', parameters: [], execute: async () => ({ ok: true, data: {} }) }
    const regF = createToolRegistry({} as never, { pluginTools: [fake as never], agent: 'frontend' })
    expect(regF.tools.has('mouse_move')).toBe(true)
    const regD = createToolRegistry({} as never, { pluginTools: [fake as never], agent: 'dmn' })
    expect(regD.tools.has('mouse_move')).toBe(false) // DMN 不可见（agents=['frontend']）
  })

  it('设置页显式关闭的插件工具不进池（toolsPolicy enabled=false 仍生效，与"不再按 defaultEnabled 过滤"不冲突）', () => {
    registerPluginToolMetas([
      { id: 'browser_press', name: '按键', category: 'browser', description: 'x', defaultEnabled: true, riskLevel: 'medium', agents: ['frontend'], caps: ['browser:input'], source: 'plugin', plugin: 'browser-tools' }
    ])
    const fake = { name: 'browser_press', description: 'x', parameters: [], execute: async () => ({ ok: true, data: {} }) }
    const reg = createToolRegistry({} as never, {
      pluginTools: [fake as never],
      agent: 'frontend',
      toolsPolicy: { browser_press: { enabled: false } }
    })
    expect(reg.tools.has('browser_press')).toBe(false) // 设置页开关真实生效
  })
})
