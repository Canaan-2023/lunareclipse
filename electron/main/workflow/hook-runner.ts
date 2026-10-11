/**
 * L8 工作流引擎：HOOK 执行器（工作流级别）



 * 职责：执行工作流模板里配置的 HOOK（事件触发的钩子）

 * 和月蚀现有 HOOK 系统的关系：
 * - 现有 HookManager（hooks/hook-manager.ts）：全局/项目级别，PreToolUse/PostToolUse/Stop 等
 * - 工作流 HOOK 执行器：工作流实例级别，before_node/after_node/on_fail/on_complete/on_user_message
 * - 两者独立，工作流 HOOK 只对该工作流实例生效，用完即弃

 * 复用模式：
 * - command 类型：先经 resolveExternalCommand 解析裸命令名（见 utils/external-command）+
 * 退出码语义（0=continue / 1=error / 2=block）
 * - javascript 类型：vm.Script 在隔离上下文执行
 * - 简化点：不做深度限制（工作流 HOOK 不触发工具调用，不会死循环）
 */
import { execFile } from 'child_process'
import { resolveExternalCommand } from '../utils/external-command'
import { assessCommandForBackgroundExec } from '../tools/run-command'
import * as vm from 'vm'
import type { WorkflowHook, WorkflowHookEvent, WorkflowHookAction } from '@shared/workflow/types'

/** 默认超时（毫秒） */
const DEFAULT_HOOK_TIMEOUT_MS = 10000

/** HOOK 执行结果 */
export interface WorkflowHookResult {
  /** continue=通过 / block=阻塞（停止当前操作） / error=非阻塞错误（记录后继续） */
  action: 'continue' | 'block' | 'error'
  /** 错误/阻塞消息 */
  message?: string
}

/** HOOK 执行上下文（传给 HOOK 的 ctx 参数） */
export interface WorkflowHookContext {
  /** 实例 ID */
  instanceId: string
  /** 模板 ID */
  templateId: string
  /** 触发事件 */
  event: WorkflowHookEvent
  /** 当前节点 ID（before_node/after_node/on_fail 时有值） */
  nodeId?: string
  /** 当前节点名称 */
  nodeName?: string
  /** 当前节点类型 */
  nodeType?: string
  /** 节点输出（after_node 时有值） */
  output?: string
  /** 错误信息（on_fail 时有值） */
  error?: string
  /** 共享上下文快照（只读，修改不影响实例） */
  context?: Record<string, unknown>
  /** 用户消息（on_user_message 时有值） */
  userMessage?: string
}

/**
 * 工作流 HOOK 执行器

 * 不做深度限制（工作流 HOOK 不触发工具调用，不会死循环）。
 * 不做自动禁用（工作流 HOOK 通常配置较少，连续错误由调用方决定如何处理）。
 */
export class WorkflowHookRunner {
  /**
   * 执行指定事件的所有匹配 HOOK

   * @param hooks 工作流模板的 HOOK 配置列表
   * @param event 触发事件
   * @param ctx HOOK 上下文
   * @returns 最终结果（block 立即返回，continue/error 继续执行后续 HOOK）
   */
  async run(
    hooks: WorkflowHook[] | undefined,
    event: WorkflowHookEvent,
    ctx: WorkflowHookContext
  ): Promise<WorkflowHookResult> {
    if (!hooks || hooks.length === 0) {
      return { action: 'continue' }
    }

    // 按事件过滤 + matcher 匹配
    const matched = hooks.filter((h) => {
      if (h.event !== event) return false
      return this.matchMatcher(h.matcher, ctx.nodeId)
    })

    if (matched.length === 0) return { action: 'continue' }

    for (const hook of matched) {
      const result = await this.executeAction(hook.action, ctx)
      // block 立即返回，不再执行后续 HOOK
      if (result.action === 'block') {
        return result
      }
      // error 记录但继续执行后续 HOOK
      if (result.action === 'error') {
        console.warn(`[workflow-hook] ${event} HOOK 错误: ${result.message}`)
      }
    }
    return { action: 'continue' }
  }

  /** matcher 匹配节点 ID（支持正则） */
  private matchMatcher(matcher: string | undefined, nodeId: string | undefined): boolean {
    if (!matcher || matcher === '.*' || matcher === '') return true
    if (!nodeId) return false
    try {
      const regex = new RegExp(matcher)
      return regex.test(nodeId)
    } catch {
      // 正则无效时默认匹配
      return true
    }
  }

  /** 执行单个 HOOK 动作 */
  private async executeAction(
    action: WorkflowHookAction,
    ctx: WorkflowHookContext
  ): Promise<WorkflowHookResult> {
    const timeout = action.timeout ?? DEFAULT_HOOK_TIMEOUT_MS

    if (action.type === 'command') {
      return this.executeCommand(action, ctx, timeout)
    } else {
      return this.executeJavaScript(action, ctx, timeout)
    }
  }

