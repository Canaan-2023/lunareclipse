/**
 * T5 L2：workflow/default-templates.ts 内置模板数据校验

 * 引擎与模板分离的模板侧测试网：
 * - 每个内置模板必须通过 validateTemplate（与 engine 的启动校验契约一致）
 * - 起始节点可达全图（BFS 遍历，模板没有"孤儿"节点）
 * - ID 唯一性、edges 引用完整性（validateTemplate 已覆盖，这里显式断言保证数据网独立可读）
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_TEMPLATES } from '../electron/main/workflow/default-templates'
import { validateTemplate, VALID_NODE_TYPES } from '../electron/main/workflow/template-validate'
import { findStartNode, findNextNode } from '../electron/main/workflow/dag-nav'
import type { WorkflowTemplate } from '../shared/workflow/types'

/** 从起始节点 BFS，返回可达节点 ID 集合 */
function reachableNodeIds(tpl: WorkflowTemplate): Set<string> {
  const start = findStartNode(tpl)
  if (!start) return new Set()
  const seen = new Set<string>()
  const queue = [start.id]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    // 从当前节点出发的所有出边
    for (const edge of tpl.edges) {
      if (edge.from === id && !seen.has(edge.to)) queue.push(edge.to)
    }
  }
  return seen
}

describe('default-templates · 内置模板数据', () => {
  it('内置模板数量 ≥ 8 且每个都有独立 ID', () => {
    expect(DEFAULT_TEMPLATES.length).toBeGreaterThanOrEqual(8)
    const ids = new Set(DEFAULT_TEMPLATES.map((t) => t.id))
    expect(ids.size).toBe(DEFAULT_TEMPLATES.length)
  })

  it('每个模板都能通过 validateTemplate（与引擎启动校验一致）', () => {
    for (const tpl of DEFAULT_TEMPLATES) {
      expect(() => validateTemplate(tpl), `模板 ${tpl.id} 未通过校验`).not.toThrow()
    }
  })

  it('每个模板节点类型都在合法类型集合内，且节点/连线 ID 引用完整', () => {
    for (const tpl of DEFAULT_TEMPLATES) {
      expect(tpl.name.trim().length).toBeGreaterThan(0)
      expect(['chatflow', 'workflow']).toContain(tpl.mode)
      const nodeIds = new Set(tpl.nodes.map((n) => n.id))
      expect(nodeIds.size).toBe(tpl.nodes.length)
      for (const n of tpl.nodes) {
        expect(VALID_NODE_TYPES).toContain(n.type)
      }
      for (const e of tpl.edges) {
        expect(nodeIds.has(e.from), `${tpl.id} 边起点 ${e.from} 不存在`).toBe(true)
        expect(nodeIds.has(e.to), `${tpl.id} 边终点 ${e.to} 不存在`).toBe(true)
      }
    }
  })

  it('每个模板从起始节点可达全图（无孤儿节点）', () => {
    for (const tpl of DEFAULT_TEMPLATES) {
      const reachable = reachableNodeIds(tpl)
      expect(reachable.size, `${tpl.id} 存在不可达节点`).toBe(tpl.nodes.length)
    }
  })

  it('condition 节点的出边可用 findNextNode 导航（首条无 condition 或 default 边兜底）', () => {
    for (const tpl of DEFAULT_TEMPLATES) {
      const start = findStartNode(tpl)!
      // 从一个空 context 出发，condition 节点必须能走到某条边（否则隐式结束但不应抛错）
      let cursor: string | null = start.id
      const walked = new Set<string>()
      let hops = 0
      while (cursor && hops < 1000) {
        if (walked.has(cursor)) break // 回边成环，停止导航冒烟
        walked.add(cursor)
        const next = findNextNode(tpl, cursor, {})
        if (!next) break
        cursor = next
        hops++
      }
    }
  })
})

describe('dag-nav · 图导航纯函数契约', () => {
  const tpl: WorkflowTemplate = {
    id: 't-nav',
    name: '导航测试',
    description: '',
    mode: 'workflow',
    nodes: [
      { id: 'a', type: 'llm', name: 'A', config: { prompt: 'x' } },
      { id: 'b', type: 'condition', name: 'B', config: {} },
      { id: 'c', type: 'llm', name: 'C', config: { prompt: 'y' } },
      { id: 'd', type: 'end', name: 'D', config: { output: 'z' } }
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c', condition: "context.input.kind == 'c'" },
      { from: 'b', to: 'd', condition: 'default' }
    ],
    createdAt: 1,
    updatedAt: 1
  }

  it('findStartNode：优先无入边节点', () => {
    expect(findStartNode(tpl)?.id).toBe('a')
  })

  it('findStartNode：显式 startNode 优先', () => {
    expect(findStartNode({ ...tpl, startNode: 'c' })?.id).toBe('c')
  })

  it('findNextNode：condition 节点按条件走边，不满足走 default', () => {
    expect(findNextNode(tpl, 'b', { input: { kind: 'c' } })).toBe('c')
    // 条件不满足 → default 边
    expect(findNextNode(tpl, 'b', { input: { kind: 'other' } })).toBe('d')
  })

  it('findNextNode：普通节点走第一条出边；无出边返回 null', () => {
    expect(findNextNode(tpl, 'a', {})).toBe('b')
    expect(findNextNode(tpl, 'd', {})).toBeNull()
  })
})