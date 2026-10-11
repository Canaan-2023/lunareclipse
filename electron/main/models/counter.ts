/**
 * 顺序计数器：记忆/NNG/RAW 等按序号命名共用的递增序号来源。
 * 独立成文件以统一“读-递增-原子写回（临时文件+rename）”的实现，
 * 避免各处自行维护导致序号冲突或丢号。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { dirname, join } from 'path'

export interface Counter {
  下一个序号: number
}

export function readCounter(counterPath: string): Counter {
  if (!existsSync(counterPath)) {
    return { 下一个序号: 1 }
  }
  try {
    const raw = readFileSync(counterPath, 'utf-8')
    const parsed = JSON.parse(raw) as Counter
    if (typeof parsed.下一个序号 !== 'number' || parsed.下一个序号 < 1) {
      return { 下一个序号: 1 }
    }
    return { 下一个序号: parsed.下一个序号 }
  } catch {
    return { 下一个序号: 1 }
  }
}

export function writeCounter(counterPath: string, counter: Counter): void {
  mkdirSync(dirname(counterPath), { recursive: true })
  const tmp = join(dirname(counterPath), `.counter.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(tmp, JSON.stringify(counter, null, 2), 'utf-8')
  renameSync(tmp, counterPath)
}

export function consumeNextSeq(counterPath: string): number {
  for (let attempt = 0; attempt < 5; attempt++) {
    const counter = readCounter(counterPath)
    const seq = counter.下一个序号
    counter.下一个序号 = seq + 1
    try {
      writeCounter(counterPath, counter)
      return seq
    } catch {
      if (attempt === 4) throw new Error(`consumeNextSeq: failed after 5 attempts`)
    }
  }
  throw new Error('consumeNextSeq: unreachable')
}
