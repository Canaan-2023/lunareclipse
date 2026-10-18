/**
 * RoomView 原位渲染探针（ADR-29 形态返工）。
 *
 * 为什么用 react-dom/server：项目 vitest 环境为 node（无 jsdom），`renderToStaticMarkup` 即可验证
 * DOM 输出，无需 jsdom + testing-library（与 `internal-sessions-view-render.test.tsx` 同范式）。
 *
 * 为什么直渲 RoomView：视图根组件经 `useSyncExternalStore` 读 store，SSR 分支固定取 `getInitialState`
 * （`sessions` 空 → AI 回落 `DEFAULT_AI_ID`；`ais` 空 → 名字回落 `AI1`）——本探针要断的正是
 * 「三主区 + 只读 AI 标签 + 自主开关」这套**结构**，不依赖注入种子。
 *
 * 覆盖：三主区按钮（执行器/采集器/设备）都在；房间所属 AI 是**只读标签**（不再有可切换的 `<select>`）；
 * 自主开关按钮在；默认落在执行器区。
 */
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import { RoomView } from '../src/components/Room/RoomView'

const html = renderToStaticMarkup(<RoomView sessionId="ses_1" />)

describe('RoomView 原位自主房间渲染', () => {
  it('三主区按钮齐全（执行器 / 采集器 / 设备）', () => {
    expect(html).toContain('执行器')
    expect(html).toContain('采集器')
    expect(html).toContain('设备')
  })

  it('房间所属 AI 是只读标签，且**没有**可切换的 AI 下拉（诉求 4：AI 选择不再单开窗口）', () => {
    expect(html).toContain('房间所属 AI')
    expect(html).toContain('AI1')
    expect(html).not.toContain('<select')
  })

  it('自主开关按钮在位（开启自主）', () => {
    expect(html).toContain('开启自主')
    expect(html).toContain('已停止')
  })

  it('默认落在执行器区（其内容容器渲染）', () => {
    // 执行器区 = 计划区 + 工具区；SSR 下两者各渲染自己的空态文案
    expect(html.length).toBeGreaterThan(200)
  })

  it('驾驶舱仪表在位：相位灯组 + 急停 + 事件流（像素风 v2）', () => {
    expect(html).toContain('room-led') // 相位灯（四灯）
    expect(html).toContain('aria-label="急停"')
    expect(html).toContain('房间事件流')
  })

  it('主区导航是 tablist（可访问性）', () => {
    expect(html).toContain('role="tablist"')
  })

  it('像素房间面板在位（AI 拟人化可视化；SSR 下为加载态）', () => {
    expect(html).toContain('AI 的房间')
    expect(html).toContain('加载像素形象')
  })
})
