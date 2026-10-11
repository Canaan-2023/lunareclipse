import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { PluginLoader } from '../electron/main/plugins/loader'
import { setPathContext } from '../electron/main/models/path-context'
import { parsePromptSections } from '../electron/main/plugins/module-prompts'
import { kernelRegistry } from '../electron/main/kernel/registry'
import { HookManager } from '../electron/main/hooks/hook-manager'

const TEST_ROOT = join(process.cwd(), 'tmp', 'plugin-modules-test-root')
const PLUGINS_DIR = join(TEST_ROOT, 'plugins')

/** 本文件用过的全部插件名（beforeEach 清全局注册残留） */
const ALL_PLUGIN_NAMES = [
  'hook-plugin', 'bad-hook', 'good-hook', 'half-hook',
  'prompt-plugin', 'patch-plugin', 'toggle-plugin', 'dep-a', 'dep-b'
]

beforeEach(() => {
  for (const n of ALL_PLUGIN_NAMES) {
    kernelRegistry.disposeBySource({ kind: 'plugin', pluginName: n })
  }
  rmSync(PLUGINS_DIR, { recursive: true, force: true })
  mkdirSync(PLUGINS_DIR, { recursive: true })
})

function makePlugin(dir: string, files: Record<string, string>): void {
  const dirPath = join(PLUGINS_DIR, dir)
  mkdirSync(dirPath, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dirPath, name), content, 'utf-8')
  }
}

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  kernelRegistry.disposeBySource({ kind: 'plugin', pluginName: 'hook-plugin' })
  kernelRegistry.disposeBySource({ kind: 'plugin', pluginName: 'prompt-plugin' })
  kernelRegistry.disposeBySource({ kind: 'plugin', pluginName: 'patch-plugin' })
})

describe('prompts.md 解析', () => {
  it('按 # 标题分段，段名 slug 化', () => {
    const sections = parsePromptSections('# 我的须知\n\n第一段内容\n\n# 第二段\n\n第二段内容\n')
    expect(sections).toHaveLength(2)
    expect(sections[0].name).toBe('我的须知')
    expect(sections[0].content).toBe('第一段内容')
    expect(sections[1].name).toBe('第二段')
    expect(sections[1].content).toBe('第二段内容')
  })

  it('空标题段被跳过，无有效内容返回空', () => {
    expect(parsePromptSections('# 空段\n\n  \n')).toHaveLength(0)
    expect(parsePromptSections('无标题的文本')).toHaveLength(0)
  })
})

