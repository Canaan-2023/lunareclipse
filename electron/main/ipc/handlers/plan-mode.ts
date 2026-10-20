/**
 * 计划模式 IPC：前端「模式切换」入口同步主进程会话级计划模式状态。
 * 状态本体在 electron/main/tools/plan-mode.ts（sessionKey = sessionId ?? workflowId ?? 'global'），
 * 执行链（execute-tool.ts）的只读闸消费同一状态；本模块提供查询/进入/退出三个通道，
 * 供 InputArea 第四模式（计划）与 AI 工具 enter_plan_mode / exit_plan_mode 双向同步——
 * 前端主动进入时后端只读闸立即生效，AI 主动进入时前端提示条同样即时出现。
 */
import { ipcMain } from 'electron'
import { enterPlanMode, exitPlanMode, isPlanModeActive } from '../../tools/plan-mode'
import { safeHandle } from './safe-handle'

/** 会话 key：与工具执行链同一口径（sessionId ?? workflowId ?? 'global'），前端无会话时按 global 查询 */
function sessionKeyOf(arg: unknown): string {
  return typeof arg === 'string' && arg.length > 0 ? arg : 'global'
}

export function registerPlanModeHandlers(ipc: typeof ipcMain): void {
  // 查询当前会话是否处于计划模式（只读；safeHandle 兜底 false = 不在计划模式）
  safeHandle<boolean>(
    ipc,
    'planMode:get',
    (_event, sessionId?: unknown) => isPlanModeActive(sessionKeyOf(sessionId)),
    false
  )
  // 进入计划模式：写入会话级状态并返回生效状态（应为 true；safeHandle 兜底 false）
  safeHandle<boolean>(
    ipc,
    'planMode:enter',
    (_event, sessionId?: unknown) => {
      const key = sessionKeyOf(sessionId)
      enterPlanMode(key)
      return isPlanModeActive(key)
    },
    false
  )
  // 退出计划模式：清除会话级状态并返回生效状态（应为 false；safeHandle 兜底 false）
  safeHandle<boolean>(
    ipc,
    'planMode:exit',
    (_event, sessionId?: unknown) => {
      const key = sessionKeyOf(sessionId)
      exitPlanMode(key)
      return isPlanModeActive(key)
    },
    false
  )
}