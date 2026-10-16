/**
 * DMN（记忆处理工作流）IPC：记忆分析与持续自主思考引擎的开关/状态
 * 查询等通道，把 Supervisor 的 MemoryWorkflowScheduler 能力暴露给
 * 前端设置与监控面板。
 * 为什么存在：渲染进程不能直接访问主进程的 Supervisor/配置，需经白名单 IPC 通道
 * 读写开关、状态与「会话继承预算生效值」（ 配置小卡片读显用）。
 */
import type { ipcMain as ipcMainType } from 'electron'
import type { Supervisor } from '../../monitor/supervisor'
import type { MonitorConfig } from '../../monitor/monitor-config'
import type { BaseDataPaths } from '../../models/paths'
import type { ConfigStore } from '../../api/config-store'
import type { SessionSummaryEffectiveInfo } from '@shared/types'
import { estimateModelWindow, resolveSummaryBudgetChars } from '../../api/server-utils'


import { safeHandle } from './safe-handle'

/** {ok:false,error} 默认 fallback（dmn 写操作 handler 失败时返回） */
const ERR = (msg = '操作失败，请查看日志') => ({ ok: false as const, error: msg })

export function registerDmnHandlers(
  ipc: typeof ipcMainType,
  getSupervisor: () => Supervisor | null,
  _getDataPaths: () => BaseDataPaths | null,
  configStore: ConfigStore
): void {
  // 记忆处理工作流开关（MemoryWorkflowScheduler）
  safeHandle(
    ipc, 'memoryWorkflow:toggle',
    (_event, enabled: unknown) => {
      const supervisor = getSupervisor()
      if (!supervisor) return { ok: false, error: 'supervisor not ready' }
      if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled 必须为布尔值' }
      supervisor.updateMemoryWorkflowEnabled(enabled)
      return { ok: true }
    },
    ERR()
  )

  safeHandle<{ enabled: boolean; running: boolean } | null>(
    ipc, 'memoryWorkflow:status',
    () => {
      const supervisor = getSupervisor()
      if (!supervisor) return null
      return {
        enabled: supervisor.isMemoryWorkflowEnabled(),
        running: supervisor.isMemoryWorkflowRunning()
      }
    },
    null
  )

  safeHandle(
    ipc, 'dmn:answer',
    (_event, dmnId: unknown, answer: unknown) => {
      const supervisor = getSupervisor()
      if (!supervisor) return { ok: false, error: 'supervisor not ready' }
      if (typeof dmnId !== 'string') return { ok: false, error: 'dmnId 必须为字符串' }
      supervisor.answerDmnQuestion(dmnId, typeof answer === 'string' ? answer : null)
      return { ok: true }
    },
    ERR()
  )

  safeHandle(
    ipc, 'dmn:heartbeat:toggle',
    (_event, enabled: unknown) => {
      const supervisor = getSupervisor()
      if (!supervisor) return { ok: false, error: 'supervisor not ready' }
      if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled 必须为布尔值' }
      // DMN 已合并到记忆处理工作流，heartbeat 开关转调 memoryWorkflow API（前端 UI 兼容）
      supervisor.updateMemoryWorkflowEnabled(enabled)
      return { ok: true }
    },
    ERR()
  )

  safeHandle(
    ipc, 'dmn:frontend:idle',
    (_event, idle: unknown) => {
      const supervisor = getSupervisor()
      if (!supervisor) return { ok: false, error: 'supervisor not ready' }
      if (typeof idle !== 'boolean') return { ok: false, error: 'idle 必须为布尔值' }
      supervisor.setFrontendIdle(idle)
      return { ok: true }
    },
    ERR()
  )

  // 前端切换/创建会话时通知 Supervisor 当前会话 ID
  // 供中断恢复机制查询持续激活状态：只有持续激活开启的会话才自动续接中断
  safeHandle(
    ipc, 'dmn:setActiveSession',
    (_event, sessionId: unknown) => {
      const supervisor = getSupervisor()
      if (!supervisor) return { ok: false, error: 'supervisor not ready' }
      supervisor.setActiveSessionId(typeof sessionId === 'string' ? sessionId : null)
      return { ok: true }
    },
    ERR()
  )

  safeHandle<MonitorConfig | null>(
    ipc, 'dmn:config:get',
    () => {
      const supervisor = getSupervisor()
      if (!supervisor) return null
      return supervisor.getConfig()
    },
    null
  )

  safeHandle(
    ipc, 'dmn:config:update',
    (_event, partial: unknown) => {
      const supervisor = getSupervisor()
      if (!supervisor) return { ok: false, error: 'supervisor not ready' }
      if (!partial || typeof partial !== 'object' || Array.isArray(partial)) return { ok: false, error: 'partial 必须为对象' }
      supervisor.updateConfig(partial as Partial<MonitorConfig>)
      return { ok: true }
    },
    ERR()
  )

  // 会话继承预算「生效值」回显（内部会话视图配置小卡片读显用）。
  // 为什么存在：落盘配置 summaryBudgetChars=0 时语义为「按模型窗口自动推导」，
  // 前端只读配置拿不到推导结果；此通道由主进程统一计算并返回 configured/effective
  // 两值，UI 直接展示「生效值」而无须复算模型窗口。
  // 推导口径复用 server-utils.resolveSummaryBudgetChars：与 internal-session.ts
  // getSessionSummaryCfg 同一函数，两侧生效值永远一致（评审 W1，不重复实现）。
  safeHandle<SessionSummaryEffectiveInfo | null>(
    ipc, 'dmn:sessionSummary:effective',
    () => {
      const supervisor = getSupervisor()
      if (!supervisor) return null
      const configured = supervisor.getConfig()?.sessionSummary.summaryBudgetChars ?? 0
      const model = configStore.get().llm?.model ?? ''
      const effective = resolveSummaryBudgetChars(model, configured)
      return {
        configured,
        effective,
        auto: !(configured > 0),
        modelWindow: estimateModelWindow(model)
      }
    },
    null
  )

  // ===== 日记工作流 IPC =====
  safeHandle(
    ipc, 'dmn:diary:toggle',
    (_event, enabled: unknown) => {
      const supervisor = getSupervisor()
      if (!supervisor) return { ok: false, error: 'supervisor not ready' }
      supervisor.updateDiaryWorkflowEnabled(enabled as boolean)
      return { ok: true }
    },
    ERR()
  )

  safeHandle<{ enabled: boolean; running: boolean } | null>(
    ipc, 'dmn:diary:status',
    () => {
      const supervisor = getSupervisor()
      if (!supervisor) return null
      return {
        enabled: supervisor.isDiaryWorkflowEnabled(),
        running: supervisor.isDiaryWorkflowRunning()
      }
    },
    null
  )
}
