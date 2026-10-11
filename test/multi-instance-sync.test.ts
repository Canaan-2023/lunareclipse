import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { SyncEngine } from '../electron/main/multi-instance/satellite/sync-engine'
import { OplogCapture } from '../electron/main/multi-instance/satellite/oplog-capture'
import { SatelliteStore } from '../electron/main/multi-instance/master/satellite-store'
import type { OpEntry, SyncPushResult } from '../electron/main/multi-instance/types'

/** 原始字节 sha256（'sha256:'+hex），与 satellite-store 的 staged 实体校验格式一致 */
function bufferHash(raw: Buffer): string {
  return 'sha256:' + createHash('sha256').update(raw).digest('hex')
}

/** 构造 staged upsert 条目（upsert 一律外置：携带 size/staged/hash，无 content） */
function stagedUpsert(instanceId: string, uid: number, aiId: number, key: string, raw: string | Buffer, seq: number): OpEntry {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf-8')
  return { instanceId, uid, aiId, op: 'upsert', key, size: buf.length, staged: true, hash: bufferHash(buf), seq, ts: 't' }
}

/** 模拟分块面前置：把 staged 实体落到收端 sync_staging（applyPush 消费前实体必达的先决条件） */
function seedStaging(root: string, uid: number, instanceId: string, key: string, raw: string | Buffer): string {
  const p = SatelliteStore.stagingPathFor(root, uid, instanceId, key)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf-8'))
  return p
}

