import { describe, it, expect } from 'vitest'
import {
  findLastCompleteAt,
  pushTaskLog,
  type TaskLogEntry
} from '../electron/main/monitor/supervisor-state'

function entry(dmnId: string, completedAt: string): TaskLogEntry {
  return { dmnId, completedAt }
}

describe('supervisor-state 任务日志聚合', () => {
  it('findLastCompleteAt 取该 DMN 最后一条有效完成记录', () => {
    const log = [
      entry('a', '2026-09-01T00:00:00Z'),
      entry('b', '2026-09-01T01:00:00Z'),
      entry('a', '2026-09-01T02:00:00Z')
    ]
    expect(findLastCompleteAt(log, 'a')).toBe(Date.parse('2026-09-01T02:00:00Z'))
    expect(findLastCompleteAt(log, 'b')).toBe(Date.parse('2026-09-01T01:00:00Z'))
  })

  it('findLastCompleteAt 无记录或时间非法返回 null', () => {
    expect(findLastCompleteAt([], 'a')).toBeNull()
    const log = [entry('a', 'not-a-date')]
    expect(findLastCompleteAt(log, 'a')).toBeNull()
  })

  it('pushTaskLog 追加记录并在超限时裁剪（保留最近 max 条）', () => {
    const log = pushTaskLog([], entry('a', '2026-09-01T00:00:00Z'), 2)
    const log2 = pushTaskLog(log, entry('b', '2026-09-01T01:00:00Z'), 2)
    const log3 = pushTaskLog(log2, entry('c', '2026-09-01T02:00:00Z'), 2)
    expect(log3.map((l) => l.dmnId)).toEqual(['b', 'c'])
  })

  it('pushTaskLog 不修改原数组（不可变）', () => {
    const original = [entry('a', '2026-09-01T00:00:00Z')]
    const next = pushTaskLog(original, entry('b', '2026-09-01T01:00:00Z'), 5)
    expect(original.length).toBe(1)
    expect(next.length).toBe(2)
  })
})