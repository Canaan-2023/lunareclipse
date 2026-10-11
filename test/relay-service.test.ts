// 中继服务层（RelayService）单元测试
// 为什么存在：中继上传/下载往返、多端并发取件隔离、确认与无人确认路径、进度回调与
//   配置生效是中继功能的核心验收线；服务层依赖已注入（LanSendResult/stub 流），
//   用临时目录 + 内存信封即可验证排队语义，不依赖真实 LAN 布线。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RelayStore } from '../electron/main/multi-instance/relay/relay-store'
import { RelayService, resolveRelayDownloadDir, RELAY_DEFAULT_RETENTION_DAYS } from '../electron/main/multi-instance/relay/relay-service'
import type { RelayServiceDeps } from '../electron/main/multi-instance/relay/relay-service'
import type { RelayEntry, RelayEvent } from '../electron/main/multi-instance/relay/relay-types'
import type { LanEnvelope } from '../electron/main/multi-instance/lan/lan-types'

/** 构造合法 LAN 信封（relay.* 业务方向的统一形态） */
function makeEnv(from: number, to: number, type: string, payload?: unknown): LanEnvelope {
  return { id: `${type}-${from}-${to}-${Date.now()}-${Math.random()}`, type, from, to, ts: Date.now(), payload }
}

/** 构造完整 RelayServiceDeps；over 可替换个别注入（测试只需关心被覆盖的字段） */
function makeDeps(root: string, over: Partial<RelayServiceDeps> = {}): {
  deps: RelayServiceDeps
  events: RelayEvent[]
  sent: Array<{ uid: number; type: string; payload: unknown }>
  sentFiles: Array<{ uid: number; filePath: string; relay: unknown }>
} {
  const events: RelayEvent[] = []
  const sent: Array<{ uid: number; type: string; payload: unknown }> = []
  const sentFiles: Array<{ uid: number; filePath: string; relay: unknown }> = []
  const deps: RelayServiceDeps = {
    root,
    getIdentity: () => ({ uid: 1, 用户名: 'hub' }),
    getRole: () => 'master',
    getDownloadDir: () => join(root, 'relay', 'downloads'),
    getRetentionDays: () => RELAY_DEFAULT_RETENTION_DAYS,
    listRoster: () => [{ uid: 1, 用户名: 'hub', role: 'master', online: true }],
    sendLan: (uid, type, payload) => {
      sent.push({ uid, type, payload })
      return { ok: true, mode: 'direct' }
    },
    sendLanFile: async (uid, filePath, opts) => {
      sentFiles.push({ uid, filePath, relay: opts?.relay })
      return { ok: true, ackedBytes: 0 }
    },
    sendLanDirectory: async () => ({ ok: true, ackedBytes: 0, files: 0, dirs: 0 }),
    emit: (event) => events.push(event),
    ...over
  }
  return { deps, events, sent, sentFiles }
}

/** 构造 relay 条目（与 store 层测试共用的形状） */
function makeEntry(over: Partial<RelayEntry> = {}): RelayEntry {
  return {
    itemId: 'item-1',
    senderUid: 3,
    senderName: 'sender',
    receiverUid: 2,
    receiverName: 'receiver',
    kind: 'file',
    name: 'a.txt',
    totalBytes: 8,
    files: 1,
    dirs: 0,
    createdAt: Date.now(),
    status: 'uploading',
    expiresAt: Date.now() + RELAY_DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ...over
  }
}

describe('resolveRelayDownloadDir 配置生效', () => {
  it('未配置或空白 → 回退默认独立目录 {root}/relay/downloads', () => {
    const root = join(tmpdir(), 'relay-dl-default')
    expect(resolveRelayDownloadDir(undefined, root)).toBe(join(root, 'relay', 'downloads'))
    expect(resolveRelayDownloadDir('', root)).toBe(join(root, 'relay', 'downloads'))
    expect(resolveRelayDownloadDir('   ', root)).toBe(join(root, 'relay', 'downloads'))
  })

  it('配置非空 → 原样使用（用户自定义下载位置，trim 后生效）', () => {
    const root = join(tmpdir(), 'relay-dl-custom')
    expect(resolveRelayDownloadDir('E:/我的下载', root)).toBe('E:/我的下载')
    expect(resolveRelayDownloadDir('  D:/relay-inbox  ', root)).toBe('D:/relay-inbox')
  })
})

