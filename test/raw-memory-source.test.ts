/**
 * RAW 来源标记落盘（ADR-25 §3.5.1）契约测试。
 *
 * 为什么存在：0.52.38 只测了纯函数 `sourceHeaderLine`（拼行），**没测「写盘后头部真的有这行」**。
 * 而「来源标记可在 RAW 头部看到」是交接单 §7 要求**可复现验证**的交付项之一；
 * 本文件直接读落盘文件断言，锁住写入链路（含外部平台接入来源写入点口径 `source: 'messaging'`）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildDataPaths, resolveScopePaths } from '../electron/main/models/paths'
import { RawMemoryWriter } from '../electron/main/services/raw-memory-writer'

let tmp = ''
let paths = buildDataPaths('')

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'le-raw-source-'))
  paths = buildDataPaths(tmp)
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function makeWriter(): RawMemoryWriter {
  return new RawMemoryWriter(paths, () => ({ uid: 1, aiId: 2 }))
}

const TS = '2020-01-01T00:00:00.000Z'

describe('RawMemoryWriter：来源标记写进 RAW 头部', () => {
  it('带 source → 头部有「- 来源：…（可读名）」行（外部平台接入写入点口径）', () => {
    const w = makeWriter()
    const file = w.write('喂', '在的', [], TS, '甲', 'AI2', undefined, { source: 'messaging' })
    const text = readFileSync(file, 'utf-8')
    expect(text).toContain('- 来源：messaging（外部平台接入）')
    expect(text).toContain('## 用户（甲）')
    expect(text).toContain('## AI（AI2）')
  })

  it('自主轮次 source → 标为自主模式（与 A5 自主域判据同一枚举）', () => {
    const w = makeWriter()
    const file = w.write('x', 'y', [], TS, undefined, undefined, undefined, { source: 'autonomous' })
    expect(readFileSync(file, 'utf-8')).toContain('- 来源：autonomous（自主模式）')
  })

  it('不带 source → 不输出来源行（老文件格式兼容）', () => {
    const w = makeWriter()
    const file = w.write('x', 'y', [], TS)
    const text = readFileSync(file, 'utf-8')
    expect(text).not.toContain('- 来源：')
    expect(text).toContain('- 时间戳：')
  })

  it('落盘位置按 scope 分（memory/U{uid}/AI{aiId}/raw_memory）', () => {
    const w = makeWriter()
    const file = w.write('x', 'y', [], TS)
    const scoped = resolveScopePaths(paths, { uid: 1, aiId: 2 })
    expect(file.replace(/\\/g, '/')).toContain(scoped.rawMemory.replace(/\\/g, '/'))
  })
})
