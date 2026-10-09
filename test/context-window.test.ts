import { describe, it, expect } from 'vitest'
import { truncateConversation } from '@shared/utils/context-window'
import type { ChatMessage, ContextWindowConfig } from '@shared/types'

/** 构造一条对话消息 */
function msg(role: 'user' | 'assistant', content: string, id?: string): ChatMessage {
  return {
    id: id ?? `${role}_${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    createdAt: Date.now()
  }
}

function cw(partial: Partial<ContextWindowConfig> = {}): ContextWindowConfig {
  return { mode: 'pairs', pairs: 10, chars: 8000, ...partial }
}

describe('truncateConversation - pairs 模式', () => {
  it('消息数小于 pairs*2 时不截断', () => {
    const msgs = [msg('user', 'a'), msg('assistant', 'b'), msg('user', 'c')]
    const r = truncateConversation(msgs, cw({ pairs: 10 }))
    expect(r.kept).toHaveLength(3)
    expect(r.droppedCount).toBe(0)
  })

  it('消息数超过 pairs*2 时只保留最近 N 对', () => {
    const msgs = Array.from({ length: 8 }, (_, i) =>
      i % 2 === 0 ? msg('user', `u${i}`) : msg('assistant', `a${i}`)
    )
    const r = truncateConversation(msgs, cw({ pairs: 2 })) // 保留 2 对 = 4 条
    expect(r.kept).toHaveLength(4)
    expect(r.droppedCount).toBe(4)
    // 保留的是最近 4 条（u4/a5/u6/a7）
    expect(r.kept[0].content).toBe('u4')
    expect(r.kept[r.kept.length - 1].content).toBe('a7')
  })

  it('pairs 模式下 token 双限制：超 chars 时从前面继续裁', () => {
    // 每条 40 字符（~中文 40/1.6=25 token），4 条 = 100 token > chars=60
    const longText = '汉'.repeat(40)
    const msgs = [
      msg('user', longText),
      msg('assistant', longText),
      msg('user', longText),
      msg('assistant', longText)
    ]
    const r = truncateConversation(msgs, cw({ pairs: 10, chars: 60 }))
    // 从后往前：第 4 条 25 token 可入，第 3 条累计 50 可入，第 2 条累计 75 > 60 停
    expect(r.kept.length).toBe(2)
    expect(r.droppedCount).toBe(2)
  })

  it('chars=0 时不做 token 双限制（仅按对截断）', () => {
    const msgs = Array.from({ length: 6 }, (_, i) => msg('user', `u${i}`))
    const r = truncateConversation(msgs, cw({ pairs: 1, chars: 0 })) // 保留 1 对 = 2 条
    expect(r.kept).toHaveLength(2)
    expect(r.droppedCount).toBe(4)
  })
})

describe('truncateConversation - chars 模式', () => {
  it('按 token 估算从后往前收，超限即停', () => {
    // 中文 1.6 字符/token：'汉' * 10 = 6.25→7 token/条；chars=20 → 最多 2 条
    const msgs = Array.from({ length: 5 }, (_, i) => msg('user', '汉'.repeat(10), `m${i}`))
    const r = truncateConversation(msgs, cw({ mode: 'chars', chars: 20 }))
    expect(r.kept.length).toBe(2)
    expect(r.droppedCount).toBe(3)
    // 保留最新 2 条
    expect(r.kept[0].id).toBe('m3')
    expect(r.kept[1].id).toBe('m4')
  })

  it('chars 足够大时不截断', () => {
    const msgs = Array.from({ length: 3 }, (_, i) => msg('user', `u${i}`))
    const r = truncateConversation(msgs, cw({ mode: 'chars', chars: 100000 }))
    expect(r.kept).toHaveLength(3)
    expect(r.droppedCount).toBe(0)
  })
})

describe('truncateConversation - off 模式', () => {
  it('off 模式不截断', () => {
    const msgs = Array.from({ length: 30 }, (_, i) => msg('user', `u${i}`))
    const r = truncateConversation(msgs, cw({ mode: 'off' }))
    expect(r.kept).toHaveLength(30)
    expect(r.droppedCount).toBe(0)
  })

  it('pairs<=0 且 chars<=0 时按 off 处理', () => {
    const msgs = Array.from({ length: 5 }, (_, i) => msg('user', `u${i}`))
    const r = truncateConversation(msgs, cw({ pairs: 0, chars: 0 }))
    expect(r.kept).toHaveLength(5)
  })
})

describe('truncateConversation - 与后端行为一致性', () => {
  it('空数组返回空', () => {
    const r = truncateConversation([], cw())
    expect(r.kept).toHaveLength(0)
    expect(r.droppedCount).toBe(0)
  })

  it('保持正序（不反转）', () => {
    const msgs = Array.from({ length: 6 }, (_, i) => msg('user', `u${i}`))
    const r = truncateConversation(msgs, cw({ pairs: 2 }))
    expect(r.kept.map((m) => m.content)).toEqual(['u2', 'u3', 'u4', 'u5'])
  })
})
