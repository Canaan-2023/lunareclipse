import { describe, it, expect } from 'vitest'
import { mkdtempSync, readdirSync, existsSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { LanFileSink } from '../electron/main/multi-instance/lan/lan-file-sink'
import type { LanStreamBeginMeta } from '../electron/main/multi-instance/lan/lan-stream'

/**
 * 文件收件器测试：权限判定 / 路径校验 / 幂等 / 威胁内容防线 / 失败清理。
 * 收端安全语义与业务信封通道一致：任一防线不过则整载荷丢弃、不产出正式文件。
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function meta(name: string, size: number): LanStreamBeginMeta {
  return { name, size, chunkSize: 1024 * 1024, chunkCount: Math.max(1, Math.ceil(size / (1024 * 1024))), totalSha256: '' }
}

/** 完整收一条流：begin + 分两次 data + end；返回等待 rename 完成的 promise */
async function feed(sink: LanFileSink, peerUid: number, streamId: number, name: string, payload: Buffer): Promise<void> {
  sink.onBegin(peerUid, streamId, meta(name, payload.length))
  const half = Math.floor(payload.length / 2)
  sink.onData(peerUid, streamId, 0, payload.subarray(0, half))
  sink.onData(peerUid, streamId, half, payload.subarray(half))
  sink.onEnd(peerUid, streamId, { name, size: payload.length })
  // onEnd 在 write stream flush 回调中 rename，等待落位
  await sleep(80)
}

/** 收件目录内的正式文件（排除 .part） */
function listIncoming(root: string, peerUid: number): string[] {
  const dir = join(root, 'incoming', String(peerUid))
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => !f.endsWith('.part'))
}

describe('lan-file-sink 收件器（默认安全：未放行不落盘）', () => {
  it('权限判定：allowPeer 拒绝 → 整流被丢弃，incoming 下零文件、无 .part 残留', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lan-sink-deny-'))
    const sink = new LanFileSink({ root, allowPeer: () => false })
    await feed(sink, 7, 1, 'secret.bin', randomBytes(128))
    expect(listIncoming(root, 7)).toEqual([])
    const peerDir = join(root, 'incoming', '7')
    expect(existsSync(peerDir) ? readdirSync(peerDir).filter((f) => f.endsWith('.part')) : []).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })

  it('权限判定：setAllowPeer 放开后按新规则落盘（无需重建收件器）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lan-sink-allow-'))
    const sink = new LanFileSink({ root })
    sink.setAllowPeer((uid) => uid === 9)
    const payload = randomBytes(64)
    await feed(sink, 9, 1, 'ok.bin', payload)
    const files = listIncoming(root, 9)
    expect(files).toHaveLength(1)
    expect(files[0]).toBe(`1-ok.bin`)
    expect(readFileSync(join(root, 'incoming', '9', files[0])).equals(payload)).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it('路径校验：../ 与 Windows 绝对路径素材被剥成单层文件名，绝不越界写盘', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lan-sink-path-'))
    const sink = new LanFileSink({ root, allowPeer: () => true })
    const payload = randomBytes(32)
    await feed(sink, 3, 1, '../../escape.bin', payload)
    await feed(sink, 3, 2, 'C:\\evil\\rootkit.exe', payload)
    // 越界路径不存在；incoming/3 下仅两个安全单层文件
    expect(existsSync(join(root, 'escape.bin'))).toBe(false)
    expect(existsSync(join(root, 'incoming', '..', '..', 'escape.bin'))).toBe(false)
    expect(existsSync(join(root, 'rootkit.exe'))).toBe(false)
    const files = listIncoming(root, 3)
    // 两个物料分别落成单层安全名（首段为 streamId 前缀；路径成分已被剥除）
    expect(files).toHaveLength(2)
    expect(files.some((f) => f.startsWith('1-') && !f.includes('/') && !f.includes('\\') && !f.includes('..'))).toBe(true)
    expect(files.some((f) => f.startsWith('2-') && !f.includes('/') && !f.includes('\\') && !f.includes('..'))).toBe(true)
    expect(readFileSync(join(root, 'incoming', '3', files[0])).equals(payload)).toBe(true)
    expect(readFileSync(join(root, 'incoming', '3', files[1])).equals(payload)).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it('幂等：同对端同 streamId 已收过 → 重复 begin/data 不重复落盘（无重复文件）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lan-sink-idem-'))
    const sink = new LanFileSink({ root, allowPeer: () => true })
    const payload = randomBytes(64)
    await feed(sink, 5, 1, 'same.bin', payload)
    expect(listIncoming(root, 5)).toEqual(['1-same.bin'])
    // 重放同一流（begin 幂等命中）
    await feed(sink, 5, 1, 'same.bin', payload)
    expect(listIncoming(root, 5)).toEqual(['1-same.bin'])
    rmSync(root, { recursive: true, force: true })
  })

  it('威胁内容防线：scanContent 命中 → 整流丢弃，.part 被删除、不产出正式文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lan-sink-threat-'))
    const sink = new LanFileSink({
      root,
      allowPeer: () => true,
      scanContent: (raw) => (raw.includes(Buffer.from('MALWR')) ? '命中伪装载荷' : null)
    })
    const payload = Buffer.concat([randomBytes(16), Buffer.from('MALWR'), randomBytes(16)])
    await feed(sink, 4, 1, 'fake.txt', payload)
    expect(listIncoming(root, 4)).toEqual([])
    expect(readdirSync(join(root, 'incoming', '4')).filter((f) => f.endsWith('.part'))).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })

  it('失败路径：onEnd 携带协议校验错误 → .part 删除、无正式文件；onAbort → .part 清理', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lan-sink-fail-'))
    const sink = new LanFileSink({ root, allowPeer: () => true })
    sink.onBegin(6, 1, meta('bad.bin', 8))
    sink.onData(6, 1, 0, randomBytes(8))
    sink.onEnd(6, 1, { name: 'bad.bin', size: 8 }, '整体 sha256 校验失败')
    await sleep(80)
    expect(listIncoming(root, 6)).toEqual([])
    expect(readdirSync(join(root, 'incoming', '6')).filter((f) => f.endsWith('.part'))).toEqual([])

    sink.onBegin(6, 2, meta('aborted.bin', 8))
    sink.onData(6, 2, 0, randomBytes(8))
    sink.onAbort(6, 2, '对端重置连接')
    await sleep(80)
    expect(listIncoming(root, 6)).toEqual([])
    expect(readdirSync(join(root, 'incoming', '6')).filter((f) => f.endsWith('.part'))).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })

  it('reset：未收齐的 .part 被清理（服务停止/对端离线时不留半成品）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lan-sink-reset-'))
    const sink = new LanFileSink({ root, allowPeer: () => true })
    sink.onBegin(8, 1, meta('half.bin', 1024))
    sink.onData(8, 1, 0, randomBytes(512))
    sink.reset(8)
    const dir = join(root, 'incoming', '8')
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })
})