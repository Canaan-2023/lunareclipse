import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionStore } from '../electron/main/api/session-store'
import type { ChatMessage } from '../shared/types'

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return {
    id: `m_${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    createdAt: Date.now()
  } as ChatMessage
}

describe('SessionStore 自动标题（2026-08-26 新增）', () => {
  let store: SessionStore
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'session-title-'))
    store = new SessionStore(dir)
  })

  afterEach(() => {
    // SessionStore.persist 是 300ms 去抖异步合并写（atomicWrite 先写 .tmp 再 rename）。
    // 不先 flush 就删目录，定时器触发时目录已消失 → uncaught ENOENT：
    // singleFork 单进程模式下 5 个用例对应 5 个进程级 errors（健康检查用此模式）。
    store.flush()
    rmSync(dir, { recursive: true, force: true })
  })

  it('saveMessages 首条用户消息 → 默认标题被替换', () => {
    const s = store.create()
    expect(s.title).toBe('新会话')
    store.saveMessages(s.id, [msg('user', '帮我修复登录按钮的样式问题')])
    const after = store.get(s.id)
    expect(after?.title).toBe('帮我修复登录按钮的样式问题')
  })

  it('超长首条用户消息 → 截断到 24 字符并加省略号', () => {
    const s = store.create()
    const long = '这段话非常长需要被截断否则会话列表会显示一大坨文字非常难看'
    store.saveMessages(s.id, [msg('user', long)])
    const after = store.get(s.id)
    expect(after?.title?.length).toBe(25) // 24 + …
    expect(after?.title?.endsWith('…')).toBe(true)
  })

  it('用户手动 rename 后 saveMessages 不覆盖标题', () => {
    const s = store.create()
    store.rename(s.id, '用户自定义标题')
    store.saveMessages(s.id, [msg('user', '这条消息不该改标题')])
    const after = store.get(s.id)
    expect(after?.title).toBe('用户自定义标题')
  })

  it('无用户消息（只有系统/助手）时保持默认标题', () => {
    const s = store.create()
    store.saveMessages(s.id, [msg('system', '初始化'), msg('assistant', '你好！')])
    const after = store.get(s.id)
    expect(after?.title).toBe('新会话')
  })

  it('消息含换行/多空格 → 空白归一后再截断', () => {
    const s = store.create()
    store.saveMessages(s.id, [msg('user', '第一条消息\n带换行    和多个空格  继续')])
    const after = store.get(s.id)
    expect(after?.title).toBe('第一条消息 带换行 和多个空格 继续')
  })
})