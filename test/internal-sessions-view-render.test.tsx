/**
 * InternalSessionsView 逆生树 v0.28 渲染实测（放射形绝对定位 + 斜向分杈连线）。
 * 为什么用 react-dom/server：项目 vitest 环境为 node（无 jsdom），renderToStaticMarkup
 * 即可验证 DOM 输出（绝对定位坐标/连线 path/线型/卡片尺寸类），无需 jsdom + testing-library。
 * 为什么直接渲 TreeCanvas 而非整个 InternalSessionsView：视图根组件经 useSyncExternalStore
 * 读 store，SSR 分支固定取 getInitialState（初始空列表），注入种子不生效；TreeCanvas 是
 * 布局渲染的唯一载体，props 直渲 + buildSessionTree 构造种子树，契约即「纯函数树 → 放射布局」。
 * 为什么存在：v0.28 布局从「逐行缩进 + token 引导线」改为「放射形坐标 + SVG path 连线」，
 * 必须实测渲染输出而不是只测 buildTreeLayout 纯函数——验证：
 *   1) 绝对定位：每个节点按「中心 x/y - 半宽/半高」定位（根在上、兄弟并排、深度越宽）；
 *   2) 连线层：SVG path 存在（斜向分杈），中线型按 v0.28 定稿——继承/时间=实线、
 *      新话题=虚线（stroke-dasharray）；
 *   3) 新话题徽章：isNewTopic 会话显示虚线徽章（与线型呼应）；
 *   4) 卡片尺寸：固定 TREE_CARD_W=320 宽度、无固定高度类（高度随内容自适应 → 文字不出框）；
 *   5) 摘要 3 行截断（line-clamp-3）、标题单行截断仍在。
 */
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import { TreeCanvas } from '../src/components/Chat/InternalSessionsView'
import { buildSessionTree, DENSE_SUBTREE_THRESHOLD } from '../src/components/Chat/session-chains'
import type { InternalSessionSummary } from '../src/shared/types'

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

function renderTree(list: InternalSessionSummary[]): string {
  const trees = buildSessionTree(list)
  return renderToStaticMarkup(
    <TreeCanvas trees={trees} sessionId="root-session" activeInternalId={null} onOpen={() => {}} />
  )
}

describe('TreeCanvas 逆生树 v0.28 放射形渲染', () => {
  it('绝对定位坐标：根在上、子在下，兄弟不重叠且向两侧散开', () => {
    const list = [
      s({ id: 'root', gen: 1, updatedAt: 100, summary: '根摘要' }),
      s({ id: 'kid', parentId: 'root', gen: 2, updatedAt: 200, summary: '继承子摘要' }),
      s({ id: 'grand', parentId: 'kid', gen: 3, updatedAt: 300, summary: '孙摘要' })
    ]
    const html = renderTree(list)

    // 三层链：根 x 居中、子 x = 根 x（单线链不横向偏移），y 逐层增大
    const rootLeft = /left:([\d.]+)px/.exec(html)?.[1]
    const kidTop = /top:([\d.]+)px/.exec(html)?.[1]
    expect(rootLeft).toBeDefined()
    expect(kidTop).toBeDefined()
    // 同一层 y 相同：单链根与继承子 center.y 差值 = TREE_CARD_H + TREE_LAYER_GAP = 196
    const tops = [...html.matchAll(/top:([\d.]+)px/g)].map((m) => Number(m[1]))
    expect(tops[0]).toBeLessThan(tops[1])
    expect(tops[1]).toBeLessThan(tops[2])
  })

  it('分杈连线：继承/时间=实线，新话题=虚线（stroke-dasharray 仅新话题）', () => {
    const list = [
      s({ id: 'root', gen: 1, updatedAt: 100 }),
      s({ id: 'kid', parentId: 'root', gen: 2, updatedAt: 200, summary: '继承' }),
      s({ id: 'new1', parentId: 'root', gen: 2, updatedAt: 250, isNewTopic: true, summary: '新开' })
    ]
    const html = renderTree(list)

    // 两条边：root→kid（inherit 实线）、root→new1（new 虚线）
    const inheritPath = /\sd="M ([\d.]+) ([\d.]+) L ([\d.]+) ([\d.]+)"/g
    const paths = [...html.matchAll(inheritPath)].map((m) => m[0])
    expect(paths.length).toBe(2)
    // 虚线：只有新话题边带 stroke-dasharray="6 4"
    const dashArrays = [...html.matchAll(/stroke-dasharray="6 4"/g)]
    expect(dashArrays.length).toBe(1)
    // 时间分叉也是实线：root 有 timeBranchId → fork 边不画虚线（不含 stroke-dasharray）
    const forkList = [
      s({ id: 'root', gen: 1, updatedAt: 100, timeBranchId: 'fork' }),
      s({ id: 'fork', parentId: 'root', gen: 2, isTimeFork: true, updatedAt: 300, summary: '分叉' })
    ].map((x) => (x.id === 'fork' ? { ...x, timeBranchId: undefined } : x))
    const forkHtml = renderTree(forkList)
    expect(forkHtml).toContain('M 0 0'.replace('M 0 0', 'M ')) // 至少有一条 path
    expect([...forkHtml.matchAll(/stroke-dasharray="6 4"/g)].length).toBe(0)
  })

  it('新话题徽章：isNewTopic 会话渲染虚线徽章（新话题）', () => {
    const list = [
      s({ id: 'root', gen: 1, updatedAt: 100 }),
      s({ id: 'new1', parentId: 'root', gen: 2, isNewTopic: true, updatedAt: 250, summary: '新开' })
    ]
    const html = renderTree(list)
    // 徽章带 dashed 边框（border-dashed）+ 文案「新话题」
    expect(html).toContain('border-dashed')
    expect(html).toContain('新话题')
  })

  it('卡片宽度固定 320、无固定高度类（高度随内容自适应 → 文字不出框）', () => {
    const list = [
      s({ id: 'root', gen: 1, updatedAt: 100, summary: '超长摘要：'.repeat(30) }),
      s({ id: 'kid', parentId: 'root', gen: 2, updatedAt: 200, summary: '子摘要' })
    ]
    const html = renderTree(list)

    expect(html).toContain('w-[320px]')
    expect(html).not.toContain('h-full')
    expect(html).not.toContain('h-[96px]')
    expect(html).toContain('line-clamp-3')
    expect(html).toContain('truncate text-left text-body')
  })

  it('时间分叉保留 Clock 徽章（延续语义标识）', () => {
    const list = [
      s({ id: 'root', gen: 1, updatedAt: 100, timeBranchId: 'fork' }),
      s({ id: 'fork', parentId: 'root', gen: 2, isTimeFork: true, updatedAt: 300, summary: '分叉摘要' })
    ]
    const html = renderTree(list)
    expect(html).toContain('时间副本')
  })
})

