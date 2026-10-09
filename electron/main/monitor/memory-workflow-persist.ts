/**
 * 记忆处理工作流——未完成批次持久化（崩溃恢复）

 * 从 memory-workflow-scheduler.ts 拆出（L2 拆分 2/3）：
 * pending 批次文件的读写删与内容重载，全部纯函数化（显式传路径），
 * 不依赖调度器实例状态。
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { BaseDataPaths } from '../models/paths'
import type { RawMemoryEntry } from '../services/raw-memory-next-batch'
import type { PendingBatch } from './memory-workflow-types'

export const PENDING_BATCH_FILE = '未完成批次.json'

export function pendingBatchPathFor(paths: BaseDataPaths): string {
  return join(paths.workflowPending, PENDING_BATCH_FILE)
}

export function readPendingBatchFile(path: string): PendingBatch | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf-8')
    const obj = JSON.parse(raw) as PendingBatch
    if (!obj.batch || !Array.isArray(obj.batch) || obj.batch.length === 0) return null
    if (!obj.nextProgress || !obj.stage) return null
    return obj
  } catch {
    return null
  }
}

export function writePendingBatchFile(path: string, data: PendingBatch): void {
  try {
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
  } catch (err) {
    console.error('[memory-workflow] 持久化未完成批次失败:', err)
  }
}

export function clearPendingBatchFile(path: string): void {
  if (!existsSync(path)) return
  try {
    unlinkSync(path)
  } catch {
    // 忽略删除失败
  }
}

/**
 * 重新加载批次文件内容（崩溃恢复时文件内容可能已变）
 */
export function reloadBatchContents(batch: RawMemoryEntry[]): RawMemoryEntry[] {
  return batch
    .map((e) => {
      try {
        const content = readFileSync(e.path, 'utf-8')
        return { ...e, content }
      } catch {
        return null
      }
    })
    .filter((e): e is RawMemoryEntry => e !== null)
}