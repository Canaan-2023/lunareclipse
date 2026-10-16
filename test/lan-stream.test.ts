import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { WebSocket } from 'ws'
import { LanService } from '../electron/main/multi-instance/lan/lan-service'
import { LanStreamManager } from '../electron/main/multi-instance/lan/lan-stream'
import {
  LAN_STREAM_TYPE_BEGIN,
  LAN_STREAM_TYPE_DATA,
  LAN_STREAM_TYPE_NAK,
  LAN_STREAM_TYPE_END,
  isLanStreamFrame,
  encodeLanStreamFrame,
  parseLanStreamFrame,
  sha256Hex
} from '../electron/main/multi-instance/lan/lan-stream'
import { LanHashPool } from '../electron/main/multi-instance/lan/lan-hash-pool'
import type { LanStreamCallbacks } from '../electron/main/multi-instance/lan/lan-stream'
import type { LanPeer } from '../electron/main/multi-instance/lan/lan-types'
import { LanPeerStore } from '../electron/main/multi-instance/lan/peer-store'
import { LanFileSink } from '../electron/main/multi-instance/lan/lan-file-sink'

/**
 * 二进制流传输层测试：
 * 1. 协议单元：帧编解码/辨识、hash 池正确性与生命周期
 * 2. 真实双端（LanService × 2）往返：sendBytes / sendFile / 多线路并发（任意二进制内容）
 * 3. 校验失败路径：块级 hash 不符 → NAK；整体 hash 不符 → onEnd(error)；发送端 NAK 耗尽 → abort
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 假 socket：捕获经 manager 发出的帧，readyState 恒为 OPEN */
class FakeSocket {
  readyState = 1
  sent: Buffer[] = []
  send(data: Buffer | string): void {
    this.sent.push(Buffer.isBuffer(data) ? data : Buffer.from(data))
  }
  terminate(): void {
    this.readyState = 3
  }
}

/** 收端重组工具：onBegin 分配缓冲 → onData 按 offset 落位 → onEnd 校验完整性 */
function buildReceiver(): { callbacks: LanStreamCallbacks; results: Map<number, { name: string; whole: Buffer; size: number }>; ended: Map<number, { error?: string }>; aborted: Map<number, string> } {
  const results = new Map<number, { name: string; whole: Buffer; size: number }>()
  const ended = new Map<number, { error?: string }>()
  const aborted = new Map<number, string>()
  const callbacks: LanStreamCallbacks = {
    onBegin: (peerUid, streamId, meta) => {
      results.set(streamId, { name: meta.name, whole: Buffer.allocUnsafe(meta.size), size: meta.size })
      void peerUid
    },
    onData: (peerUid, streamId, offset, data) => {
      const r = results.get(streamId)
      if (r) data.copy(r.whole, offset)
      void peerUid
    },
    onEnd: (peerUid, streamId, _meta, error) => {
      ended.set(streamId, { error })
      void peerUid
    },
    onAbort: (peerUid, streamId, reason) => {
      aborted.set(streamId, reason)
      void peerUid
    }
  }
  return { callbacks, results, ended, aborted }
}

describe('lan-stream 协议单元', () => {
  it('帧编解码 roundtrip：字段逐位一致', () => {
    const payload = randomBytes(2048)
    const frame = encodeLanStreamFrame(LAN_STREAM_TYPE_DATA, 7, 3, 1024n, payload)
    expect(frame.length).toBe(28 + 2048 + 32)
    expect(isLanStreamFrame(frame)).toBe(true)
    const parsed = parseLanStreamFrame(frame)
    expect(parsed).not.toBeNull()
    expect(parsed!.type).toBe(LAN_STREAM_TYPE_DATA)
    expect(parsed!.streamId).toBe(7)
    expect(parsed!.seq).toBe(3)
    expect(parsed!.offset).toBe(1024n)
    expect(parsed!.payload.equals(payload)).toBe(true)
    expect(parsed!.chunkHash).toBe(sha256Hex(payload))
  })

  it('JSON 信封不会被误判为流帧；非法/截断帧返回 null', () => {
    const json = Buffer.from('{"type":"friend.message","id":"x"}')
    expect(isLanStreamFrame(json)).toBe(false)
    expect(parseLanStreamFrame(json)).toBeNull()
    // 截断的流帧头
    const frame = encodeLanStreamFrame(LAN_STREAM_TYPE_BEGIN, 1, 0, 0n, Buffer.from('{}'), 0)
    expect(parseLanStreamFrame(frame.subarray(0, 10))).toBeNull()
    // 带 hash 标志但 payload 被截断
    const dataFrame = encodeLanStreamFrame(LAN_STREAM_TYPE_DATA, 1, 0, 0n, randomBytes(8))
    expect(parseLanStreamFrame(dataFrame.subarray(0, 28 + 4))).toBeNull()
  })

  it('LanHashPool：与同步 sha256 一致、hashMany 保序、大小受限、销毁后拒绝', async () => {
    const pool = new LanHashPool({ maxWorkers: 2 })
    expect(pool.getSize()).toBe(2)
    const bufs = [randomBytes(64), randomBytes(128), randomBytes(256)]
    const hashes = await pool.hashMany(bufs)
    expect(hashes.map((h, i) => h === sha256Hex(bufs[i]))).toEqual([true, true, true])
    const small = randomBytes(4)
    await expect(pool.hash(small)).resolves.toBe(sha256Hex(small))
    pool.destroy()
    await expect(pool.hash(randomBytes(4))).rejects.toThrow(/销毁/)
  })
})

