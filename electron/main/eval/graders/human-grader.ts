/**
 * 人工型评分器（金标准）：用于校准模型型评分器与高风险场景的初始标注。
 * 通过 IPC 等待前端人工提交 verdict（阻塞/非阻塞两种模式）并维护超时，
 * 不自动运行——是评测三类评分器中引入人的判断的环节。
 */
import type { TrialResult, GradeResult } from '../types'
import { ipcMain } from 'electron'

/**
 * 人工型评分器（第三类，金标准）

 * 业界用途：校准模型型评分器、评估高风险场景

 * 支持两种模式：
 * 1. 阻塞模式：harness 调用 requestGrade，等待前端提交后 resolve
 * 2. 非阻塞模式：前端直接提交评分（评测后校准），存入内存供查询

 * 不自动运行，仅用于：
 * - 模型型评分器校准（每月抽样比对人工 vs 模型）
 * - 能力评估新增任务的初始标注

 * 注：requestGrade 返回的 GradeResult.axis 固定为 'trajectory_quality'，
 * 因为人工型主要用于校准模型型评分器（后者只评 trajectory_quality 轴）
 */
export class HumanGrader {
  private pendingRequests = new Map<
    string,
    {
      resolve: (r: GradeResult) => void
      reject: (e: Error) => void
      timer: NodeJS.Timeout
    }
  >()

  /** 非阻塞模式存储的人工评分（key: `${taskId}:${trial}`） */
  private storedGrades = new Map<string, GradeResult>()

  constructor() {
    // IPC 监听人工标注结果（前端提交）
    ipcMain.handle('eval:submitHumanGrade', (_event, taskId: string, trial: number, pass: boolean, reason: string) => {
      const key = `${taskId}:${trial}`
      const grade: GradeResult = {
        axis: 'trajectory_quality',
        grader: 'human',
        pass,
        score: pass ? 1 : 0,
        reason,
        durationMs: 0
      }
      // 非阻塞模式：存入内存供后续查询（覆盖旧评分）
      this.storedGrades.set(key, grade)

      // 阻塞模式：如有 pending 请求则 resolve
      const pending = this.pendingRequests.get(key)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingRequests.delete(key)
        pending.resolve(grade)
      }
      return { ok: true }
    })
  }

  /**
   * 请求人工评分（异步，返回 Promise 等待人工提交）

   * 调用方应设置超时，避免永久等待
   * 注：实际通知前端需由调用方注入 mainWindow 引用后通过 webContents.send 完成
   */
  async requestGrade(trialResult: TrialResult, timeoutMs = 5 * 60 * 1000): Promise<GradeResult> {
    const key = `${trialResult.taskId}:${trialResult.trial}`
    return new Promise<GradeResult>((resolve, reject) => {
      // 超时保护：5 分钟无人工提交则拒绝
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(key)) {
          this.pendingRequests.delete(key)
          reject(new Error('人工评分超时'))
        }
      }, timeoutMs)
      this.pendingRequests.set(key, { resolve, reject, timer })
    })
  }

  /** 获取已存储的人工评分（非阻塞模式提交的） */
  getStoredGrade(taskId: string, trial: number): GradeResult | undefined {
    return this.storedGrades.get(`${taskId}:${trial}`)
  }

  /** 获取所有已存储的人工评分 */
  getAllStoredGrades(): Map<string, GradeResult> {
    return new Map(this.storedGrades)
  }

  /** 当前待处理请求数（UI 调试用） */
  pendingCount(): number {
    return this.pendingRequests.size
  }

  /** 销毁时清理所有 pending 请求 + IPC handler，防止重建实例时 "second handler" 错误 */
  destroy(): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error('HumanGrader 已销毁'))
    }
    this.pendingRequests.clear()
    this.storedGrades.clear()
    // 移除 IPC handler，避免 destroy 后重建实例时报 "Attempted to register a second handler"
    ipcMain.removeHandler('eval:submitHumanGrade')
  }
}
