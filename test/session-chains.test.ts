import { describe, it, expect } from 'vitest'
import {
  buildChains,
  buildSessionTree,
  buildTreeLayout,
  buildTreeLayouts,
  collectParentIds,
  computeSubtreeSizes,
  pruneCollapsed,
  type Chain
} from '../src/components/Chat/session-chains'
import type { InternalSessionSummary } from '../shared/types'

/**
 * 内部会话继承链组装纯函数回归（v0.20 结构化谱系视图的数据基础）：
 * 1) 根判定 —— 无父节点为根；父不在列表内（断链孤儿）兜底为根；
 * 2) 链内顺序 —— 根在前、后代按 gen 升序，分支/分支后节点不丢；
 * 3) 链间排序 —— 按最新叶子的 updatedAt 降序（最近活跃的链靠前）；
 * 4) collectParentIds —— 仅收集「列表内存在且被引用为父」的 id，孤儿父不收集。

 * v0.24 新增 buildSessionTree（继承 × 时间双轴树）回归：
 * 5) 继承子挂载 —— parentId 指向的节点挂为 children，gen 升序；
 * 6) 时间分叉挂载 —— timeBranchId 指向的副本挂为 timeFork，不计入 children；
 * 7) 双轴共存 —— 同一根节点可同时拥有继承子与时间分叉；
 * 8) 时间链嵌套 —— fork 副本自身还可拥有 timeFork（时间线多级延续）；
 * 9) 树间排序 —— 按子树内最新 updatedAt 降序。

 * v0.28 新增新话题分支（isNewTopic，三轴树）+ 放射形布局（buildTreeLayout）：
 * 10) 新话题挂载 —— isNewTopic=true 的会话挂为 newBranches（虚线），不计入 children；
 * 11) 三轴共存 —— 同一父节点可同时拥有继承子/新话题分支/时间分叉；
 * 12) 放射形 —— 根在上（depth=0），兄弟节点横向并排（同层 x 递增不重叠），
 *     深度越深横向越宽（开枝散叶），parentId 单线链天然向两侧展开；
 * 13) 线型 —— edgeType 区分 inherit/time/new（继承/时间=实线延续，新话题=虚线）；
 * 14) 折叠剪枝 —— pruneCollapsed 后布局只含未折叠节点（三类后代都被裁剪）。
 */
function s(over: Partial<InternalSessionSummary>): InternalSessionSummary {
  return {
    id: 's_1',
    title: '会话',
    summary: '',
    createdAt: 1725000000000,
    updatedAt: 1725000000000,
    messageCount: 3,
    totalChars: 100,
    ...over
  }
}

function ids(chains: Chain[]): string[][] {
  return chains.map((c) => c.nodes.map((n) => n.id))
}

describe('buildChains 根判定与链组装', () => {
  it('无父节点为根，后代按 gen 升序（根→叶子）', () => {
    const list = [
      s({ id: 'b', parentId: 'a', gen: 2, updatedAt: 300 }),
      s({ id: 'a', gen: 1, updatedAt: 100 }),
      s({ id: 'c', parentId: 'b', gen: 3, updatedAt: 400 })
    ]
    expect(ids(buildChains(list))).toEqual([['a', 'b', 'c']])
  })

  it('父不在列表内（断链孤儿）兜底为根，不丢弃', () => {
    const list = [
      s({ id: 'kid', parentId: 'ghost', gen: 2, updatedAt: 200 }),
      s({ id: 'root', gen: 1, updatedAt: 100 })
    ]
    // ghost 不在列表内 → kid 作为孤儿根独立成链；root 正常成链
    expect(ids(buildChains(list))).toEqual([['kid'], ['root']])
  })

  it('空列表返回空数组', () => {
    expect(buildChains([])).toEqual([])
  })

  it('单节点（无父无子）作为单节点链', () => {
    const list = [s({ id: 'only', gen: 1 })]
    expect(ids(buildChains(list))).toEqual([['only']])
  })
})