  /**
   * 执行 command 类型 HOOK
   * 复用现有 HookExecutor 的退出码语义：
   * - 0 = 通过（continue）
   * - 1 = 非阻塞错误（error，记录后继续）
   * - 2 = 阻塞（block，停止当前操作）
   */
  private executeCommand(
    action: WorkflowHookAction,
    ctx: WorkflowHookContext,
    timeout: number
  ): Promise<WorkflowHookResult> {
    return new Promise((resolve) => {
      // 安全闸门：HOOK 的命令在后台无用户授权通道执行，必须复用 run_command 的
      // 黑名单/危险模式/白名单判定，防止 AI 通过 workflow_define 注入任意命令
      // 绕过审批语义（威胁等级 CRITICAL，实测可静默执行 del /s /q 等破坏命令）。
      // 判定不通过时按 error 语义返回（记录后继续后续 HOOK），不执行命令。
      const verdict = assessCommandForBackgroundExec(action.command ?? '', action.args ?? [])
      if (!verdict.allowed) {
        resolve({ action: 'error', message: verdict.reason })
        return
      }

      // 裸命令名先解析成可启动进程（Windows 上 npm 等是 .cmd，直接 execFile 会 ENOENT）
      const resolved = resolveExternalCommand(action.command!, action.args ?? [])
      const child = execFile(
        resolved.file,
        resolved.args,
        { timeout, maxBuffer: 1024 * 1024 },
        (err, _stdout, stderr) => {
          if (err) {
            const exitCode = typeof err.code === 'number' ? err.code : null
            if (exitCode === null) {
              resolve({ action: 'error', message: `HOOK 命令执行失败: ${err.message}` })
            } else if (exitCode === 2) {
              resolve({ action: 'block', message: stderr?.trim() || 'HOOK 阻止了操作' })
            } else if (exitCode === 1) {
              resolve({ action: 'error', message: stderr?.trim() || 'HOOK 返回非阻塞错误' })
            } else {
              resolve({ action: 'error', message: `HOOK 执行失败（exit ${exitCode}）: ${stderr?.trim() || err.message}` })
            }
          } else {
            resolve({ action: 'continue' })
          }
        }
      )
      // stdin 传 JSON 上下文
      try {
        child.stdin?.write(JSON.stringify(ctx))
        child.stdin?.end()
      } catch {
        // stdin 写入失败不阻断
      }
    })
  }

  /**
   * 执行 javascript 类型 HOOK
   * - vm.Script 在隔离上下文执行（SECURITY_PREAMBLE 阻断原型链逃逸）
   * - 提供 ctx 和 console
   * - 返回 { action, message } 对象
   */
  private async executeJavaScript(
    action: WorkflowHookAction,
    ctx: WorkflowHookContext,
    timeout: number
  ): Promise<WorkflowHookResult> {
    let timer: NodeJS.Timeout | null = null
    const sandbox: Record<string, unknown> = {}
    try {
      const SECURITY_PREAMBLE = 'Object.defineProperty(Object.prototype,"constructor",{value:undefined,writable:false,configurable:false});Object.defineProperty(Function.prototype,"constructor",{value:undefined,writable:false,configurable:false});try{Object.freeze(Object);Object.freeze(Function);Object.freeze(Array);}catch(e){}globalThis.Function=undefined;globalThis.eval=undefined;'

      const context = vm.createContext(sandbox)
      const script = new vm.Script(
        `"use strict";\n${SECURITY_PREAMBLE}\n` +
        `var ctx = JSON.parse(${JSON.stringify(JSON.stringify(ctx))});\n` +
        `var __logs = [];\n` +
        `var console = { log: function() { __logs.push('[wf-hook] ' + Array.prototype.map.call(arguments, function(v) { return String(v); }).join(' ')); }, warn: function() { __logs.push('[wf-hook] ' + Array.prototype.map.call(arguments, function(v) { return String(v); }).join(' ')); }, error: function() { __logs.push('[wf-hook] ' + Array.prototype.map.call(arguments, function(v) { return String(v); }).join(' ')); } };\n` +
        `(async () => {\n${action.code}\n})();`
      )
      const resultPromise = script.runInContext(context, {
        timeout,
        filename: 'workflow-hook-sandbox.js'
      }) as Promise<WorkflowHookResult>

      const timeoutPromise = new Promise<WorkflowHookResult>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`HOOK 执行超时（${timeout}ms）`)), timeout)
      })

      const result = await Promise.race([
        resultPromise,
        timeoutPromise
      ])

      if (!result || !result.action || !['continue', 'block', 'error'].includes(result.action)) {
        return { action: 'error', message: 'HOOK 返回了无效的 action 值' }
      }
      return result
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('超时')) {
        return { action: 'error', message: msg }
      }
      return { action: 'error', message: `HOOK 执行失败: ${msg}` }
    } finally {
      if (timer) clearTimeout(timer)
      const logs = (sandbox.__logs as string[]) ?? []
      for (const line of logs) console.log(line)
    }
  }
}
