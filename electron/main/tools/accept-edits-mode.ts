/**
 * 自动编辑模式（acceptEdits）：为什么存在——把 acceptEdits 作为权限模式之一，
 * 语义是"自动接受文件编辑操作"：进入后文件编辑类工具不再逐次打断用户确认，适合批量化改文件。
 * 作用：提供 enter_accept_edits_mode / exit_accept_edits_mode 两个工具与会话级状态
 * （Map<sessionKey, boolean>）；执行链（execute-tool.ts）在权限覆写层消费本模块状态：
 * 自动编辑模式下，编辑白名单工具的 require-approval 覆写被跳过（自动放行）。
 *
 * 安全边界：
 * - 仅覆盖确定性文件编辑工具（Edit/Write/NotebookEdit）；DeleteFile/MoveFile/run_command
 *   等破坏性操作不在白名单，仍走原审批；
 * - deny 覆写优先于自动编辑（管理员收紧不能放宽）；
 * - 能力闸（CapabilityGuard）与 PreToolUse 治理 hook 仍生效，不经由模式绕过。
 */
import type { Tool, ToolContext, ToolResult } from './base-tool'

/** 会话级自动编辑状态：key 与执行链同一口径（sessionId ?? dmnId ?? 'global'） */
const acceptEditsSessions = new Map<string, boolean>()

/** 自动编辑白名单：确定性文件编辑工具（不含删除/移动/命令执行——安全底线） */
export const EDIT_AUTO_APPROVE_IDS = new Set(['Edit', 'Write', 'NotebookEdit'])

/** 会话是否处于自动编辑模式（execute-tool 权限覆写层消费） */
export function isAcceptEditsActive(sessionKey: string): boolean {
  return acceptEditsSessions.get(sessionKey) ?? false
}

/** 进入自动编辑模式 */
export function enterAcceptEdits(sessionKey: string): void {
  acceptEditsSessions.set(sessionKey, true)
}

/** 退出自动编辑模式 */
export function exitAcceptEdits(sessionKey: string): void {
  acceptEditsSessions.delete(sessionKey)
}

/** 清理全部会话自动编辑状态（应用重启 / 测试隔离用） */
export function resetAcceptEditsState(): void {
  acceptEditsSessions.clear()
}

/** 工具是否属于自动编辑白名单（确定性能安全地自动接受逐次授权的文件编辑工具） */
export function isEditAutoApproved(toolName: string): boolean {
  return EDIT_AUTO_APPROVE_IDS.has(toolName)
}

/** 会话 key：与 execute-tool 执行链的 sessionKey 同一口径 */
function sessionKeyOf(ctx?: ToolContext): string {
  return ctx?.sessionId ?? ctx?.dmnId ?? 'global'
}

export class EnterAcceptEditsModeTool implements Tool {
  name = 'enter_accept_edits_mode'
  description =
    '进入自动编辑模式：文件编辑类工具（Edit/Write/NotebookEdit）自动接受逐次授权请求，不打断用户。何时用：需要对多个文件批量编辑、信任 AI 的修改粒度时进入，减少逐次确认。仍受安全策略与治理规则约束（管理员禁用工具、权限收紧等优先于本模式）；删除文件、移动、执行命令等破坏性操作不在白名单，照常按原审批流程。批量编辑完成后调用 exit_accept_edits_mode 退出、恢复逐次确认。'
  parameters: Tool['parameters'] = []
  behavior = {
    readOnly: true,
    concurrencySafe: true
  }
  execute(_params: Record<string, unknown>, ctx?: ToolContext): ToolResult {
    const key = sessionKeyOf(ctx)
    const already = isAcceptEditsActive(key)
    enterAcceptEdits(key)
    return {
      ok: true,
      data: {
        message: already
          ? '已在自动编辑模式中。文件编辑类工具（Edit/Write/NotebookEdit）将继续自动接受逐次授权；删除/移动/命令执行等操作不受影响。无需时调用 exit_accept_edits_mode 退出。'
          : '已进入自动编辑模式。本阶段 Edit/Write/NotebookEdit 的逐次授权请求自动放行；删除文件、移动、执行命令等破坏性操作照常审批。批量编辑完成后调用 exit_accept_edits_mode 退出恢复严格确认。'
      }
    }
  }
}

export class ExitAcceptEditsModeTool implements Tool {
  name = 'exit_accept_edits_mode'
  description =
    '退出自动编辑模式：文件编辑类工具恢复逐次授权确认。何时用：批量编辑任务已完成、或需要恢复严格确认粒度时调用。'
  parameters: Tool['parameters'] = []
  behavior = {
    readOnly: true,
    concurrencySafe: true
  }
  execute(_params: Record<string, unknown>, ctx?: ToolContext): ToolResult {
    const key = sessionKeyOf(ctx)
    const wasActive = isAcceptEditsActive(key)
    exitAcceptEdits(key)
    return {
      ok: true,
      data: {
        message: wasActive
          ? '已退出自动编辑模式，文件编辑类工具恢复逐次授权确认。'
          : '当前不在自动编辑模式（无需退出）。文件编辑类工具保持逐次授权确认。'
      }
    }
  }
}