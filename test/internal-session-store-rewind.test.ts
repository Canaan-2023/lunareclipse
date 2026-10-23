/**
 * InternalSessionStore.truncateMessagesByOwner（REWIND 回退的 AI 上下文层）契约测试。
 *
 * 为什么存在：REWIND 是两层同步的破坏性操作——用户展示层由 SessionStore.saveMessages
 * 截断（已有测试网覆盖），AI 上下文层必须把「目标消息之后」的内部消息同步截断/清理，
 * 否则下一轮锚点注入仍会带上被撤消息。本文件钉住 AI 层的全部边界：
 * - 含目标消息的会话：截断到目标（含）+ 清空失效摘要（旧摘要描述完整历史，截断后失真）；
 * - 只含未来消息的会话：整体删除（回退时间点之后才产生，回退后从未存在过），
 *   且 active 承接指针指向它时一并清除；
 * - 无关会话：原样保留（历史冻结会话不受影响）；
 * - 竞态防护：500ms 延迟维护队列（enqueueInternalSessionJob）可能携带被删未来消息
 *   append 回来，黑名单（rewindDeletedIds）必须拦截——含多轮回退黑名单累积场景；
 * - 目标已是最后一条：无截断、摘要保留（摘要基于目标之前的历史仍有效）。
 *
 * 测试风格与 internal-session.test.ts 对齐：真磁盘临时目录 + 真 InternalSessionStore，
 * 不 mock electron——该 store 不依赖 electron，端到端语义可在纯 Node 上验证。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'
import { InternalSessionStore } from '../electron/main/services/internal-session-store'
import type { InternalMessage } from '@shared/types'

const OWNER = 'sess_rewind_owner'
const TEST_DIR = join(tmpdir(), `internal-session-store-rewind-test-${process.pid}-${Date.now()}`)

function mkMsg(id: string, role: InternalMessage['role'] = 'user', content = '内容'): InternalMessage {
  return { id, role, content, createdAt: 1725000000000 }
}

describe('InternalSessionStore.truncateMessagesByOwner (REWIND AI 层)', () => {
  let store: InternalSessionStore

  beforeEach(() => {
    mkdirSync(join(TEST_DIR, 'sessions'), { recursive: true })
    store = new InternalSessionStore(() => join(TEST_DIR, 'sessions'))
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('含目标消息的会话：截断到目标（含）并清空失效摘要', async () => {
    const s = store.create(OWNER, {
      title: '会话一',
      summary: '旧摘要（含被撤消息）',
      messages: [mkMsg('u1'), mkMsg('a1', 'assistant'), mkMsg('u2'), mkMsg('a2', 'assistant')]
    })
    const res = await store.truncateMessagesByOwner(OWNER, 'a1', ['u2', 'a2'])
    expect(res).toEqual({ truncated: 2, deletedSessions: 0 })
    const after = store.get(OWNER, s.id)
    expect(after).not.toBeNull()
    expect(after!.messages.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(after!.summary).toBe('')
  })

  it('只含未来消息的会话：整体删除；active 承接指针一并清除', async () => {
    const future = store.create(OWNER, { title: '未来会话', messages: [mkMsg('u2'), mkMsg('a2', 'assistant')] })
    store.setActive(OWNER, future.id)
    const res = await store.truncateMessagesByOwner(OWNER, 'a1', ['u2', 'a2'])
    expect(res).toEqual({ truncated: 0, deletedSessions: 1 })
    expect(store.get(OWNER, future.id)).toBeNull()
    expect(store.getActive(OWNER)).toBeNull()
  })

  it('无关会话（不含目标也不含被删消息）：原样保留', async () => {
    const keep = store.create(OWNER, { title: '无关会话', messages: [mkMsg('x1'), mkMsg('x2', 'assistant')] })
    const res = await store.truncateMessagesByOwner(OWNER, 'a1', ['u2', 'a2'])
    expect(res).toEqual({ truncated: 0, deletedSessions: 0 })
    const after = store.get(OWNER, keep.id)
    expect(after).not.toBeNull()
    expect(after!.messages.map((m) => m.id)).toEqual(['x1', 'x2'])
  })

  it('目标已是最后一条：消息不动，摘要保留', async () => {
    const s = store.create(OWNER, { title: '会话', summary: '有效摘要', messages: [mkMsg('u1'), mkMsg('a1', 'assistant')] })
    const res = await store.truncateMessagesByOwner(OWNER, 'a1', [])
    expect(res).toEqual({ truncated: 0, deletedSessions: 0 })
    const after = store.get(OWNER, s.id)
    expect(after).not.toBeNull()
    expect(after!.messages.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(after!.summary).toBe('有效摘要')
  })

  it('竞态防护：回退后延迟维护队列携带被删消息 append 时被过滤', async () => {
    const s = store.create(OWNER, { title: '会话', messages: [mkMsg('u1'), mkMsg('a1', 'assistant')] })
    await store.truncateMessagesByOwner(OWNER, 'a1', ['u2', 'a2'])
    // 模拟 500ms 延迟 job 到达：携带被删的未来消息 + 一条未被删的新消息
    await store.appendMessages(OWNER, s.id, [mkMsg('u2'), mkMsg('a2', 'assistant'), mkMsg('u3')])
    const after = store.get(OWNER, s.id)
    expect(after).not.toBeNull()
    // u2/a2 被过滤，u3（新轮消息，不在黑名单）正常追加
    expect(after!.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u3'])
  })

  it('多轮回退黑名单累积：早轮被删消息的排队 job 仍被过滤', async () => {
    const s = store.create(OWNER, { title: '会话', messages: [mkMsg('u1'), mkMsg('a1', 'assistant'), mkMsg('u2')] })
    await store.truncateMessagesByOwner(OWNER, 'a1', ['u2'])
    await store.truncateMessagesByOwner(OWNER, 'u1', ['a1', 'u2'])
    // 第一次回退前排队的 job 携带 u2 到达 → 黑名单（并集语义）仍须过滤
    await store.appendMessages(OWNER, s.id, [mkMsg('u2')])
    const after = store.get(OWNER, s.id)
    expect(after).not.toBeNull()
    expect(after!.messages.map((m) => m.id)).toEqual(['u1'])
  })

  it('空签名（无任何会话）返回 0 且不抛错', async () => {
    const res = await store.truncateMessagesByOwner(OWNER, 'a1', ['u2'])
    expect(res).toEqual({ truncated: 0, deletedSessions: 0 })
  })
})