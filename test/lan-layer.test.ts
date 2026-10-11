import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LanService } from '../electron/main/multi-instance/lan/lan-service'
import { LanPeerStore } from '../electron/main/multi-instance/lan/peer-store'
import type { LanEnvelope, LanPeer } from '../electron/main/multi-instance/lan/lan-types'

/**
 * L0 局域网通信层冒烟测试：
 * 1. 两个终端（uid=1 master / uid=2 satellite）各自启动 LanService
 * 2. 注入全员 roster（含双方地址）→ 模拟主系统名册下发
 * 3. 验证：直连送达 / 双向可通 / 离线入 outbox / 上线补投 / 在线状态维护

 * 注意竞态窗口：对端进程停止后，本端 close 事件是异步传播的；
 * 在传播完成前 sendTo 可能 false-positive 为 direct（TCP 语义固有，
 * 需上层 ack 才能根除）。测试中对关闭传播显式等待，模拟真实时序。
 */
describe('lan-layer L0', () => {
  const rootA = mkdtempSync(join(tmpdir(), 'lan-a-'))
  const rootB = mkdtempSync(join(tmpdir(), 'lan-b-'))
  const receivedA: LanEnvelope[] = []
  const receivedB: LanEnvelope[] = []

  let a: LanService
  let b: LanService
  /** B 重启后的实际监听端口（重启后 B 的 hello 会携带该值，A 侧连接表据此记录） */
  let bCurrentPort = 0

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  beforeAll(async () => {
    a = new LanService({
      root: rootA,
      role: 'master',
      getIdentity: () => ({ uid: 1, 用户名: 'master-user' }),
      pickLanIp: () => '127.0.0.1',
      onMessage: (env) => receivedA.push(env)
    })
    b = new LanService({
      root: rootB,
      role: 'satellite',
      getIdentity: () => ({ uid: 2, 用户名: 'sat-user' }),
      pickLanIp: () => '127.0.0.1',
      onMessage: (env) => receivedB.push(env)
    })

    const ra = await a.start()
    const rb = await b.start()
    expect(ra.ok).toBe(true)
    expect(rb.ok).toBe(true)

    // 模拟主系统名册下发：双方都拿到全员 roster（含地址）
    const roster: LanPeer[] = [
      { uid: 1, 用户名: 'master-user', role: 'master', lanIp: '127.0.0.1', lanPort: ra.port!, online: true, lastSeen: Date.now() },
      { uid: 2, 用户名: 'sat-user', role: 'satellite', lanIp: '127.0.0.1', lanPort: rb.port!, online: true, lastSeen: Date.now() }
    ]
    new LanPeerStore(rootA).saveRosterCache(roster)
    new LanPeerStore(rootA).applyRoster(roster)
    new LanPeerStore(rootB).saveRosterCache(roster)
    new LanPeerStore(rootB).applyRoster(roster)
  })

  afterAll(async () => {
    await a?.stop()
    await b?.stop()
    rmSync(rootA, { recursive: true, force: true })
    rmSync(rootB, { recursive: true, force: true })
  })

  it('握手后可直连送达（master → satellite）', async () => {
    const result = a.sendTo(2, 'friend.message', { text: 'hello from master' })
    expect(result.ok).toBe(true)
    await sleep(800)
    expect(receivedB.length).toBeGreaterThan(0)
    expect(receivedB[0].type).toBe('friend.message')
    expect(receivedB[0].payload).toEqual({ text: 'hello from master' })
    expect(receivedB[0].from).toBe(1)
  })

  it('双向可通（satellite → master）', async () => {
    b.sendTo(1, 'friend.message', { text: 'reply from satellite' })
    await sleep(800)
    expect(receivedA.length).toBeGreaterThan(0)
    expect(receivedA[0].type).toBe('friend.message')
    expect(receivedA[0].from).toBe(2)
  })

  it('对端离线时消息入 outbox，上线后补投', async () => {
    // 优雅停止 B，等待 close 事件传播到 A（对端在线状态更新为离线、连接表清理）
    await b.stop()
    await sleep(300)
    expect(a.getPeer(2)?.online).toBe(false)

    // 此刻发送 → 应入 A 的 outbox（记录发送时刻窗口：补投信封 ts 必须落在其中）
    const sentBefore = Date.now()
    const result = a.sendTo(2, 'publish-board.article', { title: 'offline message' })
    expect(result.ok).toBe(true)
    await sleep(300)
    const sentAfter = Date.now()
    const outboxDir = join(rootA, 'federation', 'outbox', '2')
    let files: string[] = []
    try {
      files = readdirSync(outboxDir).filter((f) => f.endsWith('.json'))
    } catch {
      files = []
    }
    expect(files.length).toBeGreaterThan(0)

    // B 重启 → B 主动回连 A（roster 中 uid=1 在线）→ A 收到 hello 后补投 outbox
    const rb = await b.start()
    expect(rb.ok).toBe(true)
    bCurrentPort = rb.port!
    await sleep(1500)
    const receivedAfter = receivedB.filter((env) => env.type === 'publish-board.article')
    expect(receivedAfter.length).toBeGreaterThan(0)
    expect(receivedAfter[0].payload).toEqual({ title: 'offline message' })
    // 时间戳保真：补投信封 ts = 原始发送时刻（落在发送窗口内），而非补投时刻
    expect(receivedAfter[0].ts).toBeGreaterThanOrEqual(sentBefore)
    expect(receivedAfter[0].ts).toBeLessThanOrEqual(sentAfter)
    // 远早于补投到达时刻（发送后至少等待了 300+300+1500ms）
    expect(receivedAfter[0].ts).toBeLessThanOrEqual(Date.now() - 1000)
  })

  it('对端在连接表中记录 lastSeen 与在线态', async () => {
    // 上一用例结束时 B 已在线且 A 已登记。
    // 端口断言不用 beforeAll 时的首次启动快照——LanServer 从 62003 起 +1 自动回退，
    // 应用本体运行（占 62003+）时测试内端口会偏移，且 B 重启可能再次回退；
    // 因此以「B 重启后的实际端口」为准：A 的连接表应记录 B 当前真实监听端口。
    const peer2 = a.getPeer(2)
    expect(peer2).not.toBeNull()
    expect(peer2!.online).toBe(true)
    expect(peer2!.lastSeen).toBeTypeOf('number')
    expect(peer2!.lanPort).toBe(bCurrentPort)
  })
})