import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { createRootContext } from '../electron/main/kernel/cordis-runtime'
import { kernelRegistry } from '../electron/main/kernel/registry'
import { setPathContext } from '../electron/main/models/path-context'
import { toCordisPlugin } from '../electron/main/plugins/dialect-adapter'
import { clearDynamicToolMetas, getAllToolMetas } from '../shared/tools/registry'
import type { LoadedPlugin } from '../electron/main/plugins/types'

/**
 * 方言适配层验证（阶段 5 交付件之二，2026-09-21）

 * 语义（与交接文档一致）：
 *   toCordisPlugin(loaded) 把方言插件（plugin.json + tools.js + hooks.js +
 *   prompts.md + config.patch.json + manifest.panel）包装为 Cordis Plugin；
 *   经 ctx.plugin() 挂载时全量注册（工具 meta / hook / prompt / configPatch / 面板），
 *   registry.delete() 卸载时全部副作用可逆回滚。
 * 测试不依赖 loader：LoadedPlugin 手工构造，直接验证 adapter 轨本身
 * （双轨边界：adapter 独立于 loader，不触碰 loader 的 kernelHandles）。
 */

const PLUGIN_NAME = 'demo'
const TEST_ROOT = join(process.cwd(), 'tmp', 'dialect-adapter-test-root')
const PLUGIN_DIR = join(TEST_ROOT, 'plugins', PLUGIN_NAME)

/** 断言 hooks.js 收到 dataRoot（写入 globalThis 的注册证据） */
declare global {
  var __dialectAdapterHookDataRoot: string | undefined
}

function makePluginDir(overrides?: Record<string, unknown>): void {
  writeFileSync(
    join(PLUGIN_DIR, 'plugin.json'),
    JSON.stringify(
      {
        name: PLUGIN_NAME,
        description: '参考实现生态示例插件（方言适配测试）',
        version: '1.0.0',
        tools: [{ id: 'demo_hello', name: '示例工具', description: '打招呼' }],
        ...overrides
      },
      null,
      2
    ),
    'utf-8'
  )
  writeFileSync(
    join(PLUGIN_DIR, 'tools.js'),
    `module.exports = [
      { name: 'demo_hello', description: '打招呼', parameters: [], execute: async () => ({ ok: true }) }
    ]`,
    'utf-8'
  )
  writeFileSync(
    join(PLUGIN_DIR, 'hooks.js'),
    `module.exports = {
      name: 'demo-hook',
      register(reg, ctx) {
        globalThis.__dialectAdapterHookDataRoot = ctx.dataRoot
        reg.registerHook('PreToolUse', async () => ({ action: 'continue' }), { matcher: 'demo_hello' })
        reg.registerCommand({ id: 'demo:exec', description: '示例命令', async run() { return { ok: true } } })
      }
    }`,
    'utf-8'
  )
  writeFileSync(
    join(PLUGIN_DIR, 'prompts.md'),
    '# 适配层须知\n\n当使用 demo_* 工具时，注意适配层注入内容。\n',
    'utf-8'
  )
  writeFileSync(
    join(PLUGIN_DIR, 'config.patch.json'),
    JSON.stringify({ appName: 'demo-patch' }, null, 2),
    'utf-8'
  )
}

