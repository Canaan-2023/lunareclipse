/**
 * @category 工具
 * @summary 工具执行控制器：能力闸 + Pre/PostToolUse Hook + 超时/取消，统一入口 executeTool
 * @note 由 index.ts 拆分而来：只搬位置，不改变任何行为与导出
 * @note 为什么存在：所有工具调用必须经过同一条执行链（能力开关 → Hook → 超时 → 取消），
 * 否则任何旁路都会绕过安全审批；本模块是唯一的工具执行入口。
 */
import type { ToolResult } from './base-tool'
import type { ToolRegistry } from './tool-registry'
import type { HookContext } from '../hooks/types'
import { checkCapability } from '../kernel'
import { getAllToolMetas } from '@shared/tools/registry'
import { getToolSignal } from '../api/llm-types'

export async function executeTool(
  registry: ToolRegistry,
  name: string,
  params: Record<string, unknown>,
  signal?: AbortSignal
): Promise<ToolResult> {
  const tool = registry.tools.get(name)
  if (!tool) {
    return { ok: false, error: `工具未注册: ${name}` }
  }

  if (signal?.aborted) {
    return { ok: false, error: '工具执行已被取消' }
  }

  // 声明式能力闸（CapabilityGuard）：在 PreToolUse 用户 hook 之前做第一道结构化能力校验；
  // policy 存 config（getEffective 实时读，运行时可改、不触发插件 reload）。默认未开启 = 全放行。
  try {
    const allMeta = getAllToolMetas()
    const meta = allMeta.find((m) => m.id === name)
    const decision = checkCapability(
      name,
      meta ? { caps: meta.caps, riskLevel: meta.riskLevel } : undefined,
      registry.ctx.config
    )
    if (!decision.allowed) {
      return { ok: false, error: `被能力策略拒绝: ${decision.reason ?? '未授权'}` }
    }
  } catch {
    // 能力闸自身异常不阻塞工具（宽松）
  }

  // 控制层：PreToolUse Hook（权限检查/参数校验/阻断）
  const hookManager = registry.ctx.hookManager
  if (hookManager && hookManager.isLoaded()) {
    // 治理开关透传（核心保护区等 PreToolUse hook 用）：从 ctx.config getter 读当前生效配置
    const rawConfig = (registry.ctx.config ?? {}) as Record<string, unknown>
    const preResult = await hookManager.run('PreToolUse', {
      event: 'PreToolUse',
      toolName: name,
      toolParams: params,
      sessionId: registry.ctx.sessionId ?? undefined,
      dmnId: registry.ctx.dmnId,
      governance: (rawConfig.governance ?? undefined) as HookContext['governance'],
      cwd: process.cwd()
    })
    if (preResult.action === 'block') {
      return { ok: false, error: `被 Hook 阻止: ${preResult.message ?? ''}` }
    }
    if (preResult.action === 'error') {
      return { ok: false, error: `Hook 错误: ${preResult.message ?? ''}` }
    }
    // PreToolUse 可修改参数
    if (preResult.modifiedParams) {
      Object.assign(params, preResult.modifiedParams)
    }
  }

  // 执行工具
  let result: ToolResult
  try {
    // 取消信号来源：调用方显式传入（DMN 等）优先，否则读 llm.ts 工具循环经
    // AsyncLocalStorage 注入的信号（前端主链路）。注入 ToolContext.signal 后，
    // 工具监听 abort 在超时/打断时终止自身工作——契约见 base-tool.ts；
    // 当前 run_command 已按契约终止子进程树，其余长任务工具待接入（未接入者只会被外层放弃，不会真正取消）。
    const cancelSignal = signal ?? getToolSignal()
    if (cancelSignal?.aborted) {
      // 已中止：直接短路，不执行工具（ALS 信号可能在进入前就已 abort）
      result = { ok: false, error: '工具执行已被取消' }
    } else {
      const toolCtx = cancelSignal ? { ...registry.ctx, signal: cancelSignal } : registry.ctx
      const execPromise = Promise.resolve(tool.execute(params, toolCtx))
      if (cancelSignal) {
        let onAbort: (() => void) | undefined
        const abortPromise = new Promise<ToolResult>((resolve) => {
          onAbort = () => resolve({ ok: false, error: '工具执行已被取消（超时）' })
          cancelSignal.addEventListener('abort', onAbort, { once: true })
        })
        result = await Promise.race([execPromise, abortPromise])
        // 工具先返回时必须摘除监听器，否则它一直挂在 signal 上直到 GC（每次调用堆一个）
        if (onAbort) cancelSignal.removeEventListener('abort', onAbort)
      } else {
        result = await execPromise
      }
    }
  } catch (err) {
    result = { ok: false, error: (err as Error).message }
  }

  // 控制层：PostToolUse Hook（结果处理/日志/审计）
  if (hookManager && hookManager.isLoaded()) {
    const postResult = await hookManager.run('PostToolUse', {
      event: 'PostToolUse',
      toolName: name,
      toolParams: params,
      toolResult: result,
      sessionId: registry.ctx.sessionId ?? undefined,
      dmnId: registry.ctx.dmnId,
      cwd: process.cwd()
    })
    // PostToolUse 可修改结果
    if (postResult.modifiedResult) {
      result = postResult.modifiedResult
    }
    // PostToolUse 的 block 不阻断已执行的结果（工具已执行完），但记录日志
    if (postResult.action === 'block') {
      console.warn(`[hooks] PostToolUse block 被忽略（工具已执行）: ${postResult.message}`)
    }
    // PostToolUse 的 error 不影响工具结果，但记录日志便于诊断
    if (postResult.action === 'error') {
      console.warn(`[hooks] PostToolUse error: ${postResult.message}`)
    }
  }

  return result
}