/**
 * 月蚀方言插件适配层（阶段 5 交付件之二）

 * 插件系统向 Cordis 生态过渡时，既存方言插件（plugin.json + tools.js 等）
 * 需要能参与统一的 Cordis 生命周期（挂载/卸载/热重载）而不被弃用——
 * 本适配层把方言插件包装为 Cordis Plugin，apply 内走与 loader 完全相同的
 * 注册机制，保证双轨过渡期间行为零差异。

 * 把方言插件（plugin.json + tools.js + hooks.js + prompts.md + config.patch.json）
 * 包装为 Cordis Plugin（`{ name, apply(ctx) }`），apply 内调用与 loader 相同的注册机制：
 * - tools.js → 工具 meta 注册进统一工具池（registerPluginToolMetas，与 loader 同幂等语义）
 * - hooks.js → loadHooksModule（register(reg, ctx) 协议）
 * - prompts.md → loadPromptsModule（分段注入）
 * - config.patch.json → loadConfigPatchModule（配置覆盖）
 * - manifest.panel → createRegistrar 注册面板

 * 可逆效应：apply 返回的 disposer 被 Cordis fiber 收集；挂载（ctx.plugin）时全量注册，
 * 卸载（registry.delete / fiber dispose）时逆序回滚全部注册句柄 + 注销工具 meta。
 * 挂载语义与 loader 加载该插件的行为零差异（同一套注册原语、同一注册中心）。

 * 双轨边界（行为零变化铁律）：
 * - 本文件不改动 loader 现有加载路径（loader 轨保持原样，kernelHandles 仍归 loader 管理）；
 * - adapter 是独立 Cordis 轨：在本 fiber 内执行与 loader 等价的注册，注册句柄对本 fiber 负责，
 * 不触碰 loader 持有的 kernelHandles；同一插件同时走两轨属双轨过渡策略，由调用方编排。
 * - 工具 meta 注册用 registerPluginToolMetas（同插件先移除旧 meta 再追加，天然幂等）；
 * 卸载用 unregisterPluginTools(dirName) 移除本插件全部动态 meta。

 * 软失败语义与 loader 一致：hooks/prompts/configPatch 加载错误收进 errors 并打 warn，
 * 不 throw、不中断其他模块注册（坏模块不拖垮整个插件的 Cordis 生命周期）。
 */
import { join } from 'path'
import { getDataRoot } from '../models/path-context'
import { createRegistrar, kernelRegistry } from '../kernel'
import { registerPluginToolMetas, unregisterPluginTools } from '../../../shared/tools/registry'
import { loadHooksModule } from './module-hooks'
import { loadPromptsModule } from './module-prompts'
import { loadConfigPatchModule } from './module-config-patch'
import type { LoadedPlugin } from './types'
import type { Plugin } from '../vendor/cordis/index.ts'

/** 可 dispose 句柄（内核注册统一最小形态） */
type DisposableHandle = { disposed: boolean; dispose(): void }

/**
 * 把已加载的方言插件包装为 Cordis Plugin。
 *
 * @param loaded 方言插件加载结果（loader 产出或测试手工构造均可；
 * 适配层只消费 dirName/dirPath/manifest/tools/metas/panel，不依赖 kernelHandles）
 * @param options 可选 { dataRoot }：hooks.js 的 ctx.dataRoot（缺省与 loader 一致 =
 * {dataRoot}/plugins，即插件根目录）
 * @returns Cordis 插件对象；经 ctx.plugin() 挂载后即可获得与 loader 等价的注册效果，
 * 卸载时全部副作用可逆回滚。
 */
export function toCordisPlugin(
  loaded: LoadedPlugin,
  options?: { dataRoot?: string }
): Plugin {
  const name = loaded.manifest.name ?? loaded.dirName

  // async apply：loadHooksModule 是动态 import（Promise）；
  // Cordis `_execute` 对 Promise 形态 effect 走 `then(safeCollect)`，resolve 的 disposer 被收集。
  return {
    name,
    async apply(ctx) {
      const dirName = loaded.dirName
      const errors: string[] = []
      const handles: DisposableHandle[] = []
      const dataRoot = options?.dataRoot ?? join(getDataRoot(), 'plugins')

      // 1) 工具 meta（与 loader 提交阶段同机制，幂等）
      if (loaded.metas.length > 0) {
        registerPluginToolMetas(loaded.metas)
      }

      // 2) hooks.js（register(reg, ctx) 协议）
      handles.push(...(await loadHooksModule(loaded.dirPath, dirName, dataRoot, errors)))

      // 3) prompts.md
      handles.push(...loadPromptsModule(loaded.dirPath, dirName, errors))

      // 4) config.patch.json
      handles.push(...loadConfigPatchModule(loaded.dirPath, dirName, errors))

      // 5) 面板声明（与 loader loadOne 同机制）
      const panel = loaded.panel
      if (panel && panel.id && panel.component) {
        const { reg, handles: panelHandles } = createRegistrar(kernelRegistry, {
          kind: 'plugin',
          pluginName: dirName
        })
        reg.registerPanel({
          id: panel.id,
          title: panel.title || dirName,
          icon: panel.icon || 'LayoutGrid',
          component: panel.component
        })
        handles.push(...panelHandles)
      }

      // 软失败仅告警（对齐 loader：错误进 errors 不打断挂载）
      if (errors.length > 0) {
        ctx.logger.warn(`[dialect-adapter] 插件 ${dirName} 部分模块加载失败：${errors.join('; ')}`)
      }

      // 可逆效应：卸载时逆序回滚内核句柄 + 注销工具 meta
      return () => {
        unregisterPluginTools(dirName)
        for (const h of [...handles].reverse()) {
          if (!h.disposed) h.dispose()
        }
      }
    }
  }
}