function makeLoaded(overrides?: Partial<LoadedPlugin>): LoadedPlugin {
  return {
    dirName: PLUGIN_NAME,
    dirPath: PLUGIN_DIR,
    source: 'user',
    manifest: {
      name: PLUGIN_NAME,
      description: '参考实现生态示例插件（方言适配测试）',
      version: '1.0.0',
      tools: [{ id: 'demo_hello', name: '示例工具', description: '打招呼' }],
      panel: { id: 'demo-panel', title: '示例面板', component: 'demo' }
    },
    tools: [],
    metas: [
      {
        id: 'demo_hello',
        name: '示例工具',
        category: 'plugin',
        description: '打招呼',
        defaultEnabled: true,
        riskLevel: 'low',
        agents: ['frontend'],
        source: 'plugin',
        plugin: PLUGIN_NAME
      }
    ],
    errors: [],
    kernelHandles: [],
    loadedModules: [],
    enabled: true,
    provides: [],
    deps: [],
    panel: { id: 'demo-panel', title: '示例面板', component: 'demo' },
    ...overrides
  }
}

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  mkdirSync(PLUGIN_DIR, { recursive: true })
  setPathContext(TEST_ROOT, () => null)
  clearDynamicToolMetas()
  for (const n of ['demo', 'damaged']) {
    kernelRegistry.disposeBySource({ kind: 'plugin', pluginName: n })
  }
  delete globalThis.__dialectAdapterHookDataRoot
})

