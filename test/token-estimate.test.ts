import { describe, it, expect } from 'vitest'
import { estimateTokens, estimateMessagesTokens, truncateByFifo } from '@shared/utils/token-estimate'

describe('estimateTokens', () => {
  it('空字符串返回 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('纯英文按 ~4 字符/token 估算', () => {
    // 8 个 ASCII 字符 → ceil(8/4) = 2
    expect(estimateTokens('abcdefgh')).toBe(2)
  })

  it('纯中文按 ~1.6 字符/token 估算', () => {
    // 4 个非 ASCII 字符 → ceil(4/1.6) = ceil(2.5) = 3
    expect(estimateTokens('你好世界')).toBe(3)
  })

  it('中英混合文本正确累加', () => {
    // 4 ASCII + 2 中文 → ceil(4/4 + 2/1.6) = ceil(1 + 1.25) = ceil(2.25) = 3
    expect(estimateTokens('test你好')).toBe(3)
  })
})

describe('estimateMessagesTokens', () => {
  it('多条消息 token 累加', () => {
    const msgs = [
      { content: 'abcd' },       // 1
      { content: '你好世界' }     // 3
    ]
    expect(estimateMessagesTokens(msgs)).toBe(4)
  })

  it('空数组返回 0', () => {
    expect(estimateMessagesTokens([])).toBe(0)
  })
})

describe('truncateByFifo', () => {
  it('budget <= 0 时不截断（关闭模式）', () => {
    const msgs = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' }
    ]
    const result = truncateByFifo(msgs, 0)
    expect(result.droppedCount).toBe(0)
    expect(result.messages).toHaveLength(2)
  })

  it('budget 不足以容纳 reservedForReply 时全部丢弃', () => {
    const msgs = [{ role: 'user', content: 'hi' }]
    const result = truncateByFifo(msgs, 100, 200)
    expect(result.droppedCount).toBe(1)
    expect(result.messages).toHaveLength(0)
  })

  it('system 消息始终保留', () => {
    const msgs = [
      { role: 'system', content: 'system prompt' },  // 4 tokens
      { role: 'user', content: 'hello world' },       // 3 tokens
      { role: 'assistant', content: 'hi there friend' } // 4 tokens
    ]
    // budget=10, reserved=5, available=5. system=4, remaining=1. user=3 → 1-3<0, 丢弃
    const result = truncateByFifo(msgs, 10, 5)
    expect(result.messages[0].role).toBe('system')
    expect(result.droppedCount).toBeGreaterThan(0)
  })

  it('budget 充足时保留全部消息', () => {
    const msgs = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' }
    ]
    const result = truncateByFifo(msgs, 10000)
    expect(result.droppedCount).toBe(0)
    expect(result.messages).toHaveLength(2)
  })

  it('budget 不足时从最旧的非 system 消息开始丢弃（FIFO）', () => {
    const msgs = [
      { role: 'user', content: 'aaaa' },           // 1 token
      { role: 'assistant', content: 'bbbb' },       // 1 token
      { role: 'user', content: 'cccc' },            // 1 token
      { role: 'assistant', content: 'dddd' }        // 1 token
    ]
    // available = 22 - 20 = 2，恰好保留最后 2 条
    const result = truncateByFifo(msgs, 22, 20)
    expect(result.messages.map((m) => m.content)).toEqual(['cccc', 'dddd'])
    expect(result.droppedCount).toBe(2)
  })

  it('保留的消息顺序正确（旧→新）', () => {
    const msgs = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' }
    ]
    const result = truncateByFifo(msgs, 10000)
    expect(result.messages.map((m) => m.content)).toEqual(['first', 'second', 'third'])
  })

  it('system 消息在前，非 system 消息保持时间顺序在后', () => {
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'system', content: 'sys2' },
      { role: 'user', content: 'u2' }
    ]
    const result = truncateByFifo(msgs, 10000)
    const roles = result.messages.map((m) => m.role)
    // system 消息在前
    expect(roles.indexOf('system')).toBeLessThan(roles.indexOf('user'))
    expect(roles.indexOf('system')).toBeLessThan(roles.indexOf('assistant'))
  })
})
