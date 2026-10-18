/**
 * 像素规格校验（`@shared/room/avatar-spec`）与默认画（`electron/main/room/default-art`）。
 *
 * 为什么测：这是「AI 画自己」（P3）的**数据入口**——越界/非法规格必须在入口 fail-closed，
 * 绝不把未校验的像素数据交给渲染端。校验是纯函数，无需主进程装配。
 */
import { describe, it, expect } from 'vitest'
import {
  AVATAR_LIMITS,
  pickFrame,
  validateAvatarSpec,
  type RoomAvatarSpec
} from '@shared/room/avatar-spec'
import { DEFAULT_AVATAR_SPEC } from '../electron/main/room/default-art'

/** 深拷贝一份默认规格，便于逐项破坏。 */
function clone(): RoomAvatarSpec {
  return JSON.parse(JSON.stringify(DEFAULT_AVATAR_SPEC)) as RoomAvatarSpec
}

describe('validateAvatarSpec：默认规格与合法路径', () => {
  it('默认规格合法（房间/形象/坐标都通过）', () => {
    const v = validateAvatarSpec(DEFAULT_AVATAR_SPEC)
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.spec.room.w).toBe(40)
      expect(v.spec.room.h).toBe(24)
      expect(v.spec.avatar.w).toBe(12)
      // 形象完整落在房间内
      expect(v.spec.avatarPos.x + v.spec.avatar.w).toBeLessThanOrEqual(v.spec.room.w)
      expect(v.spec.avatarPos.y + v.spec.avatar.h).toBeLessThanOrEqual(v.spec.room.h)
    }
  })

  it('颜色归一为小写（大小写不敏感）', () => {
    const spec = clone()
    spec.avatar.palette[0] = '#D6B276'
    const v = validateAvatarSpec(spec)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.spec.avatar.palette[0]).toBe('#d6b276')
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
    a.avatar.frames.idle = a.avatar.frames.idle.slice(0, 5)
    expect(validateAvatarSpec(a).ok).toBe(false)
    const b = clone()
    b.avatar.frames.idle[0] = '..'
    expect(validateAvatarSpec(b).ok).toBe(false)
  })

  it('帧含非法字符 → 拒（只允许 . 与 0-9a-f）', () => {
    const spec = clone()
    spec.avatar.frames.idle[0] = 'xxx0000xxxxx'
    expect(validateAvatarSpec(spec).ok).toBe(false)
  })

  it('帧数超上限 → 拒', () => {
    const spec = clone()
    for (let i = 0; i < AVATAR_LIMITS.maxFrames + 2; i++) spec.avatar.frames[`f${i}`] = spec.avatar.frames.idle
    expect(validateAvatarSpec(spec).ok).toBe(false)
  })

  it('形象越出房间边界 / 坐标为负 → 拒', () => {
    const a = clone()
    a.avatarPos = { x: 100, y: 0 }
    expect(validateAvatarSpec(a).ok).toBe(false)
    const b = clone()
    b.avatarPos = { x: -1, y: 0 }
    expect(validateAvatarSpec(b).ok).toBe(false)
  })
})

describe('pickFrame：相位 → 帧解析', () => {
  const sprite = DEFAULT_AVATAR_SPEC.avatar

  it('优先命中同名相位帧', () => {
    expect(pickFrame(sprite, 'running')).toEqual(sprite.frames.running)
  })

  it('未知相位回落 idle', () => {
    expect(pickFrame(sprite, 'nope')).toEqual(sprite.frames.idle)
  })

  it('帧名大小写不敏感', () => {
    expect(pickFrame(sprite, 'Running')).toEqual(sprite.frames.running)
  })

  it('无 idle 时回落第一帧', () => {
    const bare = { w: 1, h: 1, palette: ['#000000'], frames: { only: ['0'] } }
    expect(pickFrame(bare, 'idle')).toEqual(['0'])
  })
})
