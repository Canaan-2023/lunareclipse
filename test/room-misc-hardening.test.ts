/**
 * 收尾三项（B14）回归测试：切换审计落盘 + 全屏采集降级。
 *
 * 为什么存在：切换审计原本只有内存环（重启即清）——落盘是「可回溯」的关键；
 * 全屏采集依赖 electron 的 desktopCapturer，**无 electron 环境必须优雅降级**（否则单测/CLI 直接崩）。
 *
 * 覆盖：sink 注入后每条切换落盘 / sink 抛错不影响记录 / 清空后 sink 仍可用 /
 * captureAllScreens 在无 electron API 时返回空数组（不抛）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordModelSwitch,
  listModelSwitches,
  resetModelSwitchLog,
  setModelSwitchSink
} from '../electron/main/api/llm/model-switch-log'
import { captureAllScreens } from '../electron/main/room/screen-capture'

const ENTRY = { ts: 1, round: 2, from: 'a', to: 'b', tier: 'strong' as const, reason: 'r' }

describe('模型切换审计：落盘 sink', () => {
  beforeEach(() => {
    resetModelSwitchLog()
    setModelSwitchSink(null)
  })

  it('注入 sink 后每条切换都落盘（且仍进内存环）', () => {
    const written: unknown[] = []
    setModelSwitchSink((e) => written.push(e))
    recordModelSwitch(ENTRY)
    expect(written).toEqual([ENTRY])
    expect(listModelSwitches()).toEqual([ENTRY])
  })

  it('sink 抛错不影响记录（审计是旁路）', () => {
    setModelSwitchSink(() => {
      throw new Error('disk full')
    })
    expect(() => recordModelSwitch(ENTRY)).not.toThrow()
    expect(listModelSwitches()).toHaveLength(1)
  })

  it('未注入 sink 时只进内存环（与改造前一致）', () => {
    recordModelSwitch(ENTRY)
    expect(listModelSwitches()).toHaveLength(1)
  })

  it('环容量上限生效', () => {
    for (let i = 0; i < 130; i++) recordModelSwitch({ ...ENTRY, round: i })
    expect(listModelSwitches().length).toBeLessThanOrEqual(100)
  })
})

describe('captureAllScreens：无 electron 环境优雅降级', () => {
  it('返回数组且不抛错（vitest 下无 desktopCapturer/screen）', async () => {
    const shots = await captureAllScreens('/tmp/le-shots')
    expect(Array.isArray(shots)).toBe(true)
  })
})