afterAll(() => {
  clearDynamicToolMetas()
  for (const n of ['demo', 'damaged']) {
    kernelRegistry.disposeBySource({ kind: 'plugin', pluginName: n })
  }
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe('方言适配层 toCordisPlugin', () => {
  it('ctx.plugin 挂载 → 五类注册全部生效；registry.delete 卸载 → 全部可逆回滚', async () => {
    makePluginDir()
    const ctx = createRootContext()
    const cordisPlugin = toCordisPlugin(makeLoaded())

    // 挂载前：无该插件任何痕迹
    expect(getAllToolMetas().find((m) => m.id === 'demo_hello')).toBeUndefined()
    expect(kernelRegistry.getHandles('hook')).toHaveLength(0)
    expect(kernelRegistry.get('prompt').length).toBe(0)
    expect(kernelRegistry.get('configPatch').length).toBe(0)
    expect(kernelRegistry.get('panel').length).toBe(0)

    // 挂载（async apply 内的 loadHooksModule 动态 import 完成后返回）
    await ctx.plugin(cordisPlugin)
    await new Promise((r) => setTimeout(r, 20))

    // 1) 工具 meta 注册进统一工具池
    const meta = getAllToolMetas().find((m) => m.id === 'demo_hello')
    expect(meta).toBeDefined()
    expect(meta?.source).toBe('plugin')
    expect(meta?.plugin).toBe(PLUGIN_NAME)

    // 2) hooks.js 注册：register 收到 dataRoot（= {dataRoot}/plugins，与 loader 一致）
    expect(globalThis.__dialectAdapterHookDataRoot).toBe(join(TEST_ROOT, 'plugins'))
    const hooks = kernelRegistry.getHandles('hook')
    expect(hooks.length).toBeGreaterThan(0)
    expect(kernelRegistry.get('command').some((c: { id: string }) => c.id === 'demo:exec')).toBe(true)

    // 3) prompts.md 分段注入
    expect(kernelRegistry.get('prompt').some((p: { name: string }) => p.name === '适配层须知')).toBe(true)

    // 4) config.patch.json 配置覆盖
    expect(kernelRegistry.get('configPatch')).toEqual([{ appName: 'demo-patch' }])

    // 5) 面板声明注册
    expect(kernelRegistry.get('panel')).toEqual([
      { id: 'demo-panel', title: '示例面板', icon: 'LayoutGrid', component: 'demo' }
    ])

    // 卸载：fiber dispose 逆序回滚全部句柄 + 注销工具 meta
    ctx.registry.delete(cordisPlugin)
    await new Promise((r) => setTimeout(r, 20))

    expect(getAllToolMetas().find((m) => m.id === 'demo_hello')).toBeUndefined()
    expect(kernelRegistry.getHandles('hook')).toHaveLength(0)
    expect(kernelRegistry.get('command').some((c: { id: string }) => c.id === 'demo:exec')).toBe(false)
    expect(kernelRegistry.get('prompt')).toHaveLength(0)
    expect(kernelRegistry.get('configPatch')).toHaveLength(0)
    expect(kernelRegistry.get('panel')).toHaveLength(0)
  })

  it('无模块声明（仅 plugin.json + tools.js）也能挂载回滚，不产生噪音注册', async () => {
    writeFileSync(
      join(PLUGIN_DIR, 'plugin.json'),
      JSON.stringify({ name: PLUGIN_NAME, description: '最小插件', version: '1.0.0' }, null, 2),
      'utf-8'
    )
    // 不写 hooks.js / prompts.md / config.patch.json / panel
    const ctx = createRootContext()
    const cordisPlugin = toCordisPlugin(makeLoaded({ panel: undefined }))

    await ctx.plugin(cordisPlugin)
    await new Promise((r) => setTimeout(r, 20))

    // 工具 meta 仍在（tools.js 存在）
    expect(getAllToolMetas().find((m) => m.id === 'demo_hello')).toBeDefined()
    // 其余四项均无注册
    expect(kernelRegistry.getHandles('hook')).toHaveLength(0)
    expect(kernelRegistry.get('prompt')).toHaveLength(0)
    expect(kernelRegistry.get('configPatch')).toHaveLength(0)
    expect(kernelRegistry.get('panel')).toHaveLength(0)

    ctx.registry.delete(cordisPlugin)
    await new Promise((r) => setTimeout(r, 20))
    expect(getAllToolMetas().find((m) => m.id === 'demo_hello')).toBeUndefined()
  })

  it('坏模块软失败不中断：hooks.js 损坏 → 其余模块照常注册，卸载仍全部回滚', async () => {
    // 独立坏插件目录（vitest 对同路径动态 import 有模块缓存，坏 hooks.js 必须用独立目录
    // 才能绕过此前用例对好版本 hooks.js 的缓存，模拟真实场景中各自的插件目录）
    const BAD_NAME = 'damaged'
    const badDir = join(TEST_ROOT, 'plugins', BAD_NAME)
    mkdirSync(badDir, { recursive: true })
    writeFileSync(
      join(badDir, 'plugin.json'),
      JSON.stringify({ name: BAD_NAME, description: '坏模块插件', version: '1.0.0' }, null, 2),
      'utf-8'
    )
    writeFileSync(join(badDir, 'hooks.js'), `module.exports = { broken: true } // 无 register 函数`, 'utf-8')
    writeFileSync(join(badDir, 'prompts.md'), '# 坏模块测试\n\nprompt 仍应注入。\n', 'utf-8')
    const badLoaded: LoadedPlugin = {
      dirName: BAD_NAME,
      dirPath: badDir,
      source: 'user',
      manifest: { name: BAD_NAME, description: '坏模块插件', version: '1.0.0' },
      tools: [],
      metas: [],
      errors: [],
      kernelHandles: [],
      loadedModules: [],
      enabled: true,
      provides: [],
      deps: []
    }
    const warnSpy = { warned: false }
    const ctx = createRootContext()
    const cordisPlugin = toCordisPlugin(badLoaded)
    // 捕获 ctx.logger.warn（软失败告警不中断）：LoggerService 广播给 exporters，
    // 但默认阈值 INFO 会跳过 warn(2)，须显式 levels.default=3 接收全部级别
    ctx.logger.exporter({
      levels: { default: 3 },
      export: (msg) => {
        if (msg.type === 'warn') warnSpy.warned = true
      }
    })

    await ctx.plugin(cordisPlugin)
    await new Promise((r) => setTimeout(r, 20))

    // 坏 hooks.js → 打 warn（exporter 捕获到 warn 消息），不 throw、不中断
    expect(warnSpy.warned).toBe(true)
    // prompts 照常注入
    expect(kernelRegistry.get('prompt').some((p: { name: string }) => p.name === '坏模块测试')).toBe(true)

    ctx.registry.delete(cordisPlugin)
    await new Promise((r) => setTimeout(r, 20))
    expect(kernelRegistry.get('prompt')).toHaveLength(0)
  })
})