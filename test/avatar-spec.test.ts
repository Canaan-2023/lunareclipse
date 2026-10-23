/**
 * 像素规格校验（`@shared/room/avatar-spec`）与默认画（`electron/main/room/default-art`）。
 *
 * 为什么测：这是「AI 画自己」（P3）的**数据入口**——越界/非法规格必须在入口 fail-closed，
 * 绝不把未校验的像素数据交给渲染端。校验是纯函数，无需主进程装配。
 *
 * 本版（2026-10-19「角色要二次元风格…保存挂在某个动作上」之后）额外锁四件事：
 * 1. **默认画的结构不变量**——尺寸 / 调色板 / 行宽 / 字符集，以及**窗内必须透明**
 *    （窗内一旦被墙色填上，系统天空就透不进来，而这是静默失效：画面看起来仍然「正常」）；
 * 2. **可复现**——默认画必须逐字符稳定（画法里不得出现 `Math.random`）；
 * 3. **动画帧**——`<名字>.<序号>` 的解析与按 `tick` 循环（含序号是**数值**排序，不是字典序）；
 * 4. **行为绑定**——触发源闭集 / 帧必须存在 / 不许重复 / **阶段优先于相位、出错优先于一切**。
 */
import { describe, it, expect } from 'vitest'
import {
  AVATAR_LIMITS,
  BEHAVIOR_LIMITS,
  BEHAVIOR_TRIGGERS,
  behaviorTriggerFor,
  frameNames,
  matchBehavior,
  pickFrame,
  resolveAvatarFrameMs,
  resolveAvatarFrameName,
  resolveAvatarFrames,
  validateAvatarSpec,
  type RoomAvatarSpec
} from '@shared/room/avatar-spec'
import { DEFAULT_AVATAR_SPEC, DEFAULT_BEHAVIORS, POSE_PRESETS, makeDefaultRoomSprite } from '../electron/main/room/default-art'

/** 深拷贝一份默认规格，便于逐项破坏。 */
function clone(): RoomAvatarSpec {
  return JSON.parse(JSON.stringify(DEFAULT_AVATAR_SPEC)) as RoomAvatarSpec
}

/** 默认形象里代表「睁眼站立」的那一帧（动画帧命名下没有裸 `idle` 了） */
const IDLE0 = 'idle.0'

describe('validateAvatarSpec：默认规格与合法路径', () => {
  it('默认规格合法（房间/形象/坐标/行为都通过）', () => {
    const v = validateAvatarSpec(DEFAULT_AVATAR_SPEC)
    expect(v.ok).toBe(true)
    if (v.ok) {
      // 2026-10-19 看板娘：房间 112×72（给角色留余地）、形象 28×40（二次元少女）
      expect(v.spec.room.w).toBe(112)
      expect(v.spec.room.h).toBe(72)
      expect(v.spec.avatar.w).toBe(28)
      expect(v.spec.avatar.h).toBe(40)
      expect(v.spec.avatarPos.x + v.spec.avatar.w).toBeLessThanOrEqual(v.spec.room.w)
      expect(v.spec.avatarPos.y + v.spec.avatar.h).toBeLessThanOrEqual(v.spec.room.h)
      expect(v.spec.behaviors?.length).toBeGreaterThan(0)
    }
  })

  it('颜色归一为小写（大小写不敏感）', () => {
    const spec = clone()
    spec.avatar.palette[0] = '#D6B276'
    const v = validateAvatarSpec(spec)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.spec.avatar.palette[0]).toBe('#d6b276')
  })

  it('不带 behaviors 也合法（老规格无需改写）', () => {
    const spec = clone()
    delete spec.behaviors
    const v = validateAvatarSpec(spec)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.spec.behaviors).toBeUndefined()
  })
})

