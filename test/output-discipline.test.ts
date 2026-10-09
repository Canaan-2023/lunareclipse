/**
 * 月蚀输出纪律机制层 — 回归锁定
 *
 * 锁定三件套（用户强制要求，机制层生效，不依赖提示词软约束）：
 * 1. stripThinkingLeak：正文落盘前剥离显式思考块（XML 标签 / thinking fence / 嵌套），
 *    思考不得以语义方式进入会话历史正文。
 * 2. buildContinuationMessages：断线续接只带已产出正文；思考仅随 partial 消息以
 *    reasoning 字段回传（DeepSeek 思考模式 wire 协议要求，缺失即 400），不回灌进 content。
 * 3. OUTPUT_DISCIPLINE_PROMPT：作为独立 boot 段（output_discipline）恒注入系统消息，
 *    与 sys_prompt 副本解耦——副本覆盖不再整体吞掉输出章程。
 */
import { describe, it, expect } from 'vitest'
import {
  stripThinkingLeak,
  buildContinuationMessages,
  OUTPUT_DISCIPLINE_PROMPT
} from '../shared/utils/output-discipline'
import { createSegmentManifest } from '../electron/main/prompts/segments'
import type { ChatMessage } from '../shared/types'

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: partial.id ?? `m_${Math.random().toString(36).slice(2, 8)}`,
    role: partial.role ?? 'user',
    content: partial.content ?? '',
    createdAt: partial.createdAt ?? Date.now(),
    ...partial
  }
}

describe('stripThinkingLeak：正文落盘前剥离显式思考块', () => {
  it('剥离 XML 思考块（thinking/reasoning/analysis，大小写不敏感）', () => {
    const r = stripThinkingLeak('先说结论。\n<thinking>这里是我的思考过程</thinking>\n正文结尾。')
    expect(r.stripped).toBe(true)
    expect(r.text).not.toContain('思考过程')
    expect(r.text).toContain('先说结论')
    expect(r.text).toContain('正文结尾')

    const r2 = stripThinkingLeak('<REASONING>大写标签</REASONING>正文')
    expect(r2.stripped).toBe(true)
    expect(r2.text).toBe('正文')

    const r3 = stripThinkingLeak('a<analysis foo="1">带属性</analysis>b')
    expect(r3.stripped).toBe(true)
    expect(r3.text).toBe('ab')
  })

  it('剥离 thinking fence 代码块', () => {
    const r = stripThinkingLeak('开头\n```thinking\n过程草稿\n过程草稿2\n```\n结尾')
    expect(r.stripped).toBe(true)
    expect(r.text).not.toContain('过程草稿')
    expect(r.text).toContain('开头')
    expect(r.text).toContain('结尾')
  })

  it('混合场景：多类型思考块同时剥离', () => {
    const body = '<thinking>t1</thinking>真正文<reasoning>r1</reasoning>'
    const r = stripThinkingLeak(body)
    expect(r.stripped).toBe(true)
    expect(r.text).toBe('真正文')
  })

  it('嵌套思考块循环剥离（上限 5 次）', () => {
    const r = stripThinkingLeak('<thinking>外面<reasoning>里面</reasoning>继续</thinking>结果')
    expect(r.stripped).toBe(true)
    expect(r.text).toBe('结果')
  })

  it('无思考块的正文原样返回（stripped=false，不做任何空白改动）', () => {
    const text = '普通正文，没有思考标签。'
    const r = stripThinkingLeak(text)
    expect(r.stripped).toBe(false)
    expect(r.text).toBe(text)
  })

  it('空/null 输入安全返回', () => {
    expect(stripThinkingLeak('').stripped).toBe(false)
    expect(stripThinkingLeak('').text).toBe('')
    expect(stripThinkingLeak(undefined as never).text).toBe('')
  })

  it('剥离后仅收敛空白：行尾空白收敛 + 首尾 trim，不误伤行首内容', () => {
    const r = stripThinkingLeak(' hello \n\t<thinking>t</thinking>\n 正文 ')
    expect(r.stripped).toBe(true)
    expect(r.text).toBe('hello\n\n 正文')
  })

  it('未剥离时保留正文全部格式（含行尾空白），不做 trim', () => {
    const text = ' 首尾有空格 \n 行尾空格  \n最后一行 '
    const r = stripThinkingLeak(text)
    expect(r.stripped).toBe(false)
    expect(r.text).toBe(text)
  })
})