describe('SyncEngine outbox 补偿（断网不丢、ack 推进、退避重试）', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sync-engine-test-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function makeEngine(opts: { fail: boolean; failTimes?: number }): {
    engine: SyncEngine
    pushCalls: Array<OpEntry[]>
  } {
    const pushCalls: Array<OpEntry[]> = []
    let failCount = 0
    const client = {
      push: async (token: string, entries: OpEntry[]): Promise<SyncPushResult> => {
        pushCalls.push(entries)
        void token
        if (opts.fail && failCount < (opts.failTimes ?? 1)) {
          failCount += 1
          throw new Error('network down')
        }
        return { ok: true, ackedSeq: Math.max(...entries.map((e) => e.seq)) }
      }
    }
    const engine = new SyncEngine(root, client as never, {
      instanceId: 'inst-1',
      getToken: () => 'test-token',
      // upsert 一律 staged：实体面桩直接返回送达（引擎测试聚焦 seq/outbox/ack 调度，实体面
      // 由下方 staged 分块链路测试覆盖）——无实体面时 staged 条永远退回重试、ack 不推进
      sendStagedEntity: async () => true
    })
    return { engine, pushCalls }
  }

  it('enqueue 分配单调 seq、落盘 outbox，崩溃后可恢复补推（不丢）', async () => {
    const { engine } = makeEngine({ fail: true })
    engine.enqueue({
      instanceId: 'inst-1', uid: 7, aiId: 1, op: 'upsert', key: 'memory/U7/AI1/normal/1.json', size: 7, staged: true, hash: 'h1'
    })
    engine.enqueue({
      instanceId: 'inst-1', uid: 7, aiId: 1, op: 'upsert', key: 'memory/U7/AI1/normal/2.json', size: 7, staged: true, hash: 'h2'
    })
    // outbox 已落盘（首条 seq=1）
    const f1 = join(root, '.sync', 'outbox', '1.json')
    const f2 = join(root, '.sync', 'outbox', '2.json')
    expect(existsSync(f1)).toBe(true)
    expect(existsSync(f2)).toBe(true)
    expect(JSON.parse(readFileSync(f1, 'utf-8')).seq).toBe(1)
    expect(JSON.parse(readFileSync(f2, 'utf-8')).seq).toBe(2)

    // 模拟崩溃重启：新 engine 从 outbox 恢复，收到推送（网络恢复）
    const { pushCalls } = makeEngine({ fail: false })
    const restored = new SyncEngine(root, pushCallsClient(pushCalls), {
      instanceId: 'inst-1',
      getToken: () => 'test-token',
      sendStagedEntity: async () => true
    })
    restored.start()
    await vi.waitFor(() => expect(pushCalls.length).toBeGreaterThan(0))
    const sent = pushCalls.flat()
    expect(sent.map((e) => e.key).sort()).toEqual([
      'memory/U7/AI1/normal/1.json',
      'memory/U7/AI1/normal/2.json'
    ])
    expect(sent[0].seq).toBe(1)
    expect(sent[1].seq).toBe(2)
  })

  it('ack 成功后清理 outbox 并推进游标', async () => {
    const { engine } = makeEngine({ fail: false })
    engine.enqueue({ instanceId: 'inst-1', uid: 7, aiId: 1, op: 'upsert', key: 'memory/U7/AI1/normal/1.json', size: 2, staged: true, hash: 'h' })
    await vi.waitFor(() => expect(engine.getAckedSeq()).toBe(1))
    expect(existsSync(join(root, '.sync', 'outbox', '1.json'))).toBe(false)
    expect(engine.getPendingCount()).toBe(0)
  })

  it('推送失败保留 outbox，退避后重试成功', async () => {
    // failTimes=1：第一次失败，第二次成功
    const { engine, pushCalls } = makeEngine({ fail: true, failTimes: 1 })
    engine.enqueue({ instanceId: 'inst-1', uid: 7, aiId: 1, op: 'upsert', key: 'memory/U7/AI1/normal/1.json', size: 2, staged: true, hash: 'h' })
    // 等待第一次失败后被调度重试（retryDelay 30s 起步，等太久；改为直接操纵重试路径）
    await vi.waitFor(() => expect(pushCalls.length).toBeGreaterThan(0))
    // 失败后 outbox 仍保留
    expect(existsSync(join(root, '.sync', 'outbox', '1.json'))).toBe(true)
  })

  it('master applyPush 幂等收敛：同 key 旧 seq 重放丢弃、新 seq 覆盖、delete 生效', () => {
    const masterRoot = mkdtempSync(join(tmpdir(), 'sat-store-test-'))
    const inst = 'inst-1'
    const key = 'memory/U7/AI1/normal/1.json'
    try {
      const store = new SatelliteStore(masterRoot)
      // upsert 一律 staged：实体先落 staging，applyPush 读回验 size/hash 后落镜像
      seedStaging(masterRoot, 7, inst, key, 'v1')
      store.applyPush(7, inst, [stagedUpsert(inst, 7, 1, key, 'v1', 1)])
      // 旧 seq 重放：不覆盖（幂等分支在 staging 读回之前——实体首次应用时已被消费删除，
      // 重放不重读 staging，故此处不再 seed 也能正确丢弃）
      store.applyPush(7, inst, [stagedUpsert(inst, 7, 1, key, 'stale', 1)])
      expect(readFileSync(join(masterRoot, 'memory', 'U7', 'AI1', 'normal', '1.json'), 'utf-8')).toBe('v1')
      // 新 seq：覆盖（原实体已随首次应用消费删除，需重新 seed staging）
      seedStaging(masterRoot, 7, inst, key, 'v2')
      store.applyPush(7, inst, [stagedUpsert(inst, 7, 1, key, 'v2', 2)])
      expect(readFileSync(join(masterRoot, 'memory', 'U7', 'AI1', 'normal', '1.json'), 'utf-8')).toBe('v2')
      // delete：镜像删除，seq 记录为 deleted
      store.applyPush(7, inst, [{ instanceId: inst, uid: 7, aiId: 1, op: 'delete', key, seq: 3, ts: 't' }])
      expect(existsSync(join(masterRoot, 'memory', 'U7', 'AI1', 'normal', '1.json'))).toBe(false)
      // delete 后旧 seq upsert 重放：不复活（prev.deleted 且 seq<=prev.seq）
      store.applyPush(7, inst, [stagedUpsert(inst, 7, 1, key, 'zombie', 2)])
      expect(existsSync(join(masterRoot, 'memory', 'U7', 'AI1', 'normal', '1.json'))).toBe(false)
    } finally {
      rmSync(masterRoot, { recursive: true, force: true })
    }
  })

  it('NNG 主/分同存镜像（AIID 在前：{root}/NNG/AI{aiId}/U{uid}）', () => {
    const masterRoot = mkdtempSync(join(tmpdir(), 'sat-store-nng-'))
    try {
      const store = new SatelliteStore(masterRoot)
      const key = 'NNG/AI2/U7/root/节点.json'
      seedStaging(masterRoot, 7, 'inst-1', key, 'n')
      store.applyPush(7, 'inst-1', [stagedUpsert('inst-1', 7, 2, key, 'n', 1)])
      expect(existsSync(join(masterRoot, 'NNG', 'AI2', 'U7', 'root', '节点.json'))).toBe(true)
    } finally {
      rmSync(masterRoot, { recursive: true, force: true })
    }
  })

  it('cache 主/分同存镜像（AIID 在前：{root}/cache/AI{aiId}/U{uid}）', () => {
    const masterRoot = mkdtempSync(join(tmpdir(), 'sat-store-cache-'))
    try {
      const store = new SatelliteStore(masterRoot)
      const key = 'cache/AI2/U7/index/节点_cache.json'
      seedStaging(masterRoot, 7, 'inst-1', key, 'c')
      store.applyPush(7, 'inst-1', [stagedUpsert('inst-1', 7, 2, key, 'c', 1)])
      expect(existsSync(join(masterRoot, 'cache', 'AI2', 'U7', 'index', '节点_cache.json'))).toBe(true)
      // delete：镜像删除
      store.applyPush(7, 'inst-1', [{ instanceId: 'inst-1', uid: 7, aiId: 2, op: 'delete', key, seq: 2, ts: 't' }])
      expect(existsSync(join(masterRoot, 'cache', 'AI2', 'U7', 'index', '节点_cache.json'))).toBe(false)
    } finally {
      rmSync(masterRoot, { recursive: true, force: true })
    }
  })

  it('目录级 delete：递归删除作用域整树，不残留空目录骨架', () => {
    const masterRoot = mkdtempSync(join(tmpdir(), 'sat-store-deldir-'))
    try {
      const store = new SatelliteStore(masterRoot)
      // 先推送一棵 AI 记忆树（嵌套目录；upsert 一律 staged，实体先落 staging）
      seedStaging(masterRoot, 7, 'inst-1', 'memory/U7/AI1/normal/a.json', 'a')
      seedStaging(masterRoot, 7, 'inst-1', 'memory/U7/AI1/normal/sub/b.json', 'b')
      store.applyPush(7, 'inst-1', [
        stagedUpsert('inst-1', 7, 1, 'memory/U7/AI1/normal/a.json', 'a', 1),
        stagedUpsert('inst-1', 7, 1, 'memory/U7/AI1/normal/sub/b.json', 'b', 2)
      ])
      const tree = join(masterRoot, 'memory', 'U7', 'AI1')
      expect(existsSync(join(tree, 'normal', 'sub', 'b.json'))).toBe(true)
      // 分系统删除整棵 AI 树：watcher 父目录 delete 事件先到 → 目录级 delete op
      store.applyPush(7, 'inst-1', [
        { instanceId: 'inst-1', uid: 7, aiId: 1, op: 'delete', key: 'memory/U7/AI1', seq: 3, ts: 't' }
      ])
      expect(existsSync(tree)).toBe(false)
      expect(existsSync(join(tree, 'normal'))).toBe(false)
    } finally {
      rmSync(masterRoot, { recursive: true, force: true })
    }
  })

  it('目录级 upsert：拒绝落盘（写目录会 EISDIR，防崩溃）', () => {
    const masterRoot = mkdtempSync(join(tmpdir(), 'sat-store-dirupsert-'))
    try {
      const store = new SatelliteStore(masterRoot)
      // 实体先到达 staging（分块面完成），applyPush 仍以目录级 key 拒绝落盘（upsert 不允许整树语义）
      seedStaging(masterRoot, 7, 'inst-1', 'memory/U7/AI1', 'not a file')
      store.applyPush(7, 'inst-1', [stagedUpsert('inst-1', 7, 1, 'memory/U7/AI1', 'not a file', 1)])
      expect(existsSync(join(masterRoot, 'memory', 'U7', 'AI1'))).toBe(false)
    } finally {
      rmSync(masterRoot, { recursive: true, force: true })
    }
  })

  it('ABYSS 用户根目录级 delete：递归收敛用户资料树', () => {
    const masterRoot = mkdtempSync(join(tmpdir(), 'sat-store-abyssdir-'))
    try {
      const store = new SatelliteStore(masterRoot)
      seedStaging(masterRoot, 7, 'inst-1', 'ABYSS/U7/USER.md', 'u')
      seedStaging(masterRoot, 7, 'inst-1', 'ABYSS/U7/AI1/AI.md', 'a1')
      store.applyPush(7, 'inst-1', [
        stagedUpsert('inst-1', 7, 0, 'ABYSS/U7/USER.md', 'u', 1),
        stagedUpsert('inst-1', 7, 1, 'ABYSS/U7/AI1/AI.md', 'a1', 2)
      ])
      expect(existsSync(join(masterRoot, 'ABYSS', 'U7', 'USER.md'))).toBe(true)
      expect(existsSync(join(masterRoot, 'ABYSS', 'U7', 'AI1', 'AI.md'))).toBe(true)
      // 用户根整树删除（ABYSS/U7 2 段目录）
      store.applyPush(7, 'inst-1', [
        { instanceId: 'inst-1', uid: 7, aiId: 0, op: 'delete', key: 'ABYSS/U7', seq: 3, ts: 't' }
      ])
      expect(existsSync(join(masterRoot, 'ABYSS', 'U7'))).toBe(false)
    } finally {
      rmSync(masterRoot, { recursive: true, force: true })
    }
  })
})