describe('validateAvatarSpec：越界与非法形状一律 fail-closed', () => {
  it('版本非 1 → 拒', () => {
    const spec = clone() as unknown as { version: number }
    spec.version = 2
    expect(validateAvatarSpec(spec).ok).toBe(false)
  })

  it('尺寸为 0 / 超上限 → 拒', () => {
    const a = clone()
    a.room.w = 0
    expect(validateAvatarSpec(a).ok).toBe(false)
    const b = clone()
    b.room.w = AVATAR_LIMITS.maxDim + 1
    expect(validateAvatarSpec(b).ok).toBe(false)
  })

  it('调色板超色数 / 颜色格式非法 → 拒', () => {
    const a = clone()
    a.avatar.palette = Array.from({ length: AVATAR_LIMITS.maxColors + 1 }, () => '#000000')
    expect(validateAvatarSpec(a).ok).toBe(false)
    const b = clone()
    b.avatar.palette = ['red']
    expect(validateAvatarSpec(b).ok).toBe(false)
  })

  it('帧行数 / 每行字符数不符 → 拒', () => {
    const a = clone()
    a.avatar.frames[IDLE0] = a.avatar.frames[IDLE0].slice(0, 5)
    expect(validateAvatarSpec(a).ok).toBe(false)
    const b = clone()
    b.avatar.frames[IDLE0][0] = '..'
    expect(validateAvatarSpec(b).ok).toBe(false)
  })

  it('帧含非法字符 → 拒（只允许 . 与 0-9a-f）', () => {
    const spec = clone()
    spec.avatar.frames[IDLE0][0] = 'xxx'
    expect(validateAvatarSpec(spec).ok).toBe(false)
  })

  it('帧数超上限 → 拒', () => {
    const spec = clone()
    for (let i = 0; i < AVATAR_LIMITS.maxFrames + 2; i++) spec.avatar.frames[`f${i}`] = spec.avatar.frames[IDLE0]
    expect(validateAvatarSpec(spec).ok).toBe(false)
  })

  it('形象越出房间边界 / 坐标为负 → 拒', () => {
    const a = clone()
    a.avatarPos = { x: 200, y: 0 }
    expect(validateAvatarSpec(a).ok).toBe(false)
    const b = clone()
    b.avatarPos = { x: -1, y: 0 }
    expect(validateAvatarSpec(b).ok).toBe(false)
  })
})

describe('validateAvatarSpec：行为绑定（绑错不会报错，只会「画了但从不出现」）', () => {
  it('触发源必须在闭集里 → 未知触发源被拒', () => {
    const spec = clone()
    spec.behaviors = [{ trigger: 'nonsense' as never, frames: [IDLE0] }]
    const v = validateAvatarSpec(spec)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.error).toContain('触发源')
  })

  it('引用了不存在的帧 → 拒（否则播放时是空白）', () => {
    const spec = clone()
    spec.behaviors = [{ trigger: 'idle', frames: ['no-such-frame'] }]
    const v = validateAvatarSpec(spec)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.error).toContain('no-such-frame')
  })

  it('同一触发源重复 → 拒（重复即歧义，谁赢说不清）', () => {
    const spec = clone()
    spec.behaviors = [
      { trigger: 'idle', frames: [IDLE0] },
      { trigger: 'idle', frames: ['idle.1'] }
    ]
    expect(validateAvatarSpec(spec).ok).toBe(false)
  })

  it('空帧数组 / 超条数 / frameMs 越界 → 拒', () => {
    const empty = clone()
    empty.behaviors = [{ trigger: 'idle', frames: [] }]
    expect(validateAvatarSpec(empty).ok).toBe(false)

    const many = clone()
    many.behaviors = Array.from({ length: BEHAVIOR_LIMITS.maxBehaviors + 1 }, (_, i) => ({
      trigger: BEHAVIOR_TRIGGERS[i % BEHAVIOR_TRIGGERS.length],
      frames: [IDLE0]
    }))
    expect(validateAvatarSpec(many).ok).toBe(false)

    for (const ms of [BEHAVIOR_LIMITS.minFrameMs - 1, BEHAVIOR_LIMITS.maxFrameMs + 1, 1.5]) {
      const bad = clone()
      bad.behaviors = [{ trigger: 'idle', frames: [IDLE0], frameMs: ms }]
      expect(validateAvatarSpec(bad).ok, `frameMs=${ms}`).toBe(false)
    }
  })
})

