/**
 * 月蚀 ↔ Cordis 事件桥（阶段 3c）

 * 把月蚀既有 hook 事件流（HookManager.run 的调用点）桥接到 Cordis 事件总线，
 * 让 Cordis 模块能【观察】月蚀的 LLM 请求/工具执行/用户消息等事件。

 * 桥接方向与语义：
 * - 观察桥（本文件）：hookManager.run() 执行前，按映射表 emit 对应 Cordis 事件。
 * Cordis 监听器拿到 HookContext 载荷，可读不可改（不阻断主链，异常吞掉——
 * 与月蚀 hook 哲学一致：hook 异常不阻断主流程）。
 * - 拦截桥（阶段 4 +）：Cordis waterfall 事件（llm/request 等）并入决策链，
 * 与 server.ts 拆分同步做（那时才动 hook 调用点）。

 * 用法（server.ts 启动时挂一次）：
 * const detach = attachCordisEventBridge(rootCtx, hookManager)
 */

import { Context } from '../vendor/cordis/index.ts'
import { HookManager } from '../hooks/hook-manager'
import type { HookEvent, HookContext, HookResult } from '../hooks/types'

// ─── Cordis 事件类型扩展（观察桥载荷 = HookContext） ───
declare module '../vendor/cordis/events.ts' {
  interface Events {
    /** PreLLMCall：LLM 请求前（载荷=PreLLMCall 的 HookContext） */
    'llm/pre-call'(hookCtx: HookContext): void
    /** PreToolUse：工具执行前 */
    'tools/pre-execute'(hookCtx: HookContext): void
    /** PostToolUse：工具执行后 */
    'tools/post-execute'(hookCtx: HookContext): void
    /** UserPromptSubmit：用户消息提交 */
    'user/message'(hookCtx: HookContext): void
    /** Stop：流停止/终止检查点 */
    'agent/turn-stopping'(hookCtx: HookContext): void
    /** SubagentStop：子 agent 停止 */
    'agent/stop'(hookCtx: HookContext): void
    /** Notification：系统通知类 hook */
    'system/notify'(hookCtx: HookContext): void
  }
}

/** 月蚀 hook 事件 → Cordis 事件映射表（全部 7 个 hook 事件，缺一不可） */
export const HOOK_TO_CORDIS: Record<HookEvent, keyof import('../vendor/cordis/events.ts').Events> = {
  PreLLMCall: 'llm/pre-call',
  PreToolUse: 'tools/pre-execute',
  PostToolUse: 'tools/post-execute',
  UserPromptSubmit: 'user/message',
  Stop: 'agent/turn-stopping',
  SubagentStop: 'agent/stop',
  Notification: 'system/notify'
}

/**
 * 挂载观察桥：包装 hookManager.run，执行前 emit 对应 Cordis 事件。
 *
 * @param ctx 月蚀 Cordis 根上下文（rootCtx）
 * @param hookManager 现有 HookManager 实例
 * @returns detach 函数（恢复原始 run）
 */
export function attachCordisEventBridge(ctx: Context, hookManager: HookManager): () => void {
  const originalRun = hookManager.run.bind(hookManager)

  const patched = async (event: HookEvent, hookCtx: HookContext): Promise<HookResult> => {
    const cordisEvent = HOOK_TO_CORDIS[event]
    if (cordisEvent) {
      try {
        ctx.emit(cordisEvent, hookCtx)
      } catch (err) {
        // 观察桥异常不阻断主链（与 hook 异常保护一致）
        console.warn(`[event-bridge] Cordis 监听器异常（${event} -> ${String(cordisEvent)}）:`, err)
      }
    }
    return originalRun(event, hookCtx)
  }

  hookManager.run = patched
  return () => {
    hookManager.run = originalRun
  }
}