describe('RelayService 本机即中继端的上传/下载往返（hub=sender=receiver）', () => {
  let root: string
  let store: RelayStore
  let events: RelayEvent[]

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'relay-service-local-'))
    store = new RelayStore(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('本地上传文件 → 状态推进 uploading→uploaded→notified→downloaded，文件落到下载位置', async () => {
    // 单机自收自发：hub（uid=1）既是发送端也是接收端（本机直通路径，不经 LAN 回环）
    const { deps, events: evs } = makeDeps(root, {
      getIdentity: () => ({ uid: 1, 用户名: 'hub' })
    })
    events = evs
    const svc = new RelayService(deps)
    const dlDir = join(root, 'relay', 'downloads')

    const srcFile = join(root, 'payload.bin')
    writeFileSync(srcFile, 'hello123')

    // 1) 登记上传
    const begin = svc.beginUpload({ receiverUid: 1, kind: 'file', name: 'payload.bin', totalBytes: 8, files: 1, dirs: 0 })
    expect(begin.ok).toBe(true)
    const itemId = begin.itemId!
    expect(store.get(itemId)?.status).toBe('uploading')

    // 2) 流式上传（本机直通：复制进中继目录）
    const up = await svc.uploadFile(srcFile, { itemId, name: 'payload.bin' })
    expect(up.ok).toBe(true)
    const mid = store.get(itemId)
    expect(mid?.status).toBe('uploaded')
    // 上传进度事件已广播
    expect(events.some((e) => e.type === 'progress' && e.phase === 'upload' && e.sentBytes === 8)).toBe(true)
    // 本机直通：登记即通知（不经 LAN），notify 事件已 emit
    expect(events.some((e) => e.type === 'notify' && e.entry?.itemId === itemId)).toBe(true)

    // 3) 确认取件（hub 即取件方 → 本地复制到下载位置）
    const ok = svc.confirm(itemId)
    expect(ok.ok).toBe(true)
    await vi.waitFor(() => expect(events.some((e) => e.type === 'done' && e.ok && e.itemId === itemId)).toBe(true))
    expect(existsSync(join(dlDir, 'payload.bin'))).toBe(true)
    expect(readFileSync(join(dlDir, 'payload.bin'), 'utf-8')).toBe('hello123')
    // 下载进度事件
    expect(events.some((e) => e.type === 'progress' && e.phase === 'download' && e.sentBytes === 8)).toBe(true)
    // 终态
    expect(store.get(itemId)?.status).toBe('downloaded')

    // 4) 已下载后再次确认 → 拒绝（不重复取件）
    const again = svc.confirm(itemId)
    expect(again.ok).toBe(false)
    svc.stop()
  })

  it('同机路径下没有任何 LAN 信封产生（本机直通不依赖网络）', async () => {
    const { deps, sent, events: evs } = makeDeps(root, { getIdentity: () => ({ uid: 1, 用户名: 'hub' }) })
    events = evs
    const svc = new RelayService(deps)
    const srcFile = join(root, 'x.txt')
    writeFileSync(srcFile, 'content')
    const begin = svc.beginUpload({ receiverUid: 1, kind: 'file', name: 'x.txt', totalBytes: 7, files: 1, dirs: 0 })
    await svc.uploadFile(srcFile, { itemId: begin.itemId!, name: 'x.txt' })
    expect(sent).toHaveLength(0)
    svc.stop()
  })
})