describe('buildContinuationMessages：思考不进上下文、仅协议回传', () => {
  const base = [msg({ id: 'u1', role: 'user', content: '原问题' })]

  it('只产出思考、未出正文时：原样返回干净重试（不回灌思考，不注入伪正文）', () => {
    const out = buildContinuationMessages(base, '', '上一轮的思考内容')
    expect(out).toHaveLength(1)
    expect(out[0].content).toBe('原问题')
  })

  it('已产出正文：追加一条 assistant partial 消息续上，思考仅走 reasoning 字段', () => {
    const out = buildContinuationMessages(base, '已生成的正文', '上一轮思考')
    expect(out).toHaveLength(2)
    const partial = out[1]
    expect(partial.role).toBe('assistant')
    expect(partial.content).toBe('已生成的正文')
    // reasoning 字段仅作 wire 协议回传载体，绝不拼进 content（语义注入红线）
    expect(partial.content).not.toContain('上一轮思考')
    expect(partial.reasoning).toBe('上一轮思考')
  })

  it('无思考、有正文：partial 消息不带 reasoning 字段', () => {
    const out = buildContinuationMessages(base, '只有正文', '')
    expect(out[1].reasoning).toBeUndefined()
    expect(out[1].content).toBe('只有正文')
  })

  it('正文混入思考块：partial.content 同样剥离——续接成功落盘历史时思考不随 partial 回灌', () => {
    // 为什么测：续接成功后 runStream.onDone 的 saveMessages([...messages, finalAiMsg]) 中
    //   messages 即 continuedMessages（含 partial）；若 partial 保留思考块原文，
    //   下一轮 buildInjectedMessages 注入历史时思考块仍以语义方式回灌（剥离钩子旁路）。
    const out = buildContinuationMessages(
      base,
      '前言\n<thinking>这里的思考不应进上下文</thinking>\n正文收尾',
      '上一轮思考'
    )
    expect(out).toHaveLength(2)
    // 剥离后保留原行结构（思考块行被移除，残留换行属正常收敛行为），按内容断言而非整串相等
    expect(out[1].content).toContain('前言')
    expect(out[1].content).toContain('正文收尾')
    expect(out[1].content).not.toContain('思考不应进上下文')
    expect(out[1].content).not.toContain('<thinking>')
    // reasoning 字段仍按 wire 协议回传（DeepSeek 400 硬约束），与 content 剥离互不冲突
    expect(out[1].reasoning).toBe('上一轮思考')
  })

  it('正文剥离思考块后为空（原正文即思考块）：不追加 partial，等价于未出正文的干净重试', () => {
    const out = buildContinuationMessages(base, '<thinking>只是思考没有正文</thinking>', '思考')
    expect(out).toHaveLength(1)
    expect(out[0].content).toBe('原问题')
  })

  it('原上下文消息不被篡改（浅拷贝续接）', () => {
    const out = buildContinuationMessages(base, '正文', '思考')
    expect(out[0]).toBe(base[0])
    expect(out).not.toBe(base)
  })
})

describe('OUTPUT_DISCIPLINE_PROMPT：机制层硬性纪律段', () => {
  it('提示词文本存在且覆盖核心约束', () => {
    expect(OUTPUT_DISCIPLINE_PROMPT.length).toBeGreaterThan(100)
    expect(OUTPUT_DISCIPLINE_PROMPT).toContain('思考只出现在思考流')
    expect(OUTPUT_DISCIPLINE_PROMPT).toContain('正文是对用户输入的回复')
    expect(OUTPUT_DISCIPLINE_PROMPT).toContain('禁止以')
    // 任务执行流程纪律：规划可调 + 收尾逐一 code-review（用户强制，机制层锁定）
    expect(OUTPUT_DISCIPLINE_PROMPT).toContain('任务执行流程——规划可调、收尾必审')
    expect(OUTPUT_DISCIPLINE_PROMPT).toContain('收尾逐一 code-review')
    // 产出纪律：写提示词/工具描述/文档/命名必须"能让使用者知道能发挥什么作用"，无用即删（用户强制，机制层锁定）
    expect(OUTPUT_DISCIPLINE_PROMPT).toContain('产出纪律（写提示词')
    expect(OUTPUT_DISCIPLINE_PROMPT).toContain('删掉它是否影响使用')
    expect(OUTPUT_DISCIPLINE_PROMPT).toContain('垃圾写法，必须重写')
  })

  it('output_discipline 段以 boot tier 独立注入（不依赖 sys_prompt 副本）', () => {
    // deps 惰性：createSegmentManifest 只组装 manifest，不立即调用 deps——
    // 传入空 deps 也能拿到段定义，证明该段注入与 sys_prompt 副本读取解耦
    const manifest = createSegmentManifest({} as never)
    const segment = manifest.find((s) => s.id === 'output_discipline')
    expect(segment).toBeDefined()
    expect(segment!.tier).toBe('boot')
    expect(segment!.role).toBe('system')
    // build 不触碰 ctx/deps，直接吐常量——恒注入，副本覆盖不影响
    const built = segment!.build({} as never)
    expect(built?.content).toBe(OUTPUT_DISCIPLINE_PROMPT)
  })
})