describe('buildChains 链间排序', () => {
  it('按最新叶子 updatedAt 降序：最近活跃的链靠前', () => {
    const list = [
      // 链 A：叶子更新时间 200（较旧）
      s({ id: 'a1', gen: 1, updatedAt: 100 }),
      s({ id: 'a2', parentId: 'a1', gen: 2, updatedAt: 200 }),
      // 链 B：叶子更新时间 500（较新）
      s({ id: 'b1', gen: 1, updatedAt: 50 }),
      s({ id: 'b2', parentId: 'b1', gen: 2, updatedAt: 500 })
    ]
    expect(ids(buildChains(list))).toEqual([
      ['b1', 'b2'],
      ['a1', 'a2']
    ])
  })
})

describe('buildChains 分支兼容', () => {
  it('一父多子（潜在分支）全部保留，子链按 gen 升序', () => {
    const list = [
      s({ id: 'root', gen: 1, updatedAt: 100 }),
      s({ id: 'c2', parentId: 'root', gen: 3, updatedAt: 300 }),
      s({ id: 'c1', parentId: 'root', gen: 2, updatedAt: 200 })
    ]
    // 队列先按 gen 排序后入队：root → c1 → c2（分支以 gen 升序展开）
    expect(ids(buildChains(list))).toEqual([['root', 'c1', 'c2']])
  })
})

describe('collectParentIds 最新叶子判定', () => {
  it('仅收集列表内存在且被引用为父的 id；孤儿父不收集', () => {
    const list = [
      s({ id: 'a', gen: 1, updatedAt: 100 }),
      s({ id: 'b', parentId: 'a', gen: 2, updatedAt: 200 }),
      s({ id: 'orphan', parentId: 'ghost', gen: 2, updatedAt: 300 })
    ]
    expect(collectParentIds(list)).toEqual(new Set(['a']))
  })

  it('无父子关系时返回空集合（全是叶子）', () => {
    expect(collectParentIds([s({ id: 'x' }), s({ id: 'y' })])).toEqual(new Set())
  })
})

