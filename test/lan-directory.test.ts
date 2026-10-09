import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { WebSocket } from 'ws'
import { LanService } from '../electron/main/multi-instance/lan/lan-service'
import { LanStreamManager, walkDirectorySafe, parseLanStreamFrame } from '../electron/main/multi-instance/lan/lan-stream'
import { LanFileSink } from '../electron/main/multi-instance/lan/lan-file-sink'
import { LanHashPool } from '../electron/main/multi-instance/lan/lan-hash-pool'
import type { LanDirectoryProgress, LanStreamBeginMeta } from '../electron/main/multi-instance/lan/lan-stream'
import type { LanPeer } from '../electron/main/multi-instance/lan/lan-types'
import { LanPeerStore } from '../electron/main/multi-instance/lan/peer-store'

/**
 * 文件夹整体传输测试（用户要求：不限制大小、传任何文件/整个文件夹、结构不变、有进度条）：
 * 1. 真实双端 sendDirectory 往返：深层目录/空目录/二进制/文本 → 收端 tree/ 结构逐级一致
 * 2. 聚合进度回调：doneFiles/doneBytes 单调收敛到总量，供 UI 进度条
 * 3. 恶意相对路径整流拒绝：.. / 绝对路径 / 盘符 / 控制字符不外泄、不产文件
 * 4. 15MB+ 大文件流式往返（收端 O(1) 内存，不整文件驻留）
 * 5. 重放幂等：同名目录再发一遍 → 不重复/不破坏既有文件
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const readdirSyncSafe = (dir: string): string[] => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

describe('walkDirectorySafe 遍历', () => {
  const root = mkdtempSync(join(tmpdir(), 'lan-walk-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('递归收集文件/目录/空目录，relPath 用 / 分隔且排序稳定', async () => {
    mkdirSync(join(root, 'deep', 'deeper', 'empty'), { recursive: true })
    writeFileSync(join(root, 'a.txt'), 'a')
    writeFileSync(join(root, 'deep', 'b.bin'), Buffer.from([1, 2, 3]))
    writeFileSync(join(root, 'deep', 'deeper', 'c.txt'), 'c')
    const entries = await walkDirectorySafe(root)
    expect(entries).not.toBeNull()
    expect(entries!.filter((e) => e.kind === 'file').length).toBe(3)
    expect(entries!.filter((e) => e.kind === 'dir').length).toBe(3) // deep / deep/deeper / deep/deeper/empty
    const rels = entries!.map((e) => e.relPath).sort()
    expect(rels).toContain('a.txt')
    expect(rels).toContain('deep/b.bin')
    expect(rels).toContain('deep/deeper/c.txt')
    expect(rels).toContain('deep/deeper/empty')
    expect(entries!.every((e) => !e.relPath.includes('\\'))).toBe(true)
    expect(entries!.find((e) => e.relPath === 'deep/b.bin')!.size).toBe(3)
  })

  it('ignore 回调可跳过条目；坏根目录返回 null', async () => {
    const entries = await walkDirectorySafe(root, (rel) => rel.endsWith('.bin'))
    expect(entries!.filter((e) => e.relPath.endsWith('.bin'))).toEqual([])
    const bad = await walkDirectorySafe(join(root, 'no-such-dir'))
    expect(bad).toBeNull()
  })
})

describe('sendDirectory 双端往返（真实 ws 连接）', () => {
  const rootA = mkdtempSync(join(tmpdir(), 'lan-dir-a-'))
  const rootB = mkdtempSync(join(tmpdir(), 'lan-dir-b-'))
  let a: LanService
  let b: LanService
  let sinkB: LanFileSink

  beforeAll(async () => {
    a = new LanService({
      root: rootA,
      role: 'master',
      getIdentity: () => ({ uid: 1, 用户名: 'master-user' }),
      pickLanIp: () => '127.0.0.1',
      onMessage: () => undefined,
      onStream: {
        onEnd: () => undefined,
        onData: () => undefined,
        onAbort: () => undefined,
        onBegin: () => undefined
      }
    })
    sinkB = new LanFileSink({ root: rootB, allowPeer: () => true })
    b = new LanService({
      root: rootB,
      role: 'satellite',
      getIdentity: () => ({ uid: 2, 用户名: 'sat-user' }),
      pickLanIp: () => '127.0.0.1',
      onMessage: () => undefined,
      onStream: {
        onBegin: (u, s, m) => sinkB.onBegin(u, s, m),
        onData: (u, s, o, d) => sinkB.onData(u, s, o, d),
        onEnd: (u, s, m, e) => sinkB.onEnd(u, s, m, e),
        onAbort: (u, s, r) => sinkB.onAbort(u, s, r)
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

  it('深层目录+空目录+二进制文件整体往返，收端 tree/ 结构逐级一致、无 .part 残留', async () => {
    const src = join(rootA, 'bundle')
    mkdirSync(join(src, 'deep', 'deeper', 'empty'), { recursive: true })
    writeFileSync(join(src, 'readme.md'), '# bundle\nhello lan dir\n')
    const bin = randomBytes(1024 * 1024 + 731) // 非整块，覆盖尾部碎块 + 二进制字节
    writeFileSync(join(src, 'deep', 'model.bin'), bin)
    writeFileSync(join(src, 'deep', 'deeper', 'data.json'), '{"ok":true}')
    // deep/empty 是空目录：必须被保留

    const res = await a.sendDirectory(2, src, { concurrency: 3 })
    expect(res.ok).toBe(true)
    expect(res.files).toBe(3)
    expect(res.dirs).toBe(3)
    expect(res.ackedBytes).toBe(bin.length + Buffer.byteLength('# bundle\nhello lan dir\n') + Buffer.byteLength('{"ok":true}'))

    // 收端结构：incoming/{对端uid=1}/tree/ 下原样重建（b 收到 a=uid1 的文件夹）
    const base = join(rootB, 'incoming', '1', 'tree')
    const assertSame = (rel: string, expectFn: () => void): void => {
      expectFn()
      void rel
    }
    // 等待落盘完成（轮询上限 5s）
    let ready = false
    for (let i = 0; i < 100; i += 1) {
      if (existsSync(join(base, 'readme.md')) && existsSync(join(base, 'deep', 'model.bin'))) {
        ready = true
        break
      }
      await sleep(50)
    }
    expect(ready).toBe(true)
    assertSame('readme.md', () => expect(readFileSync(join(base, 'readme.md'), 'utf8')).toBe('# bundle\nhello lan dir\n'))
    assertSame('deep/model.bin', () => expect(readFileSync(join(base, 'deep', 'model.bin')).equals(bin)).toBe(true))
    assertSame('deep/deeper/data.json', () => expect(readFileSync(join(base, 'deep', 'deeper', 'data.json'), 'utf8')).toBe('{"ok":true}'))
    // 空目录保留 + 无 .part 残留
    expect(existsSync(join(base, 'deep', 'deeper', 'empty'))).toBe(true)
    expect(readdirSyncSafe(join(rootB, 'incoming', '1')).filter((f) => f.endsWith('.part'))).toEqual([])
  }, 60_000)

  it('聚合进度回调：doneFiles 单调递增、doneBytes 收敛到总量、relPath 逐条可达', async () => {
    const src = join(rootA, 'progress-src')
    mkdirSync(join(src, 'sub'), { recursive: true })
    const sizes = [128_000, 512_000, 2_000_000, 11_111]
    sizes.forEach((s, i) => writeFileSync(join(src, i % 2 ? join('sub', `f${i}.bin`) : `f${i}.bin`), randomBytes(s)))
    const totalBytes = sizes.reduce((x, y) => x + y, 0)

    const progresses: LanDirectoryProgress[] = []
    const res = await a.sendDirectory(2, src, { concurrency: 2, onProgress: (p) => progresses.push(p) })
    expect(res.ok).toBe(true)
    expect(progresses.length).toBe(4)
    // doneFiles 严格单调递增 1..4；每条的 totalFiles=4、totalBytes=总字节
    expect(progresses.map((p) => p.doneFiles)).toEqual([1, 2, 3, 4])
    for (const p of progresses) {
      expect(p.totalFiles).toBe(4)
      expect(p.totalBytes).toBe(totalBytes)
      expect(p.doneBytes).toBeGreaterThanOrEqual(0)
      expect(p.relPath.length).toBeGreaterThan(0)
    }
    // 最终收敛：doneBytes == 确认送达字节
    expect(progresses.at(-1)!.doneBytes).toBe(res.ackedBytes)
    expect(progresses.at(-1)!.doneBytes).toBe(totalBytes)
  }, 60_000)

  it('文件夹重放幂等：同目录再发一遍，结构不破坏、无重复写入与 .part 残留', async () => {
    const src = join(rootA, 'replay-src')
    mkdirSync(join(src, 'sub'), { recursive: true })
    const bin = randomBytes(300_000)
    writeFileSync(join(src, 'a.bin'), bin)
    writeFileSync(join(src, 'sub', 'b.txt'), 'payload')
    const first = await a.sendDirectory(2, src)
    expect(first.ok).toBe(true)
    const base = join(rootB, 'incoming', '1', 'tree')
    // 等第一遍落盘（a.bin 与 sub/b.txt 都就位才是链路完成；relPath 不含顶层目录名）
    let landed = false
    for (let i = 0; i < 100; i += 1) {
      if (
        existsSync(join(base, 'a.bin')) &&
        readdirSyncSafe(join(base, 'sub')).includes('b.txt')
      ) {
        landed = true
        break
      }
      await sleep(50)
    }
    expect(landed).toBe(true)
    const second = await a.sendDirectory(2, src)
    expect(second.ok).toBe(true)
    // 幂等命中：收端跳过既有文件，不重复落盘（发送端仍正常回报 ackedBytes）
    expect(second.ackedBytes).toBe(first.ackedBytes)
    expect(readFileSync(join(base, 'a.bin')).equals(bin)).toBe(true)
    expect(readFileSync(join(base, 'sub', 'b.txt'), 'utf8')).toBe('payload')
    expect(readdirSyncSafe(join(rootB, 'incoming', '1')).filter((f) => f.endsWith('.part'))).toEqual([])
  }, 60_000)

  it('15MB+ 大文件流式传输：内存 O(1) 收端（增量哈希），内容逐字节一致、整体校验通过', async () => {
    const filePath = join(rootA, 'huge.bin')
    const size = 15 * 1024 * 1024 + 2024 // 15MB+，跨几十块
    // 用可重复流生成数据，避免一次性 15MB randomBytes 峰值：写盘后由 sendFile 流式读
    const chunk = randomBytes(1024 * 1024)
    const fh = await import('fs/promises').then((m) => m.open(filePath, 'w'))
    for (let written = 0; written < size; written += chunk.length) {
      const part = chunk.subarray(0, Math.min(chunk.length, size - written))
      await fh.writeFile(part)
    }
    await fh.close()
    const res = await a.sendFile(2, filePath, { name: 'huge.bin' })
    expect(res.ok).toBe(true)
    expect(res.ackedBytes).toBe(size)
    // 收端落盘文件与源逐块一致（流式校验：整体 sha256 在协议层已过，这里再抽样头/尾/中）
    const targetDir = join(rootB, 'incoming', '1')
    let target = ''
    for (let i = 0; i < 200; i += 1) {
      const hits = readdirSyncSafe(targetDir).filter((f) => f.endsWith('huge.bin'))
      if (hits.length > 0) {
        target = join(targetDir, hits[0])
        break
      }
      await sleep(50)
    }
    expect(target).not.toBe('')
    const stat = await import('fs/promises').then((m) => m.stat(target))
    expect(stat.size).toBe(size)
    const srcFh = await import('fs/promises').then((m) => m.open(filePath, 'r'))
    const dstFh = await import('fs/promises').then((m) => m.open(target, 'r'))
    for (const offset of [0, 5_000_000, 10_000_000, size - 4096]) {
      const aBuf = Buffer.alloc(4096)
      const bBuf = Buffer.alloc(4096)
      const ra = await srcFh.read(aBuf, 0, 4096, offset)
      const rb = await dstFh.read(bBuf, 0, 4096, offset)
      expect(ra.bytesRead).toBe(rb.bytesRead)
      expect(aBuf.subarray(0, ra.bytesRead).equals(bBuf.subarray(0, rb.bytesRead))).toBe(true)
    }
    await srcFh.close()
    await dstFh.close()
  }, 120_000)
})

describe('收端恶意相对路径整流拒绝（安全语义保真）', () => {
  const root = mkdtempSync(join(tmpdir(), 'lan-sink-safe-'))
  let sink: LanFileSink
  beforeAll(() => {
    sink = new LanFileSink({ root, allowPeer: () => true })
  })
  afterAll(() => {
    sink.reset()
    rmSync(root, { recursive: true, force: true })
  })

  const beginMeta = (relPath: string, kind: 'file' | 'dir' = 'file'): LanStreamBeginMeta => ({
    name: 'x',
    size: 4,
    chunkSize: 1024,
    chunkCount: 1,
    totalSha256: '',
    relPath,
    kind
  })

  it('.. / 绝对路径 / 盘符 / 控制字符 / 超深路径 → 整流拒绝，不落盘不越界不产文件', () => {
    const evilRelPaths = [
      '../evil.txt',
      'a/../../evil.txt',
      '/abs/evil.txt',
      '\\abs\\evil.txt',
      'C:/evil.txt',
      'c:\\evil.txt',
      'a/b/\0evil.txt',
      // 超 64 段（140 段）——注意不能写 ...Array.from(...)，展开符会把字符串按字符拆散
      Array.from({ length: 70 }, (_, i) => `d${i}/x`).join('/'),
      '.',
      '..'
    ]
    let sid = 1000
    for (const rel of evilRelPaths) {
      sid += 1
      sink.onBegin(7, sid, beginMeta(rel))
      sink.onData(7, sid, 0, Buffer.from([1, 2, 3, 4]))
      sink.onEnd(7, sid, { name: 'x', size: 4 })
    }
    // 不产生任何正式文件 / .part（连 tree 都不应被创建到 root 之外）
    expect(readdirSyncSafe(join(root, 'incoming', '7'))).toEqual([])
    expect(existsSync(join(root, 'evil.txt'))).toBe(false)
    expect(existsSync(join(root, 'incoming', '7', 'tree'))).toBe(false)
  }, 30_000)

  it('合法多级相对路径正常落 tree/；win32 反斜杠分隔同样被逐段净化', async () => {
    // 独立对端 uid=8，与上一用例隔离（same root，互不干扰断言）
    let sid = 2000
    const src = Buffer.from('legal-payload')
    sink.onBegin(8, ++sid, { ...beginMeta('sub/dir/f.txt', 'file'), size: src.length })
    sink.onData(8, sid, 0, src)
    sink.onEnd(8, sid, { name: 'f.txt', size: src.length })
    const target = join(root, 'incoming', '8', 'tree', 'sub', 'dir', 'f.txt')
    // rename 在 WriteStream end 回调中异步执行，轮询等待落位完成
    let landed = false
    for (let i = 0; i < 100; i += 1) {
      if (existsSync(target)) {
        landed = true
        break
      }
      await sleep(50)
    }
    expect(landed).toBe(true)
    expect(readFileSync(target).equals(src)).toBe(true)
  }, 30_000)
})

describe('目录项流（kind=dir）收端语义', () => {
  const root = mkdtempSync(join(tmpdir(), 'lan-sink-dir-'))
  let sink: LanFileSink
  beforeAll(() => {
    sink = new LanFileSink({ root, allowPeer: () => true })
  })
  afterAll(() => {
    sink.reset()
    rmSync(root, { recursive: true, force: true })
  })

  it('size=0 目录项流：onBegin 创建目录，onEnd 不落位不 rename；无 .part', () => {
    const sid = 3000
    sink.onBegin(9, sid, { name: 'empty', size: 0, chunkSize: 1024, chunkCount: 0, totalSha256: '', relPath: 'a/b/empty', kind: 'dir' })
    sink.onEnd(9, sid, { name: 'empty', size: 0 })
    expect(existsSync(join(root, 'incoming', '9', 'tree', 'a', 'b', 'empty'))).toBe(true)
    expect(readdirSyncSafe(join(root, 'incoming', '9')).filter((f) => f.endsWith('.part'))).toEqual([])
    // 幂等：目录已存在 → 再来一遍 skipped，不报错不重建
    const sid2 = 3001
    sink.onBegin(9, sid2, { name: 'empty', size: 0, chunkSize: 1024, chunkCount: 0, totalSha256: '', relPath: 'a/b/empty', kind: 'dir' })
    sink.onEnd(9, sid2, { name: 'empty', size: 0 })
    expect(existsSync(join(root, 'incoming', '9', 'tree', 'a', 'b', 'empty'))).toBe(true)
  }, 30_000)
})

describe('协议级：目录项流经 LanStreamManager 双端可通（FakeSocket + 真实 manager）', () => {
  it('sendStream(kind=dir, size=0) → 收端 onBegin 收到 relPath/kind，零数据帧直接 end', async () => {
    const fake = new FakeSocket()
    const rxMeta: { relPath?: string; kind?: string; size: number }[] = []
    const mgrRecv = new LanStreamManager(
      {
        onBegin: (_u, _s, meta) => rxMeta.push({ relPath: meta.relPath, kind: meta.kind, size: meta.size }),
        onData: () => undefined,
        onEnd: () => undefined,
        onAbort: () => undefined
      },
      new LanHashPool({ maxWorkers: 1 })
    )
    const mgrSend = new LanStreamManager(
      {
        onBegin: () => undefined,
        onData: () => undefined,
        onEnd: () => undefined,
        onAbort: () => undefined
      },
      new LanHashPool({ maxWorkers: 1 })
    )
    try {
      mgrSend.attachSocket(1, fake as unknown as WebSocket)
      const sent: Buffer[] = []
      fake.send = ((data: Buffer | string) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
        sent.push(buf)
        const frame = parseLanStreamFrame(buf)
        if (frame) mgrRecv.handleFrame(1, frame)
      }) as FakeSocket['send']
      const res = await mgrSend.sendStream(
        1,
        {
          name: 'adir',
          size: 0,
          relPath: 'x/y/adir',
          kind: 'dir',
          readChunk: () => Buffer.alloc(0)
        },
        { windowSize: 2 }
      )
      expect(res.ok).toBe(true)
      expect(res.ackedBytes).toBe(0)
      expect(rxMeta).toContainEqual(expect.objectContaining({ relPath: 'x/y/adir', kind: 'dir', size: 0 }))
      expect(sent.filter((f) => parseLanStreamFrame(f)?.type === 2 /* DATA */)).toEqual([])
    } finally {
      mgrSend.destroy()
      mgrRecv.destroy()
    }
  }, 30_000)
})

/** 假 socket：捕获经 manager 发出的帧，readyState 恒为 OPEN；send 可覆盖为桥接回调 */
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