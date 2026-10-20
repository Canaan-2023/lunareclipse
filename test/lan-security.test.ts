/**
 * LAN 安全面回归测试（0.52.9 分发前审查 S1-A 修复的配套用例）。
 *
 * 为什么存在：0.52.8 审查发现 LAN 直连面「无开关即监听 0.0.0.0 + 握手 uid 无校验 + 单帧 512MB」，
 * 属分发阻断级缺陷。修复（默认关闭 / 默认回环 / isValidLanUid 三登记点 / 载荷分级）此前**零测试覆盖**
 * （复验轮实测：4 个安全关键符号在 test/ 内 0 引用）——安全修复无回归网等于随时可能被改回去。
 *
 * 覆盖：
 * 1. isValidLanUid 判定边界（0 / 负数 / 小数 / NaN / Infinity / 字符串 / null / 对象 / 布尔）
 * 2. 载荷分级档位关系（ws 硬阀 64MB > 信封软阀 32MB；防 512MB 回退）
 * 3. 真实 ws：hello 自报 uid 非法 → 拒连（close 4002）且不登记
 * 4. 真实 ws：合法 uid → 握手成功
 * 5. 真实 ws：超信封软阀的信封帧被丢弃且**连接不击穿**，其后小信封仍送达
 * 6. 真实 ws：同尺寸的**流帧**不受信封软阀约束（证明分级只作用于信封通道）
 */
import { describe, it, expect } from 'vitest'
import { WebSocket } from 'ws'
import { LanServer } from '../electron/main/multi-instance/lan/lan-server'
import {
  LAN_ENVELOPE_MAX_PAYLOAD,
  LAN_MAX_PAYLOAD,
  isValidLanUid,
  parseIdentity,
  type LanEnvelope,
  type LanHello
} from '../electron/main/multi-instance/lan/lan-types'
import { encodeLanStreamFrame, LAN_STREAM_TYPE_DATA } from '../electron/main/multi-instance/lan/lan-stream'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 轮询等待条件成立（替代固定墙钟，避免负载下竞态） */
async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await wait(20)
  }
  return cond()
}

function makeHello(uid: number): LanHello {
  return { uid, 用户名: 'test-user', role: 'master', lanIp: '127.0.0.1', lanPort: 62003 }
}

interface Harness {
  server: LanServer
  port: number
  hellos: LanHello[]
  envelopes: LanEnvelope[]
  streamFrames: number[]
}

/** 起一个 LanServer（bindHost 缺省 → 127.0.0.1，本测试即验证默认回环可用） */
async function startServer(selfUid = 1): Promise<Harness> {
  const h: Harness = { server: null as never, port: 0, hellos: [], envelopes: [], streamFrames: [] }
  h.server = new LanServer(
    () => makeHello(selfUid),
    {
      onHello: (peer) => h.hellos.push(peer),
      onEnvelope: (env) => h.envelopes.push(env),
      onPeerClose: () => undefined,
      onStreamFrame: (uid) => h.streamFrames.push(uid)
    },
    // 系统临时端口：不与正在运行的应用 / 并行 LAN 测试抢 62003+ 端口段
    { port: 0 }
  )
  h.port = await h.server.start()
  return h
}

/** 连接并完成合法握手，返回已登记连接的客户端 */
async function connectAndHello(port: number, uid = 2): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise<void>((resolve) => ws.once('open', () => resolve()))
  ws.send(JSON.stringify({ id: 'h1', type: 'hello', from: uid, to: 1, ts: Date.now(), payload: makeHello(uid) } satisfies LanEnvelope))
  return ws
}

describe('isValidLanUid：LAN 身份 uid 必须是正整数', () => {
  it('合法：正整数与安全整数上界', () => {
    expect(isValidLanUid(1)).toBe(true)
    expect(isValidLanUid(42)).toBe(true)
    expect(isValidLanUid(Number.MAX_SAFE_INTEGER)).toBe(true)
  })

  it('非法：0 / 负数 / 小数 / NaN / Infinity', () => {
    expect(isValidLanUid(0)).toBe(false)
    expect(isValidLanUid(-1)).toBe(false)
    expect(isValidLanUid(1.5)).toBe(false)
    expect(isValidLanUid(NaN)).toBe(false)
    expect(isValidLanUid(Infinity)).toBe(false)
    expect(isValidLanUid(-Infinity)).toBe(false)
  })

  it('非法：非 number 类型（字符串 / null / undefined / 对象 / 布尔 / 数组）', () => {
    expect(isValidLanUid('1')).toBe(false)
    expect(isValidLanUid(null)).toBe(false)
    expect(isValidLanUid(undefined)).toBe(false)
    expect(isValidLanUid({})).toBe(false)
    expect(isValidLanUid({ uid: 1 })).toBe(false)
    expect(isValidLanUid(true)).toBe(false)
    expect(isValidLanUid([1])).toBe(false)
  })
})

