import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRootContext } from '../electron/main/kernel/cordis-runtime'
import { PluginLoader } from '../electron/main/plugins/loader'
import { setPathContext } from '../electron/main/models/path-context'
import { mountCordisPlugins } from '../electron/main/plugins/cordis-mounter'

/**
 * 参考实现生态兼容验收（阶段 6，T14 子任务③）
 *
 * 语义：拿"现实风格"外部 Cordis 插件实测加载运行——
 *   - 函数式插件：纯 JS 模块 `export default { name, apply(ctx, config) }`，
 *     不 import 任何月蚀代码（只依赖 ctx 协议 + globalThis 传证据）；
 *   - Service 子类插件：`import { Service } from 'cordis'`（alias → vendor/cordis，
 *     即参考实现仓库内那份内核，兼容锚点）→ `class X extends Service`。
 *
 * 全链路：plugin.json `cordis.entry` → PluginLoader.reload() → mountCordisPlugins(ctx)
 * （importEntry 动态 import → ctx.plugin → fiber）：断言
 *   - ctx 服务可访问（inject 触达 / rootCtx 服务）
 *   - 事件分发（插件内 ctx.on 订阅 ↔ 测试端 ctx.emit）
 *   - config 可访问（manifest.cordis.config 透传 + cordis.patch overlay 深合并）
 *   - 卸载后副作用可逆（detach → 服务不可读 / 事件不再触达 / disposer 执行）
 *
 * 注意：cordisConfig / overlay 字段经 `p.cordisConfig` 传入，与 cordis-mounter
 * 的 config 注入路径一致；事件监听随 fiber dispose 自动清理（Cordis 语义）。
 */

// 供入口 JS 写入挂载证据（外部插件与测试进程共享 globalThis）
declare global {
  var __ecoFnApplied: { hasCoeffect: boolean; config: unknown; recv: unknown; disposed: boolean } | undefined
  var __ecoSvcConstructed: { config: unknown; greet: string } | undefined
}

let tmpRoot: string
let loader: PluginLoader

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cordis-eco-'))
  setPathContext(tmpRoot, () => null)

  // ── 函数式插件（plug-fn）：manifest.cordis.config + apply(ctx, config) ──
  mkdirSync(join(tmpRoot, 'plugins', 'plug-fn'), { recursive: true })
  writeFileSync(
    join(tmpRoot, 'plugins', 'plug-fn', 'plugin.json'),
    JSON.stringify({
      name: 'plug-fn',
      description: '外部函数式 Cordis 插件（参考实现生态验收）',
      version: '1.0.0',
      cordis: { entry: 'index.js', config: { mode: 'fn', base: 1 } }
    }),
    'utf8'
  )
  writeFileSync(
    join(tmpRoot, 'plugins', 'plug-fn', 'index.js'),
    `export default {
  name: 'plug-fn',
  apply(ctx, config) {
    const evidence = { hasCoeffect: !!ctx.coeffect, config, recv: undefined, disposed: false }
    globalThis.__ecoFnApplied = evidence
    // 事件订阅：测试端 ctx.emit('eco/ping') 应触达
    ctx.on('eco/ping', (payload) => { evidence.recv = payload })
    return () => { evidence.disposed = true }
  }
}`,
    'utf8'
  )

  // ── Service 子类插件（plug-svc）：import { Service } from 'cordis' ──
  mkdirSync(join(tmpRoot, 'plugins', 'plug-svc'), { recursive: true })
  writeFileSync(
    join(tmpRoot, 'plugins', 'plug-svc', 'plugin.json'),
    JSON.stringify({
      name: 'plug-svc',
      description: '外部 Service 子类 Cordis 插件（参考实现生态验收）',
      version: '1.0.0',
      cordis: { entry: 'index.js', config: { mode: 'svc' } }
    }),
    'utf8'
  )
  writeFileSync(
    join(tmpRoot, 'plugins', 'plug-svc', 'index.js'),
    `import { Service } from 'cordis'
export default class EcoService extends Service {
  constructor(ctx, config) {
    super(ctx, 'ecoSvc')
    globalThis.__ecoSvcConstructed = { config, greet: this.greet }
  }
  greet(name) { return 'hello ' + name }
}`,
    'utf8'
  )

  delete globalThis.__ecoFnApplied
  delete globalThis.__ecoSvcConstructed
})

afterEach(() => {
  // 销毁 loader：关闭 fs.watch + 退订 coeffectRegistry（模块级单例，不 destroy 会跨测试泄漏）
  loader?.destroy()
})