describe('buildSessionTree 继承 × 时间双轴树', () => {
  it('继承子按 parentId 挂为 children（gen 升序）', () => {
    const list = [
      s({ id: 'c', parentId: 'a', gen: 3, updatedAt: 300 }),
      s({ id: 'a', gen: 1, updatedAt: 100 }),
      s({ id: 'b', parentId: 'a', gen: 2, updatedAt: 200 })
    ]
    const [tree] = buildSessionTree(list)
    expect(tree.session.id).toBe('a')
    expect(tree.children.map((c) => c.session.id)).toEqual(['b', 'c'])
    expect(tree.timeFork).toBeUndefined()
  })

  it('时间分叉副本挂在 timeFork 而非 children（副本 parentId 与原会话相同也不并列成兄弟）', () => {
    const list = [
      // 原会话 root：有继承子 kid，同时时间延续到 fork
      s({ id: 'root', gen: 1, updatedAt: 100 }),
      s({ id: 'kid', parentId: 'root', gen: 2, updatedAt: 200 }),
      // fork 是 root 的时间分叉副本：parentId 复制自 root（同为根级），但应走 timeFork 边
      s({ id: 'fork', parentId: 'root', gen: 2, updatedAt: 300, timeBranchId: undefined, isTimeFork: true }),
      s({ id: 'root2', gen: 1, updatedAt: 50 })
    ]
    // 手动把"root 的 timeBranchId 指向 fork"补进场景：先以 root 的 timeBranchId 模拟
    const listWithBranch = list.map((x) => (x.id === 'root' ? { ...x, timeBranchId: 'fork' } : x))
    const trees = buildSessionTree(listWithBranch)
    const rootTree = trees.find((t) => t.session.id === 'root')!
    // fork 是 root 的时间下级，不是继承子
    expect(rootTree.timeFork?.session.id).toBe('fork')
    expect(rootTree.children.map((c) => c.session.id)).toEqual(['kid'])
  })

  it('继承与时间分叉双轴共存互不干扰', () => {
    const list = [
      s({ id: 'root', gen: 1, updatedAt: 100 }),
      s({ id: 'kid', parentId: 'root', gen: 2, updatedAt: 200 }),
      // root 延续到 fork1，fork1 再延续到 fork2（时间链两级）
      s({ id: 'fork1', parentId: 'root', gen: 2, updatedAt: 300, isTimeFork: true }),
      s({ id: 'fork2', parentId: 'root', gen: 2, updatedAt: 400, isTimeFork: true })
    ]
    const withBranch = list.map((x) => {
      if (x.id === 'root') return { ...x, timeBranchId: 'fork1' }
      if (x.id === 'fork1') return { ...x, timeBranchId: 'fork2' }
      return x
    })
    const [tree] = buildSessionTree(withBranch)
    expect(tree.session.id).toBe('root')
    expect(tree.timeFork?.session.id).toBe('fork1')
    expect(tree.timeFork?.timeFork?.session.id).toBe('fork2')
    expect(tree.children.map((c) => c.session.id)).toEqual(['kid'])
  })

  it('空列表返回空数组；孤儿时间分叉（指向不存在的 id）不挂载', () => {
    expect(buildSessionTree([])).toEqual([])
    const list = [
      s({ id: 'a', gen: 1, timeBranchId: 'ghost', updatedAt: 100 })
    ]
    const [tree] = buildSessionTree(list)
    expect(tree.session.id).toBe('a')
    expect(tree.timeFork).toBeUndefined()
  })

  it('树间按子树内最新 updatedAt 降序排序', () => {
    const list = [
      // a 树：子树最新更新时间 500（a2），b 树：自身 900 → b 应在最前
      s({ id: 'a1', gen: 1, updatedAt: 100 }),
      s({ id: 'a2', parentId: 'a1', gen: 2, updatedAt: 500 }),
      s({ id: 'b1', gen: 1, updatedAt: 900 })
    ]
    expect(buildSessionTree(list).map((t) => t.session.id)).toEqual(['b1', 'a1'])
  })

  it('新话题分支（isNewTopic）挂为 newBranches 而非继承 children', () => {
    const list = [
      s({ id: 'root', gen: 1, updatedAt: 100 }),
      // top1/top2 是 AI 判定新开话题的分支：有 parentId 但不是继承承接
      s({ id: 'top1', parentId: 'root', gen: 2, updatedAt: 300, isNewTopic: true }),
      s({ id: 'top2', parentId: 'root', gen: 3, updatedAt: 400, isNewTopic: true }),
      // kid 是真正的继承子（同一延续）
      s({ id: 'kid', parentId: 'root', gen: 2, updatedAt: 200 })
    ]
    const [tree] = buildSessionTree(list)
    expect(tree.children.map((c) => c.session.id)).toEqual(['kid'])
    expect(tree.newBranches.map((c) => c.session.id)).toEqual(['top1', 'top2'])
  })

  it('三轴共存：同一父同时有继承子、新话题分支与时间分叉', () => {
    const list = [
      s({ id: 'root', gen: 1, updatedAt: 100 }),
      s({ id: 'kid', parentId: 'root', gen: 2, updatedAt: 200 }),
      s({ id: 'top', parentId: 'root', gen: 2, updatedAt: 300, isNewTopic: true }),
      s({ id: 'fork', parentId: 'root', gen: 2, updatedAt: 400, isTimeFork: true })
    ]
    const withBranch = list.map((x) => (x.id === 'root' ? { ...x, timeBranchId: 'fork' } : x))
    const [tree] = buildSessionTree(withBranch)
    expect(tree.children.map((c) => c.session.id)).toEqual(['kid'])
    expect(tree.newBranches.map((c) => c.session.id)).toEqual(['top'])
    expect(tree.timeFork?.session.id).toBe('fork')
  })
})

