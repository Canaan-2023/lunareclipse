/**
 * ROOM「细节」面板（UI v3：常驻只剩顶栏 / 房间画面 / 输出流，其余**降一层**到这里）回归。
 *
 * 为什么测：
 * 1. **授权页的条数必须等于真实能力目录**——面板里写死一份「能力清单」是本处最容易犯的错
 *    （目录是唯一真源 `@shared/security/tiers`，面板只能读它）；授权页现在是**与设置页共用的
 *    `SecurityPanel`**（用户 2026-10-19 补了授予入口与告知义务），故本处顺带锁「两处同一个组件」；
 * 2. **关闭时整块不渲染**（不是「渲染了再隐藏」——否则里面的组件仍会取数）；
 * 3. **六页齐全且只有一个 `aria-selected`**（tab ↔ tabpanel 对得上）。
 */
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import { T0_CAPABILITIES, T1_CAPABILITIES, T2_CAPABILITIES } from '@shared/security/tiers'
import { shiftIso, toIso, todayIso } from '../src/components/Room/drawer/dates'
import { AboutPanel } from '../src/components/Room/drawer/RoomPanels'
import { SecurityPanel, formatStamp, splitScopeLines } from '../src/components/Security/SecurityPanel'
import { addScopeEntry, normalizeScopeEntry, removeScopeEntry } from '../src/components/Security/scope-input'
import { DetailPanel } from '../src/components/Room/DetailPanel'
import { EMPTY_ROOM_SNAPSHOT } from '../src/components/Room/room-status'

describe('细节面板 · 日期纯函数（日记页）', () => {
  it('toIso 用本地时区（不按 UTC 跨日）', () => {
    expect(toIso(new Date(2026, 9, 19, 0, 30))).toBe('2026-10-19')
    expect(toIso(new Date(2026, 0, 5))).toBe('2026-01-05')
  })

  it('todayIso 的 now 可注入（时间只采样一次）', () => {
    expect(todayIso(new Date(2026, 9, 19, 23, 59))).toBe('2026-10-19')
  })

  it('shiftIso 跨月 / 跨年 / 闰年 / 负数都正确；非法输入原样返回不抛', () => {
    expect(shiftIso('2026-11-01', -1)).toBe('2026-10-31')
    expect(shiftIso('2026-01-01', -1)).toBe('2025-12-31')
    expect(shiftIso('2024-02-28', 1)).toBe('2024-02-29')
    expect(shiftIso('not-a-date', 1)).toBe('not-a-date')
  })
})

describe('细节面板 · 授权页（可授予 + 告知义务；与设置页同一个组件）', () => {
  const html = renderToStaticMarkup(<SecurityPanel />)

  it('三档目录都在，且条数与真实目录**逐一相等**（不写死第二份清单）', () => {
    for (const n of [T0_CAPABILITIES.length, T1_CAPABILITIES.length, T2_CAPABILITIES.length]) {
      expect(html).toContain(`>${n}<`)
    }
    expect(html).toContain(T0_CAPABILITIES[0].key)
    expect(html).toContain(T0_CAPABILITIES[0].title)
  })

  it('告知义务条款在页面里（授予前必须能看到它）', () => {
    expect(html).toContain('权限授予告知')
    expect(html).toContain('由你自行承担')
  })

  it('取数完成前**不显示已确认**，且授予按钮不可用（点了也会被主进程以未确认拒绝）', () => {
    expect(html).not.toContain('条款 v')
    expect(html).toContain('disabled')
  })

  it('诚实边界**看得见**（从主界面移到授权页，但没有消失）', () => {
    expect(html).toContain('未授予 T1')
  })

  it('scoped 能力给出「必须圈范围」的说明（否则授予即失效）', () => {
    const scoped = T1_CAPABILITIES.filter((c) => c.scoped === true)
    expect(scoped.length).toBeGreaterThan(0)
    // 每个 scoped 能力都必须在目录里自述范围字段（UI 不另建映射表）
    for (const c of scoped) expect(c.scopeField, `${c.key} 缺少 scopeField`).toBeTruthy()
  })
})

