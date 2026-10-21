/**
 * llm-handler extractOutputVars 容错回归测试
 *
 * 背景（2026-08-06）：v2 全任务化流水线工作流节点 execute 报「决策 数组不能为空」——
 * LLM 未按 prompt 要求输出 <json> 标签，实际用了 ```json markdown 围栏 + 筛选摘要，
 * 旧解析器只认 <json> 标签和整段纯 JSON 两种形态，outputVars 提取落空。
 * 修复：加 ```json 围栏提取 + 首{至末}截取两档兜底。
 */
import { describe, it, expect } from 'vitest'
import { extractOutputVars } from '../electron/main/workflow/handlers/llm-handler'

function sampleJson(): string {
  return JSON.stringify(
    {
      skip: false,
      decisions: [
        { 路径: 'a.md', 保留: true },
        { 路径: 'b.md', 保留: false }
      ]
    },
    null,
    2
  )
}

describe('extractOutputVars 容错提取', () => {
  it('标准 <json> 标签块：正常提取', () => {
    const ctx: Record<string, unknown> = {}
    extractOutputVars(`说明文字\n<json>\n${sampleJson()}\n</json>\n结尾`, ['skip', 'decisions'], ctx, 'n1')
    expect(ctx.skip).toBe(false)
    expect(Array.isArray(ctx.decisions)).toBe(true)
    expect((ctx.decisions as Array<{ 路径: string }>).length).toBe(2)
    expect((ctx.decisions as Array<{ 路径: string }>)[0].路径).toBe('a.md')
  })

  it('回归：```json markdown 围栏（本次失败形态）', () => {
    const ctx: Record<string, unknown> = {}
    const output = `\`\`\`json\n${sampleJson()}\n\`\`\`\n\n---\n\n### 筛选摘要\n| raw_memory | 保留 |\n| a.md | ✅ |`
    extractOutputVars(output, ['skip', 'decisions'], ctx, 'n1')
    expect(ctx.skip).toBe(false)
    expect((ctx.decisions as Array<{ 路径: string }>).length).toBe(2)
  })

  it('回归：JSON 前后夹说明文字（无任何标签）', () => {
    const ctx: Record<string, unknown> = {}
    const output = `处理结果如下：\n${sampleJson()}\n以上就是本批全部决策。`
    extractOutputVars(output, ['skip', 'decisions'], ctx, 'n1')
    expect(ctx.skip).toBe(false)
    expect((ctx.decisions as Array<{ 路径: string }>).length).toBe(2)
  })

  it('整段纯 JSON（trim 后为对象）', () => {
    const ctx: Record<string, unknown> = {}
    extractOutputVars(sampleJson(), ['skip'], ctx, 'n1')
    expect(ctx.skip).toBe(false)
  })

  it('无 JSON 内容：warn 不写 context，不抛错', () => {
    const ctx: Record<string, unknown> = {}
    expect(() => extractOutputVars('这是纯文本回复，没有 JSON 结构', ['skip'], ctx, 'n1')).not.toThrow()
    expect(ctx.skip).toBeUndefined()
  })

  it('JSON 解析失败：warn 不写 context，不抛错', () => {
    const ctx: Record<string, unknown> = {}
    expect(() => extractOutputVars('<json>{ 这不是合法 JSON }</json>', ['skip'], ctx, 'n1')).not.toThrow()
    expect(ctx.skip).toBeUndefined()
  })

  it('outputVars 中字段不存在于 JSON：跳过该字段', () => {
    const ctx: Record<string, unknown> = {}
    extractOutputVars(sampleJson(), ['skip', '不存在的字段'], ctx, 'n1')
    expect(ctx.skip).toBe(false)
    expect(ctx['不存在的字段']).toBeUndefined()
  })

  it('数组字段保留为数组（resolveValue 语义依赖）', () => {
    const ctx: Record<string, unknown> = {}
    extractOutputVars(sampleJson(), ['decisions'], ctx, 'n1')
    expect(Array.isArray(ctx.decisions)).toBe(true)
    expect((ctx.decisions as unknown[]).length).toBe(2)
  })
})
