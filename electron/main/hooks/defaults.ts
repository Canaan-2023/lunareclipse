/**
 * 内置默认 Hook 模板：为什么存在——用户零配置开局时也需要兜底审计能力，
 * 避免"未配置即裸奔"；默认钩子以字符串模板内嵌，由加载策略按需启用。
 * 作用：导出内置默认 Hook（审计）与启用策略判断（getDefaultHooks / shouldUseDefaultHooks）。
 * 不删理由：config-loader 的 loadAllHooks 在用户全局配置为空时调用 getDefaultHooks
 * 兜底加载，删除会使默认审计能力整体消失。
 *
 * 工具纪律不在此兜底：Grep/LS/Agent 的参数约束（搜索范围、head_limit、派发上限）
 * 已内建到各工具自身 execute 层，避免"靠 HOOK 拦截指令维持工具运行"的重复机制。
 */
import type { HookHandler, ResolvedHook } from './types'

/**
 * 内置默认 Hook

 * 启用策略（loadAllHooks 中实现）：
 * - 用户全局配置文件存在且非空 → 用用户配置，不追加默认
 * - 用户全局配置文件不存在或为空 → 追加默认审计 Hook

 * 项目级配置始终追加到全局（含默认）之后，优先级最高。
 */

/** 默认审计 Hook 的 javascript handler 函数体 */
const AUDIT_HANDLER = `
const ts = new Date().toISOString();
const tool = ctx.toolName || 'unknown';
const ok = ctx.toolResult?.ok ? 'OK' : 'FAIL';
console.log('[hook:audit] ' + ts + ' ' + ctx.event + ' ' + tool + ' ' + ok);
return { action: 'continue' };
`.trim()

/** 审计 Hook 超时常量（毫秒） */
const AUDIT_HOOK_TIMEOUT_MS = 5000

/**
 * 构造内置默认 Hook 列表

 * 当前含：
 * - PostToolUse 审计 hook（matcher=.* 匹配所有工具）

 * PreLLMCall 注入由 governance.ts 的 javascript hook 负责，
 * 不在此注册 command-type hook。
 */
export function getDefaultHooks(): ResolvedHook[] {
  const auditHandler: HookHandler = {
    type: 'javascript',
    handler: AUDIT_HANDLER,
    timeout: AUDIT_HOOK_TIMEOUT_MS
  }

  return [
    {
      event: 'PostToolUse',
      handler: auditHandler,
      matcher: '.*',
      scope: 'global',
      sourceFile: '<builtin-default>'
    }
  ]
}

/**
 * 判断是否应启用默认 Hook
 *
 * 规则：用户全局配置为空（文件不存在或无 hook）时启用。
 * 项目级配置不影响判断——即使项目级有配置，全局仍可能用默认。
 */
export function shouldUseDefaultHooks(userGlobalHooks: ResolvedHook[]): boolean {
  return userGlobalHooks.length === 0
}
