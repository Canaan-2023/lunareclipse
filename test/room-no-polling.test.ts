/**
 * ROOM 渲染端**不得轮询**的机械守卫。
 *
 * 为什么存在（用户裁决，2026-10-19）：「采集器复杂给 AI 环境，那只需要在 AI 沉默后返回数据就好了，
 * 那个时候再采集就好了，其余时间都是浪费」——同一条裁决适用于界面：**没事发生时不产生任何工作**。
 * 此前渲染端有 **3 个定时轮询**（`RoomView` 3s + `RuntimeZones` 3s 同一通道 + `ModeMenu` 5s），
 * 现已全部改为「挂载读一次 + 主进程状态推送」。
 *
 * 为什么用源码扫描而不是渲染测试：轮询的回归形态是「有人又加回一个 `setInterval`」——渲染测试
 * 不会因此失败（DOM 输出一模一样），只有扫源码才看得见。本项目已有同类机械门禁
 * （`build/scripts/assert-max-lines.mjs` / `assert-test-typecheck.mjs`），此处把该裁决变成可执行断言。
 *
 * 覆盖：① 房间渲染组件 / 取数 hook / 模式 pill 内无定时轮询；② 取数 hook 确实同时具备
 * 「一次性读取」与「推送订阅」；③ 推送通道名在主进程与 preload 两侧**字面一致**。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..')

/** 房间的渲染面与取数点：这些文件里出现定时轮询 = 裁决被推翻 */
// 例外（不在清单内）：`src/components/Room/use-character-drag.ts` 有一个 `setTimeout`，
// 它是**用户拖动/滚轮之后的防抖落盘**（450ms 后写一次 appearance.json），
// 只在有人操作时存在、空闲即清；不是后台轮询，故不纳入源码扫描。
const NO_POLL_FILES = [
  'src/components/Room/RoomView.tsx',
  'src/components/Room/RuntimeZones.tsx',
  // 画面与输出（v3 重做后）：画面动画用 `requestAnimationFrame`（渲染本身，且被相位/可见性/
  // reduced-motion 闸住）、呼吸用 **CSS 动画**（无 JS 定时器）——这里锁死「不得退回
  // setInterval/setTimeout」（那才是定时轮询的形态）
  'src/components/Room/Presence.tsx',
  'src/components/Room/PerspectiveRoom.tsx',
  'src/components/Room/perspective-art.ts',
  'src/components/Room/PresenceBar.tsx',
  'src/components/Room/OutputStream.tsx',
  'src/components/Room/DetailPanel.tsx',
  'src/components/Room/scene-layers.ts',
  'src/components/Room/use-room-state.ts',
  'src/components/Input/ModeMenu.tsx'
]

/** 推送通道的**两处**字面（一发送 + 一订阅）：改名只改一侧 = 界面永远收不到状态 */
const PUSH_CHANNEL = 'room:state-changed'
const CHANNEL_FILES = [
  'electron/main/bootstrap/room-runtime.ts',
  'electron/preload/domains/room.ts'
]

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf-8')
}

describe('ROOM 渲染端不轮询（没事发生时不产生工作）', () => {
  it('房间渲染组件 / 取数 hook / 模式 pill 内无定时轮询', () => {
    for (const rel of NO_POLL_FILES) {
      const text = read(rel)
      // 只看**调用**（`setInterval(`）——注释里提到它是允许的（本批就是在注释里解释为什么去掉）
      expect(text, `${rel} 不应有 setInterval 轮询`).not.toMatch(/setInterval\s*\(/)
      expect(text, `${rel} 不应有 setTimeout 轮询`).not.toMatch(/setTimeout\s*\(/)
    }
  })

  it('运行态靠推送：取数 hook 同时具备一次性读取与推送订阅', () => {
    const text = read('src/components/Room/use-room-state.ts')
    expect(text).toContain('roomRuntimeState')
    expect(text).toContain('onRoomState')
  })

  it('推送通道名在主进程与 preload 两侧字面一致', () => {
    for (const rel of CHANNEL_FILES) {
      expect(read(rel), rel).toContain(`'${PUSH_CHANNEL}'`)
    }
  })
})
