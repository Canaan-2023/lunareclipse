/**
 * @category 监控
 * @summary Supervisor 状态聚合与任务日志纯函数（无副作用，可独立测试）
 * 为什么存在：Supervisor 需要可回溯的任务日志与状态聚合，抽成无副作用纯函数便于独立测试与复用。
 */

export interface TaskLogEntry {
  dmnId: string
  summary?: string
  filesModified?: string[]
  filesCreated?: string[]
  completedAt: string
}

/** 从 taskLog 找到某 DMN 最后一条完成记录的时间戳（找不到返回 null） */
export function findLastCompleteAt(taskLog: TaskLogEntry[], dmnId: string): number | null {
  for (let i = taskLog.length - 1; i >= 0; i--) {
    if (taskLog[i].dmnId === dmnId) {
      const t = Date.parse(taskLog[i].completedAt)
      if (!Number.isNaN(t)) {
        return t
      }
      break
    }
  }
  return null
}

/** 追加一条完成记录并裁剪到 maxEntries（保留最近 maxEntries 条） */
export function pushTaskLog(
  taskLog: TaskLogEntry[],
  entry: TaskLogEntry,
  maxEntries: number
): TaskLogEntry[] {
  const next = [...taskLog, entry]
  if (next.length > maxEntries) {
    next.splice(0, next.length - maxEntries)
  }
  return next
}