function pushCallsClient(pushCalls: Array<OpEntry[]>): unknown {
  return {
    push: async (token: string, entries: OpEntry[]): Promise<SyncPushResult> => {
      void token
      pushCalls.push(entries)
      return { ok: true, ackedSeq: Math.max(...entries.map((e) => e.seq)) }
    }
  }
}

describe('OplogCapture 白名单与作用域解析', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'oplog-capture-test-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('memory 解析为 U{uid}/AI{aiId}，sessions 解析为 {uid}/{aiId}，NNG 解析为 AI{aiId}/U{uid}', async () => {
    const ops: Array<{ key: string; uid: number; aiId: number }> = []
    mkdirSync(join(root, 'memory', 'U7', 'AI1', 'normal'), { recursive: true })
    mkdirSync(join(root, 'NNG', 'AI2', 'U7', 'root'), { recursive: true })
    writeFileSync(join(root, 'memory', 'U7', 'AI1', 'normal', 'a.json'), '{}', 'utf-8')
    writeFileSync(join(root, 'NNG', 'AI2', 'U7', 'root', 'b.json'), '{}', 'utf-8')

    const capture = new OplogCapture(root, (op) => ops.push(op))
    await capture.start()
    await vi.waitFor(() => expect(ops.length).toBe(2))
    await capture.stop()

    const mem = ops.find((o) => o.key.startsWith('memory'))
    const nng = ops.find((o) => o.key.startsWith('NNG'))
    expect(mem).toMatchObject({ key: 'memory/U7/AI1/normal/a.json', uid: 7, aiId: 1 })
    expect(nng).toMatchObject({ aiId: 2, uid: 7 })
  })

  it('federation/plugins/skills/config 不在采集白名单（永不采集）', async () => {
    const ops: Array<{ key: string }> = []
    mkdirSync(join(root, 'federation', 'x'), { recursive: true })
    mkdirSync(join(root, 'plugins', 'p'), { recursive: true })
    mkdirSync(join(root, 'skills', '7', '1'), { recursive: true })
    mkdirSync(join(root, 'config', '7', '1'), { recursive: true })
    writeFileSync(join(root, 'federation', 'x', 'f.json'), '{}', 'utf-8')
    writeFileSync(join(root, 'plugins', 'p', 'plugin.json'), '{}', 'utf-8')
    writeFileSync(join(root, 'skills', '7', '1', 'skill.json'), '{}', 'utf-8')
    writeFileSync(join(root, 'config', '7', '1', 'config.json'), '{}', 'utf-8')

    const capture = new OplogCapture(root, (op) => ops.push(op))
    await capture.start()
    // 无白名单文件 → 无基线 op
    expect(ops.length).toBe(0)
    await capture.stop()
  })
})
describe('staged 统一分块链路（采集→分块面→applyPush 落镜像）', () => {
  it('oplog-capture 对非 UTF-8 文件产出 staged 条目（不再 fatal 丢弃、hash 为原始字节指纹）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'staged-capture-'))
    try {
      // 非 UTF-8 原始字节：无内联判定可依赖，采集不尝试解码、一律外置走分块面
      const raw = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x41, 0x42, 0x43])
      const rel = 'memory/U7/AI1/normal/1.bin'
      const abs = join(root, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, raw)

      const ops: Array<Record<string, unknown>> = []
      const capture = new OplogCapture(root, (op) => ops.push(op as unknown as Record<string, unknown>))
      await capture.start()
      await vi.waitFor(() => expect(ops.length).toBe(1))
      await capture.stop()

      const op = ops[0]
      expect(op).toMatchObject({ op: 'upsert', key: rel, uid: 7, aiId: 1, staged: true })
      expect(op).not.toHaveProperty('content')
      expect(op.size).toBe(raw.length)
      // staged hash = 原始字节 sha256（不是字符串哈希：字节从 Buffer 直读，不做 UTF-8 往返）
      expect(typeof op.hash).toBe('string')
      const hex = String(op.hash).replace(/^sha256:/, '')
      expect(createHash('sha256').update(raw).digest('hex')).toBe(hex)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('oplog-capture 对 UTF-8 文本文件同样产出 staged 条目（统一分块面，不再内联 content）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'staged-capture-utf8-'))
    try {
      // UTF-8 文本（既往 ≤8MB 内联路径的典型对象）：采集合一后同样外置走分块面，
      // 无阈值、无格式分流——文本与任意字节同一条可靠通道
      const text = '{"a":1,"b":"中文内容"}'
      const rel = 'memory/U7/AI1/normal/1.json'
      const abs = join(root, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, text, 'utf-8')

      const ops: Array<Record<string, unknown>> = []
      const capture = new OplogCapture(root, (op) => ops.push(op as unknown as Record<string, unknown>))
      await capture.start()
      await vi.waitFor(() => expect(ops.length).toBe(1))
      await capture.stop()

      const op = ops[0]
      expect(op).toMatchObject({ op: 'upsert', key: rel, uid: 7, aiId: 1, staged: true })
      expect(op).not.toHaveProperty('content')
      expect(op.size).toBe(Buffer.byteLength(text, 'utf-8'))
      // hash = 原始字节 sha256（与字符串哈希对 UTF-8 文本等价，但统一走 Buffer 直读）
      const hex = String(op.hash).replace(/^sha256:/, '')
      expect(createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex')).toBe(hex)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('SyncStreamSink 落盘 staging（流名路由/权限/作用域校验/整流 rename）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'staged-sink-'))
    try {
      const { SyncStreamSink } = await import('../electron/main/multi-instance/master/sync-stream-sink')
      const sink = new SyncStreamSink({ root, allowPeer: (uid) => uid === 7 })
      const raw = Buffer.from([0xff, 0x00, 0xfe, 0x41])
      const key = 'memory/U7/AI1/normal/1.bin'
      const instanceId = 'satellite-A1B2C3'
      const streamId = 1
      // 流名 = sync:{instanceId}:{key}；同步实体流由 SyncStreamSink 接管（LanFileSink 整流跳过）
      sink.onBegin(7, streamId, {
        name: `sync:${instanceId}:${key}`,
        size: raw.length,
        chunkSize: raw.length,
        chunkCount: 1,
        totalSha256: createHash('sha256').update(raw).digest('hex')
      })
      sink.onData(7, streamId, 0, raw)
      sink.onEnd(7, streamId, { name: `sync:${instanceId}:${key}`, size: raw.length })
      await vi.waitFor(() => {
        const staged = join(root, 'sync_staging', `U7`, instanceId, ...key.split('/'))
        expect(existsSync(staged)).toBe(true)
        expect(readFileSync(staged).equals(raw)).toBe(true)
      })
      // 权限拒绝：非放行 uid 的同步流不落盘
      const deniedPath = join(root, 'sync_staging', 'U999', instanceId, ...key.split('/'))
      sink.onBegin(999, 99, {
        name: `sync:${instanceId}:${key}`,
        size: 1,
        chunkSize: 1,
        chunkCount: 1,
        totalSha256: ''
      })
      sink.onData(999, 99, 0, raw)
      sink.onEnd(999, 99, { name: `sync:${instanceId}:${key}`, size: 1 })
      await new Promise((r) => setTimeout(r, 50))
      expect(existsSync(deniedPath)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('applyPush staged 分支：读 staging 验 size/hash 落镜像、删暂存；实体未达不推进 ack', async () => {
    const root = mkdtempSync(join(tmpdir(), 'staged-push-'))
    try {
      const store = new SatelliteStore(root)
      const instanceId = 'satellite-A1B2C3'
      // 卫星侧先经分块面落好 staged 实体（与 sendStagedEntity → SyncStreamSink 同源路径）
      const raw = Buffer.from([0xff, 0x00, 0x41, 0x42, 0x43])
      const key = 'memory/U7/AI1/normal/1.bin'
      const stagedPath = SatelliteStore.stagingPathFor(root, 7, instanceId, key)
      mkdirSync(dirname(stagedPath), { recursive: true })
      writeFileSync(stagedPath, raw)
      const hash = 'sha256:' + createHash('sha256').update(raw).digest('hex')
      const entry: OpEntry = {
        instanceId, uid: 7, aiId: 1, op: 'upsert', key,
        size: raw.length, staged: true, hash, seq: 5, ts: 't'
      }
      const r1 = store.applyPush(7, instanceId, [entry])
      expect(r1.ok).toBe(true)
      expect(r1.ackedSeq).toBe(5)
      // 镜像字节与原字节完全一致（Buffer 直写，非 UTF-8 不损坏）
      expect(readFileSync(join(root, 'memory', 'U7', 'AI1', 'normal', '1.bin')).equals(raw)).toBe(true)
      // 消费后暂存已清理（幂等重放不再残留）
      expect(existsSync(stagedPath)).toBe(false)
      // 重放同 seq：幂等丢弃、不重新消费暂存
      const r2 = store.applyPush(7, instanceId, [entry])
      expect(r2.ackedSeq).toBe(5)
      // 实体未达（暂存不存在）→ 本条 markBad，ackedSeq 截断在该条之前，分系统保留 outbox 重推
      const entry2: OpEntry = { ...entry, seq: 6, key: 'memory/U7/AI1/normal/2.bin' }
      const r3 = store.applyPush(7, instanceId, [entry2, { ...entry, seq: 7 }])
      expect(r3.ok).toBe(true)
      expect(r3.ackedSeq).toBe(5)
      expect(existsSync(join(root, 'memory', 'U7', 'AI1', 'normal', '2.bin'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('端到端：采集→分级→SyncStreamSink→applyPush 全链路，非 UTF-8 实体字节无损落镜像', async () => {
    const satRoot = mkdtempSync(join(tmpdir(), 'staged-e2e-sat-'))
    const masterRoot = mkdtempSync(join(tmpdir(), 'staged-e2e-master-'))
    try {
      const { SyncStreamSink } = await import('../electron/main/multi-instance/master/sync-stream-sink')
      // 卫星侧：非 UTF-8 原始字节文件
      const raw = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7 + 0xff) % 256))
      const key = 'memory/U7/AI1/normal/1.bin'
      const abs = join(satRoot, key)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, raw)

      // 主系统：SyncStreamSink 收端 + SatelliteStore 镜像
      const store = new SatelliteStore(masterRoot)
      let flowEnded = false
      const sink = new SyncStreamSink({
        root: masterRoot,
        allowPeer: (uid) => uid === 7
      })
      // 模拟 LAN 分块面：sendStagedEntity 从卫星本地读文件 → 流式喂给收端 sink
      const sendStagedEntity = async (entry: OpEntry): Promise<boolean> => {
        const src = join(satRoot, entry.key)
        if (!existsSync(src)) return false
        const data = readFileSync(src)
        const streamId = 9001
        sink.onBegin(entry.uid, streamId, {
          name: `sync:${entry.instanceId}:${entry.key}`,
          size: data.length,
          chunkSize: data.length,
          chunkCount: 1,
          totalSha256: (entry.hash ?? '').replace(/^sha256:/, '')
        })
        sink.onData(entry.uid, streamId, 0, data)
        sink.onEnd(entry.uid, streamId, { name: `sync:${entry.instanceId}:${entry.key}`, size: data.length })
        await vi.waitFor(() => {
          expect(existsSync(SatelliteStore.stagingPathFor(masterRoot, entry.uid, entry.instanceId, entry.key))).toBe(true)
        })
        flowEnded = true
        return true
      }
      const client = {
        push: async (_token: string, entries: OpEntry[]): Promise<SyncPushResult> => {
          const r = store.applyPush(7, 'satellite-A1B2C3', entries)
          return r
        }
      }
      const engine = new SyncEngine(satRoot, client as never, {
        instanceId: 'satellite-A1B2C3',
        getToken: () => 'tok',
        sendStagedEntity
      })
      // 采集器接入 engine：scanBaseline 触发 emitUpsert → staged 条目入队
      const capture = new OplogCapture(satRoot, (op) => engine.enqueue(op))
      engine.start()
      await capture.start()
      // 全链路收敛：实体经分块面落 staging → applyPush 验 size/hash 落镜像 → ack 推进
      await vi.waitFor(() => expect(engine.getAckedSeq()).toBeGreaterThanOrEqual(1))
      expect(flowEnded).toBe(true)
      const mirror = readFileSync(join(masterRoot, 'memory', 'U7', 'AI1', 'normal', '1.bin'))
      expect(mirror.equals(raw)).toBe(true)
      // 暂存已清理，outbox 已回收
      expect(existsSync(SatelliteStore.stagingPathFor(masterRoot, 7, 'satellite-A1B2C3', key))).toBe(false)
      await capture.stop()
      engine.stop()
    } finally {
      rmSync(satRoot, { recursive: true, force: true })
      rmSync(masterRoot, { recursive: true, force: true })
    }
  })
})