describe('lan-stream 双端往返（真实 ws 连接，任意二进制）', () => {
  const rootA = mkdtempSync(join(tmpdir(), 'lan-stream-a-'))
  const rootB = mkdtempSync(join(tmpdir(), 'lan-stream-b-'))
  let a: LanService
  let b: LanService
  const rxA = buildReceiver()
  const rxB = buildReceiver()
  // 收件器与观察者回调组成链（与 multi-instance/index.ts 的 wireLanStream 同构），验证真实落盘
  const sinkB = new LanFileSink({ root: rootB, allowPeer: () => true })

  beforeAll(async () => {
    a = new LanService({
      root: rootA,
      role: 'master',
      getIdentity: () => ({ uid: 1, 用户名: 'master-user' }),
      pickLanIp: () => '127.0.0.1',
      onMessage: () => undefined,
      onStream: rxA.callbacks
    })
    b = new LanService({
      root: rootB,
      role: 'satellite',
      getIdentity: () => ({ uid: 2, 用户名: 'sat-user' }),
      pickLanIp: () => '127.0.0.1',
      onMessage: () => undefined,
      onStream: {
        onBegin: (u, s, m) => {
          sinkB.onBegin(u, s, m)
          rxB.callbacks.onBegin?.(u, s, m)
        },
        onData: (u, s, o, d) => {
          sinkB.onData(u, s, o, d)
          rxB.callbacks.onData(u, s, o, d)
        },
        onEnd: (u, s, m, e) => {
          sinkB.onEnd(u, s, m, e)
          rxB.callbacks.onEnd(u, s, m, e)
        },
        onAbort: (u, s, r) => {
          sinkB.onAbort(u, s, r)
          rxB.callbacks.onAbort(u, s, r)
        }
      }
    })
    const ra = await a.start()
    const rb = await b.start()
    expect(ra.ok).toBe(true)
    expect(rb.ok).toBe(true)
    const roster: LanPeer[] = [
      { uid: 1, 用户名: 'master-user', role: 'master', lanIp: '127.0.0.1', lanPort: ra.port!, online: true, lastSeen: Date.now() },
      { uid: 2, 用户名: 'sat-user', role: 'satellite', lanIp: '127.0.0.1', lanPort: rb.port!, online: true, lastSeen: Date.now() }
    ]
    new LanPeerStore(rootA).saveRosterCache(roster)
    new LanPeerStore(rootA).applyRoster(roster)
    new LanPeerStore(rootB).saveRosterCache(roster)
    new LanPeerStore(rootB).applyRoster(roster)
    // 以一次业务信封触发双方出站直连（流通道与信封共用连接；此后 send*Stream 立即可达）
    a.sendTo(2, 'friend.message', { text: 'warmup' })
    b.sendTo(1, 'friend.message', { text: 'warmup' })
    await sleep(1500)
    expect(a.getPeer(2)?.online).toBe(true)
    expect(b.getPeer(1)?.online).toBe(true)
  }, 60_000)

  afterAll(async () => {
    sinkB.reset()
    await a?.stop()
    await b?.stop()
    rmSync(rootA, { recursive: true, force: true })
    rmSync(rootB, { recursive: true, force: true })
  })

  it('sendBytes：3.2MB 随机二进制跨块往返，内容逐字节一致且整体校验通过', async () => {
    const payload = randomBytes(3 * 1024 * 1024 + 217_000) // 非 1MB 对齐，覆盖尾部碎块
    const res = await a.sendBytes(2, 'model.bin', payload, { windowSize: 8 })
    expect(res.ok).toBe(true)
    expect(res.ackedBytes).toBe(payload.length)
    expect(rxB.results.size).toBeGreaterThan(0)
    const entry = rxB.results.get([...rxB.results.keys()].at(-1)!)
    expect(entry).toBeDefined()
    expect(entry!.name).toBe('model.bin')
    expect(entry!.size).toBe(payload.length)
    expect(entry!.whole.equals(payload)).toBe(true)
    const end = rxB.ended.get([...rxB.ended.keys()].at(-1)!)
    expect(end!.error).toBeUndefined()
  }, 60_000)

  it('sendFile：本地二进制文件（含 NUL/0xFF 字节）流式发送，收端重组一致', async () => {
    const filePath = join(rootA, 'assets.dat')
    const fileBytes = Buffer.concat([randomBytes(1024 * 1024 + 33), Buffer.from([0, 0xff, 0x00, 0x7f]), randomBytes(2 * 1024 * 1024)])
    writeFileSync(filePath, fileBytes)
    const res = await a.sendFile(2, filePath, { name: 'assets.dat' })
    expect(res.ok).toBe(true)
    const entry = rxB.results.get([...rxB.results.keys()].at(-1)!)
    expect(entry!.name).toBe('assets.dat')
    expect(entry!.whole.equals(fileBytes)).toBe(true)
    expect(rxB.ended.get([...rxB.ended.keys()].at(-1)!)!.error).toBeUndefined()
  }, 60_000)

  it('多线路并发：8 条不同大小流并行发送，各自独立且内容完整', async () => {
    const sizes = [512, 7 * 1024, 1024 * 1024, 2 * 1024 * 1024 + 11, 33, 1024 * 300 + 7, 1024 * 1024 * 3 + 1, 8191]
    const payloads = sizes.map((s) => randomBytes(s))
    const before = rxB.results.size
    const results = await Promise.all(payloads.map((p, i) => a.sendBytes(2, `flow-${i}.dat`, p)))
    expect(results.every((r) => r.ok)).toBe(true)
    expect(results.reduce((acc, r) => acc + r.ackedBytes, 0)).toBe(sizes.reduce((x, y) => x + y, 0))
    // 收端应收到 8 条独立流（含此前两条），且各自内容完整。
    // 并发完成顺序 ≠ 发起顺序（异步哈希/多线路调度），按 name 对应 payload 验证，不依赖顺序。
    const newOnes = [...rxB.results.entries()].slice(before)
    expect(newOnes.length).toBe(8)
    const nameTo = new Map<string, { sid: number; entry: { name: string; whole: Buffer; size: number } }>()
    for (const [sid, entry] of newOnes) nameTo.set(entry!.name, { sid, entry: entry! })
    expect([...nameTo.keys()].sort()).toEqual(Array.from({ length: 8 }, (_, i) => `flow-${i}.dat`))
    for (let i = 0; i < 8; i += 1) {
      const { sid, entry } = nameTo.get(`flow-${i}.dat`)!
      expect(entry.whole.equals(payloads[i])).toBe(true)
      expect(rxB.ended.get(sid)!.error).toBeUndefined()
    }
  }, 60_000)

  it('sendBytes → 收件器真实落盘：incoming/{对端uid}/{streamId}-photo.png 内容逐字节一致（收端安全语义闭环）', async () => {
    const payload = randomBytes(1024 * 1024 + 517)
    const res = await a.sendBytes(2, 'photo.png', payload)
    expect(res.ok).toBe(true)
    // 等待收件器 flush + rename 落位（轮询上限 3s）。b 侧收到 a(uid=1) 的文件 → 落 incoming/1/
    const dir = join(rootB, 'incoming', '1')
    let files: string[] = []
    for (let i = 0; i < 60; i += 1) {
      files = readdirSyncSafe(dir).filter((f) => f.endsWith('photo.png'))
      if (files.length > 0) break
      await sleep(50)
    }
    console.log('[debug] dir:', dir, ' all:', readdirSyncSafe(dir), ' rxB:', [...rxB.results.entries()].map(([s, e]) => [s, e.name]))
    expect(files).toHaveLength(1)
    expect(readFileSync(join(dir, files[0])).equals(payload)).toBe(true)
    // 无 .part 残留（整流收齐并成功 rename）
    expect(readdirSyncSafe(dir).filter((f) => f.endsWith('.part'))).toEqual([])
  }, 60_000)
})

