/**
 * @category 插件
 * @summary 插件系统：plugin.json 加载、工具并入统一池、卸载可逆回滚

 * 插件子系统对外统一导出入口：把加载器、各模块加载器与类型定义
 * 汇总暴露给主进程其他模块与 IPC，供管理面板与运行时统一调用。
 */
/**
 * 模块系统导出（插件 = 插件格式）
 */
export type {
  PluginManifest,
  PluginToolMetaDecl,
  LoadedPlugin,
  PluginLoaderApi,
  PluginToolModule,
  PluginSource
} from './types'

export { PluginLoader, getUserPluginsDir, getDomainPluginsDir } from './loader'
export { loadHooksModule } from './module-hooks'
export { loadPromptsModule, parsePromptSections } from './module-prompts'
export { loadConfigPatchModule } from './module-config-patch'
