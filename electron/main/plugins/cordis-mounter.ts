/**
 * Cordis 模块挂载器（阶段 5a）

 * 为了让月蚀直接复用成熟的 Cordis 模块生态（第三方模块零改造成本），
 * 需要一条按 Cordis 协议把插件入口挂载进月蚀 rootCtx 的通道——

 * 把 plugin.json 声明 `cordis: { entry }` 的插件按 Cordis 协议挂载进 rootCtx，
 * 这是「兼容 Cordis 模块生态」的直接通道：

 * plugins/<name>/plugin.json { "cordis": { "entry": "index.js" } }
 * plugins/<name>/index.js export default { inject?: [...], apply(ctx) {...} }

 * 模块 apply 收到的 ctx = 月蚀 rootCtx（Cordis 内核一致，API 100% 兼容），
 * 依赖经 ctx 服务键获取（ctx.coeffect / ctx.tools / ctx.config / ...），
 * 模块作者无需 import 任何框架包——这正是 Cordis 的模块协议。

 * 生命周期：
 * - 挂载 = ctx.plugin(pluginObj, config) → fiber（随 rootCtx 生命周期）
 * - 卸载 = registry.delete(pluginObj)（按 callback identity 清理全部 fiber，可逆副作用）
 * - 热重载 = 订阅 PluginLoader.onChanged（提交后触发）→ 卸载旧集 → 挂载新集
 */

import { Context } from '../vendor/cordis/index.ts'
import type { Plugin } from '../vendor/cordis/index.ts'
import { pathToFileURL } from 'url'
import type { PluginLoader } from './loader'
import { coeffectRegistry } from '../kernel'
import { deepMerge, readCordisPatchOverlay } from '../kernel/config-layer'
import { getDataRoot } from '../models/path-context'
import type { SandboxExecService } from '../tools/code-sandbox'

/** 单个 Cordis 模块的挂载记录 */
export interface MountedCordisPlugin {
  dirName: string
  pluginObj: Plugin
  fiber: unknown
}

/**
 * 已挂载 fiber 的最小结构（只声明本文件用到的「等待落定」能力）。
 *
 * 为什么存在：fiber 的完整类型来自 vendor/cordis，而这里只依赖其中 `await()`
 * 一项能力——用结构化最小接口而非 import 完整 Fiber 类型，避免为了一个方法
 * 把 vendor 类型面引入本模块（vendor 是 @ts-nocheck 的兼容锚，类型面不稳定）。
 * 作用：让 settleActivated 能在不 import vendor 类型的前提下等待 fiber 落定。
 * 不删理由：这是「挂载完成」的判定依据类型；删除即无法表达等待语义。
 */
interface SettleableFiber {
  await(): Promise<unknown>
}

/**
 * 单批挂载的激活等待上界（毫秒）。
 *
 * 为什么存在：ctx.plugin() 的激活是异步的（见 settleActivated 注释），必须给等待一个界；
 * 无界的等待会在「模块依赖的服务未被提供」时永久挂起启动链。
 * 作用：整批共用一个上界（并行等待），正常激活是微任务级、远早于上界返回，
 * 因此这个数字只在病态 fiber 上生效。
 * 不删理由：它是「不因单个坏模块卡死启动」的兜底；删除即退化为无界等待。
 */
const CORDIS_ACTIVATE_SETTLE_TIMEOUT_MS = 2000