/** readdirSync 的容错包装：目录不存在返回空数组 */
function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

describe('lan-stream 校验失败路径（协议级）', () => {
  let mgr: LanStreamManager
  let fake: FakeSocket
  const rx = buildReceiver()

  const uid = 1
  const sid = 42

  beforeAll(() => {
    fake = new FakeSocket()
    mgr = new LanStreamManager(rx.callbacks, new LanHashPool({ maxWorkers: 2 }))
    mgr.attachSocket(uid, fake as unknown as WebSocket)
  })

  afterAll(() => {
    mgr.destroy()
  })

  const sendBegin = (meta: Record<string, unknown>): void => {
    mgr.handleFrame(uid, parseLanStreamFrame(encodeLanStreamFrame(LAN_STREAM_TYPE_BEGIN, sid, 0, 0n, Buffer.from(JSON.stringify(meta)), 0))!)
  }

  const lastControlTypes = (): number[] => fake.sent.map((f) => parseLanStreamFrame(f)?.type ?? -1)

  it('块级 sha256 不符 → 回 NAK 请求重传', async () => {
    fake.sent.length = 0
    sendBegin({ name: 'bad.bin', size: 10, chunkSize: 1024, chunkCount: 1, totalSha256: '' })
    const payload = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const dataBuf = encodeLanStreamFrame(LAN_STREAM_TYPE_DATA, sid, 0, 0n, payload)
    // 篡改 payload 字节但保留原 hash：收端计算值 ≠ 帧内 hash → NAK
    dataBuf[28] = 0xff
    mgr.handleFrame(uid, parseLanStreamFrame(dataBuf)!)
    // 块哈希走 worker 池（异步）：等待校验结论回帧
    await sleep(200)
    const types = lastControlTypes()
    expect(types.some((t) => t === LAN_STREAM_TYPE_NAK)).toBe(true)
  })

  it('整体 sha256 不符 → onEnd(error) 且回 end{ok:false}', async () => {
    ;(rx.ended as unknown as Map<number, { error?: string }>).clear()
    fake.sent.length = 0
    const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef])
    sendBegin({ name: 'whole.bin', size: 4, chunkSize: 1024, chunkCount: 1, totalSha256: 'f'.repeat(64) })
    const good = LanHashPool.sha256(payload)
    const dataBuf = encodeLanStreamFrame(LAN_STREAM_TYPE_DATA, sid, 0, 0n, payload)
    // 帧内 hash 为正确值（块校验通过）；begin 里 totalSha256 是错误值 → 整体校验失败
    dataBuf.write(good, 28 + 4, 'hex')
    mgr.handleFrame(uid, parseLanStreamFrame(dataBuf)!)
    await sleep(200)
    const endInfo = [...rx.ended.entries()].at(-1)
    expect(endInfo).toBeDefined()
    expect(endInfo![1].error).toMatch(/整体校验失败/)
    const last = parseLanStreamFrame(fake.sent.at(-1)!)
    expect(last!.type).toBe(LAN_STREAM_TYPE_END)
    const payloadJson = JSON.parse(last!.payload.toString('utf8')) as { ok: boolean }
    expect(payloadJson.ok).toBe(false)
  })

  it('发送端收到持续 NAK → 重传耗尽后 abort 整条流', async () => {
    fake.sent.length = 0
    // 发送端：永远 NAK 的假对端（收到 data 帧立即回 NAK）
    let outstanding = 0
    const originalSend = fake.send.bind(fake)
    fake.send = ((data: Buffer | string) => {
      originalSend(data)
      const parsed = parseLanStreamFrame(Buffer.isBuffer(data) ? data : Buffer.from(data))
      if (parsed?.type === LAN_STREAM_TYPE_DATA && outstanding === 0) {
        outstanding = 1
        // 用 data 帧自己的 streamId 回 NAK（发送侧的流 ID 与接收侧 sid=42 无关）
        mgr.handleFrame(uid, parseLanStreamFrame(encodeLanStreamFrame(LAN_STREAM_TYPE_NAK, parsed.streamId, 0, 0n, Buffer.from(JSON.stringify({ seqs: [parsed.seq] })), 0))!)
        outstanding = 0
      }
    }) as FakeSocket['send']
    const res = await mgr.sendBytes(uid, 'nak-loop.bin', randomBytes(64 * 1024), { chunkSize: 1024, windowSize: 1 })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/重传耗尽/)
    fake.send = originalSend
  }, 30_000)

  it('无活跃连接时 sendStream 直接拒绝', async () => {
    const mgr2 = new LanStreamManager(rx.callbacks, new LanHashPool({ maxWorkers: 1 }))
    const res = await mgr2.sendBytes(999, 'no-peer.bin', Buffer.from([1, 2, 3]))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/不在线/)
    mgr2.destroy()
  })
})