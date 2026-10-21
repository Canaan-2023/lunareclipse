/**
 * RoomView 原位渲染探针（UI v3 重做：**一个存在 + 一条输出 + 一个开关**）。
 *
 * 为什么用 react-dom/server：项目 vitest 环境为 node（无 jsdom），`renderToStaticMarkup` 即可验证
 * DOM 输出。视图根组件经 `useSyncExternalStore` 读 store，SSR 分支固定取 `getInitialState`
 * （`sessions` 空 → AI 回落 `DEFAULT_AI_ID`；`ais` 空 → 名字回落 `AI1`）——本探针断的正是
 * 「常驻只剩三件」这套**结构**，不依赖注入种子。
 *
 * 覆盖（重做后的**减法定则**）：
 * - 顶栏**一条**：AI 名 + 月相（形状）+ 状态词 + 记录 / 细节 / 开关；
 * - **输出常驻一条紧凑带**（用户要求「一定要有」），完整历史用 GALGAME 式 LOG 抽屉按需打开；
 * - **旧的 8 件常驻元素不再出现**：相位灯组 / 三 tab 区导航 / 状态栏 / 底部事件流；
 * - 区内容（计划 / 工具 / 设备）**降一层**——SSR 下不渲染（在细节面板里，且关闭时不挂载）。
 */
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import { RoomView } from '../src/components/Room/RoomView'
import { RoomLogPanel } from '../src/components/Room/RoomLogPanel'
import { AppearancePanel } from '../src/components/Room/drawer/AppearancePanel'
import { __setAppearanceForTest } from '../src/components/Room/use-appearance'

const html = renderToStaticMarkup(<RoomView sessionId="ses_1" />)

describe('RoomView：一个存在 + 一条输出 + 一个开关', () => {
  it('顶栏是一条：AI 名 + 月相 + 状态词 + 开关 + 细节入口', () => {
    expect(html).toContain('AI1')
    expect(html).toContain('已停止') // 状态词（room.phase.stopped）
    expect(html).toContain('开启自主') // 开关
    expect(html).toContain('aria-label="房间信息"') // 细节入口
    expect(html).toContain('aria-label="相位"') // 月相的可访问名
    expect(html).toContain('room-bar')
  })

  it('记录入口在位；常驻输出带可见（完整历史按需打开）', () => {
    expect(html).toContain('记录')
    // 用户要求「AI 的输出地方一定要有」：常驻一条紧凑输出带
    expect(html).toContain('room-stream')
    expect(html).toContain('role="log"')
    expect(html).toContain('还没有输出')
    const log = renderToStaticMarkup(<RoomLogPanel open events={[]} live={false} onClose={() => undefined} />)
    expect(log).toContain('role="log"')
    expect(log).toContain('room-stream')
    expect(log).toContain('还没有输出')
  })

  it('存在画面在位（全幅房间镜头；SSR 下画布照常挂载）', () => {
    expect(html).toContain('room-presence')
    expect(html).toContain('房间直播镜头')
  })

  it('房间镜头没有无意义 HUD / 空对话盒（环境表达状态，文字只用于真说话）', () => {
    expect(html).not.toContain('CAM 02')
    expect(html).not.toContain('CAM 01')
    expect(html).not.toContain('LIVE')
    expect(html).not.toContain('STOPPED')
    expect(html).not.toContain('在房间里')
    expect(html).not.toContain('room-hud-chip')
    // 没有台词时连字幕容器都不挂载（不是「渲染了再隐藏」）
    expect(html).not.toContain('room-subtitle-line')
    expect(html).toContain('room-camera')
  })

  it('房间所属 AI 是只读标签（没有可切换的 AI 下拉）', () => {
    expect(html).not.toContain('<select')
  })

  it('**旧的 8 件常驻元素不再出现在常驻面**（这是重做的全部意义）', () => {
    // 相位灯组（四盏带标签的灯）
    expect(html).not.toContain('room-led')
    // 三主区导航（tablist 常驻）
    expect(html).not.toContain('role="tablist"')
    // 底部事件流（与「唯一输出」重复的那一份）
    expect(html).not.toContain('房间事件流')
    // 急停按钮（0.52.71 已确认停止只有一档 → 一个控件就够）
    expect(html).not.toContain('aria-label="急停"')
  })

  it('区内容降一层：SSR 下不渲染（它们在细节面板里，且面板关闭时不挂载）', () => {
    expect(html).not.toContain('规划区')
    expect(html).not.toContain('AI 自造工具')
  })

  it('外观配置是用户侧独立入口（人物位置/大小 + 背景来源）', () => {
    const look = renderToStaticMarkup(<AppearancePanel aiId={1} />)
    expect(look).toContain('形象与背景')
    expect(look).toContain('水平')
    expect(look).toContain('纵深')
    expect(look).toContain('大小')
    expect(look).toContain('代码房间')
    expect(look).toContain('图片')
  })
})

describe('手动切背景（图片模式）', () => {
  it('有分区图 → 输出带出现「背景」入口；没有图 → 不出现', () => {
    __setAppearanceForTest(1, {
      appearance: {
        version: 1,
        character: { x: -0.45, y: 2.16, lift: 0, scale: 1 },
        background: { mode: 'image' }
      },
      scenes: {
        home: 'room-asset://room/AI1/scenes/home.png?v=1',
        work: 'room-asset://room/AI1/scenes/work.png?v=2'
      }
    })
    const seeded = renderToStaticMarkup(<RoomView sessionId="ses_1" />)
    expect(seeded).toContain('aria-label="背景"')
    expect(seeded).toContain('aria-expanded="false"')
    // 浮层默认关闭：分区 chip 不挂载（不占舞台）
    expect(seeded).not.toContain('跟随 AI')
  })
})