describe('插件 hooks.js 模块', () => {
  it('注册函数 hook → HookManager 触发 → 卸载回滚', async () => {
    makePlugin('hook-plugin', {
      'plugin.json': JSON.stringify({ name: 'hook-plugin', description: 'hook 测试', version: '0.1.0' }),
      'hooks.js': `
        module.exports = {
          name: 'hook-plugin',
          register(reg) {
            reg.registerHook('PreToolUse', async (ctx) => {
              if ((ctx.toolName ?? '').toLowerCase() === 'write') {
                return { action: 'block', message: 'hook-plugin 拦截 write' }
              }
              return { action: 'continue' }
            }, { matcher: 'write' })
            reg.registerHook('PreLLMCall', async () => {
              return { action: 'continue', injectedContext: '来自插件 hook 的注入' }
            })
          }
        }
      `
    })

    setPathContext(TEST_ROOT, () => null)
    const loader = new PluginLoader()
    await loader.reload()
    const plugin = loader.list().find((p) => p.dirName === 'hook-plugin')
    expect(plugin).toBeDefined()
    expect(plugin!.errors).toEqual([])
    expect(plugin!.loadedModules).toContain('hooks.js')
    expect(kernelRegistry.getHandles('hook').length).toBeGreaterThan(0)

    // HookManager 触发：matcher 命中 write → block
    const hm = new HookManager()
    hm.loadHooks([])
    const blockResult = await hm.run('PreToolUse', { toolName: 'write', cwd: TEST_ROOT } as never)
    expect(blockResult.action).toBe('block')
    expect(blockResult.message).toContain('hook-plugin')

    // matcher 未命中 read → continue
    const passResult = await hm.run('PreToolUse', { toolName: 'read', cwd: TEST_ROOT } as never)
    expect(passResult.action).toBe('continue')

    // PascalCase 工具名 + 小写 matcher（真实月蚀工具名形态）→ 大小写不敏感命中
    const pascalResult = await hm.run('PreToolUse', { toolName: 'Write', cwd: TEST_ROOT } as never)
    expect(pascalResult.action).toBe('block')

    // PreLLMCall 注入
    const injectResult = await hm.run('PreLLMCall', { cwd: TEST_ROOT } as never)
    expect(injectResult.injectedContext).toContain('来自插件 hook 的注入')

    // 卸载回滚：destroy 后 hook 不再触发
    loader.destroy()
    expect(kernelRegistry.getHandles('hook').length).toBe(0)
    const afterDestroy = await hm.run('PreToolUse', { toolName: 'write', cwd: TEST_ROOT } as never)
    expect(afterDestroy.action).toBe('continue')
  })

  it('E3: hooks.js register 中途抛错 → 已注册句柄回滚，不残留幽灵 hook', async () => {
    makePlugin('half-hook', {
      'plugin.json': JSON.stringify({ name: 'half-hook', description: '半途抛错', version: '0.1.0' }),
      'hooks.js': `
        module.exports = {
          register(reg) {
            // 先注册一个 hook，再抛错——修复前该句柄泄漏，卸载后仍生效
            reg.registerHook('PreToolUse', async () => ({ action: 'block', message: 'should-not-survive' }), { matcher: 'write' })
            throw new Error('register 中途抛错')
          }
        }
      `
    })

    setPathContext(TEST_ROOT, () => null)
    const loader = new PluginLoader()
    await loader.reload()
    const half = loader.list().find((p) => p.dirName === 'half-hook')
    expect(half!.errors.some((e) => e.includes('hooks.js 加载失败'))).toBe(true)
    // 已注册句柄必须被回滚：无 half-hook 来源的 hook 残留
    expect(kernelRegistry.getBySource('hook', { kind: 'plugin', pluginName: 'half-hook' })).toHaveLength(0)

    // 卸载后 HookManager 不应触发已泄漏的 hook
    const hm = new HookManager()
    hm.loadHooks([])
    const res = await hm.run('PreToolUse', { toolName: 'write', cwd: TEST_ROOT } as never)
    expect(res.action).toBe('continue')
    loader.destroy()
  })

  it('坏 hooks.js（无 register）→ errors 收集，不拖垮其他插件', async () => {
    makePlugin('bad-hook', {
      'plugin.json': JSON.stringify({ name: 'bad-hook', description: '坏模块', version: '0.1.0' }),
      'hooks.js': 'module.exports = { notARegister: true }'
    })
    makePlugin('good-hook', {
      'plugin.json': JSON.stringify({ name: 'good-hook', description: '好模块', version: '0.1.0' }),
      'hooks.js': `
        module.exports = { register(reg) { reg.registerHook('PreToolUse', async () => ({ action: 'continue' }), { matcher: '.*' }) } }
      `
    })

    setPathContext(TEST_ROOT, () => null)
    const loader = new PluginLoader()
    await loader.reload()
    const bad = loader.list().find((p) => p.dirName === 'bad-hook')
    expect(bad!.errors.some((e) => e.includes('register'))).toBe(true)
    const good = loader.list().find((p) => p.dirName === 'good-hook')
    expect(good!.errors).toEqual([])
    expect(good!.loadedModules).toContain('hooks.js')
    loader.destroy()
  })
})