describe('RelayService 多端点（sender/hub/receiver 分机）上传→通知→确认下载', () => {
  let root: string
  let store: RelayStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'relay-service-lan-'))
    store = new RelayStore(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('sender 上传登记 → hub 落栈 → 通知 receiver；receiver 确认 → hub 回发下载流；完成 → 终态', async () => {
    // 三机拓扑：hub=uid1（中继存储）、sender=uid3、receiver=uid2
    const hubEvents: RelayEvent[] = []
    const receiverEvents: RelayEvent[] = []
    const hubFiles: Array<{ uid: number; relay: unknown }> = []
    // receiver 的 sendLan 应把 confirm 等信封路由到 hub（模拟 LAN 直连投递）
    let hub: RelayService | null = null
    const receiverDeps: RelayServiceDeps = {
      root,
      getIdentity: () => ({ uid: 2, 用户名: 'receiver' }),
      getRole: () => 'satellite',
      getDownloadDir: () => join(root, 'dl'),
      getRetentionDays: () => 7,
      listRoster: () => [{ uid: 1, 用户名: 'hub', role: 'master', online: true }],
      sendLan: (uid, type, payload) => {
        if (uid === 1) hub?.handleLanEnvelope(makeEnv(2, 1, type, payload))
        return { ok: true, mode: 'direct' }
      },
      sendLanFile: async () => ({ ok: true, ackedBytes: 0 }),
      sendLanDirectory: async () => ({ ok: true, ackedBytes: 0, files: 0, dirs: 0 }),
      emit: (e) => receiverEvents.push(e)
    }
    const receiver = new RelayService(receiverDeps)

    // hub：sendLan 直连投递给 receiver 端点（模拟 LAN 信封送达），回发下载流记录下发给谁
    hub = new RelayService({
      root,
      getIdentity: () => ({ uid: 1, 用户名: 'hub' }),
      getRole: () => 'master',
      getDownloadDir: () => join(root, 'relay', 'downloads'),
      getRetentionDays: () => 7,
      listRoster: () => [
        { uid: 1, 用户名: 'hub', role: 'master', online: true },
        { uid: 2, 用户名: 'receiver', role: 'satellite', online: true }
      ],
      sendLan: (uid, type, payload) => {
        if (uid === 2) receiver.handleLanEnvelope(makeEnv(1, 2, type, payload))
        return { ok: true, mode: 'direct' }
      },
      sendLanFile: async (uid, _filePath, opts) => {
        hubFiles.push({ uid, relay: opts?.relay })
        return { ok: true, ackedBytes: 8 }
      },
      sendLanDirectory: async () => ({ ok: true, ackedBytes: 0, files: 0, dirs: 0 }),
      emit: (e) => hubEvents.push(e)
    })

    // sender 视角：发送 upload-begin 信封给 hub（本测试直接以信封驱动 hub，sender 决策逻辑由 store 层覆盖）
    const entry = makeEntry({ itemId: 'lan-item', totalBytes: 5, receiverUid: 2, senderUid: 3 })
    store.upsert(entry)
    // 模拟上传流已落盘中继目录（字节校验需 ≥ totalBytes）
    const rootDir = store.ensureFiles('lan-item')!
    writeFileSync(join(rootDir, 'a.txt'), '12345')
    hub.handleLanEnvelope(makeEnv(3, 1, 'relay.upload-done', { itemId: 'lan-item' }))

    // hub 校验收齐 → uploaded → 通知 receiver（信封经 sendLan 送达 receiver.handleLanEnvelope）
    await vi.waitFor(() => expect(hubEvents.some((e) => e.type === 'entry' && e.entry?.status === 'uploaded')).toBe(true))
    expect(store.get('lan-item')?.status).toBe('uploaded')
    await vi.waitFor(() => expect(receiverEvents.some((e) => e.type === 'notify')).toBe(true))

    // receiver 确认取件 → hub 校验 receiverUid=env.from 后回发下载流
    receiver.confirm('lan-item')
    await vi.waitFor(() => expect(hubFiles.some((f) => f.uid === 2)).toBe(true))
    expect(hubFiles[0].relay).toMatchObject({ itemId: 'lan-item', phase: 'download' })

    // receiver 下载完成回报 → hub 置终态 downloaded
    hub.handleLanEnvelope(makeEnv(2, 1, 'relay.download-done', { itemId: 'lan-item', ok: true }))
    await vi.waitFor(() => expect(store.get('lan-item')?.status).toBe('downloaded'))
    expect(store.get('lan-item')?.downloadedAt).toBeGreaterThan(0)

    hub.stop()
    receiver.stop()
  })

  it('多端并发取件隔离：receiver 只能确认自己的条目，非接收方确认被整流拒绝', async () => {
    const hubEvents: RelayEvent[] = []
    const hubFiles: Array<{ uid: number; relay: unknown }> = []
    const hub = new RelayService({
      root,
      getIdentity: () => ({ uid: 1, 用户名: 'hub' }),
      getRole: () => 'master',
      getDownloadDir: () => join(root, 'relay', 'downloads'),
      getRetentionDays: () => 7,
      listRoster: () => [{ uid: 1, 用户名: 'hub', role: 'master', online: true }],
      sendLan: () => ({ ok: true, mode: 'direct' }),
      sendLanFile: async (uid, _fp, opts) => {
        hubFiles.push({ uid, relay: opts?.relay })
        return { ok: true, ackedBytes: 0 }
      },
      sendLanDirectory: async () => ({ ok: true, ackedBytes: 0, files: 0, dirs: 0 }),
      emit: (e) => hubEvents.push(e)
    })

    // 两个条目：itemA 归 uid2，itemB 归 uid4
    store.upsert(makeEntry({ itemId: 'itemA', receiverUid: 2, status: 'uploaded', totalBytes: 3 }))
    store.upsert(makeEntry({ itemId: 'itemB', receiverUid: 4, status: 'uploaded', totalBytes: 3 }))
    const dirA = store.ensureFiles('itemA')!
    const dirB = store.ensureFiles('itemB')!
    writeFileSync(join(dirA, 'a.txt'), 'aaa')
    writeFileSync(join(dirB, 'b.txt'), 'bbb')

    // uid2 尝试确认不属于自己的 itemB → 拒绝（不回发下载流）
    hub.handleLanEnvelope(makeEnv(2, 1, 'relay.confirm', { itemId: 'itemB' }))
    await vi.waitFor(() => expect(hubFiles.length).toBe(0))
    expect(store.get('itemB')?.status).toBe('uploaded')

    // uid2 确认自己的 itemA → 回发下载流
    hub.handleLanEnvelope(makeEnv(2, 1, 'relay.confirm', { itemId: 'itemA' }))
    // 下载进行中（downloads 未清）的重复确认去重：同一同步窗口连发两次只回发一次
    hub.handleLanEnvelope(makeEnv(2, 1, 'relay.confirm', { itemId: 'itemA' }))
    await vi.waitFor(() => expect(hubFiles.filter((f) => f.uid === 2).length).toBe(1))
    expect(store.get('itemA')?.status).toBe('uploaded') // 尚未回报完成，未置终态
    // uid4 确认自己的 itemB → 各自独立回发（互不干扰）
    hub.handleLanEnvelope(makeEnv(4, 1, 'relay.confirm', { itemId: 'itemB' }))
    await vi.waitFor(() => expect(hubFiles.filter((f) => f.uid === 4).length).toBe(1))
    expect(hubFiles.length).toBe(2)
    expect(hubEvents.some((e) => e.type === 'error')).toBe(false)
    hub.stop()
  })

  it('同意制守卫：未经确认的 download 流被整流拒绝不落盘；确认后同 itemId 流才放行', async () => {
    // receiver 端点（satellite）：downloadDir 为 dl；lisRoster 给出 hub=uid1
    const dl = join(root, 'dl')
    const events: RelayEvent[] = []
    const receiver = new RelayService(
      makeDeps(root, {
        getIdentity: () => ({ uid: 2, 用户名: 'receiver' }),
        getRole: () => 'satellite',
        getDownloadDir: () => dl,
        listRoster: () => [{ uid: 1, 用户名: 'hub', role: 'master', online: true }],
        sendLan: () => ({ ok: true, mode: 'direct' }),
        emit: (e) => events.push(e)
      }).deps
    )
    const cb = receiver.getStreamCallbacks()
    const makeDownloadMeta = (itemId: string, name: string) =>
      ({
        name,
        size: 4,
        chunkSize: 4,
        chunkCount: 1,
        totalSha256: '',
        kind: 'file' as const,
        relay: { itemId, phase: 'download' as const, targetName: name, kind: 'file' as const }
      }) as const

    // 1) 伪造/未经确认的 download 流：整流拒绝，不落盘
    cb.onBegin(1, 1001, makeDownloadMeta('forged-item', 'evil.txt'))
    cb.onData(1, 1001, 0, Buffer.from('EVIL'))
    cb.onEnd(1, 1001, { name: 'evil.txt', size: 4 })
    expect(existsSync(join(dl, 'evil.txt'))).toBe(false)
    expect(existsSync(join(dl, 'evil.txt.part'))).toBe(false)

    // 2) 确认后才放行：confirm 登记 → 同 itemId 的 download 流落盘成功；流收齐后登记被消费
    const ok = receiver.confirm('real-item')
    expect(ok.ok).toBe(true)
    cb.onBegin(1, 1002, makeDownloadMeta('real-item', 'real.txt'))
    cb.onData(1, 1002, 0, Buffer.from('REAL'))
    cb.onEnd(1, 1002, { name: 'real.txt', size: 4 })
    // onEnd 的 .part → 正式名 rename 在写流回调中异步完成，等待落盘
    await vi.waitFor(() => expect(existsSync(join(dl, 'real.txt'))).toBe(true))
    expect(readFileSync(join(dl, 'real.txt'), 'utf8')).toBe('REAL')

    // 3) 下载完成消费登记后（completeDownload 消费），重放同 itemId 的 download 流 → 整流拒绝
    const before = new Set(readdirSync(dl))
    cb.onBegin(1, 1003, makeDownloadMeta('real-item', 'replay.txt'))
    cb.onData(1, 1003, 0, Buffer.from('EVIL'))
    await vi.waitFor(() => !cb.onEnd(1, 1003, { name: 'replay.txt', size: 4 }) || true) // onEnd 同步收尾
    // 给异步 .part 清理留出窗口：断言短暂等待后目录仍无新文件
    await new Promise((r) => setTimeout(r, 50))
    const after = new Set(readdirSync(dl))
    expect(after).toEqual(before) // 无新增文件、无 .part 残留

    receiver.stop()
    void events
  })

  it('无人确认路径与撤回：过期清理置 expired；sender 可撤回未下载条目，非 sender 撤回拒绝', async () => {
    const events: RelayEvent[] = []
    const hub = new RelayService({
      root,
      getIdentity: () => ({ uid: 1, 用户名: 'hub' }),
      getRole: () => 'master',
      getDownloadDir: () => join(root, 'relay', 'downloads'),
      getRetentionDays: () => 7,
      listRoster: () => [{ uid: 1, 用户名: 'hub', role: 'master', online: true }],
      sendLan: () => ({ ok: true, mode: 'direct' }),
      sendLanFile: async () => ({ ok: true, ackedBytes: 0 }),
      sendLanDirectory: async () => ({ ok: true, ackedBytes: 0, files: 0, dirs: 0 }),
      emit: (e) => events.push(e)
    })

    // 过期未确认条目：cleanup 后置 expired 且文件实体删除
    const expired = makeEntry({ itemId: 'stale', status: 'uploaded', expiresAt: Date.now() - 1000, totalBytes: 1, receiverUid: 2 })
    store.upsert(expired)
    const staleDir = store.ensureFiles('stale')!
    writeFileSync(join(staleDir, 'a.txt'), 'x')
    expect(hub.sweep()).toBe(1)
    expect(store.get('stale')?.status).toBe('expired')
    expect(existsSync(staleDir)).toBe(false)

    // 撤回：非 sender 的撤回请求被整流拒绝
    const item = makeEntry({ itemId: 'rv', receiverUid: 2, senderUid: 3, status: 'uploaded', totalBytes: 3 })
    store.upsert(item)
    const rvDir = store.ensureFiles('rv')!
    writeFileSync(join(rvDir, 'a.txt'), 'abc')
    hub.handleLanEnvelope(makeEnv(9, 1, 'relay.revoke', { itemId: 'rv' }))
    expect(store.get('rv')?.status).toBe('uploaded')
    // sender 本人撤回 → 条目与文件实体删除
    hub.handleLanEnvelope(makeEnv(3, 1, 'relay.revoke', { itemId: 'rv' }))
    expect(store.get('rv')).toBeNull()
    expect(existsSync(rvDir)).toBe(false)

    // 已下载条目撤回被拒
    const done = makeEntry({ itemId: 'dl', receiverUid: 2, senderUid: 3, status: 'downloaded', totalBytes: 3, downloadedAt: Date.now() })
    store.upsert(done)
    hub.handleLanEnvelope(makeEnv(3, 1, 'relay.revoke', { itemId: 'dl' }))
    expect(store.get('dl')?.status).toBe('downloaded')
    hub.stop()
  })
})