describe('parseIdentity：uid 段口径与 isValidLanUid 一致（复审轮 A1 回归）', () => {
  it('合法：真人身份 `1` 与 AI 身份 `1-2`（容忍前后空白）', () => {
    expect(parseIdentity('1')).toEqual({ uid: 1 })
    expect(parseIdentity('42')).toEqual({ uid: 42 })
    expect(parseIdentity('1-2')).toEqual({ uid: 1, aiId: 2 })
    expect(parseIdentity(' 7-3 ')).toEqual({ uid: 7, aiId: 3 })
  })

  it('非法 uid 段：负数 / 零 → null（原实现接受负 uid，与握手侧口径相反）', () => {
    expect(parseIdentity('-5')).toBeNull()
    expect(parseIdentity('-5-3')).toBeNull()
    expect(parseIdentity('0')).toBeNull()
    expect(parseIdentity('0-1')).toBeNull()
  })

  it('非法 aiId 段：0 / 负数 → null', () => {
    expect(parseIdentity('1-0')).toBeNull()
    expect(parseIdentity('1--2')).toBeNull()
  })

  it('非法形态：空串 / 非数字 / 多段 / 带符号 / 小数', () => {
    expect(parseIdentity('')).toBeNull()
    expect(parseIdentity('abc')).toBeNull()
    expect(parseIdentity('1-2-3')).toBeNull()
    expect(parseIdentity('+1')).toBeNull()
    expect(parseIdentity('1.5')).toBeNull()
  })
})

describe('LAN 载荷分级档位（防 512MB 回退）', () => {
  it('ws 硬阀 64MB、信封软阀 32MB，且软阀严格小于硬阀', () => {
    expect(LAN_MAX_PAYLOAD).toBe(64 * 1024 * 1024)
    expect(LAN_ENVELOPE_MAX_PAYLOAD).toBe(32 * 1024 * 1024)
    expect(LAN_ENVELOPE_MAX_PAYLOAD).toBeLessThan(LAN_MAX_PAYLOAD)
  })
})

describe('LanServer 握手 uid 校验（真实 ws）', () => {
  it('hello 自报 uid=0 → 拒连（close 4002）且不登记', async () => {
    const h = await startServer()
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}`)
      await new Promise<void>((resolve) => ws.once('open', () => resolve()))
      const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
      ws.send(JSON.stringify({ id: 'bad', type: 'hello', from: 0, to: 1, ts: Date.now(), payload: makeHello(0) } satisfies LanEnvelope))
      const code = await closed
      expect(code).toBe(4002)
      expect(h.hellos).toHaveLength(0)
      expect(h.server.hasPeer(0)).toBe(false)
    } finally {
      h.server.stop()
    }
  })

  it('hello 自报 uid=-5 → 拒连且不登记', async () => {
    const h = await startServer()
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}`)
      await new Promise<void>((resolve) => ws.once('open', () => resolve()))
      const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
      ws.send(JSON.stringify({ id: 'bad', type: 'hello', from: -5, to: 1, ts: Date.now(), payload: makeHello(-5) } satisfies LanEnvelope))
      expect(await closed).toBe(4002)
      expect(h.hellos).toHaveLength(0)
    } finally {
      h.server.stop()
    }
  })

  it('合法 uid → 握手成功并登记', async () => {
    const h = await startServer()
    try {
      const ws = await connectAndHello(h.port, 7)
      expect(await waitFor(() => h.hellos.length === 1)).toBe(true)
      expect(h.hellos[0].uid).toBe(7)
      expect(h.server.hasPeer(7)).toBe(true)
      ws.close()
    } finally {
      h.server.stop()
    }
  })
})

describe('LanServer 载荷分级（真实 ws）', () => {
  it('超信封软阀的信封帧被丢弃、连接不击穿，其后小信封仍送达', async () => {
    const h = await startServer()
    try {
      const ws = await connectAndHello(h.port, 8)
      expect(await waitFor(() => h.hellos.length === 1)).toBe(true)

      // 构造一条 >32MB 的信封（payload 为纯文本；信封通道按设计只承载 UTF-8 文本）
      const bigPayload = 'A'.repeat(LAN_ENVELOPE_MAX_PAYLOAD + 1024)
      ws.send(JSON.stringify({ id: 'big', type: 'friend.message', from: 8, to: 1, ts: Date.now(), payload: bigPayload } satisfies LanEnvelope))
      await wait(300)
      expect(h.envelopes).toHaveLength(0) // 超软阀被丢弃

      // 连接仍存活：随后的小信封正常送达
      ws.send(JSON.stringify({ id: 'small', type: 'friend.message', from: 8, to: 1, ts: Date.now(), payload: 'ok' } satisfies LanEnvelope))
      expect(await waitFor(() => h.envelopes.length === 1)).toBe(true)
      expect((h.envelopes[0].payload as string)).toBe('ok')
      ws.close()
    } finally {
      h.server.stop()
    }
  }, 20_000)

  it('同尺寸流帧不受信封软阀约束（分级只作用于信封通道）', async () => {
    const h = await startServer()
    try {
      const ws = await connectAndHello(h.port, 9)
      expect(await waitFor(() => h.hellos.length === 1)).toBe(true)

      // LMST 流帧，尺寸同样超过信封软阀：应被识别为流帧并直通 onStreamFrame
      const bigChunk = Buffer.alloc(LAN_ENVELOPE_MAX_PAYLOAD + 1024)
      const frame = encodeLanStreamFrame(LAN_STREAM_TYPE_DATA, 1, 0, 0n, bigChunk, 0)
      expect(frame.length).toBeGreaterThan(LAN_ENVELOPE_MAX_PAYLOAD)
      ws.send(frame)
      expect(await waitFor(() => h.streamFrames.length === 1)).toBe(true)
      expect(h.streamFrames[0]).toBe(9)
      expect(h.envelopes).toHaveLength(0) // 未被当作信封处理
      ws.close()
    } finally {
      h.server.stop()
    }
  }, 20_000)
})