describe('插件 prompts.md / config.patch.json 模块', () => {
  it('prompts.md 注册 prompt 段 → 卸载回滚', async () => {
    makePlugin('prompt-plugin', {
      'plugin.json': JSON.stringify({ name: 'prompt-plugin', description: 'prompt 测试', version: '0.1.0' }),
      'prompts.md': '# 插件须知\n\n使用 my_* 工具时先看插件说明。\n'
    })

    setPathContext(TEST_ROOT, () => null)
    const loader = new PluginLoader()
    await loader.reload()
    const plugin = loader.list().find((p) => p.dirName === 'prompt-plugin')
    expect(plugin!.errors).toEqual([])
    expect(plugin!.loadedModules).toContain('prompts.md')
    const prompts = kernelRegistry.get<{ name: string }>('prompt')
    expect(prompts.some((p) => p.name === '插件须知')).toBe(true)

    loader.destroy()
    expect(kernelRegistry.get('prompt')).toHaveLength(0)
  })

  it('config.patch.json 注册配置覆盖 → 卸载回滚', async () => {
    makePlugin('patch-plugin', {
      'plugin.json': JSON.stringify({ name: 'patch-plugin', description: 'patch 测试', version: '0.1.0' }),
      'config.patch.json': JSON.stringify({ lilith: { toolPolicy: { test_tool: { enabled: true } } } })
    })

    setPathContext(TEST_ROOT, () => null)
    const loader = new PluginLoader()
    await loader.reload()
    const plugin = loader.list().find((p) => p.dirName === 'patch-plugin')
    expect(plugin!.errors).toEqual([])
    expect(plugin!.loadedModules).toContain('config.patch.json')
    const patches = kernelRegistry.get<Record<string, unknown>>('configPatch')
    expect(patches.some((p) => (p as { lilith?: unknown }).lilith)).toBe(true)

    loader.destroy()
    expect(kernelRegistry.get('configPatch')).toHaveLength(0)
  })

  it('setEnabled 禁用回滚内核注册，启用重新加载', async () => {
    makePlugin('toggle-plugin', {
      'plugin.json': JSON.stringify({ name: 'toggle-plugin', description: '开关测试', version: '0.1.0' }),
      'prompts.md': '# 开关段\n\n内容\n'
    })

    setPathContext(TEST_ROOT, () => null)
    const loader = new PluginLoader()
    await loader.reload()
    expect(kernelRegistry.getBySource('prompt', { kind: 'plugin', pluginName: 'toggle-plugin' }).length).toBeGreaterThan(0)

    await loader.setEnabled('toggle-plugin', false)
    expect(kernelRegistry.getBySource('prompt', { kind: 'plugin', pluginName: 'toggle-plugin' })).toHaveLength(0)
    const disabled = loader.list().find((p) => p.dirName === 'toggle-plugin')
    expect(disabled!.enabled).toBe(false)
    expect(disabled!.loadedModules).toEqual([])

    await loader.setEnabled('toggle-plugin', true)
    const enabled = loader.list().find((p) => p.dirName === 'toggle-plugin')
    expect(enabled!.enabled).toBe(true)
    expect(enabled!.loadedModules).toContain('prompts.md')
    expect(kernelRegistry.getBySource('prompt', { kind: 'plugin', pluginName: 'toggle-plugin' }).length).toBeGreaterThan(0)
    loader.destroy()
  })
})

describe('dependsOn 拓扑排序', () => {
  it('被依赖方先加载', async () => {
    makePlugin('dep-b', {
      'plugin.json': JSON.stringify({ name: 'dep-b', description: 'b', version: '0.1.0' })
    })
    makePlugin('dep-a', {
      'plugin.json': JSON.stringify({ name: 'dep-a', description: 'a', version: '0.1.0', dependsOn: ['dep-b'] })
    })

    setPathContext(TEST_ROOT, () => null)
    const loader = new PluginLoader()
    await loader.reload()
    const names = loader.list().map((p) => p.dirName)
    const idxA = names.indexOf('dep-a')
    const idxB = names.indexOf('dep-b')
    expect(idxB).toBeLessThan(idxA)
    loader.destroy()
  })
})
