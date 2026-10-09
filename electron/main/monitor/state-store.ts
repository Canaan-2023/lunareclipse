/**
 * 为什么存在：进程重启后冻结中的任务仍需继续等待用户答复，冻结记录必须跨会话持久化存活。
 * 作用：把冻结记录（会话/冻结 DMN/问题/时间戳）落盘，提供加载/保存/移除并校验会话 ID，原子写入。
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { validateSessionId } from '../api/session-store'

export interface FreezeRecord {
  会话ID: string
  冻结DMN: string
  冻结原因?: string
  冻结问题: string
  冻结时间戳: string
}

interface FreezeRecordInternal {
  dmnId: string
  sessionId: string
  question: string
  context?: string
  frozenAt: string
}

function toSpec(record: FreezeRecordInternal): FreezeRecord {
  return {
    会话ID: record.sessionId,
    冻结DMN: record.dmnId,
    冻结原因: record.context,
    冻结问题: record.question,
    冻结时间戳: record.frozenAt
  }
}

function fromSpec(record: FreezeRecord): FreezeRecordInternal {
  return {
    dmnId: record.冻结DMN,
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
      const idx = records.findIndex(r => r.dmnId === internal.dmnId)
      if (idx >= 0) {
        records[idx] = internal
      } else {
        records.push(internal)
      }
      const data = records.map(r => JSON.stringify(toSpec(r))).join('\n') + '\n'
      const tmp = filePath + '.tmp'
      writeFileSync(tmp, data, 'utf-8')
      renameSync(tmp, filePath)
    })
  }

  loadFreeze(sessionId: string, dmnId: string): FreezeRecord | null {
    const records = this.loadAllFreezesInternal(sessionId)
    const found = records.find(r => r.dmnId === dmnId)
    return found ? toSpec(found) : null
  }

  loadAllFreezes(sessionId: string): FreezeRecord[] {
    return this.loadAllFreezesInternal(sessionId).map(toSpec)
  }

  private loadAllFreezesInternal(sessionId: string): FreezeRecordInternal[] {
    const filePath = this.getFreezeFilePath(sessionId)
    if (!existsSync(filePath)) return []
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const lines = raw.split('\n').filter(line => line.trim())
      const result: FreezeRecordInternal[] = []
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line)
          if (parsed && parsed.会话ID) {
            result.push({
              dmnId: parsed.冻结DMN,
              sessionId: parsed.会话ID,
              question: parsed.冻结问题,
              context: parsed.冻结原因,
              frozenAt: parsed.冻结时间戳
            })
          } else if (parsed && parsed.dmnId) {
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

  async clearFreeze(sessionId: string, dmnId: string): Promise<void> {
    return this.serialize(() => {
      const records = this.loadAllFreezesInternal(sessionId)
      const filtered = records.filter(r => r.dmnId !== dmnId)
      const filePath = this.getFreezeFilePath(sessionId)
      if (filtered.length === 0) {
        if (existsSync(filePath)) {
          writeFileSync(filePath, '', 'utf-8')
        }
      } else {
        const data = filtered.map(r => JSON.stringify(toSpec(r))).join('\n') + '\n'
        const tmp = filePath + '.tmp'
        writeFileSync(tmp, data, 'utf-8')
        renameSync(tmp, filePath)
      }
    })
  }

  private getFreezeFilePath(sessionId: string): string {
    validateSessionId(sessionId)
    return join(this.sessionsDir, sessionId, 'dmn状态.jsonl')
  }
}
