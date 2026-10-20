/**
 * data-dir.test.ts — resolveDataDir 单测（2026-08-18）
 * 覆盖：相对标记锚点推导、早期自动写回绝对路径归位、用户自定义绝对路径尊重。
 */
import { describe, it, expect } from 'vitest'
import { join, resolve } from 'node:path'
import { resolveDataDir, DATA_DIR_MARKER } from '../electron/main/models/paths'

const anchor = join('D:', 'workspace', 'app')

describe('resolveDataDir', () => {
  it('默认值（未配置）按锚点解析', () => {
    const r = resolveDataDir(undefined, anchor)
    expect(r.dir).toBe(resolve(anchor, 'data'))
    expect(r.shouldMigrateToMarker).toBe(false)
  })

  it('相对标记 ./data 按锚点解析，不改配置', () => {
    const r = resolveDataDir(DATA_DIR_MARKER, anchor)
    expect(r.dir).toBe(resolve(anchor, 'data'))
    expect(r.shouldMigrateToMarker).toBe(false)
  })

  it('相对自定义目录按锚点解析', () => {
    const r = resolveDataDir('./my-data', anchor)
    expect(r.dir).toBe(resolve(anchor, 'my-data'))
    expect(r.shouldMigrateToMarker).toBe(false)
  })

  it('早期自动写回的默认绝对路径 → 迁移回可移植标记', () => {
    const autoWritten = resolve(anchor, 'data')
    const r = resolveDataDir(autoWritten, anchor)
    expect(r.dir).toBe(autoWritten)
    expect(r.shouldMigrateToMarker).toBe(true)
  })

  it('大小写差异的默认绝对路径 → 仍识别为默认位置并迁移', () => {
    const r = resolveDataDir(join('D:', '\\', 'workspace', 'APP', 'Data'), anchor)
    expect(r.shouldMigrateToMarker).toBe(true)
  })

  it('用户自定义绝对路径 → 尊重，原样使用不回写', () => {
    const custom = join('D:', 'custom-data')
    const r = resolveDataDir(custom, anchor)
    expect(r.dir).toBe(resolve(custom))
    expect(r.shouldMigrateToMarker).toBe(false)
  })
})