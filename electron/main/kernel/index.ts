/**
 * @category 核心
 * @summary 内核 LXK：工具/hook/提示词段/配置覆盖/命令/面板六类扩展注册与可逆效应
 * 为什么存在：六类扩展（工具/hook/提示词段/配置覆盖/命令/面板）的注册与回滚需要统一出口，供上层装配与插件引用。
 */
/**
 * 月蚀内核（LXK）出口
 *
 * 统一扩展模型：工具 / hook / prompt 段 / 配置覆盖 / 命令 / 面板 六类扩展，
 * 注册即可逆效应，卸载即回滚。
 */
export * from './extension'
export { ExtensionRegistry, kernelRegistry } from './registry'
export { CoeffectRegistry, coeffectRegistry } from './coeffect'
export type {
  CoeffectKey,
  CoeffectHandle,
  CoeffectStatus,
  CoeffectChangeListener
} from './coeffect'
export { checkCapability, readCapabilityPolicy } from './capability'
export type { CapabilityPolicy, CapabilityDecision } from './capability'
export type { RegistryChangeListener } from './registry'
export { createRegistrar } from './lifecycle'
export {
deepMerge,
  mergeConfigLayers,
  readPatchFiles,
  writePatchFile,
  deletePatchFile,
  listPatchFiles,
  PATCH_DIR,
  buildConfigTreeLayers,
  readActiveProfile,
  writeActiveProfile,
  listProfiles,
  readProfile,
  resolveProfileConfig,
  readActiveProfileConfig,
  readActiveBundle,
  writeActiveBundle,
  listBundles,
  readBundle,
  readActiveBundleConfig,
  readActiveBundlePlugins,
  readCordisPatchOverlay,
  writeCordisPatchOverlay,
  writeProfileFile,
  deleteProfileFile,
  writeBundleFile,
  deleteBundleFile,
  listProfileFiles,
  listBundleFiles
} from './config-layer'
export { buildSelfAwarenessSection, buildKernelStatus, SELF_AWARENESS_RULES } from './introspection'
export {
  installIdleSuppression,
  installFactCheckReminder,
  installClosingReflection,
  installFailureCircuitBreaker
} from './governance'
export { FEATURE_PLUGINS, FeaturePluginsService } from './feature-plugins'
export type { FeaturePluginMeta } from './feature-plugins'