describe('buildTreeLayout 放射形开枝散叶布局', () => {
  it('根在上（depth=0）、居画布中心，单线继承链纵向居中', () => {
    const list = [
      s({ id: 'root', gen: 1, updatedAt: 100 }),
      s({ id: 'kid', parentId: 'root', gen: 2, updatedAt: 200 })
    ]
    const [tree] = buildSessionTree(list)
    const layout = buildTreeLayout(tree)
    const [root, kid] = layout.nodes
    expect(root.session.id).toBe('root')
    expect(root.depth).toBe(0)
    expect(root.isRoot).toBe(true)
    expect(root.x).toBe(layout.width / 2) // 根在画布中心，向两侧散开
    expect(kid.depth).toBe(1)
    expect(kid.x).toBe(root.x) // 单链唯一后代沿中轴向下
    expect(root.y).toBeLessThan(kid.y) // 根在上、子在下
    expect(layout.edges).toHaveLength(1)
    expect(layout.edges[0].edgeType).toBe('inherit')
  })

  it('深度越深横向越宽：三层树第 2 层比第 1 层更宽（开枝散叶）', () => {
    const list = [
      s({ id: 'root', gen: 1, updatedAt: 100 }),
      s({ id: 'a', parentId: 'root', gen: 2, updatedAt: 200 }),
      s({ id: 'b', parentId: 'root', gen: 2, updatedAt: 300 }),
      s({ id: 'a1', parentId: 'a', gen: 3, updatedAt: 400 }),
      s({ id: 'a2', parentId: 'a', gen: 3, updatedAt: 500 }),
      s({ id: 'b1', parentId: 'b', gen: 3, updatedAt: 600 }),
      s({ id: 'b2', parentId: 'b', gen: 3, updatedAt: 700 }),
      s({ id: 'b3', parentId: 'b', gen: 3, updatedAt: 800 })
    ]
    const [tree] = buildSessionTree(list)
    const layout = buildTreeLayout(tree)
    const depth1 = layout.nodes.filter((n) => n.depth === 1)
    const depth2 = layout.nodes.filter((n) => n.depth === 2)
    const span = (arr: typeof layout.nodes) => Math.max(...arr.map((n) => n.x)) - Math.min(...arr.map((n) => n.x))
    expect(depth2.length).toBeGreaterThan(depth1.length)
    expect(span(depth2)).toBeGreaterThan(span(depth1)) // 深度越深、分支越散开
  })

  it('兄弟节点横向并排：同层 x 依次递增且互不重叠（间距 ≥ 卡片宽 + 槽距）', () => {
    const list = [
      s({ id: 'root', gen: 1, updatedAt: 100 }),
      s({ id: 'a', parentId: 'root', gen: 2, updatedAt: 200 }),
      s({ id: 'b', parentId: 'root', gen: 2, updatedAt: 300 }),
      s({ id: 'c', parentId: 'root', gen: 2, updatedAt: 400 })
    ]
    const [tree] = buildSessionTree(list)
    const layout = buildTreeLayout(tree)
    const depth1 = layout.nodes.filter((n) => n.depth === 1).sort((m, n) => m.x - n.x)
    expect(depth1.map((n) => n.session.id)).toEqual(['a', 'b', 'c'])
    for (let i = 1; i < depth1.length; i++) {
      const gap = depth1[i].x - depth1[i - 1].x
      expect(gap).toBeGreaterThanOrEqual(320 + 24) // 卡片宽 + 槽距，视觉不重叠
    }
  })

  it('线型语义：继承/时间=实线（延续），新话题=虚线（非延续）', () => {
    const list = [
      s({ id: 'root', gen: 1, updatedAt: 100 }),
      s({ id: 'kid', parentId: 'root', gen: 2, updatedAt: 200 }),
      s({ id: 'top', parentId: 'root', gen: 2, updatedAt: 300, isNewTopic: true }),
      s({ id: 'fork', parentId: 'root', gen: 2, updatedAt: 400, isTimeFork: true })
    ]
    const withBranch = list.map((x) => (x.id === 'root' ? { ...x, timeBranchId: 'fork' } : x))
    const [tree] = buildSessionTree(withBranch)
    const layout = buildTreeLayout(tree)
    const byType = Object.fromEntries(layout.edges.map((e) => [e.toId, e.edgeType]))
    expect(byType['kid']).toBe('inherit') // 继承：实线延续
    expect(byType['fork']).toBe('time') // 时间分叉：实线延续
    expect(byType['top']).toBe('new') // 新话题：虚线
    // 连线从父底部中心到子顶部中心（斜向分杈）
    for (const e of layout.edges) {
      expect(e.y1).toBeLessThan(e.y2)
      expect(e.y1).toBeGreaterThanOrEqual(0)
    }
  })

  it('时间分叉/新话题分支与继承子同层：depth 一致且不重叠', () => {
    const list = [
      s({ id: 'root', gen: 1, updatedAt: 100 }),
      s({ id: 'kid', parentId: 'root', gen: 2, updatedAt: 200 }),
      s({ id: 'top', parentId: 'root', gen: 2, updatedAt: 300, isNewTopic: true }),
      s({ id: 'fork', parentId: 'root', gen: 2, updatedAt: 400, isTimeFork: true })
    ]
    const withBranch = list.map((x) => (x.id === 'root' ? { ...x, timeBranchId: 'fork' } : x))
    const [tree] = buildSessionTree(withBranch)
    const layout = buildTreeLayout(tree)
    const depth1 = layout.nodes.filter((n) => n.depth === 1)
    expect(depth1).toHaveLength(3)
    expect(new Set(depth1.map((n) => n.session.id))).toEqual(new Set(['kid', 'top', 'fork']))
    const xs = depth1.map((n) => n.x).sort((a, b) => a - b)
    expect(xs[1] - xs[0]).toBeGreaterThanOrEqual(320)
    expect(xs[2] - xs[1]).toBeGreaterThanOrEqual(320)
  })

  it('裁剪后布局：折叠节点丢失全部三类后代，且布局宽度收窄', () => {
    const list = [
      s({ id: 'root', gen: 1, updatedAt: 100 }),
      s({ id: 'a', parentId: 'root', gen: 2, updatedAt: 200 }),
      s({ id: 'b', parentId: 'root', gen: 2, updatedAt: 300 }),
      s({ id: 'a1', parentId: 'a', gen: 3, updatedAt: 400 }),
      s({ id: 'a2', parentId: 'a', gen: 3, updatedAt: 500 }),
      s({ id: 'b1', parentId: 'b', gen: 3, updatedAt: 600 })
    ]
    const [tree] = buildSessionTree(list)
    const full = buildTreeLayout(tree)
    const pruned = pruneCollapsed([tree], new Set(['a', 'b']))
    const folded = buildTreeLayout(pruned[0])
    // 折叠 a、b：节点自身保留，但各自后代被裁剪 → 只剩 root/a/b，宽度收窄
    expect(folded.nodes.map((n) => n.session.id)).toEqual(['root', 'a', 'b'])
    expect(folded.width).toBeLessThan(full.width)
    // 原树不被修改（纯函数）
    expect(tree.children.map((c) => c.session.id)).toEqual(['a', 'b'])
  })

  it('空森林：布局列表为空', () => {
    expect(buildTreeLayouts([])).toEqual([])
  })

  it('多根森林逐棵布局：每棵根 depth=0 且成独立画布', () => {
    const list = [
      s({ id: 'a', gen: 1, updatedAt: 100 }),
      s({ id: 'b', gen: 1, updatedAt: 200 }),
      s({ id: 'a-kid', parentId: 'a', gen: 2, updatedAt: 150 })
    ]
    const trees = buildSessionTree(list)
    const layouts = buildTreeLayouts(trees)
    // b 树最新叶子 200 > a 树 150 → b 树在前（buildSessionTree 既有排序语义）
    expect(layouts.map((l) => l.nodes[0].session.id)).toEqual(['b', 'a'])
    for (const l of layouts) {
      expect(l.nodes[0].depth).toBe(0)
      expect(l.nodes[0].isRoot).toBe(true)
      expect(l.nodes[0].x).toBe(l.width / 2)
    }
  })
})

