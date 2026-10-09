import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { PluginLoader } from '../electron/main/plugins/loader'
import { setPathContext } from '../electron/main/models/path-context'
import { kernelRegistry } from '../electron/main/kernel'
import type { PanelDef, CommandDef } from '../electron/main/kernel/extension'
import { clearDynamicToolMetas } from '../shared/tools/registry'

/**
 * 插件加载器集成测试：panel/command 注册 + 禁用插件回滚 + 启用/禁用切换。

 * 重点覆盖之前发现的运行时 bug：禁用插件的内核模块（hooks/prompts/panel）
 * 在 reload 后仍激活——Phase C 回滚补丁的回归测试。
 */

const TEST_ROOT = join(process.cwd(), 'tmp', 'plugin-loader-integration')
const PLUGINS_DIR = join(TEST_ROOT, 'plugins')

afterAll(() => {
  clearDynamicToolMetas()
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

/** 创建一个带 panel + hooks（command）的插件 */
function makePanelPlugin(dirName: string, panelId: string, commandId: string): string {
  const dir = join(PLUGINS_DIR, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({
      name: dirName,
      description: '面板+命令插件',
      version: '1.0.0',
      panel: { id: panelId, title: `面板-${panelId}`, icon: 'BookOpenText', component: 'test-component' }
    }),
    'utf-8'
  )
  // hooks.js 用 ESM 格式（bundled 目录 package.json type=module）
  // 测试目录下无 package.json type=module，用 .cjs 保证 CJS 兼容
  // 但 module-hooks.ts 只认 hooks.js 文件名——所以用 ESM 语法，靠 vitest 环境 Node ESM 支持
  writeFileSync(
    join(dir, 'hooks.js'),
    `export default {
      name: '${dirName}-commands',
      register(reg, ctx) {
        reg.registerCommand({
          id: '${commandId}',
          description: '测试命令',
          async run(args) {
            return { ok: true, data: { echo: args[0] ?? 'none' } }
          }
        })
      }
    }`,
    'utf-8'
  )
  return dir
}

/** 创建一个纯工具插件（无 panel/hooks） */
function makeToolPlugin(dirName: string): string {
  const dir = join(PLUGINS_DIR, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({
      name: dirName,
      description: '纯工具插件',
      version: '1.0.0',
      tools: [{ id: `${dirName}_tool`, name: '工具', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] }]
    }),
    'utf-8'
  )
  writeFileSync(
    join(dir, 'tools.js'),
    `export default [{ name: '${dirName}_tool', description: '测试', parameters: [], async execute() { return { ok: true } } }]`,
    'utf-8'
  )
  return dir
}

describe('插件加载器集成测试：panel/command 注册 + 禁用回滚', () => {
  let loader: PluginLoader

  beforeEach(() => {
    // 清理测试目录
    rmSync(PLUGINS_DIR, { recursive: true, force: true })
    mkdirSync(PLUGINS_DIR, { recursive: true })
    setPathContext(TEST_ROOT, () => null)
    clearDynamicToolMetas()
  })

  it('panel 声明 → reload 后内核注册表有对应 PanelDef', async () => {
    makePanelPlugin('panel-test', 'testpanel', 'test:cmd')
    loader = new PluginLoader()
    await loader.reload()

    const panels = kernelRegistry.get<PanelDef>('panel')
    const found = panels.find((p) => p.id === 'testpanel')
    expect(found).toBeDefined()
    expect(found!.title).toBe('面板-testpanel')
    expect(found!.icon).toBe('BookOpenText')
    expect(found!.component).toBe('test-component')
    loader.destroy()
  })

  it('command 注册 → reload 后内核注册表有对应 CommandDef', async () => {
    makePanelPlugin('cmd-test', 'cmdpanel', 'cmd:echo')
    loader = new PluginLoader()
    await loader.reload()

    const commands = kernelRegistry.get<CommandDef>('command')
    const cmd = commands.find((c) => c.id === 'cmd:echo')
    expect(cmd).toBeDefined()

    // 验证命令可执行
    const result = await cmd!.run(['hello'], {})
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ echo: 'hello' })
    loader.destroy()
  })

  it('禁用插件 → reload 后内核注册表无该插件的 panel/command（Phase C 回滚验证）', async () => {
    // 插件 A（带 panel+command）+ 插件 B（纯工具）
    makePanelPlugin('disabled-panel', 'disabledp', 'disabled:cmd')
    makeToolPlugin('enabled-tool')

    // 预设 .plugin-state.json：disabled-panel 被禁用
    mkdirSync(PLUGINS_DIR, { recursive: true })
    writeFileSync(
      join(PLUGINS_DIR, '.plugin-state.json'),
      JSON.stringify({ 'user:disabled-panel': false }),
      'utf-8'
    )

    loader = new PluginLoader()
    await loader.reload()

    // 禁用插件的 panel 不应在内核注册表中
    const panels = kernelRegistry.get<PanelDef>('panel')
    const disabledPanel = panels.find((p) => p.id === 'disabledp')
    expect(disabledPanel).toBeUndefined()

    // 禁用插件的 command 不应在内核注册表中
    const commands = kernelRegistry.get<CommandDef>('command')
    const disabledCmd = commands.find((c) => c.id === 'disabled:cmd')
    expect(disabledCmd).toBeUndefined()

    // 插件本身在 list 中但 enabled=false
    const plugin = loader.list().find((p) => p.dirName === 'disabled-panel')
    expect(plugin).toBeDefined()
    expect(plugin!.enabled).toBe(false)
    expect(plugin!.kernelHandles).toEqual([])

    loader.destroy()
  })

  it('启用→禁用→再启用：panel/command 随之注册/回滚/重新注册', async () => {
    makePanelPlugin('toggle-test', 'togglep', 'toggle:cmd')
    loader = new PluginLoader()
    await loader.reload()

    // 初始状态：启用，panel+command 在注册表中
    let panels = kernelRegistry.get<PanelDef>('panel')
    expect(panels.find((p) => p.id === 'togglep')).toBeDefined()
    let commands = kernelRegistry.get<CommandDef>('command')
    expect(commands.find((c) => c.id === 'toggle:cmd')).toBeDefined()

    // 禁用 → panel+command 从注册表移除
    await loader.setEnabled('toggle-test', false)
    panels = kernelRegistry.get<PanelDef>('panel')
    expect(panels.find((p) => p.id === 'togglep')).toBeUndefined()
    commands = kernelRegistry.get<CommandDef>('command')
    expect(commands.find((c) => c.id === 'toggle:cmd')).toBeUndefined()

    // 再启用 → panel+command 重新注册
    await loader.setEnabled('toggle-test', true)
    panels = kernelRegistry.get<PanelDef>('panel')
    expect(panels.find((p) => p.id === 'togglep')).toBeDefined()
    commands = kernelRegistry.get<CommandDef>('command')
    expect(commands.find((c) => c.id === 'toggle:cmd')).toBeDefined()

    loader.destroy()
  })

  it('destroy → 所有插件的 panel/command 从内核注册表移除', async () => {
    makePanelPlugin('destroy-test', 'destroyp', 'destroy:cmd')
    loader = new PluginLoader()
    await loader.reload()

    // 确认注册
    let panels = kernelRegistry.get<PanelDef>('panel')
    expect(panels.find((p) => p.id === 'destroyp')).toBeDefined()

    loader.destroy()

    // destroy 后内核注册表无残留
    panels = kernelRegistry.get<PanelDef>('panel')
    expect(panels.find((p) => p.id === 'destroyp')).toBeUndefined()
    const commands = kernelRegistry.get<CommandDef>('command')
    expect(commands.find((c) => c.id === 'destroy:cmd')).toBeUndefined()
  })

  it('热重载：修改 plugin.json panel 声明 → reload 后内核注册表更新', async () => {
    const dir = makePanelPlugin('hotreload-test', 'oldpanel', 'hr:cmd')
    loader = new PluginLoader()
    await loader.reload()

    // 初始 panel id = oldpanel
    let panels = kernelRegistry.get<PanelDef>('panel')
    expect(panels.find((p) => p.id === 'oldpanel')).toBeDefined()

    // 修改 plugin.json：换 panel id
    writeFileSync(
      join(dir, 'plugin.json'),
      JSON.stringify({
        name: 'hotreload-test',
        description: '改了 panel id',
        version: '1.0.0',
        panel: { id: 'newpanel', title: '新面板', icon: 'BookOpenText', component: 'new-component' }
      }),
      'utf-8'
    )

    await loader.reload()

    // 旧 panel 移除，新 panel 注册
    panels = kernelRegistry.get<PanelDef>('panel')
    expect(panels.find((p) => p.id === 'oldpanel')).toBeUndefined()
    const newPanel = panels.find((p) => p.id === 'newpanel')
    expect(newPanel).toBeDefined()
    expect(newPanel!.title).toBe('新面板')
    expect(newPanel!.component).toBe('new-component')

    loader.destroy()
  })
})