describe('授权面板 · 纯函数', () => {
  it('splitScopeLines 去空、去重、认换行与逗号', () => {
    expect(splitScopeLines('a\n b , a\n\nc')).toEqual(['a', 'b', 'c'])
    expect(splitScopeLines('   ')).toEqual([])
  })

  it('formatStamp 只依赖入参（不读当前时刻）', () => {
    expect(formatStamp(new Date(2026, 9, 19, 8, 5).getTime())).toBe('2026-10-19 08:05')
  })

  it('0.53.1 范围条目：规范化 / 去重追加 / 移除（不改入参）', () => {
    expect(normalizeScopeEntry('  "192.168.1.10"  ')).toBe('192.168.1.10')
    expect(normalizeScopeEntry('   ')).toBeNull()
    const base = ['a']
    expect(addScopeEntry(base, ' b ')).toEqual(['a', 'b'])
    expect(addScopeEntry(base, 'a')).toEqual(['a'])
    expect(base).toEqual(['a'])
    expect(removeScopeEntry(['a', 'b'], 'a')).toEqual(['b'])
  })
})

describe('授权面板 · 范围编辑器（0.53.1：不再让用户猜填什么）', () => {
  const html = renderToStaticMarkup(<SecurityPanel />)
  const scoped = T1_CAPABILITIES.filter((c) => c.scoped === true)

  it('每个 scoped 能力都自述「范围怎么填」+「授予后会发生什么」（目录即唯一真源）', () => {
    for (const c of scoped) {
      expect(c.scopeHint, `${c.key} 缺少 scopeHint`).toBeTruthy()
      expect(c.usage, `${c.key} 缺少 usage`).toBeTruthy()
    }
  })

  it('t1.migrate 的候选来源是局域网节点（列出当前节点供勾选，而不是空白文本框）', () => {
    const migrate = T1_CAPABILITIES.find((c) => c.key === 't1.migrate')!
    expect(migrate.scopeSource).toBe('lan-nodes')
    expect(html).toContain('读取局域网节点')
  })

  it('targets / endpoints 给出可直接点选的示例（路径 / 网址 / IP）', () => {
    const targets = T1_CAPABILITIES.find((c) => c.key === 't1.authorized-target-ops')!
    const egress = T1_CAPABILITIES.find((c) => c.key === 't1.declared-egress')!
    expect(targets.scopeExamples?.length).toBeGreaterThan(0)
    expect(egress.scopeExamples?.some((x) => x.startsWith('http'))).toBe(true)
    expect(html).toContain('示例')
  })
})

describe('细节面板 · 关于页', () => {
  it('SSR（规格未取到）时仍显示 AI 名字与房间会话 id', () => {
    const html = renderToStaticMarkup(<AboutPanel aiId={1} aiName="月蚀" roomSessionId="room-autonomous-U1-AI1" />)
    expect(html).toContain('月蚀')
    expect(html).toContain('room-autonomous-U1-AI1')
  })
})

describe('细节面板 · 壳', () => {
  const noop = (): void => undefined
  const render = (open: boolean, tab: 'act' | 'diary' = 'act'): string =>
    renderToStaticMarkup(
      <DetailPanel
        open={open}
        tab={tab}
        onTab={noop}
        onClose={noop}
        state={EMPTY_ROOM_SNAPSHOT}
        aiId={1}
        aiName="月蚀"
      />
    )

  it('关闭时**不渲染**（不是渲染了再隐藏——否则面板仍会取数）', () => {
    expect(render(false)).toBe('')
  })

  it('打开时是 dialog + 六页，且只有一个 aria-selected', () => {
    const html = render(true)
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('role="tablist"')
    for (const label of ['动作', '感知', '设备', '日记', '授权', '关于我']) {
      expect(html, `缺少页：${label}`).toContain(label)
    }
    expect([...html.matchAll(/aria-selected="true"/g)]).toHaveLength(1)
  })

  it('tab 与 tabpanel 通过 aria-controls / aria-labelledby 对得上', () => {
    const html = render(true, 'diary')
    expect(html).toContain('id="room-detail-tab-diary"')
    expect(html).toContain('aria-controls="room-detail-panel-diary"')
    expect(html).toContain('id="room-detail-panel-diary"')
    expect(html).toContain('aria-labelledby="room-detail-tab-diary"')
  })
})