describe('computeSubtreeSizes 子树规模（v0.29 密集降级依据）', () => {
  it('单节点规模为 1', () => {
    const [tree] = buildSessionTree([s({ id: 'only', gen: 1 })])
    expect(computeSubtreeSizes([tree]).get('only')).toBe(1)
  })

  it('链式树按后代逐层累加（根最大、叶子最小）', () => {
    const list = [
      s({ id: 'root', gen: 1, updatedAt: 100 }),
      s({ id: 'kid', parentId: 'root', gen: 2, updatedAt: 200 }),
      s({ id: 'grand', parentId: 'kid', gen: 3, updatedAt: 300 })
    ]
    const [tree] = buildSessionTree(list)
    const sizes = computeSubtreeSizes([tree])
    expect(sizes.get('grand')).toBe(1)
    expect(sizes.get('kid')).toBe(2)
    expect(sizes.get('root')).toBe(3)
  })

  it('多叉树包含自身；三类分支（继承/新话题/时间分叉）都计入', () => {
    const list = [
      s({ id: 'root', gen: 1, updatedAt: 100 }),
      s({ id: 'kid1', parentId: 'root', gen: 2, updatedAt: 200 }),
      s({ id: 'kid2', parentId: 'root', gen: 2, updatedAt: 210 }),
      s({ id: 'top', parentId: 'root', gen: 2, updatedAt: 220, isNewTopic: true }),
      s({ id: 'fork', parentId: 'root', gen: 2, updatedAt: 230, isTimeFork: true })
    ]
    const withBranch = list.map((x) => (x.id === 'root' ? { ...x, timeBranchId: 'fork' } : x))
    const [tree] = buildSessionTree(withBranch)
    const sizes = computeSubtreeSizes([tree])
    // 自身 1 + 继承子 2 + 新话题 1 + 时间分叉 1 = 5
    expect(sizes.get('root')).toBe(5)
    expect(sizes.get('kid1')).toBe(1)
  })

  it('多根森林分别统计；空森林返回空 Map', () => {
    const list = [
      s({ id: 'a', gen: 1, updatedAt: 100 }),
      s({ id: 'a-kid', parentId: 'a', gen: 2, updatedAt: 150 }),
      s({ id: 'b', gen: 1, updatedAt: 200 })
    ]
    const trees = buildSessionTree(list)
    const sizes = computeSubtreeSizes(trees)
    expect(sizes.get('a')).toBe(2)
    expect(sizes.get('b')).toBe(1)
    expect(computeSubtreeSizes([]).size).toBe(0)
  })
})