/**
 * 等待本批已挂载模块完成激活（apply 执行 / Service 构造 → 服务注册进 ctx）。
 *
 * 为什么存在：ctx.plugin() 的语义是「创建 fiber 并排定激活」，模块的 apply 与
 * Service 构造发生在 fiber 的生命周期任务里异步执行，挂载循环本身不等待它。
 * 实测证据：cordis-ecosystem 测试单独跑 4/4 绿，全量并行跑偶发
 * `expect(ctx.ecoSvc).toBeDefined()` 失败——构造函数已执行（证据已写入 globalThis）
 * 但服务尚未注册进 ctx，正是这个时序缺口；而调用方（启动链 initKernelExtensions）
 * 在 mountCordisPlugins 返回后紧接着就访问 ctx 服务。
 * 作用：把「挂载完成」的定义严格化为「本批模块已激活」，使 mountCordisPlugins
 * docstring 对调用方的承诺（resolve 后 ctx.<service> 可读）在实现上真正成立。
 * 不删理由：这是挂载与「调用方读 ctx 服务」之间唯一的同步点；删除即回到竞态，
 * 回归测试会重新出现随机失败（而非确定性失败，更难定位）。
 * 边界：单模块激活失败只记录、不抛出；等待超时只告警、不中断——与 importEntry
 * 入口加载失败、sandbox 服务缺失的软失败语义保持一致（单个模块问题不拖垮整批）。
 */
async function settleActivated(mounted: readonly MountedCordisPlugin[]): Promise<void> {
  if (mounted.length === 0) return

  // 已落定（含激活失败）的模块名：激活失败的模块已单独记录原因，不应再报成「超时未激活」
  const settled = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    await Promise.race([
      Promise.all(
        mounted.map(async (m) => {
          try {
            await (m.fiber as SettleableFiber).await()
          } catch (err) {
            // 单模块激活失败（配置校验失败 / apply 抛错）：记录后继续等其它模块
            console.error(
              `[cordis-mounter] 模块 ${m.dirName} 激活失败：${err instanceof Error ? err.message : err}`
            )
          } finally {
            settled.add(m.dirName)
          }
        })
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CORDIS_ACTIVATE_SETTLE_TIMEOUT_MS)
      })
    ])
  } finally {
    // 正常路径提前返回时必须清掉兜底定时器：否则每次热重载都会留下一个 2s 定时器（泄漏）
    if (timer) clearTimeout(timer)
  }

  const pending = mounted.filter((m) => !settled.has(m.dirName)).map((m) => m.dirName)
  if (pending.length > 0) {
    console.warn(
      `[cordis-mounter] 模块 ${pending.join(', ')} 在 ${CORDIS_ACTIVATE_SETTLE_TIMEOUT_MS}ms 内未完成激活` +
        `（可能在等待未被提供的依赖服务），本次挂载不再等待`
    )
  }
}

/**
 * 动态 import 模块入口（时间戳 query 绕过模块缓存，热重载拿新代码）
 * [SECURITY] import() 在主进程执行，Cordis 模块代码拥有完整 Node.js 权限（与 tools.js 同信任层）。

 * 热重载语义说明（阶段 5）：每次挂载都会重新 import（带新时间戳），ESM module cache 按 URL 键，
 * 因此每次热重载都会生成全新模块实例。这是**有意为之**的行为（热重载必须拿新代码），
 * 副作用泄漏风险由调用方控制：resync 前会先 unmountCurrent（registry.delete 卸载旧 fiber），
 * 旧实例的副作用随 fiber dispose 全部回滚；未被引用的旧模块实例由 V8/GC 回收。
 * （不做池化/缓存：Cordis 模块可能持有模块级状态，复用旧实例会引入跨生命周期状态泄漏。）
 */
async function importEntry(entryPath: string): Promise<Plugin> {
  const fileUrl = `${pathToFileURL(entryPath).href}?t=${Date.now()}`
  const mod = (await import(/* @vite-ignore */ fileUrl)) as { default?: Plugin }
  const plugin = mod?.default ?? (mod as unknown as Plugin)
  if (!plugin || (typeof plugin !== 'function' && typeof (plugin as { apply?: unknown }).apply !== 'function')) {
    throw new Error('cordis 入口 default 导出必须是模块（函数 / Service 子类 / { apply(ctx) }）')
  }
  return plugin
}

