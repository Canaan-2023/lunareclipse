/**
 * file-history.test.ts
 * 会话级文件编辑审计模块单测：记录/查询/会话隔离/上限淘汰/清理/hash 稳定性。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  MAX_RECORDS_PER_SESSION,
  clearFileHistory,
  getFileHistory,
  recordFileEdit,
  sha256Of
} from '../electron/main/tools/file-history'

function base() {
  return {
    op: 'Write' as const,
    filePath: 'C:/tmp/demo.txt',
    bytes: 5,
    addedLines: 2,
    removedLines: 1,
    sha256: 'abc'
  }
}

beforeEach(() => {
  clearFileHistory()
})

describe('file-history 会话级编辑审计', () => {
  it('记录 Write 并可查询（字段完整、id 递增）', () => {
    const r1 = recordFileEdit({ ...base(), sessionId: 's1', filePath: 'a.txt' })
    const r2 = recordFileEdit({ ...base(), sessionId: 's1', filePath: 'b.txt', op: 'Edit' })
    const history = getFileHistory('s1')
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({ id: r1.id, sessionId: 's1', op: 'Write', filePath: 'a.txt' })
    expect(history[1]).toMatchObject({ id: r2.id, sessionId: 's1', op: 'Edit', filePath: 'b.txt' })
    expect(history[0].timestamp).toBeGreaterThan(0)
    expect(r2.id).toBeGreaterThan(r1.id)
  })

  it('会话隔离：不同 session 互不可见', () => {
    recordFileEdit({ ...base(), sessionId: 's1', filePath: 'a.txt' })
    recordFileEdit({ ...base(), sessionId: 's2', filePath: 'b.txt' })
    expect(getFileHistory('s1')).toHaveLength(1)
    expect(getFileHistory('s2')).toHaveLength(1)
    expect(getFileHistory('s1')[0].filePath).toBe('a.txt')
  })

  it('未传 sessionId 归入 global，且按 session 清理不影响 global', () => {
    recordFileEdit({ ...base(), filePath: 'g.txt' })
    recordFileEdit({ ...base(), sessionId: 's1', filePath: 's.txt' })
    expect(getFileHistory()).toHaveLength(1)
    expect(getFileHistory('global')).toHaveLength(1)
    clearFileHistory('s1')
    expect(getFileHistory()).toHaveLength(1)
  })

  it('超过上限时淘汰最旧记录、保留最近 MAX_RECORDS_PER_SESSION 条', () => {
    for (let i = 0; i < MAX_RECORDS_PER_SESSION + 5; i++) {
      recordFileEdit({ ...base(), sessionId: 's1', filePath: `f${i}.txt` })
    }
    const history = getFileHistory('s1')
    expect(history).toHaveLength(MAX_RECORDS_PER_SESSION)
    // 前 5 条被淘汰，第一条为 f5.txt；id 仍保持插入顺序
    expect(history[0].filePath).toBe('f5.txt')
    expect(history[history.length - 1].filePath).toBe(
      `f${MAX_RECORDS_PER_SESSION + 4}.txt`
    )
  })

  it('getFileHistory 返回只读快照（改动副本不影响存储）', () => {
    recordFileEdit({ ...base(), sessionId: 's1', filePath: 'a.txt' })
    const snapshot = getFileHistory('s1')
    snapshot[0].filePath = 'HACKED'
    expect(getFileHistory('s1')[0].filePath).toBe('a.txt')
  })

  it('clearFileHistory 清空指定会话或全部', () => {
    recordFileEdit({ ...base(), sessionId: 's1' })
    recordFileEdit({ ...base(), sessionId: 's2' })
    clearFileHistory('s1')
    expect(getFileHistory('s1')).toHaveLength(0)
    expect(getFileHistory('s2')).toHaveLength(1)
    clearFileHistory()
    expect(getFileHistory('s2')).toHaveLength(0)
  })

  it('sha256Of 稳定且区分内容', () => {
    const h1 = sha256Of('hello')
    const h2 = sha256Of('hello')
    const h3 = sha256Of('hello world')
    expect(h1).toBe(h2)
    expect(h1).not.toBe(h3)
    // 64 位 16 进制
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
  })
})