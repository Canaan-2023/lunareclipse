/**
 * 插件 hooks.js 模块加载器

 * 插件需要在不改动内核代码的前提下拦截/扩展行为（事件钩子、人类命令、
 * coeffect 服务），故提供 register(reg, ctx) 协议经内核 registrar 注册，
 * 句柄由加载器收集、随插件卸载批量回滚——

 * 协议：hooks.js 导出 { name?, register(reg, ctx) }，
 * register 阶段通过内核 registrar 注册函数 hook / 人类命令 / coeffect 服务，
 * 注册句柄由加载器收集，插件卸载时批量回滚。

 * 支持 ESM 和 CJS 两种导出格式（bundled 目录 package.json type=module 时须用 ESM）：
 * - ESM: export default { register(reg, ctx) { ... } }
 * - CJS: module.exports = { register(reg, ctx) { ... } }

 * 示例（ESM）：
 * ```js
 * export default {
 * name: 'my-guard',
 * register(reg, ctx) {
 * reg.registerHook('PreToolUse', async (hookCtx) => {
 * if (hookCtx.toolName === 'run_command') return { action: 'block', message: '拦截' }
 * return { action: 'continue' }
 * }, { matcher: '.*' })
 * // 也可注册人类命令（不经 AI 模型直接执行）
 * reg.registerCommand({
 * id: 'my:doSomething',
 * description: '直接执行某操作',
 * async run(args) { return { ok: true } }
 * })
 * }
 * }
 * ```
 */
import { existsSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { createRegistrar, kernelRegistry, coeffectRegistry } from '../kernel'
import type { PluginModule, PluginModuleContext } from '../kernel'

/** 可 dispose 句柄（扩展注册 + coeffect 提供的统一最小形态） */
type DisposableHandle = { disposed: boolean; dispose(): void }

/** 加载 hooks.js（不存在则跳过；失败收集进 errors，不拖垮其他插件） */
export async function loadHooksModule(
  dirPath: string,
  pluginName: string,
  dataRoot: string,
  errors: string[]
): Promise<DisposableHandle[]> {
  const hooksFile = join(dirPath, 'hooks.js')
  if (!existsSync(hooksFile)) return []
  // handles 提升到 try 外：register 中途抛错时 catch 需要遍历回滚已注册句柄
  let handles: DisposableHandle[] = []
  try {
    // [SECURITY] import() 在主进程执行，hooks.js 拥有完整 Node.js 权限（与 tools.js 同信任层）。
    // 时间戳 query 绕过模块缓存，保证热重载拿到新代码
    const fileUrl = `${pathToFileURL(hooksFile).href}?t=${Date.now()}`
    const mod = (await import(/* @vite-ignore */ fileUrl)) as { default?: PluginModule } | PluginModule
    const exported = Array.isArray(mod) ? undefined : ((mod as { default?: PluginModule }).default ?? mod)
    const moduleObj = exported as PluginModule | undefined
    if (!moduleObj || typeof moduleObj.register !== 'function') {
      errors.push('hooks.js 未导出 register 函数（需 module.exports = { register(reg, ctx) } 或 export default）')
      return []
    }
    const { reg, handles: regHandles } = createRegistrar(kernelRegistry, { kind: 'plugin', pluginName })
    handles = regHandles
    const ctx: PluginModuleContext = {
      pluginName,
      pluginDir: dirPath,
      dataRoot,
      // 对插件模块暴露 coeffect 服务表：register 阶段可读依赖（自己/他人此前 provide 的）
      coeffect: {
        get: <T = unknown>(key: string): T | undefined => coeffectRegistry.get<T>(key),
        has: (key: string) => coeffectRegistry.has(key)
      }
    }
    await moduleObj.register(reg, ctx)
    return handles
  } catch (err) {
    // 注册中途抛错：已注册句柄必须回滚，否则坏插件卸载后其 hook/命令残留生效（幽灵行为）
    for (const h of handles) {
      if (!h.disposed) h.dispose()
    }
    errors.push(`hooks.js 加载失败: ${(err as Error).message}`)
    return []
  }
}
