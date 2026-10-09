/**
 * 为什么存在：事中需要知道"某 DMN 已用过哪些工具"，避免重复调用或为恢复/审计提供上下文。
 * 作用：按 dmnId 记录每次工具调用（名称/参数/时间戳），提供 log/reset/getToolNames 内存态查询。
 */

export interface ToolCallLogEntry {
  name: string
  params: Record<string, unknown>
  timestamp: string
}

export class ToolCallLogger {
  private logs = new Map<string, ToolCallLogEntry[]>()

  reset(dmnId: string): void {
    this.logs.set(dmnId, [])
  }

  log(dmnId: string, name: string, params: Record<string, unknown>): void {
    const arr = this.logs.get(dmnId) ?? []
    arr.push({ name, params, timestamp: new Date().toISOString() })
    this.logs.set(dmnId, arr)
  }

  getToolNames(dmnId: string): string[] {
    const arr = this.logs.get(dmnId) ?? []
    return arr.map((e) => e.name)
  }

  clear(dmnId: string): void {
    this.logs.delete(dmnId)
  }

  clearAll(): void {
    this.logs.clear()
  }
}
