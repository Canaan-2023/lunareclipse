/**
 * ROOM「存在」画面：分层与五态（UI v3 重做后）回归。
 *
 * 设计口径：**里面是它的画（像素），外面是系统给的真实光（平滑）**。
 * 为什么测：五态差异**错了不会报错**——只会显示错的天气/错的光（静默失效）。另锁四条硬约束：
 * 1. **静止时零开销**：停 / 待机 / 出错、页面不可见、`prefers-reduced-motion` → 一律不跑天空动画；
 * 2. **呼吸是「越快越活」**：运行 < 空闲 < 待机的周期，且静止态**不呼吸**（`null`）；
 * 3. **整数缩放**：非整数倍会让 1px 方块粗细不一（像素风第一条硬约束）；
 * 4. **可复现**：星点用确定性伪随机（不用 `Math.random`）——同一 `(state, w, h)` 必须逐点相同。
 */
import { describe, it, expect } from 'vitest'
import {
  SCENE_FRAME_MS,
  SCENE_SCALE_MAX,
  SCENE_SCALE_MIN,
  avatarFrameMs,
  breathAmplitude,
  breathPeriodMs,
  cloudBand,
  fitScale,
  glowFor,
  integerScale,
  sceneStateOf,
  shouldAnimate,
  skyGradient,
  starSprite,
  stars,
  type SceneState
} from '../src/components/Room/scene-layers'

const STATES: SceneState[] = ['stopped', 'standby', 'idle', 'running', 'error']

describe('sceneStateOf：五态（四相位 + 出错）', () => {
  it('四相位各自映射；未知相位归 stopped', () => {
    expect(sceneStateOf('running')).toBe('running')
    expect(sceneStateOf('idle')).toBe('idle')
    expect(sceneStateOf('standby')).toBe('standby')
    expect(sceneStateOf('stopped')).toBe('stopped')
    expect(sceneStateOf('nonsense')).toBe('stopped')
  })

  it('出错优先于一切（与顶栏红月同口径）', () => {
    for (const p of ['stopped', 'standby', 'idle', 'running']) {
      expect(sceneStateOf(p, { llmFailed: true })).toBe('error')
    }
  })
})

describe('integerScale：整数倍缩放', () => {
  it('按容器宽取房间宽的整数倍，并夹在上下限内', () => {
    expect(integerScale(640, 64)).toBe(10) // 上限已抬到 14（0.52.87），不再夹在 6
    expect(integerScale(320, 64)).toBe(5)
    expect(integerScale(128, 64)).toBe(2)
    expect(integerScale(64, 64)).toBe(1)
    expect(integerScale(0, 64)).toBe(SCENE_SCALE_MIN)
    expect(integerScale(9999, 64)).toBe(SCENE_SCALE_MAX)
  })

  it('非法输入不炸（NaN / 房间宽 0）', () => {
    expect(integerScale(Number.NaN, 64)).toBe(SCENE_SCALE_MIN)
    expect(integerScale(320, 0)).toBe(SCENE_SCALE_MIN)
  })
})

describe('fitScale：**同时**受宽与高约束（只看宽度会把角色裁没）', () => {
  it('取宽高两个整数倍里更小的那个', () => {
    // 宽 600/112 = 5，高 240/72 = 3 → 3
    expect(fitScale(600, 240, 112, 72)).toBe(3)
    // 高很富裕时由宽度决定
    expect(fitScale(600, 800, 112, 72)).toBe(5)
    // 宽很富裕时由高度决定
    expect(fitScale(2000, 144, 112, 72)).toBe(2)
  })

  it('容器还没量到（0×0）→ 返回下限，量到后自动修正', () => {
    expect(fitScale(0, 0, 112, 72)).toBe(SCENE_SCALE_MIN)
    expect(fitScale(560, 360, 112, 72)).toBe(5)
  })

  it('下限保底：容器比一屏还小时仍返回下限（宁可裁，也不画成不可辨的 0 倍）', () => {
    expect(fitScale(50, 30, 112, 72)).toBe(SCENE_SCALE_MIN)
    expect(fitScale(9999, 9999, 112, 72)).toBe(SCENE_SCALE_MAX)
  })

  it('非法输入不炸（NaN / 尺寸 0）', () => {
    expect(fitScale(Number.NaN, 240, 112, 72)).toBe(SCENE_SCALE_MIN)
    expect(fitScale(600, Number.NaN, 112, 72)).toBe(SCENE_SCALE_MIN)
    expect(fitScale(600, 240, 0, 72)).toBe(SCENE_SCALE_MIN)
    expect(fitScale(600, 240, 112, 0)).toBe(SCENE_SCALE_MIN)
  })

  it('结果永远不超出容器（这是它的全部意义）', () => {
    for (const [w, h] of [[600, 240], [320, 200], [900, 500], [450, 130]]) {
      const s = fitScale(w, h, 112, 72)
      expect(112 * s, `宽 ${w}`).toBeLessThanOrEqual(Math.max(w, 112))
      expect(72 * s, `高 ${h}`).toBeLessThanOrEqual(Math.max(h, 72))
    }
  })
})

describe('shouldAnimate：静止时零开销（天空动画）', () => {
  it('只有空闲与运行会动', () => {
    expect(shouldAnimate('idle', { hidden: false, reducedMotion: false })).toBe(true)
    expect(shouldAnimate('running', { hidden: false, reducedMotion: false })).toBe(true)
    for (const s of ['stopped', 'standby', 'error'] as SceneState[]) {
      expect(shouldAnimate(s, { hidden: false, reducedMotion: false })).toBe(false)
    }
  })

  it('页面不可见 / 要求减弱动效 → 一律不动', () => {
    for (const s of STATES) {
      expect(shouldAnimate(s, { hidden: true, reducedMotion: false })).toBe(false)
      expect(shouldAnimate(s, { hidden: false, reducedMotion: true })).toBe(false)
    }
  })
})

