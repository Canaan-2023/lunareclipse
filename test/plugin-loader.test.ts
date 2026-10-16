import { describe, it, expect, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { PluginLoader } from '../electron/main/plugins/loader'
import { setPathContext } from '../electron/main/models/path-context'
import { registerPluginToolMetas, unregisterPluginTools, clearDynamicToolMetas, isToolForAgent, isToolEnabled, type PluginToolMeta } from '../shared/tools/registry'
import { createToolRegistry } from '../electron/main/tools/index'

/** 临时插件根目录（测试专用，不碰真实 abyssac_data）。
 * 注意：PluginLoader 的约定是 dataRoot/plugins/ 下放插件目录，测试按此结构建目录 */
const TEST_ROOT = join(process.cwd(), 'tmp', 'plugin-test-root')
const PLUGINS_DIR = join(TEST_ROOT, 'plugins')

afterAll(() => {
  clearDynamicToolMetas()
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe('插件系统：加载 + 注册 + 工具池注入', () => {
  it('ESM tools.js 加载 → execute 可用', async () => {
    const dir = join(PLUGINS_DIR, 'esm-plugin')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'plugin.json'),
      JSON.stringify({
        name: 'esm-plugin',
        description: 'ESM 插件',
        version: '0.1.0',
        tools: [{ id: 'esm_hello', name: '你好', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] }]
      }),
      'utf-8'
    )
    writeFileSync(
      join(dir, 'tools.js'),
      `export default [{ name: 'esm_hello', description: '测试', parameters: [], async execute() { return { ok: true, data: 'hello' } } }]`,
      'utf-8'
    )

    setPathContext(TEST_ROOT, () => null)
    const loader = new PluginLoader()
    await loader.reload()
    const plugins = loader.list()
    const esm = plugins.find((p) => p.dirName === 'esm-plugin')
    expect(esm).toBeDefined()
    expect(esm!.tools.length).toBe(1)
    expect(esm!.errors).toEqual([])

    const res = await esm!.tools[0].execute({}, undefined)
    expect(res.ok).toBe(true)
    expect(res.data).toBe('hello')
    loader.destroy()
  })

  it('CJS tools.js 也能加载（无 type 字段环境兼容）', async () => {
    // 即使 package.json type=module，用 .cjs 后缀就是 CJS
    const dir = join(TEST_ROOT, 'cjs-plugin')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'plugin.json'),
      JSON.stringify({ name: 'cjs-plugin', description: 'CJS 插件', version: '0.1.0' }),
      'utf-8'
    )
    writeFileSync(
      join(dir, 'tools.cjs'),
      `module.exports = [{ name: 'cjs_hello', description: '测试', parameters: [], async execute() { return { ok: true, data: 'cjs' } } }]`,
      'utf-8'
    )

    // 直接 require .cjs 验证 CJS 格式可加载（PluginLoader 目前只认 tools.js，这里验证格式本身）
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 刻意验证 CJS 模块可被 require 加载
    const mod = require(join(dir, 'tools.cjs')) as Array<{ name: string; execute: () => Promise<{ ok: boolean; data: string }> }>
    expect(mod.length).toBe(1)
    const r = await mod[0].execute()
    expect(r.data).toBe('cjs')
  })

  it('元数据注册 → isToolForAgent/isToolEnabled 可判定', () => {
    clearDynamicToolMetas()
    const meta: PluginToolMeta = {
      id: 'plugin_tool_a',
      name: '插件工具A',
      category: 'plugin',
      description: '测试',
      defaultEnabled: true,
      riskLevel: 'low',
      agents: ['frontend'],
      source: 'plugin',
      plugin: 'test-plugin'
    }
    registerPluginToolMetas([meta])

    expect(isToolForAgent('plugin_tool_a', 'frontend')).toBe(true)
    expect(isToolForAgent('plugin_tool_a', 'dmn')).toBe(false)
    expect(isToolEnabled('plugin_tool_a', {})).toBe(true)

    // 卸载后不可判定
    unregisterPluginTools('test-plugin')
    expect(isToolForAgent('plugin_tool_a', 'frontend')).toBe(false)
  })

  it('createToolRegistry 注入插件工具（前端池可见）', () => {
    clearDynamicToolMetas()
    registerPluginToolMetas([
      {
        id: 'plugin_tool_b',
        name: '插件工具B',
        category: 'plugin',
        description: '测试',
        defaultEnabled: true,
        riskLevel: 'low',
        agents: ['frontend'],
        source: 'plugin',
        plugin: 'test-plugin-2'
      }
    ])
    const pluginTool = {
      name: 'plugin_tool_b',
      description: '测试',
      parameters: [],
      execute: async () => ({ ok: true, data: 'b' })
    }

    const reg = createToolRegistry({}, { pluginTools: [pluginTool] })
    const tool = reg.tools.get('plugin_tool_b')
    expect(tool).toBeDefined()
    expect(tool?.name).toBe('plugin_tool_b')

    // DMN 池不可见（agents 只有 frontend）
    const dmnReg = createToolRegistry({ dmnId: 'memory-workflow' }, { pluginTools: [pluginTool] })
    expect(dmnReg.tools.has('plugin_tool_b')).toBe(false)
    clearDynamicToolMetas()
  })

  it('manifest 声明了但 tools.js 缺工具 → 报错不崩溃', async () => {
    const dir = join(PLUGINS_DIR, 'bad-plugin')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'plugin.json'),
      JSON.stringify({
        name: 'bad-plugin',
        description: '声明两个工具但只导出一个',
        version: '0.1.0',
        tools: [
          { id: 'ok_tool', name: 'OK' },
          { id: 'missing_tool', name: '缺失' }
        ]
      }),
      'utf-8'
    )
    writeFileSync(join(dir, 'tools.js'), `export default [{ name: 'ok_tool', description: 'x', parameters: [], async execute() { return { ok: true } } }]`, 'utf-8')

    setPathContext(TEST_ROOT, () => null)
    const loader = new PluginLoader()
    await loader.reload()
    const plugins = loader.list()
    const bad = plugins.find((p) => p.dirName === 'bad-plugin')
    expect(bad).toBeDefined()
    expect(bad!.errors.some((e) => e.includes('missing_tool'))).toBe(true)
    expect(bad!.tools.length).toBe(1) // 成功的工具仍加载
    loader.destroy()
  })

  it('事务化 reload：全量重载后新插件并入、旧插件 meta 正确替换（原子提交）', async () => {
    clearDynamicToolMetas()
    // 插件 A：先加载
    const dirA = join(PLUGINS_DIR, 'txn-plugin-a')
    mkdirSync(dirA, { recursive: true })
    writeFileSync(join(dirA, 'plugin.json'), JSON.stringify({ name: 'txn-a', description: 'A', version: '0.1.0' }), 'utf-8')
    writeFileSync(join(dirA, 'tools.js'), `export default [{ name: 'txn_a_tool', description: 'A工具', parameters: [], async execute() { return { ok: true, data: 'a' } } }]`, 'utf-8')

    setPathContext(TEST_ROOT, () => null)
    const loader = new PluginLoader()
    await loader.reload()
    // A 的 meta 已注册（isToolForAgent 可见）
    const metasA = loader.list().find((p) => p.dirName === 'txn-plugin-a')
    expect(metasA).toBeDefined()

    // 插件 B：reload 前新增，形成"一批新加载"
    const dirB = join(PLUGINS_DIR, 'txn-plugin-b')
    mkdirSync(dirB, { recursive: true })
    writeFileSync(join(dirB, 'plugin.json'), JSON.stringify({ name: 'txn-b', description: 'B', version: '0.1.0' }), 'utf-8')
    writeFileSync(join(dirB, 'tools.js'), `export default [{ name: 'txn_b_tool', description: 'B工具', parameters: [], async execute() { return { ok: true, data: 'b' } } }]`, 'utf-8')

    await loader.reload()
    const after = loader.list()
    // 原子提交后：A、B 都在（含可能的内置插件，不硬编码数量）
    expect(after.some((p) => p.dirName === 'txn-plugin-a')).toBe(true)
    expect(after.some((p) => p.dirName === 'txn-plugin-b')).toBe(true)
    const b = after.find((p) => p.dirName === 'txn-plugin-b')
    expect(b).toBeDefined()
    expect(b!.errors).toEqual([])
    expect(b!.tools.length).toBe(1)
    const res = await b!.tools[0].execute({}, undefined)
    expect(res.ok).toBe(true)
    expect(res.data).toBe('b')
    // A 的工具仍可用（旧插件在 reload 后保留 + meta 重新注册）
    const a = after.find((p) => p.dirName === 'txn-plugin-a')
    const resA = await a!.tools[0].execute({}, undefined)
    expect(resA.data).toBe('a')
    loader.destroy()
    clearDynamicToolMetas()
  })

  it('软失败插件（errors）不中止其它插件加载（坏插件不拖垮整批）', async () => {
    clearDynamicToolMetas()
    // 好插件 + 坏插件（tools.js 语法错误）并存
    const goodDir = join(PLUGINS_DIR, 'good-plugin')
    mkdirSync(goodDir, { recursive: true })
    writeFileSync(join(goodDir, 'plugin.json'), JSON.stringify({ name: 'good', description: 'G', version: '0.1.0' }), 'utf-8')
    writeFileSync(join(goodDir, 'tools.js'), `export default [{ name: 'good_tool', description: 'G', parameters: [], async execute() { return { ok: true, data: 'good' } } }]`, 'utf-8')

    const brokenDir = join(PLUGINS_DIR, 'broken-plugin')
    mkdirSync(brokenDir, { recursive: true })
    writeFileSync(join(brokenDir, 'plugin.json'), JSON.stringify({ name: 'broken', description: 'B', version: '0.1.0' }), 'utf-8')
    writeFileSync(join(brokenDir, 'tools.js'), `module.exports = { broken`) // 语法错误

    setPathContext(TEST_ROOT, () => null)
    const loader = new PluginLoader()
    await loader.reload()
    const list = loader.list()
    // 坏插件带 errors，好插件正常加载 —— reload 不中断
    const good = list.find((p) => p.dirName === 'good-plugin')
    expect(good).toBeDefined()
    expect(good!.errors).toEqual([])
    expect(good!.tools.length).toBe(1)
    const broken = list.find((p) => p.dirName === 'broken-plugin')
    expect(broken).toBeDefined()
    expect(broken!.errors.length).toBeGreaterThan(0)
    loader.destroy()
    clearDynamicToolMetas()
  })

  it('E2: 坏 plugin.json（语法错误）→ 软失败记 errors，不整批回滚热重载', async () => {
    clearDynamicToolMetas()
    // 坏 manifest + 好插件并存：坏的不该让 reload() 回滚整批
    const badDir = join(PLUGINS_DIR, 'broken-manifest')
    mkdirSync(badDir, { recursive: true })
    writeFileSync(join(badDir, 'plugin.json'), '{ "name": "broken-manifest", "version": "0.1.0", ', 'utf-8') // 语法错误
    writeFileSync(join(badDir, 'tools.js'), `export default [{ name: 'bm_tool', description: 'x', parameters: [], async execute() { return { ok: true } } }]`, 'utf-8')

    const goodDir = join(PLUGINS_DIR, 'good-manifest')
    mkdirSync(goodDir, { recursive: true })
    writeFileSync(join(goodDir, 'plugin.json'), JSON.stringify({ name: 'good-manifest', description: 'G', version: '0.1.0' }), 'utf-8')
    writeFileSync(join(goodDir, 'tools.js'), `export default [{ name: 'gm_tool', description: 'G', parameters: [], async execute() { return { ok: true, data: 'gm' } } }]`, 'utf-8')

    setPathContext(TEST_ROOT, () => null)
    const loader = new PluginLoader()
    await loader.reload()
    const list = loader.list()
    // 好插件照常加载
    const good = list.find((p) => p.dirName === 'good-manifest')
    expect(good).toBeDefined()
    expect(good!.errors).toEqual([])
    expect(good!.tools.length).toBe(1)
    // 坏插件软失败：errors 有解析失败记录，且名字兜底为目录名
    const bad = list.find((p) => p.dirName === 'broken-manifest')
    expect(bad).toBeDefined()
    expect(bad!.errors.some((e) => e.includes('plugin.json 解析失败'))).toBe(true)
    expect(bad!.manifest.name).toBe('broken-manifest')
    loader.destroy()
    clearDynamicToolMetas()
  })

  it('E2: toposort 中坏 plugin.json（dependsOn 场景）不中断排序加载', async () => {
    clearDynamicToolMetas()
    // provider 正常；依赖方 manifest 语法错误（dependsOn 解析失败视为无依赖）
    const badDepDir = join(PLUGINS_DIR, 'bad-dep-on')
    mkdirSync(badDepDir, { recursive: true })
    writeFileSync(join(badDepDir, 'plugin.json'), '{ "name": "bad-dep-on", "dependsOn": [', 'utf-8')
    writeFileSync(join(badDepDir, 'tools.js'), `export default [{ name: 'bd_tool', description: 'x', parameters: [], async execute() { return { ok: true } } }]`, 'utf-8')

    const pDir = join(PLUGINS_DIR, 'dep-provider')
    mkdirSync(pDir, { recursive: true })
    writeFileSync(join(pDir, 'plugin.json'), JSON.stringify({ name: 'dep-provider', version: '0.1.0' }), 'utf-8')

    setPathContext(TEST_ROOT, () => null)
    const loader = new PluginLoader()
    await loader.reload()
    const list = loader.list()
    expect(list.some((p) => p.dirName === 'bad-dep-on')).toBe(true)
    expect(list.some((p) => p.dirName === 'dep-provider')).toBe(true)
    loader.destroy()
    clearDynamicToolMetas()
  })

  it('coeffect deps 校验：依赖缺失记警告、服务已提供则无（2026-08-18）', async () => {
    clearDynamicToolMetas()
    const dirs = {
      provider: join(PLUGINS_DIR, 'co-provider'),
      consumer: join(PLUGINS_DIR, 'co-consumer'),
      missing: join(PLUGINS_DIR, 'co-missing')
    }
    // 提供方：hooks.js 里 reg.provide('greeting')
    mkdirSync(dirs.provider, { recursive: true })
    writeFileSync(join(dirs.provider, 'plugin.json'), JSON.stringify({ name: 'co-provider', version: '0.1.0', provides: ['greeting'] }), 'utf-8')
    writeFileSync(join(dirs.provider, 'hooks.js'), `module.exports = { register(reg) { reg.provide('greeting', 'hifromprovider') } }`, 'utf-8')

    // 消费方：deps ['greeting']
    mkdirSync(dirs.consumer, { recursive: true })
    writeFileSync(join(dirs.consumer, 'plugin.json'), JSON.stringify({ name: 'co-consumer', version: '0.1.0', deps: ['greeting'] }), 'utf-8')

    // 缺依赖方：deps ['nonexistent-svc']
    mkdirSync(dirs.missing, { recursive: true })
    writeFileSync(join(dirs.missing, 'plugin.json'), JSON.stringify({ name: 'co-missing', version: '0.1.0', deps: ['nonexistent-svc'] }), 'utf-8')

    setPathContext(TEST_ROOT, () => null)
    const loader = new PluginLoader()
    await loader.reload()
    const list = loader.list()
    const consumer = list.find((p) => p.dirName === 'co-consumer')
    const missing = list.find((p) => p.dirName === 'co-missing')
    // 提供方已 provide → consumer 无 deps 警告
    expect(consumer).toBeDefined()
    expect(consumer!.errors.every((e) => !e.includes('依赖的 coeffect'))).toBe(true)
    // 缺依赖 → missing 有警告
    expect(missing).toBeDefined()
    expect(missing!.errors.some((e) => e.includes('nonexistent-svc'))).toBe(true)
    loader.destroy()
    clearDynamicToolMetas()
  })
})