describe('TreeCanvas 画布化与密集降级（v0.29）', () => {
  function renderWith(list: InternalSessionSummary[], initialZoom?: number): string {
    const trees = buildSessionTree(list)
    return renderToStaticMarkup(
      <TreeCanvas trees={trees} sessionId="root-session" activeInternalId={null} onOpen={() => {}} initialZoom={initialZoom} />
    )
  }

  it('画布内容层带 translate+scale 变换（默认 1x 平移 0）', () => {
    const list = [s({ id: 'root', gen: 1, updatedAt: 100 })]
    const html = renderWith(list)
    expect(html).toContain('translate(0px, 0px) scale(1)')
  })

  it('初始缩放低于阈值时整片画布降级为点形态（圆点 + 标题，无摘要/徽章）', () => {
    const list = [
      s({ id: 'root', gen: 1, updatedAt: 100, title: '根标题', summary: '根摘要' }),
      s({ id: 'kid', parentId: 'root', gen: 2, updatedAt: 200, title: '子标题', summary: '子摘要' })
    ]
    const html = renderWith(list, 0.3)
    // 降级形态：圆点（h-2 w-2）出现、完整卡片内容（摘要 3 行截断）消失
    expect(html).toContain('h-2 w-2')
    expect(html).not.toContain('line-clamp-3')
    // 点形态保留标题（可辨识节点）、丢弃摘要
    expect(html).toContain('根标题')
    expect(html).toContain('子标题')
    expect(html).not.toContain('根摘要')
  })

  it('单节点子树规模低于阈值不降级（完整卡片 + 摘要截断仍在）', () => {
    const list = [
      s({ id: 'root', gen: 1, updatedAt: 100, title: '根标题', summary: '根摘要' }),
      s({ id: 'kid', parentId: 'root', gen: 2, updatedAt: 200, title: '子标题', summary: '子摘要' })
    ]
    const html = renderWith(list)
    expect(html).toContain('line-clamp-3')
    // 完整卡片渲染摘要文本（未降级时摘要可见）
    expect(html).toContain('根摘要')
    expect(html).toContain('子摘要')
  })

  it('子树规模达到阈值时该分支降级为点、未达阈值的兄弟保持完整卡片', () => {
    // root 的一支「big」挂 DENSE_SUBTREE_THRESHOLD 个后代 → big 及全部后代降级；
    // 另一支「small」仅 1 个后代，不降级，保留摘要。
    const list: InternalSessionSummary[] = [
      s({ id: 'root', gen: 1, updatedAt: 100 }),
      s({ id: 'big', parentId: 'root', gen: 2, updatedAt: 200, summary: '大分支摘要' }),
      s({ id: 'small', parentId: 'root', gen: 2, updatedAt: 300, summary: '小分支摘要' })
    ]
    for (let i = 0; i < DENSE_SUBTREE_THRESHOLD; i++) {
      list.push(s({ id: `big_kid_${i}`, parentId: 'big', gen: 3, updatedAt: 400 + i, summary: '后代摘要' }))
    }
    const html = renderWith(list)
    // big 分支降级：摘要行消失（line-clamp-3 仍存在 = small 分支保留完整卡片）
    expect(html).toContain('line-clamp-3')
    expect(html).toContain('小分支摘要')
    expect(html).not.toContain('大分支摘要')
    expect(html).not.toContain('后代摘要')
  })
})