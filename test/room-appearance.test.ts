/**
 * 房间外观配置（人物位置/大小 + 背景来源）回归。
 *
 * 为什么测：这是**用户侧独立配置**，越界/非法输入如果被静默夹紧，用户会以为「保存了但没生效」；
 * 背景文件如果静默回落，用户会以为「图没放对」。两类失效都不会报错，只会看起来「设计不对」。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  DEFAULT_ROOM_APPEARANCE,
  ROOM_CHARACTER_LIMITS,
  ROOM_BACKGROUND_FILE,
  isRoomImageSrc,
  parseRoomAppearance,
  sceneImageFor
} from '../shared/room/appearance'
import { AppearanceStore } from '../electron/main/room/appearance-store'

/** 测试用资源根（与 `room-avatar.ts` 的构造方式一致） */
const URLS = { ai: 'room-asset://room/AI1', global: 'room-asset://room/global' }

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==',
  'base64'
)

/** 1×1 JPEG（真实 SOI + APP0 + SOF0；用于验证国内素材站常见的 JPG 背景） */
const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==',
  'base64'
)

describe('parseRoomAppearance：fail-closed', () => {
  it('默认值合法', () => {
    expect(parseRoomAppearance(DEFAULT_ROOM_APPEARANCE).ok).toBe(true)
  })

  it('合法自定义：人物位置/大小 + 图片背景', () => {
    const r = parseRoomAppearance({
      version: 1,
      character: { x: 0.5, y: 2.5, scale: 1.2 },
      background: { mode: 'image' }
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.appearance.character).toEqual({ x: 0.5, y: 2.5, lift: 0, scale: 1.2 })
      expect(r.appearance.background.mode).toBe('image')
    }
  })

  it('越界不静默夹紧：x / y / scale 各自给出原因', () => {
    const bad = (patch: Partial<typeof DEFAULT_ROOM_APPEARANCE.character>) =>
      parseRoomAppearance({
        ...DEFAULT_ROOM_APPEARANCE,
        character: { ...DEFAULT_ROOM_APPEARANCE.character, ...patch }
      })
    expect(bad({ x: ROOM_CHARACTER_LIMITS.x.max + 1 }).ok).toBe(false)
    expect(bad({ y: ROOM_CHARACTER_LIMITS.y.min - 1 }).ok).toBe(false)
    expect(bad({ scale: ROOM_CHARACTER_LIMITS.scale.max + 0.1 }).ok).toBe(false)
    const r = bad({ x: 99 })
    if (!r.ok) expect(r.error).toContain('水平位置')
  })

  it('高度（lift）：缺省 0（兼容旧配置）；越界不静默夹紧', () => {
    const legacy = {
      version: 1,
      character: { x: 0, y: 2.16, scale: 1 },
      background: { mode: 'code' }
    }
    const ok = parseRoomAppearance(legacy)
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.appearance.character.lift).toBe(0)

    const bad = parseRoomAppearance({
      ...legacy,
      character: { x: 0, y: 2.16, lift: ROOM_CHARACTER_LIMITS.lift.max + 1, scale: 1 }
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('高度')
  })

  it('非法版本 / 背景模式 / 缺字段 → 拒', () => {
    expect(parseRoomAppearance({ ...DEFAULT_ROOM_APPEARANCE, version: 2 }).ok).toBe(false)
    expect(parseRoomAppearance({ ...DEFAULT_ROOM_APPEARANCE, background: { mode: 'video' } }).ok).toBe(false)
    expect(parseRoomAppearance({ version: 1 }).ok).toBe(false)
  })
})

describe('sceneImageFor：分区图优先，主背景兜底', () => {
  it('该分区有图 → 用它；没有 → 主背景；都没有 → null（回落代码房间）', () => {
    const scenes = { plan: 'room-asset://room/AI1/scenes/plan.png?v=1' }
    expect(sceneImageFor('plan', scenes, 'room-asset://room/AI1/background/background.jpg?v=2')).toBe(
      'room-asset://room/AI1/scenes/plan.png?v=1'
    )
    expect(sceneImageFor('work', scenes, 'room-asset://room/AI1/background/background.jpg?v=2')).toBe(
      'room-asset://room/AI1/background/background.jpg?v=2'
    )
    expect(sceneImageFor('work', undefined, null)).toBeNull()
  })

  it('渲染侧只认本地协议 URL 或 data URL（其它来源一律拒）', () => {
    expect(isRoomImageSrc('room-asset://room/AI1/scenes/desk.jpg?v=3')).toBe(true)
    expect(isRoomImageSrc('data:image/png;base64,AA')).toBe(true)
    expect(isRoomImageSrc('https://example.com/a.png')).toBe(false)
    expect(isRoomImageSrc('file:///C:/a.png')).toBe(false)
    expect(isRoomImageSrc(null)).toBe(false)
  })
})

describe('AppearanceStore：落盘与背景读取', () => {
  let root = ''
  const store = () => new AppearanceStore(join(root, 'room'), undefined, URLS)

  const makeRoot = (): void => {
    root = mkdtempSync(join(tmpdir(), 'room-look-'))
  }

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('缺失配置 → 默认（不是错误）', () => {
    makeRoot()
    const r = store().load()
    expect(r.appearance).toEqual(DEFAULT_ROOM_APPEARANCE)
    expect(r.error).toBeUndefined()
  })

  it('保存 / 读取往返', () => {
    makeRoot()
    const next = {
      version: 1 as const,
      character: { x: 0.4, y: 2.2, lift: 40, scale: 1.1 },
      background: { mode: 'image' as const }
    }
    const saved = store().save(next)
    expect(saved.ok).toBe(true)
    const loaded = store().load()
    expect(loaded.appearance).toEqual(next)
    expect(loaded.error).toBeUndefined()
  })

  it('损坏配置 → 默认 + 原因（不把房间弄崩）', () => {
    makeRoot()
    mkdirSync(join(root, 'room'), { recursive: true })
    writeFileSync(join(root, 'room', 'appearance.json'), '{not json', 'utf-8')
    const r = store().load()
    expect(r.appearance).toEqual(DEFAULT_ROOM_APPEARANCE)
    expect(r.error).toContain('外观配置读取失败')
  })

  it('背景：缺失 = null；合法 PNG = 只读 URL；非 PNG = 原因', () => {
    makeRoot()
    const bgDir = join(root, 'room', 'background')
    expect(store().loadBackground().url).toBeNull()

    mkdirSync(bgDir, { recursive: true })
    writeFileSync(join(bgDir, ROOM_BACKGROUND_FILE), PNG_1X1)
    const ok = store().loadBackground()
    expect(ok.error).toBeUndefined()
    // 不再 base64 过 IPC：只回带版本参数的本地协议 URL
    expect(ok.url).toMatch(/^room-asset:\/\/room\/AI1\/background\/background\.png\?v=\d+$/)

    writeFileSync(join(bgDir, ROOM_BACKGROUND_FILE), Buffer.from('not a png'))
    const bad = store().loadBackground()
    expect(bad.url).toBeNull()
    expect(bad.error).toContain('不是 PNG')
  })

  it('背景也接受 JPG（国内素材站常见）', () => {
    makeRoot()
    const bgDir = join(root, 'room', 'background')
    mkdirSync(bgDir, { recursive: true })
    writeFileSync(join(bgDir, 'background.jpg'), JPEG_1X1)
    const r = store().loadBackground()
    expect(r.error).toBeUndefined()
    expect(r.url).toMatch(/^room-asset:\/\/room\/AI1\/background\/background\.jpg\?v=\d+$/)
  })

  it('按 AI 分层：当前 AI 缺失时读全局；保存只写当前 AI；分区场景按 zone 读', () => {
    makeRoot()
    const global = join(root, 'room')
    const perAi = join(global, 'AI2')
    mkdirSync(global, { recursive: true })
    const legacy = {
      version: 1 as const,
      character: { x: 0.1, y: 2.6, scale: 1.3 },
      background: { mode: 'image' as const }
    }
    writeFileSync(join(global, 'appearance.json'), JSON.stringify(legacy), 'utf-8')

    const scoped = new AppearanceStore(perAi, global, { ai: 'room-asset://room/AI2', global: 'room-asset://room/global' })
    // 旧配置没有 lift 字段：按 0 读入（兼容，不判非法）
    expect(scoped.load().appearance).toEqual({
      ...legacy,
      character: { ...legacy.character, lift: 0 }
    }) // 回落全局
    expect(scoped.save(DEFAULT_ROOM_APPEARANCE).ok).toBe(true)
    expect(existsSync(join(perAi, 'appearance.json'))).toBe(true) // 只写当前 AI
    expect(scoped.load().appearance).toEqual(DEFAULT_ROOM_APPEARANCE)

    // 分区场景：AI 目录优先
    mkdirSync(join(perAi, 'scenes'), { recursive: true })
    writeFileSync(join(perAi, 'scenes', 'plan.png'), PNG_1X1)
    const scenes = scoped.loadScenes()
    expect(scenes.scenes.plan).toMatch(/^room-asset:\/\/room\/AI2\/scenes\/plan\.png\?v=\d+$/)
    expect(scenes.dir).toBe(join(perAi, 'scenes'))
    expect(scenes.errors).toEqual([])
  })
})
