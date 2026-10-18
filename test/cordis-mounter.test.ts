import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRootContext } from '../electron/main/kernel/cordis-runtime'
import { PluginLoader } from '../electron/main/plugins/loader'
import { setPathContext } from '../electron/main/models/path-context'
import { mountCordisPlugins } from '../electron/main/plugins/cordis-mounter'

/**
 * Cordis 模块挂载器验证（阶段 5a，2026-08-25）
 *
 * 「兼容 Cordis 模块」的直接通道：plugin.json 声明 cordis.entry →
 * 入口文件 default 导出 { inject, apply(ctx) } → 挂进 rootCtx（Cordis 内核一致）。
 * 断言：apply 执行 + ctx 服务注入触达（inject 声明生效）+ detach 卸载。
 */

// 供入口文件写入挂载证据（ESM 插件模块与测试进程共享 globalThis）
declare global {
   
  var __cordisMounterTestApplied: { dirName: string; hasCoeffect: boolean; hasConfig: unknown } | undefined
  var __cordisMounterTestAppliedCount: number | undefined
}

let tmpRoot: string
let loader: PluginLoader
// 本用例持有的 detach：afterEach 兜底调用，确保 mounter 不跨用例存活
let detach: (() => void | Promise<void>) | undefined

beforeEach(() => {
  tmpRoot = join(tmpdir(), `cordis-mounter-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  setPathContext(tmpRoot, () => null)
  // 插件根 = {dataRoot}/plugins/（getPluginsRoot 语义）；tools 格式与 cordis 格式并存
  mkdirSync(join(tmpRoot, 'plugins', 'plug-cordis'), { recursive: true })
  writeFileSync(
      join(tmpRoot, 'plugins', 'plug-cordis', 'plugin.json'),
      JSON.stringify({
        name: 'plug-cordis',
        description: 'cordis 格式测试插件',
        version: '1.0.0',
        cordis: { entry: 'index.js', config: { mode: 'test' } }
      }),
      'utf8'
    )
    writeFileSync(
      join(tmpRoot, 'plugins', 'plug-cordis', 'index.js'),
    `export default {
  name: 'plug-cordis',
  inject: ['coeffect'],
  apply(ctx, config) {
    globalThis.__cordisMounterTestApplied = { dirName: 'plug-cordis', hasCoeffect: !!ctx.coeffect, hasConfig: config }
    // 精确记录 apply 被执行次数：仅凭「标记存在」无法区分「挂载一次」与「被重挂后再次写入」，
    // 计数让「detach 后不得再 apply」成为可判定的事实（回归抓手）。
    globalThis.__cordisMounterTestAppliedCount = (globalThis.__cordisMounterTestAppliedCount ?? 0) + 1
  }
}`,
    'utf8'
  )
  delete globalThis.__cordisMounterTestApplied
  delete globalThis.__cordisMounterTestAppliedCount
  detach = undefined
})

afterEach(async () => {
  // 用例隔离前提：每个用例都自建 PluginLoader，必须显式卸载 + 销毁。
  // PluginLoader 构造时 startWatch 注册递归 fs.watch，目录变化在 500ms 防抖后触发
  // reload() → emitChanged()，而 mountCordisPlugins 订阅了 onChanged 并据此 resync() 重挂插件。
  // 若不清理，泄漏的 watcher/mounter 会跨用例继续写 globalThis 标记——本文件会退化成
  // 「谁先跑谁污染谁」的假红/假绿。此处是隔离手段，不是为绿而绿：断言强度见各用例（apply 计数）。
  await detach?.()
  detach = undefined
  loader?.destroy()
  delete globalThis.__cordisMounterTestApplied
  delete globalThis.__cordisMounterTestAppliedCount
})

describe('Cordis 模块挂载器', () => {
  it('cordis 型插件经 loader 加载 + mounter 挂载，apply 执行且 ctx 服务注入触达', async () => {
    loader = new PluginLoader()
    await loader.reload()
    const ctx = createRootContext()

    detach = await mountCordisPlugins(ctx, loader)
    // 初始挂载已 await 完成（import -> ctx.plugin -> inject 激活 -> apply 全跑完）
    await new Promise((r) => setTimeout(r, 50))

    expect(globalThis.__cordisMounterTestApplied).toBeDefined()
    expect(globalThis.__cordisMounterTestApplied?.dirName).toBe('plug-cordis')
    expect(globalThis.__cordisMounterTestAppliedCount).toBe(1)
    // inject: ['coeffect'] 触达：ctx.coeffect 服务在 apply 时可用（rootCtx 提供）
    expect(globalThis.__cordisMounterTestApplied?.hasCoeffect).toBe(true)
    // config 透传：cordis.config 原样到达 apply 第二参
    expect(globalThis.__cordisMounterTestApplied?.hasConfig).toEqual({ mode: 'test' })
  })

  it('入口导出非法时挂载失败不中断（软失败），其他插件不受影响', async () => {
    mkdirSync(join(tmpRoot, 'plugins', 'plug-bad'), { recursive: true })
    writeFileSync(
      join(tmpRoot, 'plugins', 'plug-bad', 'plugin.json'),
      JSON.stringify({ name: 'plug-bad', description: 'bad', version: '1.0.0', cordis: { entry: 'index.js' } }),
      'utf8'
    )
    writeFileSync(join(tmpRoot, 'plugins', 'plug-bad', 'index.js'), 'export default 42', 'utf8')

    loader = new PluginLoader()
    await loader.reload()
    const ctx = createRootContext()

    detach = await mountCordisPlugins(ctx, loader)
    await new Promise((r) => setTimeout(r, 50))

    // 合法插件照常挂载，坏插件仅报错
    expect(globalThis.__cordisMounterTestApplied?.dirName).toBe('plug-cordis')
    expect(globalThis.__cordisMounterTestAppliedCount).toBe(1)
  })

  it('detach 卸载全部挂载（registry.delete 可逆副作用）', async () => {
    loader = new PluginLoader()
    await loader.reload()
    const ctx = createRootContext()

    detach = await mountCordisPlugins(ctx, loader)
    await new Promise((r) => setTimeout(r, 50))
    expect(globalThis.__cordisMounterTestApplied?.dirName).toBe('plug-cordis')
    expect(globalThis.__cordisMounterTestAppliedCount).toBe(1)

    // detach 卸载：清标记后主动触发一次热重载（emitChanged），并等待跨过 loader 的
    // 500ms 防抖窗口——若 detach 未真正退订 onChanged / 未拦住已 disposed 的 resync，
    // 插件会被重新挂载、apply 再次执行，计数与标记都会卷土重来。
    await detach()
    delete globalThis.__cordisMounterTestApplied
    await loader.reload()
    await new Promise((r) => setTimeout(r, 600))
    // registry 中已无该插件 fiber（delete 后 ctx 上服务不可再被 apply 触碰——以无异常 + 无新标记 + 计数不增为准）
    expect(globalThis.__cordisMounterTestApplied).toBeUndefined()
    expect(globalThis.__cordisMounterTestAppliedCount).toBe(1)
  })
})