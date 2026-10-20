/**
 * 图片看板娘（ADR-34）回归：`<data>/room/mascot/<帧名>.png` → 帧名 → data URL。
 *
 * 为什么测：这条路径**全程静默**——图放错名字、扩展名改了但内容不是 PNG、尺寸超限、
 * 目录里混了别的文件，界面上都只是「还是像素画」，没有任何报错。所以校验必须是纯函数、
 * 必须逐条被断言，而且**跳过的文件必须报出原因**（静默跳过等于「我放了图它不生效」且毫无线索）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  EMPTY_MASCOT_SHEET,
  MASCOT_LIMITS,
  isPng,
  mascotFrameKey,
  mascotImageFor,
  readPngSize,
  validateMascotSheet
} from '../shared/room/mascot'
import { MascotStore } from '../electron/main/room/mascot-store'

/** 造一个「头部合法」的 PNG：8 字节魔数 + 块长 + IHDR + 宽 + 高（共 24 字节，够校验用） */
function fakePng(w: number, h: number, pad = 0): Buffer {
  const b = Buffer.alloc(24 + pad)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8) // IHDR 块长
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b
}

const DATA_URL = 'data:image/png;base64,AAAA'

describe('mascotFrameKey：文件名 → 帧名（只认 .png，且必须是干净的帧名）', () => {
  it('正常：`idle.0.png` → `idle.0`（帧名里的点不是扩展名）', () => {
    expect(mascotFrameKey('idle.0.png')).toBe('idle.0')
    expect(mascotFrameKey('work-1.png')).toBe('work-1')
    expect(mascotFrameKey('idle.0.PNG')).toBe('idle.0') // 扩展名大小写不敏感
  })

  it('非 png / 非法字符 / 隐藏文件 / 超长 → 拒', () => {
    expect(mascotFrameKey('idle.0.jpg')).toBeNull()
    expect(mascotFrameKey('idle 0.png')).toBeNull()
    expect(mascotFrameKey('.hidden.png')).toBeNull()
    expect(mascotFrameKey(`${'a'.repeat(80)}.png`)).toBeNull()
    expect(mascotFrameKey('')).toBeNull()
  })

  it('**带路径分隔符一律拒**（`../evil.png` 若只取末段会被当成合法帧名）', () => {
    expect(mascotFrameKey('../evil.png')).toBeNull()
    expect(mascotFrameKey('sub/dir/evil.png')).toBeNull()
    expect(mascotFrameKey('sub\\evil.png')).toBeNull()
  })
})