describe('默认画：结构不变量（错了不会报错，只会显示错的画）', () => {
  const room = DEFAULT_AVATAR_SPEC.room
  const avatar = DEFAULT_AVATAR_SPEC.avatar

  it('行宽 / 行数 / 字符集 / 色数全部合法（与校验器同口径）', () => {
    for (const [label, sp] of [['房间', room], ['看板娘', avatar]] as const) {
      expect(sp.palette.length, label).toBeLessThanOrEqual(AVATAR_LIMITS.maxColors)
      expect(Object.keys(sp.frames).length, label).toBeLessThanOrEqual(AVATAR_LIMITS.maxFrames)
      for (const [name, rows] of Object.entries(sp.frames)) {
        expect(rows, `${label}/${name}`).toHaveLength(sp.h)
        for (const row of rows) {
          expect(row, `${label}/${name}`).toHaveLength(sp.w)
          for (const ch of row) expect(/^[.0-9a-f]$/.test(ch), `${label}/${name} 含非法字符 ${ch}`).toBe(true)
        }
      }
    }
  })

  it('**窗内必须透明**：系统天空要从窗口透进来（填上墙色就静默失效了）', () => {
    const rows = room.frames.base
    // 窗内取一块矩形，逐点断言透明（避开窗棂十字与窗框：取左上四分之一区）
    for (let y = 12; y <= 20; y++) {
      for (let x = 16; x <= 28; x++) {
        expect(rows[y][x], `窗内 (${x},${y}) 应为透明`).toBe('.')
      }
    }
  })

  it('房间有明暗层次（不是一整块纯色）：墙与地板各自多色阶', () => {
    const rows = room.frames.base
    const wall = new Set(rows.slice(0, 44).flatMap((r) => r.slice(56, 111).split('')))
    expect(wall.size).toBeGreaterThan(1)
    const floor = new Set(rows.slice(46).flatMap((r) => r.slice(0, 20).split('')))
    expect(floor.size).toBeGreaterThan(1)
  })

  it('可复现：两次生成逐字符相同（画法里不得用 Math.random）', () => {
    expect(makeDefaultRoomSprite().frames.base).toEqual(makeDefaultRoomSprite().frames.base)
  })

  it('看板娘：**姿态预设库**里的每一帧都真的存在，且姿态两两可辨', () => {
    const names = Object.keys(avatar.frames)
    // 目录是生图清单与绑定的共同真源：漏写进 AVATAR_FRAMES 的预设必须在这里被抓住
    for (const p of POSE_PRESETS) expect(names, `预设 ${p.frame}（${p.label}）没有对应的帧`).toContain(p.frame)
    expect(POSE_PRESETS.length).toBe(names.length) // 反过来：没有「画了但不在清单里」的帧
    // 姿态必须真的不一样（同姿态换色不算）
    const sig = (n: string): string => avatar.frames[n].join('\n')
    const distinct = new Set(POSE_PRESETS.map((p) => sig(p.frame)))
    expect(distinct.size, '存在完全相同的两帧（预设名不同但画一样）').toBe(names.length)
    // 关键姿态在位
    for (const n of ['idle.0', 'idle.1', 'look.0', 'tired.0', 'think.0', 'recall.0', 'plan.0', 'work.0', 'watch.0', 'trouble.0', 'sleep.0', 'off.0']) {
      expect(names, `缺少帧 ${n}`).toContain(n)
    }
  })

  it('姿态预设库覆盖 10 个触发源（每个动作都有它自己的样子）', () => {
    const bound = new Set((DEFAULT_BEHAVIORS ?? []).map((b) => b.trigger))
    for (const t of BEHAVIOR_TRIGGERS) expect(bound, `触发源 ${t} 没有绑任何行为`).toContain(t)
  })
})

