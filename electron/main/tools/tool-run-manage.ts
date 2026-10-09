/**
 * 后台运行托管配套工具：tool_watch（检查/等待托管任务）+ tool_stop（主动停止）。
 *
 * 为什么存在：月蚀外墙 30s 保护墙会 abort 长任务（run_command/code_run），
 * "锁死固定时间"导致长任务永远完不成。改造后外墙对托管工具改为"转后台继续跑"，
 * AI 需要一对配套工具管理这些后台运行：
 * - tool_watch(taskId, waitMs?): AI 设定新的检查时间——等至多 waitMs，落定拿结果；
 * 到期未完成返回 running 状态，AI 可再设定更长时间继续检查（循环直至完成）；
 * - tool_stop(taskId): AI 主动停止——abort 取消信号，底层（run_command）killTree 收尸。
 *
 * 为什么存在（状态来源）：均只读托管注册表（services/tool-run-registry.ts）的状态，
 * 不持有任务本身；注册表由 llm.ts 外墙超时分支在转后台时写入。
 */
import type { AnyTool, ToolResult, ToolContext } from './base-tool'
import {
  peekManagedRun,
  stopManagedRun,
  waitForManagedRun,
  formatConcurrencyAdvisory
} from '../services/tool-run-registry'

/** tool_watch 等待上限：防止 AI 设定超长 waitMs 拖住整轮对话（默认 10s，上限 5 分钟） */
const WATCH_MAX_WAIT_MS = 5 * 60_000

/** 把托管运行快照折叠为给 AI 的状态 JSON（不含内部 settle 细节） */
function runSnapshot(run: {
  taskId: string
  toolName: string
  args: Record<string, unknown>
  startedAt: number
  status: string
  finishedAt?: number
  result?: string
  error?: string
}): Record<string, unknown> {
  const elapsed = Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000)
  const snapshot: Record<string, unknown> = {
    taskId: run.taskId,
    tool: run.toolName,
    status: run.status,
    elapsedSec: elapsed
  }
  if (run.result !== undefined) snapshot.result = run.result
  if (run.error !== undefined) snapshot.error = run.error
  return snapshot
}

/**
 * tool_watch：检查后台托管任务的运行状态。
 * - 任务不存在 → 明确报错（taskId 可能过期被清理或从未存在）；
 * - 等待期内落定 → 返回完整最终结果（成功结果 / 失败错误）；
 * - 到期仍未完成 → 返回 running + 已耗时，AI 据此决定再 watch 或 stop。
 */
export class ToolWatchTool implements AnyTool {
  name = 'tool_watch'
  description = `检查后台托管任务（tool_watch）的进度：传入上一步超时或上次 watch 返回的 taskId，可设定等待时长 waitMs（单位毫秒，默认 10000，上限 ${WATCH_MAX_WAIT_MS}）。
返回：status=running（仍在后台运行，附 elapsedSec 已耗时，可再次调用本工具设更长 waitMs 继续等，或调 tool_stop 主动停止）/ status=settled（已完成，附完整 result 或 error，直接使用）/ status=stopped（已被停止）。
返回同时附设备并发状态（后台托管数 / 动态上限，按 CPU/内存负载实时计算）：超限时由你自行排序取舍——用 tool_stop 停掉低优先级任务释放资源后再发起新任务，系统不强制停止任何任务。
何时用：工具超时提示转后台后、或长任务后续需要取结果时；已完成的托管任务结果保留约 10 分钟内可查。
注意：waitMs 是等待上限而非固定延时——任务提前落定会立即返回，不空等。`
  parameters = [
    {
      name: 'taskId',
      type: 'string' as const,
      description: '托管任务 id（超时诊断结果或上次 watch 返回的 taskId）',
      required: true
    },
    {
      name: 'waitMs',
      type: 'number' as const,
      description: `本次等待上限毫秒（默认 10000，最大 ${WATCH_MAX_WAIT_MS}）`,
      required: false
    }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const taskId = typeof params.taskId === 'string' ? params.taskId : ''
    if (!taskId) return { ok: false, error: 'tool_watch 必须传入 taskId（上次超时/托管任务返回的 id）' }
    const rawWait = Number(params.waitMs ?? 10000)
    const waitMs = Number.isFinite(rawWait)
      ? Math.min(Math.max(Math.round(rawWait), 0), WATCH_MAX_WAIT_MS)
      : 10000
    // 快速路径：任务不存在直接报错，不进等待
    const peek = peekManagedRun(taskId)
    if (!peek) {
      return {
        ok: false,
        error:
          '未找到该托管任务（taskId 不存在或已完成已超过约 10 分钟被清理）。请确认 taskId 是否正确——它来自超时诊断结果或上次 watch 的返回。'
      }
    }
    // 长路径：等至多 waitMs，落定、超时或被打断后返回最新状态。
    // ctx.signal 来自执行器注入（llm.ts 桥接用户打断信号）：用户打断本对话时不继续空等，
    // 立即让位返回当前状态——托管任务本身不受影响仍后台运行，之后仍可再 watch 取结果。
    const outcome = await waitForManagedRun(taskId, waitMs, ctx?.signal)
    if (outcome === 'not_found') {
      return { ok: false, error: '托管任务已不存在（被清理或从未登记）' }
    }
    if (outcome === 'wait_timeout' || outcome === 'interrupted') {
      const latest = peekManagedRun(taskId)
      const base = latest ?? peek
      return {
        ok: true,
        data: {
          ...runSnapshot(base),
          hint:
            (outcome === 'interrupted'
              ? '本次等待被用户打断而提前结束；任务仍在后台运行，可稍后再次调用 tool_watch 查询，或调用 tool_stop 主动停止。'
              : '任务仍在后台运行，未在本次 waitMs 内完成。可再次调用 tool_watch 设置更长的 waitMs 继续检查；若确认无必要继续，调用 tool_stop 主动停止。') +
            formatConcurrencyAdvisory({ taskId })
        }
      }
    }
    // 落定（settled / stopped）：返回终局
    return { ok: true, data: runSnapshot(outcome) }
  }
}

/**
 * tool_stop：主动停止一个仍在后台运行的托管任务。
 * 停止动作 = abort 取消信号（底层 run_command 监听 ctx.signal 后 killTree 清理子进程树），
 * 已落定的任务直接返回其现有终局。
 */
export class ToolStopTool implements AnyTool {
  name = 'tool_stop'
  description = `主动停止一个仍在后台运行的托管任务（tool_stop）。传入 taskId，返回该任务最终状态（status=stopped 表示已发出停止信号）。
何时用：tool_watch 返回 running 且确认任务无必要继续（死循环/跑了太久/方案已变）时；进程由底层清理，不会遗留孤儿。
注意：停止不可撤销，已停止任务的结果不可再取。`
  parameters = [
    {
      name: 'taskId',
      type: 'string' as const,
      description: '托管任务 id（超时诊断结果或 tool_watch 返回的 taskId）',
      required: true
    }
  ]

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const taskId = typeof params.taskId === 'string' ? params.taskId : ''
    if (!taskId) return { ok: false, error: 'tool_stop 必须传入 taskId' }
    const run = stopManagedRun(taskId)
    if (!run) {
      return {
        ok: false,
        error:
          '未找到该托管任务（taskId 不存在或已完成超 10 分钟被清理）。若任务早已结束，其结果在当时的 watch/settle 中已返回，无需停止。'
      }
    }
    return { ok: true, data: runSnapshot(run) }
  }
}