/**
 * 有界等待条件成立（替代固定 `setTimeout(r, 50)` 的时序凑合）。
 *
 * 为什么存在：固定 sleep 是「猜够不够久」——本机单文件跑够用，全量并行跑时事件循环
 *   被其余 151 个测试文件抢占，50ms 内 fiber 未落定即断言失败，表现为随机红灯
 *   （实测：单跑 4/4 绿，全量跑出现 `expect(ctx.ecoSvc).toBeDefined()` 失败）。
 * 作用：把「等它好了」变成「等到条件成立或超时」——条件成立立即返回，不赌时间、不空等。
 * 不删理由：卸载/退订是 fiber 生命周期的异步收尾（registry.delete → 异步 dispose），
 *   对「已移除」这类否定断言必须给确定性上界；删掉即回到固定 sleep 的随机失败。
 * 超时后直接返回，由紧随其后的 expect 给出具体失败信息（不在此处抛错，避免掩盖真实差异）。
 *
 * 注：挂载侧的同步已由 cordis-mounter 的 settleActivated 保证（resolve 即已激活），
 * 因此挂载后的断言无需本函数，直接断言即为对那条契约的回归验证。
 */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) return
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('参考实现生态兼容：外部 Cordis 插件全链路加载', () => {
  it('函数式插件 {name, apply(ctx,config)}：ctx 服务/事件/config 可访问，卸载副作用可逆', async () => {
    loader = new PluginLoader()
    await loader.reload()
    const ctx = createRootContext()

    const detach = await mountCordisPlugins(ctx, loader)

    // apply 执行 + ctx 服务触达（rootCtx 已注册 coeffect）
    // 挂载后不加 sleep：mountCordisPlugins 的契约就是「resolve 时模块已激活」，
    // 此处直接断言即是该契约的回归验证（若契约被破坏，失败应是确定性的而非随机）
    expect(globalThis.__ecoFnApplied).toBeDefined()
    expect(globalThis.__ecoFnApplied?.hasCoeffect).toBe(true)
    expect(globalThis.__ecoFnApplied?.disposed).toBe(false)

    // config 透传：manifest.cordis.config 原样到达 apply 第二参
    expect(globalThis.__ecoFnApplied?.config).toEqual({ mode: 'fn', base: 1 })

    // 事件分发：测试端 emit → 插件内 ctx.on 订阅触达
    ctx.emit('eco/ping', { seq: 1 })
    expect(globalThis.__ecoFnApplied?.recv).toEqual({ seq: 1 })

    // 卸载：disposer 执行 + 事件监听随 fiber 清理（同一事件不再触达）
    detach()
    await waitFor(() => globalThis.__ecoFnApplied?.disposed === true)
    expect(globalThis.__ecoFnApplied?.disposed).toBe(true)
    const oldRecv = globalThis.__ecoFnApplied?.recv
    ctx.emit('eco/ping', { seq: 2 })
    expect(globalThis.__ecoFnApplied?.recv).toBe(oldRecv)
  })

  it('函数式插件 config 经 cordis.patch overlay 深合并（阶段 5 配置树联动）', async () => {
    // cordis.patch.json：{ 插件id: {配置片段} } → 深合并进 cordisConfig（优先级更高）
    writeFileSync(
      join(tmpRoot, 'cordis.patch.json'),
      JSON.stringify({ 'plug-fn': { overlayKey: 'patched', base: 99 } }),
      'utf8'
    )

    loader = new PluginLoader()
    await loader.reload()
    const ctx = createRootContext()
    const detach = await mountCordisPlugins(ctx, loader)

    // 挂载返回即已应用 overlay（同 test 1：不加 sleep，直接断言契约）
    expect(globalThis.__ecoFnApplied?.config).toEqual({
      mode: 'fn',
      base: 99, // overlay 覆盖 manifest 值
      overlayKey: 'patched' // overlay 新增字段
    })

    // 必须 detach：否则 resync 回调存活并持有 overlay 闭包，
    // 全量并行时 coeffectRegistry（模块级单例）事件会触发其重挂，
    // 把 overlay config 二次写入 globalThis 污染其它用例断言
    detach()
  })

  it('Service 子类插件：构造即注册 ctx.ecoSvc，外部可调方法，卸载后服务不可读', async () => {
    loader = new PluginLoader()
    await loader.reload()
    const ctx = createRootContext()

    const detach = await mountCordisPlugins(ctx, loader)

    // 构造执行 + config 透传 + greet 方法可用
    // 关键契约点：ctx.plugin() 只排定激活，服务注册发生在 fiber 激活时；
    // mountCordisPlugins 已在返回前 await 激活落定（settleActivated），故此处可直接断言。
    // 历史上这里靠固定 sleep 凑时序，全量并行下曾随机失败（见 waitFor 注释）。
    expect(globalThis.__ecoSvcConstructed).toBeDefined()
    expect(globalThis.__ecoSvcConstructed?.config).toEqual({ mode: 'svc' })
    const ecoSvc = ctx.ecoSvc as { greet(name: string): string } | undefined
    expect(ecoSvc).toBeDefined()
    expect(ecoSvc?.greet('world')).toBe('hello world')

    // 卸载：Service 随 fiber 移除，ctx.ecoSvc 不再可读
    detach()
    await waitFor(() => (ctx as unknown as { ecoSvc?: unknown }).ecoSvc === undefined)
    expect((ctx as unknown as { ecoSvc?: unknown }).ecoSvc).toBeUndefined()
  })

  it('函数式 + Service 子类并存挂载，互不干扰，detach 全部回滚', async () => {
    loader = new PluginLoader()
    await loader.reload()
    const ctx = createRootContext()

    const detach = await mountCordisPlugins(ctx, loader)

    expect(globalThis.__ecoFnApplied?.config).toEqual({ mode: 'fn', base: 1 })
    expect((ctx.ecoSvc as { greet(name: string): string }).greet('x')).toBe('hello x')

    detach()
    await waitFor(() => globalThis.__ecoFnApplied?.disposed === true)
    expect(globalThis.__ecoFnApplied?.disposed).toBe(true)
    await waitFor(() => (ctx as unknown as { ecoSvc?: unknown }).ecoSvc === undefined)
    expect((ctx as unknown as { ecoSvc?: unknown }).ecoSvc).toBeUndefined()
  })
})