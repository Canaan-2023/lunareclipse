/**
 * ROOM 窗口 URL 构造（B3）+ 承载面判定（ADR-29）回归测试。
 *
 * 为什么存在：ROOM 与主窗口**共用同一渲染包**，靠查询串 `?room=1` 区分（同悬浮小窗 `?overlay=1` 范式）。
 * 该查询串是「ROOM 渲染成房间而不是主应用」的唯一开关——写错会导致 ROOM 窗口渲染出主应用。
 *
 * 承载面判定（`resolveRoomViewMode`）：ADR-29 裁决①把独立窗口降级为**灰度回滚分支**，
 * 硬约束是「**默认不达**」——只有显式 `room.viewMode === 'window'` 才可达，老配置/undefined 一律 inline。
 *
 * 覆盖：dev 分支附加 `room=1` 且保留既有查询参数；打包态走 file 分支；承载面判定的默认与显式两态。
 */
import { describe, it, expect } from 'vitest'
import { buildRoomUrl, resolveRoomViewMode } from '../electron/main/room-window'

describe('buildRoomUrl', () => {
  it('dev：附加 room=1 并保留既有查询参数', () => {
    const r = buildRoomUrl('http://localhost:5173/?foo=bar')
    expect(r.kind).toBe('url')
    if (r.kind === 'url') {
      const u = new URL(r.url)
      expect(u.searchParams.get('room')).toBe('1')
      expect(u.searchParams.get('foo')).toBe('bar')
      expect(u.origin).toBe('http://localhost:5173')
    }
  })

  it('dev：无查询串时也能附加', () => {
    const r = buildRoomUrl('http://localhost:5173/')
    expect(r.kind).toBe('url')
    if (r.kind === 'url') expect(new URL(r.url).searchParams.get('room')).toBe('1')
  })

  it('打包态：返回 file 分支', () => {
    expect(buildRoomUrl(undefined)).toEqual({ kind: 'file' })
  })
})

describe('resolveRoomViewMode：默认不达独立窗口（ADR-29 裁决①）', () => {
  it('显式 window → window（回滚分支可达）', () => {
    expect(resolveRoomViewMode({ room: { viewMode: 'window' } })).toBe('window')
  })

  it('显式 inline / 缺字段 / 老配置 / 非法值 → 一律 inline', () => {
    expect(resolveRoomViewMode({ room: { viewMode: 'inline' } })).toBe('inline')
    expect(resolveRoomViewMode({ room: {} })).toBe('inline')
    expect(resolveRoomViewMode({ room: { enabled: true } })).toBe('inline')
    expect(resolveRoomViewMode({})).toBe('inline')
    expect(resolveRoomViewMode(null)).toBe('inline')
    expect(resolveRoomViewMode(undefined)).toBe('inline')
    expect(resolveRoomViewMode({ room: { viewMode: 'WINDOW' } })).toBe('inline')
  })
})
