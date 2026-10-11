import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRootContext } from '../electron/main/kernel/cordis-runtime'
import { PluginLoader } from '../electron/main/plugins/loader'
import { setPathContext } from '../electron/main/models/path-context'
import { mountCordisPlugins } from '../electron/main/plugins/cordis-mounter'

/**
 * Cordis 模块挂载器：entry 级 isolate/intercept 声明验证。

 * 对齐 Cordis loader entry 协议：plugin.json 的 cordis.isolate / cordis.intercept
 * 声明 → mounter 挂载前派生 ctx（ctx.isolate / ctx.intercept）→ 插件在隔离
 * 作用域内 provide/get 同名服务不影响父级；拦截配置按祖先优先合并。

 * 断言分三层：
 *   - isolate：挂载 ctx 的 isolate map 键已归一为稳定 symbol，且同名 label
 *     跨插件 join 同一作用域（Symbol.for 归一化保证）；
 *   - intercept：挂载 ctx 的 intercept map 含声明键，值原样透传；
 *   - 缺省：不声明时 mountCtx === rootCtx 语义（行为零变化回归保护）。

 * 注意：每个用例自建插件目录，避免公共插件污染（挂载顺序 → apply 记录覆盖）。
 */

// 供入口文件写入挂载证据（ESM 插件模块与测试进程共享 globalThis；
// Context 的 isolate/intercept 是全局注册 symbol，可用 Symbol.for 取到）
declare global {
  var __cordisScopeTest: {
    isolateMap: Record<string, symbol>
    interceptMap: Record<string, unknown>
    demoFromRoot: unknown
    demoFromScoped: unknown
  } | undefined
}

let tmpRoot: string
let loader: PluginLoader

beforeEach(() => {
  tmpRoot = join(tmpdir(), `cordis-scope-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  setPathContext(tmpRoot, () => null)
  delete globalThis.__cordisScopeTest
})

afterEach(() => {
  // fs.watch 持有目录句柄，Windows 下无法删除——留给系统 tmp 清理
})

/** 创建一个 Cordis 插件目录（plugin.json + index.js），返回插件名 */
function makeCordisPlugin(dirName: string, cordisField: Record<string, unknown>, applyBody: string): void {
  mkdirSync(join(tmpRoot, 'plugins', dirName), { recursive: true })
  writeFileSync(
    join(tmpRoot, 'plugins', dirName, 'plugin.json'),
    JSON.stringify({
      name: dirName,
      description: 'scope 测试插件',
      version: '1.0.0',
      cordis: { entry: 'index.js', ...cordisField }
    }),
    'utf8'
  )
  writeFileSync(
    join(tmpRoot, 'plugins', dirName, 'index.js'),
    `export default {
  name: '${dirName}',
  inject: [],
  apply(ctx) {
    ${applyBody}
  }
}`,
    'utf8'
  )
}

describe('Cordis 模块挂载器：entry 级 isolate/intercept 声明（G1）', () => {
  it('isolate 声明派生挂载 ctx：插件在隔离 realm 提供同名服务不影响 root 绑定', async () => {
    // 先建立唯一插件 plug-isolated（isolate 声明）
    makeCordisPlugin(
      'plug-isolated',
      { isolate: { demo: 'scoped' } },
      `ctx.provide('demo', 'scoped-value')
       globalThis.__cordisScopeTest = {
         isolateMap: Object.fromEntries(Object.entries(ctx[Symbol.for('cordis.isolate')] || {})),
         interceptMap: ctx[Symbol.for('cordis.intercept')] || {},
         demoFromRoot: undefined,
         // 非 strict 读取：apply 阶段自身 fiber 尚在 LOADING，strict get 会因
         // fiber.state !== ACTIVE 返回 undefined；非 strict 直接读 impl.value
         demoFromScoped: ctx.get('demo', false),
       }`
    )

    // 先在 rootCtx 提供 demo（模拟已存在的父级服务）
    const ctx = createRootContext()
    ctx.provide('demo', 'root-value')

    loader = new PluginLoader()
    await loader.reload()
    const detach = await mountCordisPlugins(ctx, loader)
    await new Promise((r) => setTimeout(r, 50))

    // 1) 挂载 ctx 的 isolate map 含 demo → 归一化 symbol（Symbol.for 保证跨插件 join）
    expect(__cordisScopeTest).toBeDefined()
    expect(Object.keys(__cordisScopeTest!.isolateMap)).toContain('demo')
    expect(__cordisScopeTest!.isolateMap['demo']).toBe(Symbol.for('cordis:isolate:demo:scoped'))

    // 2) 隔离作用域内 get('demo') 解析到 scope 内提供的值（σ(ρ) 分层可见）
    expect(__cordisScopeTest!.demoFromScoped).toBe('scoped-value')

    // 3) root 绑定不受影响：仍解析到 root 提供的值（Spatial Composability - Ordering）
    expect(ctx.get('demo')).toBe('root-value')

    detach()
  })

  it('intercept 声明派生挂载 ctx：拦截配置原样写入 intercept map', async () => {
    makeCordisPlugin(
      'plug-intercept',
      { intercept: { demo: { mode: 'express' } } },
      `globalThis.__cordisScopeTest = {
         isolateMap: {},
         interceptMap: ctx[Symbol.for('cordis.intercept')] || {},
         demoFromRoot: undefined,
         demoFromScoped: undefined,
       }`
    )

    const ctx = createRootContext()
    loader = new PluginLoader()
    await loader.reload()
    const detach = await mountCordisPlugins(ctx, loader)
    await new Promise((r) => setTimeout(r, 50))

    // intercept 声明已应用到挂载 ctx（祖先优先合并语义由 vendor 侧 resolveConfig 承担）
    expect(__cordisScopeTest).toBeDefined()
    expect(__cordisScopeTest!.interceptMap).toHaveProperty('demo')
    expect(__cordisScopeTest!.interceptMap['demo']).toEqual({ mode: 'express' })

    detach()
  })

  it('缺省声明时行为零变化：挂载 ctx 的 isolate/intercept map 与 rootCtx 一致', async () => {
    makeCordisPlugin(
      'plug-plain',
      { config: { mode: 'test' } },
      `globalThis.__cordisScopeTest = {
         isolateMap: Object.fromEntries(Object.entries(ctx[Symbol.for('cordis.isolate')] || {})),
         interceptMap: ctx[Symbol.for('cordis.intercept')] || {},
         demoFromRoot: !!ctx.coeffect,
         demoFromScoped: undefined,
       }`
    )

    const ctx = createRootContext()
    loader = new PluginLoader()
    await loader.reload()
    const detach = await mountCordisPlugins(ctx, loader)
    await new Promise((r) => setTimeout(r, 50))

    // 无声明插件：不新增任何 isolate/intercept 键（demo 从未被本插件声明）
    expect(__cordisScopeTest).toBeDefined()
    expect(__cordisScopeTest!.isolateMap['demo']).toBeUndefined()
    expect(__cordisScopeTest!.interceptMap['demo']).toBeUndefined()
    // inject 触达照旧（无声明插件行为与改造前一致）
    expect(__cordisScopeTest!.demoFromRoot).toBe(true)

    detach()
  })
})