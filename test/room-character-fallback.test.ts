/**
 * 立绘失败 → 回落像素角色的**渲染分支**回归（0.53.3 补测，纯函数 / 画笔，不起 jsdom）。
 *
 * 缺口背景：`PerspectiveRoom` 的分支是 `const img = mascotReady ? mascotRef.current : null`，
 * 「立绘加载失败（onerror / 没有该帧）」最终必须落到**像素角色**，否则画面上的角色直接消失。
 * jsdom 里既没有 Image 解码也没有 canvas，所以这里测**分支两端的真实函数**：
 *
 * - 取图点 `mascotSrcFor`：没有该帧 / 没有帧表 → `null`（= 渲染侧走像素路径）；
 * - 像素路径 `drawCharacter`：有帧表就逐像素画；**没有帧/调色板**时还有兜底立牌（房间不空）；
 * - 图片路径 `drawCharacterImage`：等比缩放、镜像可断言，且 **naturalH=0 不会算出 Infinity**。
 */
import { describe, it, expect } from 'vitest'
import { drawCharacter, drawCharacterImage } from '../src/components/Room/perspective-art'
import { mascotSrcFor, type MascotState } from '../src/components/Room/use-mascot'
import { defaultProjection, ROOM_ZONES } from '@shared/room/room-scene'

type Call = { op: string; args: number[] }

/** 记录型 2D 上下文：只需要画笔用到的那些方法（结构化满足即足够） */
function fakeCtx() {
  const calls: Call[] = []
  const rec =
    (op: string) =>
    (...args: unknown[]) => {
      calls.push({ op, args: args.filter((a): a is number => typeof a === 'number') })
    }
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    imageSmoothingEnabled: false,
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    closePath: rec('closePath'),
    fill: rec('fill'),
    stroke: rec('stroke'),
    ellipse: rec('ellipse'),
    fillRect: rec('fillRect'),
    save: rec('save'),
    restore: rec('restore'),
    translate: rec('translate'),
    scale: rec('scale'),
    drawImage: rec('drawImage')
  }
  const all = (op: string): Call[] => calls.filter((c) => c.op === op)
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    // 用 getter：调用记录是**画完之后**才可读的（不能在建夹具时就快照成空数组）
    get rects() {
      return all('fillRect')
    },
    get ellipses() {
      return all('ellipse')
    },
    get images() {
      return all('drawImage')
    },
    get scales() {
      return all('scale')
    }
  }
}

const sheet = (frames: Record<string, string>): MascotState => ({ frames, skipped: [], dir: null, loaded: true, error: null })
const pos = { x: ROOM_ZONES.home.x, y: ROOM_ZONES.home.y }
const projection = defaultProjection()

describe('取图点：没有可用立绘 → null（渲染侧因此走像素角色）', () => {
  it('帧表为空 / 该姿态没有图 / 没有帧名 → 都是 null', () => {
    const empty = sheet({})
    expect(mascotSrcFor(empty, 'idle.0')).toBeNull()
    expect(mascotSrcFor(sheet({ 'idle.1': 'data:image/png;base64,AAA' }), 'idle.0')).toBeNull()
    expect(mascotSrcFor(sheet({ 'idle.0': 'data:image/png;base64,AAA' }), null)).toBeNull()
  })

  it('有图 → 返回该帧（此时才走图片路径）', () => {
    const src = 'data:image/png;base64,AAA'
    expect(mascotSrcFor(sheet({ 'idle.0': src }), 'idle.0')).toBe(src)
  })

  it('立绘不可用（null）时，像素角色仍然被画出来（不会出现「什么都没有」）', () => {
    const src = mascotSrcFor(sheet({}), 'idle.0')
    expect(src).toBeNull() // 渲染分支：没有图 → 走像素角色

    const f = fakeCtx()
    drawCharacter(f.ctx, projection, pos, ['111', '1.1', '111'], ['#000', '#abc'], 3, 3, false, 'down')

    expect(f.rects.length).toBe(8) // 8 个非 '.' 像素（中间的 '.' 是透明）
    for (const r of f.rects) expect(r.args.every((n) => Number.isFinite(n))).toBe(true)
    expect(f.rects.every((r) => r.args[2] > 0 && r.args[3] > 0)).toBe(true)
  })
})

describe('drawCharacter：帧数据不可用时的兜底立牌', () => {
  it('rows 为空（形象规格还没到）→ 画兜底立牌，不抛、不留白', () => {
    const f = fakeCtx()
    expect(() => drawCharacter(f.ctx, projection, pos, [], [], 28, 40, false, 'down')).not.toThrow()
    expect(f.rects).toHaveLength(1) // 身体
    expect(f.ellipses).toHaveLength(2) // 地面阴影 + 头部
  })

  it('rows 有但调色板为空 → 同样走兜底（不画一堆 undefined 颜色）', () => {
    const f = fakeCtx()
    drawCharacter(f.ctx, projection, pos, ['111', '111'], [], 3, 2, false, 'down')
    expect(f.rects).toHaveLength(1)
  })

  it('镜像/朝左：像素画到 sprite 的另一侧（x 坐标翻转）', () => {
    // 偏左的一个像素：朝右时在 sprite 左端，朝左时应被翻到右端
    const facingRight = fakeCtx()
    const facingLeft = fakeCtx()
    drawCharacter(facingRight.ctx, projection, pos, ['1..'], ['#000', '#abc'], 3, 1, false, 'right')
    drawCharacter(facingLeft.ctx, projection, pos, ['1..'], ['#000', '#abc'], 3, 1, false, 'left')
    expect(facingRight.rects[0].args[0]).toBeLessThan(facingLeft.rects[0].args[0])
  })
})

describe('drawCharacterImage：图片路径的几何（含退化输入）', () => {
  const img = { naturalWidth: 100, naturalHeight: 200 } as unknown as CanvasImageSource

  it('按自然宽高比等比缩放，底边落在同一水平线（与像素角色同锚点）', () => {
    const f = fakeCtx()
    drawCharacterImage(f.ctx, projection, pos, img, 100, 200, false)
    expect(f.images).toHaveLength(1)
    // 记录里只保留数值参数（图片对象被夹具过滤掉）：[left, top, w, h]
    const [left, top, w, h] = f.images[0].args
    expect(w / h).toBeCloseTo(100 / 200, 5)
    expect([left, top, w, h].every((n) => Number.isFinite(n))).toBe(true)
    expect(w).toBeGreaterThan(0)
    expect(h).toBeGreaterThan(0)
  })

  it('镜像：走 scale(-1, 1) 且不抛', () => {
    const f = fakeCtx()
    drawCharacterImage(f.ctx, projection, pos, img, 100, 200, true)
    expect(f.scales).toHaveLength(1)
    expect(f.scales[0].args).toEqual([-1, 1])
    expect(f.images).toHaveLength(1)
  })

  it('naturalHeight=0（损坏图）→ 不产生 Infinity/NaN（有 1px 保护）', () => {
    const f = fakeCtx()
    expect(() => drawCharacterImage(f.ctx, projection, pos, img, 100, 0, false)).not.toThrow()
    const [, , w, h] = f.images[0].args
    expect(Number.isFinite(w)).toBe(true)
    expect(Number.isFinite(h)).toBe(true)
    expect(w).toBeGreaterThan(0)
    expect(h).toBeGreaterThan(0)
  })
})