describe('PNG 判定与尺寸（认魔数，不认扩展名）', () => {
  it('魔数正确才算 PNG；太短 / 签名不对 → 否', () => {
    expect(isPng(fakePng(1, 1))).toBe(true)
    expect(isPng(Buffer.from([0x89, 0x50]))).toBe(false)
    expect(isPng(Buffer.from('not a png at all........', 'utf8'))).toBe(false)
  })

  it('从 IHDR 读出宽高（大端）', () => {
    expect(readPngSize(fakePng(512, 768))).toEqual({ w: 512, h: 768 })
  })

  it('头部损坏 / 宽高为 0 → null（调用方据此跳过并报原因）', () => {
    expect(readPngSize(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull()
    const badType = fakePng(10, 10)
    badType.write('IHDR'.replace('IHDR', 'XXXX'), 12, 'ascii')
    expect(readPngSize(badType)).toBeNull()
    expect(readPngSize(fakePng(0, 10))).toBeNull()
  })
})

describe('validateMascotSheet：渲染侧对跨进程数据也要过一遍', () => {
  it('合法表通过；空表通过', () => {
    expect(validateMascotSheet(EMPTY_MASCOT_SHEET).ok).toBe(true)
    expect(validateMascotSheet({ version: 1, frames: { 'idle.0': DATA_URL } }).ok).toBe(true)
  })

  it('版本错 / frames 不是对象 / 超帧数 / 不是 PNG data URL → 拒', () => {
    expect(validateMascotSheet({ version: 2, frames: {} }).ok).toBe(false)
    expect(validateMascotSheet({ version: 1, frames: [] }).ok).toBe(false)
    const many: Record<string, string> = {}
    for (let i = 0; i <= MASCOT_LIMITS.maxFrames; i++) many[`f${i}`] = DATA_URL
    expect(validateMascotSheet({ version: 1, frames: many }).ok).toBe(false)
    // 只认 data URL：渲染侧永远不加载外部 URL
    expect(validateMascotSheet({ version: 1, frames: { a: 'https://evil.example/x.png' } }).ok).toBe(false)
    expect(validateMascotSheet({ version: 1, frames: { a: 'data:image/svg+xml;base64,AA' } }).ok).toBe(false)
  })

  it('mascotImageFor：按帧名取图；没有帧名/没有图 → null', () => {
    const sheet = { version: 1 as const, frames: { 'idle.0': DATA_URL } }
    expect(mascotImageFor(sheet, 'idle.0')).toBe(DATA_URL)
    expect(mascotImageFor(sheet, 'work.0')).toBeNull()
    expect(mascotImageFor(sheet, null)).toBeNull()
    expect(mascotImageFor(null, 'idle.0')).toBeNull()
  })
})

describe('MascotStore：逐张校验，坏的那张报原因、好的那张照常生效', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  const setup = (files: Record<string, Buffer | string>): MascotStore => {
    dir = mkdtempSync(join(tmpdir(), 'le-mascot-'))
    mkdirSync(join(dir, 'mascot'), { recursive: true })
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, 'mascot', name), content)
    }
    return new MascotStore(join(dir, 'mascot'))
  }

  it('目录不存在 → 空表且不抛（合法状态：用内置像素画）', () => {
    const r = new MascotStore(join(tmpdir(), 'le-mascot-does-not-exist-xyz')).load()
    expect(r.sheet.frames).toEqual({})
    expect(r.skipped).toEqual([])
  })

  it('好图生效（转成 PNG data URL），坏图进 skipped 且带原因，非 png 杂项不报', () => {
    const store = setup({
      'idle.0.png': fakePng(400, 560),
      'work.0.png': Buffer.from('这不是 PNG，只是改了扩展名', 'utf8'),
      'note.txt': 'readme',
      'huge.png': fakePng(MASCOT_LIMITS.maxDim + 1, 10)
    })
    const { sheet, skipped } = store.load()
    expect(Object.keys(sheet.frames)).toEqual(['idle.0'])
    expect(sheet.frames['idle.0'].startsWith('data:image/png;base64,')).toBe(true)
    const reasons = Object.fromEntries(skipped.map((s) => [s.file, s.reason]))
    expect(reasons['work.0.png']).toContain('不是 PNG')
    expect(reasons['huge.png']).toContain('超过单边')
    expect(reasons['note.txt']).toBeUndefined() // 目录里允许有别的东西
  })

  it('文件名不能作为帧名时也报（否则「改了名没生效」没有线索）', () => {
    const store = setup({ 'idle 0.png': fakePng(10, 10) })
    const { skipped } = store.load()
    expect(skipped.map((s) => s.file)).toContain('idle 0.png')
    expect(skipped[0].reason).toContain('帧名')
  })

  it('可复现：两次读取逐字节相同（同样的文件 → 同样的表）', () => {
    const store = setup({ 'idle.0.png': fakePng(20, 30) })
    expect(store.load().sheet).toEqual(store.load().sheet)
  })

  it('按 AI 分层：当前 AI 有整套图时**不混入全局帧**；当前 AI 为空才回落全局', () => {
    const root = mkdtempSync(join(tmpdir(), 'le-mascot-scope-'))
    try {
      const perAi = join(root, 'AI1', 'mascot')
      const global = join(root, 'mascot')
      mkdirSync(perAi, { recursive: true })
      mkdirSync(global, { recursive: true })
      writeFileSync(join(perAi, 'idle.0.png'), fakePng(10, 10, 1))
      writeFileSync(join(global, 'idle.0.png'), fakePng(20, 20, 2))
      writeFileSync(join(global, 'idle.1.png'), fakePng(30, 30, 3))

      const own = new MascotStore(perAi, global).load().sheet
      expect(Object.keys(own.frames)).toEqual(['idle.0']) // 不混帧
      expect(Buffer.from(own.frames['idle.0'].split(',')[1], 'base64')).toEqual(fakePng(10, 10, 1))

      // 当前 AI 目录存在但没有任何 .png → 回落全局
      const emptyPerAi = join(root, 'AI2', 'mascot')
      mkdirSync(emptyPerAi, { recursive: true })
      const fallback = new MascotStore(emptyPerAi, global).load().sheet
      expect(Object.keys(fallback.frames).sort()).toEqual(['idle.0', 'idle.1'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
