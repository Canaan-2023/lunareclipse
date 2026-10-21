/**
 * 输入区「模式选择」判定（ROOM 界面重做 · 阶段 A）。
 *
 * 覆盖三件事：
 * 1. pill 当前态的**优先级**（房间视图 > 计划模式 > aiMode）——三者性质不同（视图态 / 后端会话闸 / 持久化配置）；
 * 2. 「自主」与 aiMode **正交**：进出房间不改写 aiMode，故离开房间后 pill 自然回到进入前的值；
 * 3. **入口去重**：视图切换按钮收窄为 普通 ↔ 会话树（房间入口只留模式菜单一处）；
 * 4. 「循环仍在跑但已切走视图」的标记显示条件（切走视图不停循环，必须让用户看得见）。
 */
import { describe, it, expect } from 'vitest'
import {
  nextViewModeForToggle,
  resolveCurrentModeKey,
  shouldShowRunningIndicator
} from '../src/components/Input/mode-selection'

describe('resolveCurrentModeKey：pill 当前态优先级', () => {
  it('房间视图最优先，且与 aiMode 无关（房间 + 计划同时为真也仍是 auto）', () => {
    for (const aiMode of ['coding', 'chat', 'task', undefined]) {
      expect(resolveCurrentModeKey({ inRoom: true, planModeActive: false, aiMode })).toBe('auto')
      expect(resolveCurrentModeKey({ inRoom: true, planModeActive: true, aiMode })).toBe('auto')
    }
  })

  it('计划模式次优先于 aiMode（会话级只读闸）', () => {
    expect(resolveCurrentModeKey({ inRoom: false, planModeActive: true, aiMode: 'chat' })).toBe('plan')
    expect(resolveCurrentModeKey({ inRoom: false, planModeActive: true, aiMode: 'task' })).toBe('plan')
  })

  it('否则显示 aiMode；缺省或非法值回退 coding', () => {
    expect(resolveCurrentModeKey({ inRoom: false, planModeActive: false, aiMode: 'chat' })).toBe('chat')
    expect(resolveCurrentModeKey({ inRoom: false, planModeActive: false, aiMode: 'task' })).toBe('task')
    expect(resolveCurrentModeKey({ inRoom: false, planModeActive: false, aiMode: undefined })).toBe('coding')
    expect(resolveCurrentModeKey({ inRoom: false, planModeActive: false, aiMode: 'bogus' })).toBe('coding')
  })

  it('进出房间不改 aiMode：离开后 pill 回到进入前的值', () => {
    const aiMode = 'task'
    expect(resolveCurrentModeKey({ inRoom: true, planModeActive: false, aiMode })).toBe('auto')
    expect(resolveCurrentModeKey({ inRoom: false, planModeActive: false, aiMode })).toBe('task')
  })
})

describe('nextViewModeForToggle：入口去重（房间不再在循环里）', () => {
  it('普通 ↔ 会话树 往返', () => {
    expect(nextViewModeForToggle('normal')).toBe('tree')
    expect(nextViewModeForToggle('tree')).toBe('normal')
  })

  it('房间 → 会话树（不再循环回普通，也不再把房间当第三态）', () => {
    expect(nextViewModeForToggle('room')).toBe('tree')
  })
})

describe('shouldShowRunningIndicator：切走视图后仍可见', () => {
  it('不在房间 + 循环在跑 → 显示', () => {
    expect(shouldShowRunningIndicator({ inRoom: false, roomRunning: true })).toBe(true)
  })

  it('在房间里不显示（房间自己就是状态显示器）', () => {
    expect(shouldShowRunningIndicator({ inRoom: true, roomRunning: true })).toBe(false)
  })

  it('循环没跑就不显示（不制造无意义的状态点）', () => {
    expect(shouldShowRunningIndicator({ inRoom: false, roomRunning: false })).toBe(false)
  })
})