/**
 * 卸载单个已挂载的 Cordis 模块（删除插件前调用）。
 *
 * 为什么存在：loader.deletePlugin 删除的是磁盘目录 + 工具注册，Cordis fiber 不归
 * loader 管——若删除目录后 fiber 仍挂在 rootCtx 上，依赖该插件服务的其它模块会
 * 继续读到已删除插件的服务（论文「依赖 key 在被依赖者完整卸载前保持可读」
 * Theorem 63 的逆命题：被依赖者移除后依赖者也不应继续消费）。因此 loader 在物理
 * 删除前必须先把本插件的 fiber 卸载干净，由 here 提供这个能力并注册进 loader。
 * 作用：按插件 dirName 定位 mounted 记录 → registry.delete 排定卸载 → await 落定
 * （含 _drainDependents 先让依赖者离开）→ 从 mounted 列表移除。
 * 不删理由：这是「先卸载后删除」论文删除流程在月蚀的接缝；删除即回到旧缺陷
 * （目录已删、fiber 孤悬，依赖者读到失效服务或卸载报错）。
 */
async function unloadOne(mounted: MountedCordisPlugin[], ctx: Context, dirName: string): Promise<void> {
  const m = mounted.find((x) => x.dirName === dirName)
  if (!m) return
  try {
    ctx.registry.delete(m.pluginObj)
    await (m.fiber as SettleableFiber).await()
  } catch (err) {
    // 软失败：单模块卸载失败只记录不抛出——调用方（deletePlugin）目录已删，
    // 必须继续完成工具注销与列表清理，不能让一个 fiber 的卸载错误中断删除流程
    console.error(`[cordis-mounter] 模块 ${dirName} 卸载失败：${err instanceof Error ? err.message : err}`)
  }
  // 无论成败都移除记录：mounted 只代表「本批要挂载/卸载的对象」，
  // 卸载尝试后不再重挂它（该插件已从 loader 列表删除）
  const idx = mounted.findIndex((x) => x.dirName === dirName)
  if (idx !== -1) mounted.splice(idx, 1)
}

/**
 * 挂载全部已启用 Cordis 模块到 ctx；订阅 loader.onChanged 自动重挂（热重载）。
 * async：初始挂载完成（含所有模块 apply）后才 resolve——调用方须 await，
 * 确保后续 ctx.<service> 访问发生在模块注册之后（阶段 4 模块化前置条件）。
 * 该承诺的实现点在 resync 末尾的 settleActivated：ctx.plugin() 本身只排定激活，
 * 不 await 它则本函数提前 resolve，调用方会在服务注册前读到 undefined。
 * @param ctx 月蚀 rootCtx
 * @param loader 现有 PluginLoader（已加载完成的实例）
 * @returns detach 函数（卸载全部 + 退订 onChanged）
 */
