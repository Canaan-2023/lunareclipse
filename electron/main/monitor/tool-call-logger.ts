/**
 * 为什么存在：事中需要知道"某记忆工作流已用过哪些工具"，避免重复调用或为恢复/审计提供上下文。
 * 作用：按 workflowId 记录每次工具调用（名称/参数/时间戳），提供 log/reset/getToolNames 内存态查询。
 */

export interface ToolCallLogEntry {
  name: string
  params: Record<string, unknown>
  timestamp: string
}

export class ToolCallLogger {
  private logs = new Map<string, ToolCallLogEntry[]>()

  reset(workflowId: string): void {
    this.logs.set(workflowId, [])
  }

  log(workflowId: string, name: string, params: Record<string, unknown>): void {
    const arr = this.logs.get(workflowId) ?? []
    arr.push({ name, params, timestamp: new Date().toISOString() })
    this.logs.set(workflowId, arr)
  }

  getToolNames(workflowId: string): string[] {
    const arr = this.logs.get(workflowId) ?? []
    return arr.map((e) => e.name)
  }

  clear(workflowId: string): void {
    this.logs.delete(workflowId)
  }

  clearAll(): void {
    this.logs.clear()
  }
}