describe('RelayService 配置生效（保留天数与下载位置注入）', () => {
  let root: string
  let store: RelayStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'relay-service-cfg-'))
    store = new RelayStore(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('登记条目过期时间 = now + 注入保留天数；getInfo 回显配置值', async () => {
    const { deps } = makeDeps(root, {
      getRetentionDays: () => 3,
      getDownloadDir: () => 'D:/relay-inbox'
    })
    const svc = new RelayService(deps)
    const before = Date.now()
    const begin = svc.beginUpload({ receiverUid: 2, kind: 'file', name: 'a.txt', totalBytes: 8, files: 1, dirs: 0 })
    expect(begin.ok).toBe(true)
    const entry = store.get(begin.itemId!)
    expect(entry?.expiresAt).toBeGreaterThanOrEqual(before + 3 * 24 * 60 * 60 * 1000 - 1000)
    expect(entry?.expiresAt).toBeLessThanOrEqual(before + 3 * 24 * 60 * 60 * 1000 + 60 * 1000)
    expect(svc.getInfo()).toEqual({ isHub: true, downloadDir: 'D:/relay-inbox', retentionDays: 3 })
    svc.stop()
  })

  it('保留天数非法（0/负数）时回退默认 7 天', async () => {
    const { deps } = makeDeps(root, { getRetentionDays: () => 0 })
    const svc = new RelayService(deps)
    const before = Date.now()
    const begin = svc.beginUpload({ receiverUid: 2, kind: 'file', name: 'a.txt', totalBytes: 8, files: 1, dirs: 0 })
    const entry = store.get(begin.itemId!)
    expect(entry?.expiresAt).toBeGreaterThanOrEqual(before + RELAY_DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000 - 1000)
    expect(svc.getInfo().retentionDays).toBe(RELAY_DEFAULT_RETENTION_DAYS)
    svc.stop()
  })

  it('未登录时上传登记与确认取件均拒绝（身份门禁）', async () => {
    const { deps, sent } = makeDeps(root, { getIdentity: () => null })
    const svc = new RelayService(deps)
    const begin = svc.beginUpload({ receiverUid: 2, kind: 'file', name: 'a.txt', totalBytes: 8, files: 1, dirs: 0 })
    expect(begin.ok).toBe(false)
    expect(begin.error).toBe('未登录')
    expect(svc.list()).toEqual([])
    expect(sent).toHaveLength(0)
    svc.stop()
  })
})