export async function mountCordisPlugins(ctx: Context, loader: PluginLoader): Promise<() => void | Promise<void>> {
  const mounted: MountedCordisPlugin[] = []
  let disposed = false

  // cordis.patch overlay（阶段 5 配置树）：dataRoot 未设置时 returns {}，安全跳过
  const cordisPatch = readCordisPatchOverlay(getDataRoot())

  const unmountCurrent = async () => {
    // 逆序卸载（后挂先卸）：逐个 delete 并 await 落定。
    // 为什么不并行：论文 Algorithm 5 / 4.4.2 要求卸载按 LIFO 逆回、每个 fiber 的
    // 依赖者先于被依赖者完成卸载——并行会让多个 fiber 的卸载交错，破坏「后挂先卸」
    // 的次序承诺；且 await() 内部本来就等 _drainDependents，串行只是把等待串起来。
    for (const m of [...mounted].reverse()) {
      await unloadOne(mounted, ctx, m.dirName)
    }
  }

  const resync = async () => {
    if (disposed) return
    await unmountCurrent()
    const targets = loader
      .list()
      .filter((p) => p.enabled && p.cordisEntry && p.errors.length === 0)
    for (const p of targets) {
      let pluginObj: Plugin
      try {
        pluginObj = await importEntry(p.cordisEntry!)
      } catch (err) {
        // 软失败：入口导出非法时记录错误，不中断其他插件加载
        console.error(`[cordis-mounter] 模块 ${p.dirName} 入口加载失败：${err instanceof Error ? err.message : err}`)
        continue
      }
      // 按需注入沙箱服务：只有 manifest 声明 deps: ['sandbox:exec'] 的模块才拿到
      // 未声明该 deps 的模块不受影响（config 原样透传，不乱注入）
      let config = p.cordisConfig
      // cordis.patch overlay（按插件 id 深合并，优先级高于 manifest.cordis.config）
      const overlay = cordisPatch[p.dirName]
      if (overlay && Object.keys(overlay).length > 0) {
        config = deepMerge(config ?? {}, overlay)
        console.log(`[cordis-mounter] 模块 ${p.dirName} 应用 cordis.patch overlay`)
      }
      if (p.deps?.includes('sandbox:exec')) {
        const sandbox = coeffectRegistry.get<SandboxExecService>('sandbox:exec')
        if (!sandbox) {
          // 软失败而非 throw：sandbox 服务缺失只影响声明依赖它的这一个模块，
          // 一旦抛出会中断整批挂载——初始挂载时连累后续所有模块、热重载时
          // 产生 unhandled rejection（onChanged → void resync() 无 try/catch），
          // 与上方 importEntry 的软失败语义保持一致；记录错误使问题可观测。
          console.error(`[cordis-mounter] 模块 ${p.dirName} 声明了 sandbox:exec 依赖但服务未提供，跳过该模块（其余模块继续挂载）`)
          continue
        }
        config = { ...(config ?? {}), sandbox }
        console.log(`[cordis-mounter] 模块 ${p.dirName} 注入沙箱执行服务（按需）`)
      }
      // entry 级 isolate/intercept 声明（对齐 Cordis loader entry 协议）：
      // 缺省时挂载进 rootCtx（行为零变化）；声明后派生子 ctx 再挂载，
      // 服务在隔离作用域内 provide/get、配置按拦截片段合并（祖先优先）。
      let mountCtx: Context = ctx
      for (const [name, label] of Object.entries(p.cordisIsolate ?? {})) {
        // 字符串 label 归一为稳定 symbol：同 label 跨插件 join 同一作用域（对齐原生 isolate(label) 语义）
        mountCtx = mountCtx.isolate(name, Symbol.for(`cordis:isolate:${name}:${label}`))
      }
      for (const [name, interceptCfg] of Object.entries(p.cordisIntercept ?? {})) {
        mountCtx = mountCtx.intercept(name, interceptCfg as never)
      }
      const fiber = mountCtx.plugin(pluginObj, config)
      mounted.push({ dirName: p.dirName, pluginObj, fiber })
      console.log(`[cordis-mounter] 已挂载 Cordis 模块 ${p.dirName}（entry=${p.manifest.cordis?.entry}${p.cordisIsolate ? `, isolate=${Object.keys(p.cordisIsolate).join(',')}` : ''}${p.cordisIntercept ? `, intercept=${Object.keys(p.cordisIntercept).join(',')}` : ''}）`)
    }

    // 本批全部 create 完成后统一等待激活落定（见 settleActivated 注释）：
    // 放在 resync 内部使初始挂载与热重载两条路径共享同一同步语义——
    // 初始挂载靠 mountCordisPlugins 的 await 传给调用方，热重载靠 void resync() 自行收尾。
    await settleActivated(mounted)
  }

  // 初始挂载：await 完成后再返回（调用方在启动链 await，保证后续 ctx 访问安全）
  await resync()

  // 向 loader 注册「删除前卸载单个插件」的回调（论文 O-Remove 先卸载后删除）：
  // loader.deletePlugin 删除目录前调用，确保该插件的 cordis fiber 连同其依赖者
  // 全部卸载落定，避免目录已删、fiber 仍挂在 ctx 上（依赖者读到失效服务）。
  loader.setCordisUnloader(async (dirName: string) => {
    if (disposed) return
    await unloadOne(mounted, ctx, dirName)
  })

  loader.onChanged(() => {
    void resync()
  })

  return async () => {
    disposed = true
    await unmountCurrent()
  }
}