describe('pickFrame / frameNames：相位 → 帧解析与动画帧', () => {
  const sprite = DEFAULT_AVATAR_SPEC.avatar

  it('帧名序列：同一相位的多帧按**数值**升序（不是字典序）', () => {
    const sp = { w: 1, h: 1, palette: ['#000000'], frames: { 'idle.10': ['0'], 'idle.2': ['0'], 'idle.1': ['0'] } }
    expect(frameNames(sp, 'idle')).toEqual(['idle.1', 'idle.2', 'idle.10'])
  })

  it('动画帧：tick 在帧间循环，且越界自动取模；非正/非法 tick 取第一帧', () => {
    expect(frameNames(sprite, 'idle')).toEqual(['idle.0', 'idle.1'])
    expect(pickFrame(sprite, 'idle', 1)).toEqual(sprite.frames['idle.1'])
    expect(pickFrame(sprite, 'idle', 2)).toEqual(sprite.frames['idle.0'])
    expect(pickFrame(sprite, 'idle', -3)).toEqual(sprite.frames['idle.0'])
    expect(pickFrame(sprite, 'idle', Number.NaN)).toEqual(sprite.frames['idle.0'])
  })

  it('未知相位回落 idle；帧名大小写不敏感；单帧相位不随 tick 变', () => {
    expect(frameNames(sprite, 'nope')).toEqual(['idle.0', 'idle.1'])
    expect(frameNames(sprite, 'Think')).toEqual(['think.0', 'think.1'])
    expect(frameNames(sprite, 'sleep')).toEqual(['sleep.0'])
    expect(pickFrame(sprite, 'sleep', 7)).toEqual(pickFrame(sprite, 'sleep', 0))
  })

  it('无 idle 时回落第一帧（空精灵返回空数组，不抛）', () => {
    const bare = { w: 1, h: 1, palette: ['#000000'], frames: { only: ['0'] } }
    expect(pickFrame(bare, 'idle')).toEqual(['0'])
    expect(pickFrame({ w: 1, h: 1, palette: ['#000000'], frames: {} }, 'idle')).toEqual([])
  })
})

