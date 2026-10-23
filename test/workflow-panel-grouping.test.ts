/**
 * WorkflowPanel 分组陈列逻辑单测（groupTemplates / groupKeyOf / WORKFLOW_CATEGORY_ORDER）
 *
 * 为什么存在：工作流面板按分类分组陈列（记忆/日记/安全/其他）是本轮新增的 UI 契约——
 * 分类键由模板 tags 推导，分组函数必须是可独立验证的纯函数，不能只在渲染层隐式存在。
 */
import { describe, it, expect } from 'vitest'
import { groupTemplates, groupKeyOf, WORKFLOW_CATEGORY_ORDER } from '../src/components/Workflow/WorkflowPanel'
import type { WorkflowTemplate, WorkflowMode } from '../shared/workflow/types'

function makeTemplate(id: string, tags: string[], mode: WorkflowMode = 'workflow'): WorkflowTemplate {
  return {
    id,
    name: id,
    description: '',
    mode,
    source: 'default',
    nodes: [{ id: 'start', type: 'end', name: '开始', config: { output: '' } }],
    edges: [],
    tags,
    updatedAt: 0,
    createdAt: 0
  } as WorkflowTemplate
}

describe('WorkflowPanel · 分组陈列', () => {
  it('分类键按 tags 推导：记忆/日记/安全均为专有分类，其余归"其他"', () => {
    expect(groupKeyOf(makeTemplate('a', ['记忆', '默认']))).toBe('记忆')
    expect(groupKeyOf(makeTemplate('b', ['日记']))).toBe('日记')
    expect(groupKeyOf(makeTemplate('c', ['安全', '探测']))).toBe('安全')
    expect(groupKeyOf(makeTemplate('d', ['默认']))).toBe('其他')
    expect(groupKeyOf(makeTemplate('e', []))).toBe('其他')
    expect(groupKeyOf(makeTemplate('f', ['黑客', '草稿']))).toBe('其他')
  })

  it('分类优先级：记忆 > 日记 > 安全（一个模板多 tag 时取首位）', () => {
    expect(groupKeyOf(makeTemplate('a', ['日记', '记忆']))).toBe('记忆')
    expect(groupKeyOf(makeTemplate('b', ['安全', '日记']))).toBe('日记')
  })

  it('分组顺序固定：记忆 → 日记 → 安全 → 其他', () => {
    expect(WORKFLOW_CATEGORY_ORDER).toEqual(['记忆', '日记', '安全', '其他'])
  })

  it('空组不输出，只保留存在的分类', () => {
    const groups = groupTemplates([
      makeTemplate('mem', ['记忆']),
      makeTemplate('sec', ['安全'])
    ])
    expect(groups.map((g) => g.key)).toEqual(['记忆', '安全'])
    expect(groups[0].label).toBe('记忆工作流')
    expect(groups[1].label).toBe('安全工作流')
  })

  it('组内保持输入顺序，items 完整归属', () => {
    const mem1 = makeTemplate('mem1', ['记忆'])
    const mem2 = makeTemplate('mem2', ['记忆'])
    const diary = makeTemplate('d1', ['日记'])
    const other = makeTemplate('o1', ['默认'])
    const groups = groupTemplates([mem2, diary, mem1, other])
    expect(groups.find((g) => g.key === '记忆')!.items.map((t) => t.id)).toEqual(['mem2', 'mem1'])
    expect(groups.find((g) => g.key === '日记')!.items[0].id).toBe('d1')
    expect(groups.find((g) => g.key === '其他')!.items[0].id).toBe('o1')
  })

  it('全部模板无 tag 时仅"其他"一组', () => {
    const groups = groupTemplates([makeTemplate('a', []), makeTemplate('b', ['两张未分类'] as string[])])
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('其他')
    expect(groups[0].items).toHaveLength(2)
  })
})