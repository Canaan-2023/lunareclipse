/**
 * 月蚀 CLI TUI 渲染实测：buildFrameElement 按 RenderLine 类型着色渲染消息与工具调用行。
 * 为什么用 ink.renderToString：CLI 渲染走 Ink/React（真实终端帧与 autopilot 帧导出共用
 *   buildFrameElement），node 环境下 renderToString 可直接得到布局文本，无需 TTY。
 * 为什么存在：CLI UI 优化新增 AiActivity 状态机与 RenderLine 分级渲染（用户/思考/工具/错误），
 *   必须实测帧内文本而非只信类型检查。
 */
import * as React from 'react'
import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/types'
import type { ToolCall } from '@shared/types'
import { CliApp, type TuiWs } from '../electron/main/cli-tui/App'

function fakeWs(): TuiWs {
  return { readyState: 0, send: () => undefined, on: () => undefined, off: () => undefined }
}

const tool = (id: string, toolName: string, toolLabel: string, status: ToolCall['status']): ToolCall => ({
  id,
  toolName,
  toolLabel,
  category: 'mechanism',
  args: {},
  status,
  startedAt: 1728200000000,
  endedAt: status === 'done' || status === 'error' ? 1728200001000 : undefined
})

describe('月蚀 CLI TUI 渲染（buildFrameElement）', () => {
  const messages: ChatMessage[] = [
    { id: 'u1', role: 'user', content: '帮我查一下月蚀的源码位置', createdAt: 1 },
    {
      id: 'a1',
      role: 'assistant',
      content: '已找到：项目在 D:\\ABYSSAC-lunareclipse。',
      createdAt: 2,
      reasoning: '用户需要定位源码，先搜索工作区。',
      toolCalls: [tool('t1', 'web_search', '网页搜索', 'done'), tool('t2', 'Grep', '文件搜索', 'running')]
    },
    { id: 'a2', role: 'assistant', content: '(已中止) 推理被中断', createdAt: 3, aborted: true },
    { id: 'a3', role: 'assistant', content: '', createdAt: 4, recalled: true },
    { id: 's1', role: 'system', content: '系统提示：仅限工作区', createdAt: 5 }
  ]

  it('渲染标题栏、会话与连接状态', () => {
    const frame = renderToString(
      <CliApp
        ws={fakeWs()}
        initialSessionId="cli_test_1"
        initialMessages={messages}
        port={62002}
        autopilot="测试消息"
        onExit={() => undefined}
        newSession={() => ({ id: 'x', messages: [] })}
        switchSession={() => null}
      />
    )
    expect(frame).toContain('月蚀 CLI')
    expect(frame).toContain('cli_test_1')
    expect(frame).toContain('端口 62002')
  })

  it('用户消息、推理摘要与 AI 正文进入消息区', () => {
    const frame = renderToString(
      <CliApp
        ws={fakeWs()}
        initialSessionId="cli_test_1"
        initialMessages={messages}
        port={62002}
        autopilot="测试消息"
        onExit={() => undefined}
        newSession={() => ({ id: 'x', messages: [] })}
        switchSession={() => null}
      />
    )
    expect(frame).toContain('❯ 帮我查一下月蚀的源码位置')
    expect(frame).toContain('思考')
    expect(frame).toContain('已找到：项目在')
    expect(frame).toContain('月蚀 CLI')
  })

  it('工具调用行渲染：完成 ✓ / 进行中 正在调用… / 失败 ✗', () => {
    const single: ChatMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        content: '汇总',
        createdAt: 1,
        toolCalls: [
          tool('t1', 'web_search', '网页搜索', 'done'),
          tool('t2', 'Grep', '文件搜索', 'running'),
          tool('t3', 'jina_ex', '抽取失败', 'error')
        ]
      }
    ]
    const frame = renderToString(
      <CliApp
        ws={fakeWs()}
        initialSessionId="cli_test_2"
        initialMessages={single}
        port={62002}
        autopilot="测试消息"
        onExit={() => undefined}
        newSession={() => ({ id: 'x', messages: [] })}
        switchSession={() => null}
      />
    )
    expect(frame).toContain('✓ 网页搜索')
    expect(frame).toContain('正在调用 文件搜索…')
    expect(frame).toContain('✗ 抽取失败')
  })

  it('中止、撤回与 system 角色消息正确进入消息区', () => {
    const frame = renderToString(
      <CliApp
        ws={fakeWs()}
        initialSessionId="cli_test_3"
        initialMessages={messages}
        port={62002}
        autopilot="测试消息"
        onExit={() => undefined}
        newSession={() => ({ id: 'x', messages: [] })}
        switchSession={() => null}
      />
    )
    expect(frame).toContain('(已中止)')
    expect(frame).toContain('(已撤回)')
    expect(frame).toContain('system: 系统提示')
  })
})