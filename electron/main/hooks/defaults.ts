/**
 * 内置默认 Hook 模板：为什么存在——用户零配置开局时也需要兜底审计与守卫能力，
 * 避免"未配置即裸奔"；这些默认钩子以字符串模板内嵌，由加载策略按需启用。
 * 作用：导出内置默认 Hook（审计 / grep 守卫等）与启用策略判断（getDefaultHooks / shouldUseDefaultHooks）。
 * 不删理由：config-loader 的 loadAllHooks 在用户全局配置为空时调用 getDefaultHooks
 * 兜底加载，删除会使默认审计/守卫能力整体消失。
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

/**
 * 搜索纪律守护：PreToolUse 拦截无界搜索，不让 AI 靠"全项目摸底"烧 token。

 * Grep 守护：必须带 path 或 glob 限定范围；content 输出模式必须带 head_limit。
 * LS 守护：必须带 path 限定目录（找文件用 Glob 精确匹配，禁止无参列举）。
 */
const GREP_GUARD_HANDLER = `
const p = ctx.toolParams || {};
const hasScope = !!(p.path || p.glob);
if (!hasScope) {
  return { action: 'block', message: '搜索纪律守护：Grep 必须带 path 或 glob 限定搜索范围（禁止无界全项目扫描烧 token）。例：Grep(pattern="TodoPanel", path="app/src") 或 glob="*.ts" 配合具体目录。' };
}
if (p.output_mode === 'content' && !p.head_limit) {
  return { action: 'block', message: '搜索纪律守护：Grep 的 content 输出模式必须带 head_limit 限制条数（防输出刷屏烧 token）。例：head_limit=20。' };
}
return { action: 'continue' };
`.trim()

const LS_GUARD_HANDLER = `
const p = ctx.toolParams || {};
const pth = String(p.path || '').trim();
if (!pth) {
  return { action: 'block', message: '搜索纪律守护：LS 必须带 path 参数限定目录（禁止无参列举当前目录）。找文件用 Glob 精确匹配，例：Glob(pattern="**/TodoPanel*", path="app/src")。' };
}
return { action: 'continue' };
`.trim()

/** Agent 并行模式子任务上限（防多路 LLM 并发烧 token + DeepSeek 429） */
const AGENT_PARALLEL_LIMIT = 5
/** Agent 串行模式子任务上限（串行可控，宽松） */
const AGENT_SERIAL_LIMIT = 8

/**
 * 并行守护：Agent 子 agent 并行会多路 LLM 并发烧 token + 卡 UI。
 * - mode=parallel：tasks ≤ 5（LLMClient 已并发化；DeepSeek 并发过高会 429）
 * - mode=serial：tasks ≤ 8（串行可控，宽松）
 */
const AGENT_GUARD_HANDLER = `
const p = ctx.toolParams || {};
const tasks = Array.isArray(p.tasks) ? p.tasks : [];
if (tasks.length === 0) return { action: 'continue' };
const mode = p.mode === 'parallel' ? 'parallel' : 'serial';
const limit = mode === 'parallel' ? ${AGENT_PARALLEL_LIMIT} : ${AGENT_SERIAL_LIMIT};
if (tasks.length > limit) {
  return { action: 'block', message: '并行守护：Agent(' + mode + ') 一次最多派 ' + limit + ' 个子任务（当前 ' + tasks.length + ' 个）——并行太多会多路 LLM 并发烧 token 卡 UI。分批派发：先派前 ' + limit + ' 个，完成后再派下一批。' };
}
return { action: 'continue' };
`.trim()

/** Hook 超时常量（毫秒） */
const AUDIT_HOOK_TIMEOUT_MS = 5000
const GUARD_HOOK_TIMEOUT_MS = 3000

/**
 * 构造内置默认 Hook 列表

 * 当前含：
 * - PostToolUse 审计 hook（matcher=.* 匹配所有工具）
 * - PreToolUse 搜索纪律守护（Grep / LS / Agent 无界调用拦截，机制兜底不靠 AI 自觉）

 * PreLLMCall 注入由 governance.ts 的 javascript hook 负责，
 * 不在此注册 command-type hook。
 */
export function getDefaultHooks(): ResolvedHook[] {
  const auditHandler: HookHandler = {
    type: 'javascript',
    handler: AUDIT_HANDLER,
    timeout: AUDIT_HOOK_TIMEOUT_MS
  }
  const grepGuard: HookHandler = {
    type: 'javascript',
    handler: GREP_GUARD_HANDLER,
    timeout: GUARD_HOOK_TIMEOUT_MS
  }
  const lsGuard: HookHandler = {
    type: 'javascript',
    handler: LS_GUARD_HANDLER,
    timeout: GUARD_HOOK_TIMEOUT_MS
  }
  const agentGuard: HookHandler = {
    type: 'javascript',
    handler: AGENT_GUARD_HANDLER,
    timeout: GUARD_HOOK_TIMEOUT_MS
  }

  return [
    {
      event: 'PreToolUse',
      handler: grepGuard,
      matcher: '^Grep$',
      scope: 'global',
      sourceFile: '<builtin-default>'
    },
    {
      event: 'PreToolUse',
      handler: lsGuard,
      matcher: '^LS$',
      scope: 'global',
      sourceFile: '<builtin-default>'
    },
    {
      event: 'PreToolUse',
      handler: agentGuard,
      matcher: '^Agent$',
      scope: 'global',
      sourceFile: '<builtin-default>'
    },
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