describe('呼吸：越快越活，静止不呼吸', () => {
  it('周期 running < idle < standby；停 / 出错为 null（不呼吸）', () => {
    const run = breathPeriodMs('running')!
    const idle = breathPeriodMs('idle')!
    const stand = breathPeriodMs('standby')!
    expect(run).toBeLessThan(idle)
    expect(idle).toBeLessThan(stand)
    expect(breathPeriodMs('stopped')).toBeNull()
    expect(breathPeriodMs('error')).toBeNull()
  })

  it('振幅同样单调，且静止为 null（振幅很小，是「呼吸」不是「跳动」）', () => {
    expect(breathAmplitude('running')!).toBeGreaterThan(breathAmplitude('idle')!)
    expect(breathAmplitude('idle')!).toBeGreaterThan(breathAmplitude('standby')!)
    expect(breathAmplitude('running')!).toBeLessThan(0.05)
    expect(breathAmplitude('stopped')).toBeNull()
  })
})

describe('形象动画帧节拍（与天空节拍**解耦**）', () => {
  it('运行比空闲快；待机 / 熄灯 / 出错一律不动（null）', () => {
    expect(avatarFrameMs('running')!).toBeLessThan(avatarFrameMs('idle')!)
    for (const s of ['standby', 'stopped', 'error'] as SceneState[]) expect(avatarFrameMs(s)).toBeNull()
  })

  it('比天空节拍慢：形象的动作不该跟云一样快', () => {
    expect(avatarFrameMs('running')!).toBeGreaterThan(SCENE_FRAME_MS)
  })
})

describe('天空：五态渐变两两不同', () => {
  it('五态各有不同的三段色（不只靠星/云区分）', () => {
    const sigs = STATES.map((s) => JSON.stringify(skyGradient(s)))
    expect(new Set(sigs).size).toBe(STATES.length)
  })
})

describe('星点', () => {
  it('熄灯态没有星（外面什么都看不见）；其余四态都有', () => {
    expect(stars('stopped', 64, 40)).toHaveLength(0)
    for (const s of ['standby', 'idle', 'running', 'error'] as SceneState[]) {
      expect(stars(s, 64, 40).length).toBeGreaterThan(0)
    }
  })

  it('可复现：同一 (state, w, h) 逐点相同（不用 Math.random）', () => {
    expect(stars('idle', 64, 40)).toEqual(stars('idle', 64, 40))
  })

  it('星只在画面上部（地平线以下没有星）', () => {
    for (const s of stars('idle', 64, 40)) expect(s.y).toBeLessThan(40 * 0.62)
  })

  it('出错态星是烧红的（调色板与其它态不同）', () => {
    expect(starSprite('error', 64, 40)!.palette).not.toEqual(starSprite('idle', 64, 40)!.palette)
  })

  it('starSprite：无星返回 null；有星时尺寸/调色板合法', () => {
    expect(starSprite('stopped', 64, 40)).toBeNull()
    const sp = starSprite('idle', 64, 40)!
    expect(sp.w).toBe(64)
    expect(sp.h).toBe(40)
    expect(sp.frames.stars).toHaveLength(40)
    for (const row of sp.frames.stars) {
      expect(row).toHaveLength(64)
      for (const ch of row) {
        if (ch === '.') continue
        expect(Number.parseInt(ch, 16)).toBeLessThan(sp.palette.length)
      }
    }
  })
})

describe('云：只有空闲/运行有云，且随时间漂移（运行更快）', () => {
  it('停 / 待机 / 出错没有云', () => {
    for (const s of ['stopped', 'standby', 'error'] as SceneState[]) {
      expect(cloudBand(s, 64, 40, 0)).toBeNull()
    }
  })

  it('云随时间左移；运行比空闲快', () => {
    const idle0 = cloudBand('idle', 64, 40, 0)!
    const idle1 = cloudBand('idle', 64, 40, 1)!
    expect(idle1.x).not.toBe(idle0.x)
    const run1 = cloudBand('running', 64, 40, 1)!
    // 同样 +1 帧：运行位移是空闲的两倍
    expect(idle0.x - idle1.x).toBeCloseTo(2, 5)
    expect(idle0.x - run1.x).toBeCloseTo(4, 5)
  })
})

describe('环境光晕：五态两两不同（含「熄灯=不发光」）', () => {
  it('熄灯不发光；其余四态各有色温与强度', () => {
    expect(glowFor('stopped')).toBeNull()
    const sigs = STATES.map((s) => JSON.stringify(glowFor(s) ?? null))
    expect(new Set(sigs).size).toBe(STATES.length)
  })

  it('运行最亮最大；出错是红警', () => {
    expect(glowFor('running')!.alpha).toBeGreaterThan(glowFor('standby')!.alpha)
    expect(glowFor('running')!.radiusRatio).toBeGreaterThan(glowFor('standby')!.radiusRatio)
    expect(glowFor('error')!.color).toContain('ff2d3d')
  })
})

describe('天空节拍', () => {
  it('约 5fps（云与星不需要 60fps）', () => {
    expect(SCENE_FRAME_MS).toBe(200)
  })
})