describe('pruneCollapsed 折叠裁剪', () => {
  it('折叠节点丢失其全部后代（继承子 + 时间分叉 + 新话题），原树不被修改', () => {
    const list = [
      s({ id: 'root', gen: 1, updatedAt: 100 }),
      s({ id: 'kid', parentId: 'root', gen: 2, updatedAt: 200 }),
      s({ id: 'top', parentId: 'root', gen: 2, updatedAt: 300, isNewTopic: true }),
      s({ id: 'fork', parentId: 'root', gen: 2, updatedAt: 400, isTimeFork: true })
    ]
    const withBranch = list.map((x) => (x.id === 'root' ? { ...x, timeBranchId: 'fork' } : x))
    const [tree] = buildSessionTree(withBranch)
    const pruned = pruneCollapsed([tree], new Set(['root']))
    expect(pruned).toHaveLength(1)
    expect(pruned[0].session.id).toBe('root')
    expect(pruned[0].children).toEqual([])
    expect(pruned[0].newBranches).toEqual([])
    expect(pruned[0].timeFork).toBeUndefined()
    // 原树不受影响（纯函数）
    expect(tree.children).toHaveLength(1)
    expect(tree.newBranches).toHaveLength(1)
    expect(tree.timeFork?.session.id).toBe('fork')
  })

  it('折叠叶子节点（无后代）原样保留；折叠不存在的 id 无副作用', () => {
    const list = [s({ id: 'root', gen: 1, updatedAt: 100 })]
    const [tree] = buildSessionTree(list)
    expect(pruneCollapsed([tree], new Set(['root']))[0].children).toEqual([])
    expect(pruneCollapsed([tree], new Set(['ghost']))).toHaveLength(1)
  })
})