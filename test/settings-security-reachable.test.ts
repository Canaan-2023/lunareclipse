/**
 * 「权限授予入口必须可达」的机械守卫。
 *
 * 为什么存在（用户 2026-10-19 报「采集器一直显示需要显式授权，实际设置里面根本没有那个选项」）：
 * 问题不在主进程——`security:*` 通道、告知义务门与 T1 目录都在；问题在**渲染面可达性**：
 * 设置抽屉是 `max-h-[88vh]`，左侧 18 个 Tab 却**没有 `overflow-y-auto`**，小屏/缩放时排在
 * 最后的「自主房间 / 权限 / 数据」被直接裁掉。DOM 里存在 ≠ 用户看得见——渲染测试也不会失败
 * （元素确实渲染了，只是不可达），只有扫源码能拦住这类回归。
 *
 * 同时锁住「采集器 → 权限页」的一步跳转：日志里「未授予 t1.collector」时，用户应当能从
 * 采集器分区直接跳到对应能力的授予行，而不是自己去猜权限在哪。
 */
import { describe, it, expect } from 'vitest'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'fs'
import { join } from 'path'
import { SecurityPanel } from '../src/components/Security/SecurityPanel'

const SRC = join(__dirname, '..', 'src')
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf-8')

describe('设置页 · 权限入口可达', () => {
  const settings = read('components/Settings/SettingsPanel.tsx')

  it('左侧 Tab 侧栏可滚动（18 个 Tab 不再被 88vh 抽屉裁掉）', () => {
    const nav = settings.match(/<nav[^>]*className="([^"]*)"/)
    expect(nav, '找不到设置页 Tab 侧栏').not.toBeNull()
    expect(nav![1]).toContain('overflow-y-auto')
  })

  it('「权限」Tab 在导航表里，且内容区**真的挂载** SecurityPanel（不是只 import）', () => {
    expect(settings).toContain("id: 'security' as Tab")
    // 只断言 `toContain('SecurityPanel')` 会被 import 行骗过（假通过）——这里断渲染分支
    expect(settings).toMatch(/\{tab === 'security' && <SecurityPanel\b/)
    // 跳转时把 focusKey 传下去
    expect(settings).toContain('focusKey')
  })

  it('采集器分区能跳到权限页并聚焦 t1.collector', () => {
    const room = read('components/Settings/sections/RoomSection.tsx')
    expect(room).toContain('onOpenSecurity')
    expect(room).toContain("'t1.collector'")
    expect(room).toContain('securityListCapabilities')
    // 第二层（AI 侧授予）必须显示在用户层勾选**之前/之上**，不能只藏在提示小字里
    expect(room.indexOf('collector.grant.title')).toBeLessThan(room.indexOf('collector.enable'))
  })

  it('权限页支持 focusKey：目标行真的被高亮（渲染断言，不只是字符串存在）', () => {
    const focused = renderToStaticMarkup(React.createElement(SecurityPanel, { focusKey: 't1.collector' }))
    expect(focused).toContain('id="security-cap-t1.collector"')
    expect(focused).toMatch(/id="security-cap-t1\.collector"[^>]*class="[^"]*border-accent\/60/)
    const plain = renderToStaticMarkup(React.createElement(SecurityPanel))
    expect(plain).toMatch(/id="security-cap-t1\.collector"[^>]*class="[^"]*border-border-subtle/)
  })

  it('面板源码有滚动聚焦与 catch（权限操作不许静默失败）', () => {
    const panel = read('components/Security/SecurityPanel.tsx')
    expect(panel).toContain('scrollIntoView')
    expect(panel).toContain('setActionError(err instanceof Error')
  })
})
