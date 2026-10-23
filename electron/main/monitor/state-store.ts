/**
 * 为什么存在：进程重启后冻结中的任务仍需继续等待用户答复，冻结记录必须跨会话持久化存活。
 * 作用：把冻结记录（会话/冻结任务/问题/时间戳）落盘，提供加载/保存/移除并校验会话 ID，原子写入。
 * 历史兼容：磁盘字段曾用「冻结DMN」、文件名曾用 dmn状态.jsonl（旧 DMN 语义已迁移至记忆工作流），
 * 读取时兜底旧字段/旧文件名并自动迁移，旧语义只保留在本文件的历史数据兼容处。
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'fs'
import { renameFileWithRetry } from '../utils/atomic-write'
import { join } from 'path'
import { validateSessionId } from '../api/session-store'

export interface FreezeRecord {
  会话ID: string
  冻结任务: string
  冻结原因?: string
  冻结问题: string
  冻结时间戳: string
}

interface FreezeRecordInternal {
  taskId: string
  sessionId: string
  question: string
  context?: string
  frozenAt: string
}

function toSpec(record: FreezeRecordInternal): FreezeRecord {
  return {
    会话ID: record.sessionId,
    冻结任务: record.taskId,
    冻结原因: record.context,
    冻结问题: record.question,
    冻结时间戳: record.frozenAt
  }
}

function fromSpec(record: FreezeRecord): FreezeRecordInternal {
  return {
    taskId: record.冻结任务,
    sessionId: record.会话ID,
    question: record.冻结问题,
    context: record.冻结原因,
    frozenAt: record.冻结时间戳
  }
}

export class StateStore {
  private writeChain: Promise<void> = Promise.resolve()
  constructor(private sessionsDir: string) {}

  private serialize<T>(fn: () => T | Promise<T>): Promise<T> {
    const prev = this.writeChain
    let release!: () => void
    this.writeChain = new Promise<void>((r) => { release = r })
    return prev.then(() => Promise.resolve(fn())).finally(release)
  }

  async saveFreeze(record: FreezeRecord): Promise<void> {
    return this.serialize(() => {
      const filePath = this.getFreezeFilePath(record.会话ID)
      mkdirSync(join(filePath, '..'), { recursive: true })
      const records = this.loadAllFreezesInternal(record.会话ID)
      const internal = fromSpec(record)
      const idx = records.findIndex(r => r.taskId === internal.taskId)
      if (idx >= 0) {
        records[idx] = internal
      } else {
        records.push(internal)
      }
      const data = records.map(r => JSON.stringify(toSpec(r))).join('\n') + '\n'
      const tmp = filePath + '.tmp'
      writeFileSync(tmp, data, 'utf-8')
      renameFileWithRetry(tmp, filePath)
    })
  }

  loadFreeze(sessionId: string, taskId: string): FreezeRecord | null {
    const records = this.loadAllFreezesInternal(sessionId)
    const found = records.find(r => r.taskId === taskId)
    return found ? toSpec(found) : null
  }

  loadAllFreezes(sessionId: string): FreezeRecord[] {
    return this.loadAllFreezesInternal(sessionId).map(toSpec)
  }

  private loadAllFreezesInternal(sessionId: string): FreezeRecordInternal[] {
    const filePath = this.getFreezeFilePath(sessionId)
    const legacyPath = join(this.sessionsDir, sessionId, 'dmn状态.jsonl')
    // 历史兼容：优先新文件名；旧文件名存在且新文件不存在时尝试原地迁移，迁移失败回退读旧文件
    let activePath = filePath
    if (!existsSync(filePath) && existsSync(legacyPath)) {
      try {
        mkdirSync(join(filePath, '..'), { recursive: true })
        renameSync(legacyPath, filePath)
      } catch {
        activePath = legacyPath
      }
    }
    if (!existsSync(activePath)) return []
    try {
      const raw = readFileSync(activePath, 'utf-8')
      const lines = raw.split('\n').filter(line => line.trim())
      const result: FreezeRecordInternal[] = []
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line)
          if (parsed && parsed.会话ID) {
            result.push({
              taskId: parsed.冻结任务 ?? parsed.冻结DMN,
              sessionId: parsed.会话ID,
              question: parsed.冻结问题,
              context: parsed.冻结原因,
              frozenAt: parsed.冻结时间戳
            })
          } else if (parsed && parsed.taskId) {
            result.push(parsed as FreezeRecordInternal)
          }
        } catch {
          continue
        }
      }
      return result
    } catch {
      return []
    }
  }

  async clearFreeze(sessionId: string, taskId: string): Promise<void> {
    return this.serialize(() => {
      const records = this.loadAllFreezesInternal(sessionId)
      const filtered = records.filter(r => r.taskId !== taskId)
      const filePath = this.getFreezeFilePath(sessionId)
      if (filtered.length === 0) {
        if (existsSync(filePath)) {
          writeFileSync(filePath, '', 'utf-8')
        }
      } else {
        const data = filtered.map(r => JSON.stringify(toSpec(r))).join('\n') + '\n'
        const tmp = filePath + '.tmp'
        writeFileSync(tmp, data, 'utf-8')
        renameFileWithRetry(tmp, filePath)
      }
    })
  }

  private getFreezeFilePath(sessionId: string): string {
    validateSessionId(sessionId)
    return join(this.sessionsDir, sessionId, '冻结状态.jsonl')
  }
}