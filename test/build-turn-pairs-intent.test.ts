/**
 * buildTurnPairsIntent 蒸馏意图组装专项测试（2026-10-07 升级）。
 * 为什么存在：意图不再只是 user/assistant 的 content 摘录，而是窗口内完整消息形态
 *   ——调用者 AI 的思考（reasoning）与输出（tool_calls 声明）、此前轮次的工具消息链
 *   一并可见，蒸馏器与调取工具的那个 AI 同视角；本文件独立锁定该契约，避免 wire
 *   测试只覆盖"蒸馏被调用"而漏掉"蒸馏器看到了什么"。
 */
import { describe, expect, it } from 'vitest'
import { buildTurnPairsIntent } from '../electron/main/api/llm'

interface ItMsg {
  role: string
  content: string | null
  reasoning_content?: string
  reasoning?: string
  tool_call_id?: string
  tool_calls?: Array<{ function: { name: string; arguments: string } }>
}

const u = (c: string): ItMsg => ({ role: 'user', content: c })
const a = (c: string): ItMsg => ({ role: 'assistant', content: c })

describe('buildTurnPairsIntent（完整消息形态）', () => {
  it('pairs<=0 返回空串（等同旧行为：不带历史上下文）', () => {
    const msgs = [u('你好'), a('你好！')]
    expect(buildTurnPairsIntent(msgs, 2, 0)).toBe('')
    expect(buildTurnPairsIntent(msgs, 2, -1)).toBe('')
  })

  it('窗口回溯最近 N 对 user 对话，旧轮不进入（宁多勿空仍生效）', () => {
    const msgs = [u('Q1'), a('A1'), u('Q2'), a('A2'), u('当前提问')]
    const intent = buildTurnPairsIntent(msgs, 5, 2)
    expect(intent).toContain('user: 当前提问')
    expect(intent).toContain('user: Q2')
    expect(intent).toContain('assistant: A2')
    expect(intent).not.toContain('Q1')
    expect(intent).not.toContain('A1')
  })

  it('assistant 思考（reasoning_content：wire 字段名）进入意图', () => {
    const msgs = [
      u('读 A 文件'),
      { role: 'assistant', content: '', reasoning_content: '用户想了解项目结构，先读入口文件' }
    ]
    const intent = buildTurnPairsIntent(msgs, 2, 1)
    expect(intent).toContain('assistant 思考: 用户想了解项目结构，先读入口文件')
    // content 为空但思考存在：意图不能为空（调用者 AI 的决策链就在思考里）
    expect(intent.trim().length).toBeGreaterThan(0)
  })

  it('assistant 思考（reasoning：ApiMessage 内部字段名）同样进入意图', () => {
    const msgs = [
      u('查天气'),
      { role: 'assistant', content: '', reasoning: '需要调 web_search 获取实时天气' }
    ]
    const intent = buildTurnPairsIntent(msgs, 2, 1)
    expect(intent).toContain('assistant 思考: 需要调 web_search 获取实时天气')
  })

  it('assistant 工具调用声明（tool_calls：调用者 AI 当时的输出）进入意图', () => {
    const msgs = [
      u('搜一下月食'),
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'web_search', arguments: '{"query":"月食"}' } }]
      }
    ]
    const intent = buildTurnPairsIntent(msgs, 2, 1)
    expect(intent).toContain('assistant 调用工具: web_search({"query":"月食"})')
  })

  it('此前轮次的 tool 消息（工具消息链）进入意图，标注 tool_call_id', () => {
    const msgs = [
      u('先查目录再读文件'),
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'Glob', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_glob_1', content: 'src/main.ts\nsrc/utils.ts' },
      u('读 main.ts'),
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'Read', arguments: '{"path":"src/main.ts"}' } }] }
    ]
    // upToIndex = 5（第二条 tool 消息，不含自身）；窗口 2 覆盖最近 2 个 user 提问
    const intent = buildTurnPairsIntent(msgs, 5, 2)
    expect(intent).toContain('tool(call_glob_1): src/main.ts\nsrc/utils.ts')
    expect(intent).toContain('assistant 调用工具: Glob({})')
    // 当前轮的调用者声明（Read）也在窗口内（index 4 < upToIndex），属正常行为
    expect(intent).toContain('assistant 调用工具: Read')
  })

  it('窗口内 system 消息保留（与调用者同视角）', () => {
    const msgs = [
      { role: 'system', content: '你是月蚀助手' },
      u('你好')
    ]
    const intent = buildTurnPairsIntent(msgs, 2, 1)
    expect(intent).toContain('system: 你是月蚀助手')
  })

  it('工具消息链顺序与对话一致（思考→调用→工具结果穿插呈现）', () => {
    const msgs = [
      u('查天气再读文件'),
      {
        role: 'assistant',
        content: '先查天气',
        reasoning: '天气需要实时数据，先 web_search',
        tool_calls: [{ function: { name: 'web_search', arguments: '{"query":"北京天气"}' } }]
      },
      { role: 'tool', tool_call_id: 'call_w', content: '晴 25°C' }
    ]
    const intent = buildTurnPairsIntent(msgs, 3, 1)
    const idxContent = intent.indexOf('assistant: 先查天气')
    const idxThought = intent.indexOf('assistant 思考: 天气需要实时数据，先 web_search')
    const idxCall = intent.indexOf('assistant 调用工具: web_search')
    const idxTool = intent.indexOf('tool(call_w): 晴 25°C')
    // 全部出现，且顺序 = 正文 → 思考 → 调用声明 → 工具结果
    expect(idxContent).toBeGreaterThanOrEqual(0)
    expect(idxThought).toBeGreaterThan(idxContent)
    expect(idxCall).toBeGreaterThan(idxThought)
    expect(idxTool).toBeGreaterThan(idxCall)
  })
})