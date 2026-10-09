/**
 * @category 核心
 * @summary 事件钩子系统：HookManager 执行、配置加载与治理钩子
 * @note 为什么存在：月蚀的生命周期事件（工具调用/用户输入等）需要可编程拦截点来实现
 * 审计、守卫与自定义行为；本模块是钩子机制的对外统一出口。
 */
export { HookManager, HookExecutor } from './hook-manager'
export { loadAllHooks, watchHooksConfig, getHooksPaths, hasProjectHooks, setProjectHooksAllowed, isProjectHooksAllowed, setHooksConfigRoot } from './config-loader'
export { getDefaultHooks, shouldUseDefaultHooks } from './defaults'
export type {
  HookEvent,
  HookType,
  HookScope,
  HookHandler,
  HookMatcherGroup,
  HooksConfig,
  HookContext,
  HookResult,
  ResolvedHook
} from './types'
