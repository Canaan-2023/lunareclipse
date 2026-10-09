/**
 * 模块生命周期（createRegistrar）

 * 生成绑定来源的 ExtensionRegistrar；注册句柄统一收集，卸载时由调用方逆序回滚。
 * （ModuleMounter 已按奥卡姆剃刀删除：全仓零调用，插件热重载走 plugins/loader 事务化路径）
 */
import type { ExtensionRegistrar, ExtensionSource } from './extension'
import type { ExtensionRegistry } from './registry'
import type { CoeffectRegistry } from './coeffect'
import { coeffectRegistry } from './coeffect'
import type { HookFn } from './extension'

/**
 * 生成绑定来源的 registrar（扩展协议适配）。
 * 自动收集全部注册句柄（无需模块作者手动 return），
 * 卸载时统一回滚；作者显式 return 的句柄作为补充。
 * provide() 落到 coeffect 服务表（默认为全局 coeffectRegistry），同样纳入回滚。
 */
export function createRegistrar(
  reg: ExtensionRegistry,
  source: ExtensionSource,
  coeffect: CoeffectRegistry = coeffectRegistry
): {
  reg: ExtensionRegistrar
  handles: Array<{ disposed: boolean; dispose(): void }>
} {
  const handles: Array<{ disposed: boolean; dispose(): void }> = []
  const track = <T extends { disposed: boolean; dispose(): void }>(h: T): T => {
    handles.push(h)
    return h
  }
  const registrar: ExtensionRegistrar = {
    registerTool: (tool, meta) => track(reg.register('tool', source, { tool, meta })),
    registerHook: (event, fn: HookFn, opts) =>
      track(
        reg.register('hook', source, {
          event,
          fn,
          matcher: opts?.matcher,
          priority: opts?.priority ?? 100
        })
      ),
    registerPrompt: (section) => track(reg.register('prompt', source, section)),
    registerConfigPatch: (patch) => track(reg.register('configPatch', source, patch)),
    registerCommand: (cmd) => track(reg.register('command', source, cmd)),
    registerPanel: (panel) => track(reg.register('panel', source, panel)),
    provide: (key, value) => track(coeffect.provide(key, value, source))
  }
  return { reg: registrar, handles }
}