describe('行为绑定：触发源优先级与取帧', () => {
  const spec = DEFAULT_AVATAR_SPEC

  it('触发源优先级：**出错 > 阶段 > 相位**', () => {
    expect(behaviorTriggerFor({ phase: 'running', stage: 'execute' })).toBe('execute')
    expect(behaviorTriggerFor({ phase: 'running' })).toBe('running')
    expect(behaviorTriggerFor({ phase: 'running', stage: 'execute', llmFailed: true })).toBe('error')
    // 未知相位不产出触发源（渲染侧只画第一帧，不瞎猜）
    expect(behaviorTriggerFor({ phase: 'nonsense' })).toBeNull()
  })

  it('阶段命中行为 → 画该行为的帧；阶段没绑 → 回落**相位**帧（部分绑定不该让其它动作失去动画）', () => {
    const bound = resolveAvatarFrames(spec, { phase: 'running', stage: 'execute', tick: 0 })
    expect(bound).toEqual(spec.avatar.frames['work.0'])
    // 把 plan 的绑定去掉：此时它在「规划」阶段应回落 running 的帧名约定，而不是掉回站立
    const partial: RoomAvatarSpec = {
      ...spec,
      behaviors: (spec.behaviors ?? []).filter((b) => b.trigger !== 'plan')
    }
    const unbound = resolveAvatarFrames(partial, { phase: 'running', stage: 'plan', tick: 0 })
    expect(unbound).toEqual(pickFrame(spec.avatar, 'running', 0))
  })

  it('相位兜底：没有 behaviors 的规格照样按帧名约定工作（老规格零改动）', () => {
    const bare = { ...spec, behaviors: undefined } as RoomAvatarSpec
    expect(resolveAvatarFrames(bare, { phase: 'idle', tick: 1 })).toEqual(spec.avatar.frames['idle.1'])
    // 老约定里 standby 要有**同名帧**才生效；默认画把闭眼帧命名为 `sleep.0` 并靠 behaviors 绑定，
    // 所以「无 behaviors + 帧名 standby」会回落到 idle——这是老约定的既有语义，不是回归。
    expect(frameNames(spec.avatar, 'standby')).toEqual(['idle.0', 'idle.1'])
    expect(resolveAvatarFrames(spec, { phase: 'standby', tick: 0 })).toEqual(spec.avatar.frames['sleep.0'])
  })

  it('行为帧多帧时按 tick 循环', () => {
    const a = resolveAvatarFrames(spec, { phase: 'running', stage: 'execute', tick: 0 })
    const b = resolveAvatarFrames(spec, { phase: 'running', stage: 'execute', tick: 1 })
    expect(a).not.toEqual(b)
    expect(resolveAvatarFrames(spec, { phase: 'running', stage: 'execute', tick: 2 })).toEqual(a)
  })

  it('matchBehavior：未绑定的触发源返回 undefined', () => {
    expect(matchBehavior(spec, { phase: 'idle' })?.trigger).toBe('idle')
    expect(matchBehavior({ ...spec, behaviors: [] }, { phase: 'idle' })).toBeUndefined()
  })

  it('**帧名**是唯一判定（图片立绘按帧名找图，不能有第二份推导）', () => {
    // 有绑定的触发源 → 该行为的第 tick 帧
    expect(resolveAvatarFrameName(spec, { phase: 'idle', tick: 0 })).toBe('idle.0')
    expect(resolveAvatarFrameName(spec, { phase: 'idle', tick: 2 })).toBe('look.0')
    expect(resolveAvatarFrameName(spec, { phase: 'idle', tick: 4 })).toBe('idle.0') // 越界取模
    // 出错优先于一切，且**有自己的姿态**（不再回落相位）
    expect(resolveAvatarFrameName(spec, { phase: 'running', stage: 'execute', llmFailed: true })).toBe('trouble.0')
    // 阶段命中
    expect(resolveAvatarFrameName(spec, { phase: 'running', stage: 'execute', tick: 0 })).toBe('work.0')
    // 阶段没绑 → 回落相位帧名（部分绑定不该让其它动作失去动画）
    const partial: RoomAvatarSpec = {
      ...spec,
      behaviors: (spec.behaviors ?? []).filter((b) => b.trigger !== 'plan')
    }
    expect(resolveAvatarFrameName(partial, { phase: 'running', stage: 'plan', tick: 0 })).toBe('idle.0')
    // 帧名 → 行：与 resolveAvatarFrames 完全同源
    const name = resolveAvatarFrameName(spec, { phase: 'idle', tick: 0 })
    expect(resolveAvatarFrames(spec, { phase: 'idle', tick: 0 })).toEqual(spec.avatar.frames[name!])
  })

  it('**已停止时不画黑色剪影**（用户 2026-10-19：「没开启自主前，AI 形象全黑色…最好不要有全黑色的占位」）', () => {
    // 「已停止」由画面环境表达（夜空全黑、不发光），不该把她本人涂黑
    expect(resolveAvatarFrameName(spec, { phase: 'stopped' })).toBe('idle.0')
    expect(resolveAvatarFrameName(spec, { phase: 'stopped' })).not.toBe('off.0')
  })

  it('空精灵：帧名与行都返回空（不抛）', () => {
    const empty: RoomAvatarSpec = { ...spec, avatar: { w: 1, h: 1, palette: ['#000000'], frames: {} }, behaviors: [] }
    expect(resolveAvatarFrameName(empty, { phase: 'idle' })).toBeNull()
    expect(resolveAvatarFrames(empty, { phase: 'idle' })).toEqual([])
  })

  it('节拍：命中行为自定节拍优先；**静止态一律不动**（不管 behaviors 怎么说）', () => {
    // 节拍在 0.52.87 整体放慢约 1.5×（用户「图变的太快了」）
    expect(resolveAvatarFrameMs(spec, { phase: 'running', stage: 'execute' }, 300)).toBe(360)
    expect(resolveAvatarFrameMs(spec, { phase: 'idle' }, 300)).toBe(900)
    // 没绑的触发源 → 用传入的相位节拍
    const partial: RoomAvatarSpec = {
      ...spec,
      behaviors: (spec.behaviors ?? []).filter((b) => b.trigger !== 'plan')
    }
    expect(resolveAvatarFrameMs(partial, { phase: 'running', stage: 'plan' }, 300)).toBe(300)
    // 熄灯 / 出错：即使绑了 behaviors 也不动
    expect(resolveAvatarFrameMs(spec, { phase: 'stopped' }, 300)).toBeNull()
    expect(resolveAvatarFrameMs(spec, { phase: 'running', llmFailed: true }, 300)).toBeNull()
  })
})
