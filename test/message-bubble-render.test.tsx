/**
 * MessageBubble 前端来源展示渲染实测（T6）。
 * 为什么用 react-dom/server：项目 vitest 环境为 node（无 jsdom），来源徽章/审查标注是
 *   纯展示文本，renderToStaticMarkup 即可验证 DOM 输出，无需引入 jsdom + testing-library。
 * 为什么存在：T4 给消息气泡加了「⚖️ 审查 + 代码审查 · AI 独立轮次」与 AI 活动来源徽章
 *   （子AGENT/网页搜索/文件读取/工具返回），必须实测渲染输出而不是只测 shared 聚合函数。
 */
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/types'
import type { ToolCall } from '@shared/types'
import { MessageBubble } from '../src/components/Chat/MessageBubble'

describe('MessageBubble 消息来源展示渲染', () => {
  const baseToolCall = (toolName: string): ToolCall => ({
    id: `tc_${toolName}`,
    toolName,
    toolLabel: toolName,
    category: 'network',
    args: {},
    status: 'done',
    startedAt: 1728200000000
  })

  // 用例1：用户消息 → 「用户」标签，无活动来源徽章
  it('用户消息渲染「用户」来源标签', () => {
    const msg: ChatMessage = {
      id: 'user_1',
      role: 'user',
      content: '你好',
      createdAt: 1728200000000
    }
    const html = renderToStaticMarkup(<MessageBubble message={msg} />)
    expect(html).toContain('用户')
    expect(html).not.toContain('⚖️')
  })

  // 用例2：代码审查消息（assistant + review_ 前缀 id）→ 「⚖️ 审查 / 代码审查 / AI 独立轮次」
  it('代码审查消息渲染「审查 + 代码审查 · AI 独立轮次」标注', () => {
    const msg: ChatMessage = {
      id: 'review_1_1728200000000',
      role: 'assistant',
      content: '审查通过',
      createdAt: 1728200000000
    }
    const html = renderToStaticMarkup(<MessageBubble message={msg} />)
    expect(html).toContain('⚖️ 审查')
    expect(html).toContain('代码审查')
    expect(html).toContain('AI 独立轮次')
    // 审查发言代表用户侧 → 不应出现 AI 名（月蚀）活动徽章区
    expect(html).not.toContain('网页搜索')
  })

  // 用例3：AI 消息带多工具活动 → 全部来源徽章（网页搜索/文件读取/子AGENT/工具返回）
  it('AI 消息按工具渲染活动来源徽章（网页搜索/文件读取/子AGENT/工具返回）', () => {
    const msg: ChatMessage = {
      id: 'ai_1',
      role: 'assistant',
      content: '已汇总',
      createdAt: 1728200000000,
      toolCalls: [
        baseToolCall('web_search'),
        baseToolCall('Read'),
        baseToolCall('Agent'),
        baseToolCall('fly_command')
      ]
    }
    const html = renderToStaticMarkup(<MessageBubble message={msg} />)
    expect(html).toContain('网页搜索')
    expect(html).toContain('文件读取')
    expect(html).toContain('子AGENT消息')
    expect(html).toContain('工具返回')
  })

  // 用例4：AI 消息 rows 优先（web_extract + Grep + 无工具行）→ 去重保序且不重复
  it('AI 消息按 rows 聚合活动来源（去重保序）', () => {
    const msg: ChatMessage = {
      id: 'ai_2',
      role: 'assistant',
      content: '已处理',
      createdAt: 1728200000000,
      rows: [
        { kind: 'toolCall', rowId: 1, turnId: 't1', createdAt: 1728200000000, createdAtSeq: 1, toolCallId: 'a', toolName: 'web_extract', status: 'success' },
        { kind: 'toolCall', rowId: 2, turnId: 't1', createdAt: 1728200000000, createdAtSeq: 2, toolCallId: 'b', toolName: 'Grep', status: 'success' },
        { kind: 'subagent', rowId: 3, turnId: 't1', createdAt: 1728200000000, createdAtSeq: 3, toolCallId: 'c', toolName: 'Agent', subagentType: 'general', status: 'success', name: 'x' }
      ]
    }
    const html = renderToStaticMarkup(<MessageBubble message={msg} />)
    // 去重保序：网页搜索只聚合出一个徽章——一个徽章 = span 文本 1 次 + title 属性 1 次，
    // 全文出现 2 次即代表唯一徽章；出现 4 次则说明重复渲染了第二个徽章
    expect(html.match(/网页搜索/g)?.length).toBe(2)
    expect(html).toContain('文件读取')
    expect(html).toContain('子AGENT消息')
  })

  // 用例5：非审查 user + activation 的审查指令消息 → 整体隐藏（不冒泡）
  it('审查指令 phaseMsg（user+activation+review id）不渲染', () => {
    const msg: ChatMessage = {
      id: 'review_1_1728200000000',
      role: 'user',
      activation: true,
      content: '【代码审查】请审查',
      createdAt: 1728200000000
    }
    const html = renderToStaticMarkup(<MessageBubble message={msg} />)
    expect(html).toBe('')
  })
})