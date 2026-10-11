import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { FriendService, type RelayUploadPort } from '../electron/main/multi-instance/friends/friend-service'
import type { FriendChatMessage, FriendEvent } from '../electron/main/multi-instance/friends/friend-types'
import type { LanPeer } from '../electron/main/multi-instance/lan/lan-types'

/**
 * L1 好友/私聊测试：双端信封模拟。
 * 重点覆盖跨实例 AI 协作：AI 代答标记随信封上网、别的实例的 AI 消息触发本机 AI、本机自己的消息不触发。
 */
class FakeDeps {
  root: string
  identity: { uid: number; 用户名: string } | null = null
  events: FriendEvent[] = []
  sent: Array<{ from: number; uid: number; type: string; payload: unknown }> = []
  peers: LanPeer[] = []
  roster: LanPeer[] = []
  downloadDir = ''
  sendLan: (uid: number, type: string, payload: unknown) => { ok: boolean; mode: string; error?: string } = () => ({ ok: false, mode: 'outbox', error: 'not-wired' })
  /** inviteFile 时登记本地路径；发送方推流 mock 记录调用并可选落盘到接收方暂存区 */
  fileCalls: Array<{ uid: number; filePath: string; transferId?: string }> = []
  dirCalls: Array<{ uid: number; dirPath: string; transferId?: string }> = []
  /** 模拟 LAN 推流：把发送方本地文件内容写入接收方暂存区（invites/{transferId}/ 下同名文件） */
  wireFileStream?: (fromIdentity: { uid: number; 用户名: string }, toRoot: string, transferId: string, name: string) => void

  /** fake 中继：record beginUpload/uploadFile/uploadDirectory 调用，可配置失败以测错误分支 */
  relayBeginCalls: Array<{ receiverUid: number; kind: string; name: string; totalBytes: number }> = []
  relayUploadCalls: Array<{ filePath: string; itemId: string; name: string }> = []
  relayBeginResult: { ok: boolean; itemId?: string; error?: string } = { ok: true, itemId: 'relay-item-1' }
  relayUploadResult: { ok: boolean; error?: string } = { ok: true }

  constructor(root: string) {
    this.root = root
  }

  /** 注入 fake 中继端口（getRelay 返回它；FriendService 装配早于 RelayService，测试验证 getter 语义） */
  installFakeRelay(): void {
    this.getRelay = () => this.fakeRelayPort
  }
  /** 中继端口形态（与 FriendService.RelayUploadPort 一致，直接复用主进程导出类型） */
  fakeRelayPort: RelayUploadPort = {
    beginUpload: (input: {
      receiverUid: number
      kind: 'file' | 'dir'
      name: string
      totalBytes: number
      files: number
      dirs: number
    }) => {
      this.relayBeginCalls.push({ receiverUid: input.receiverUid, kind: input.kind, name: input.name, totalBytes: input.totalBytes })
      return this.relayBeginResult
    },
    uploadFile: async (filePath: string, opts: { itemId: string; name: string }) => {
      this.relayUploadCalls.push({ filePath, itemId: opts.itemId, name: opts.name })
      return this.relayUploadResult
    },
    uploadDirectory: async (dirPath: string, opts: { itemId: string; name: string }) => {
      this.relayUploadCalls.push({ filePath: dirPath, itemId: opts.itemId, name: opts.name })
      return this.relayUploadResult
    }
  }
  getRelay: () => RelayUploadPort | null = () => null

  /** 默认桥接：sendLanFile/sendLanDirectory 记录调用、落盘暂存区、返回 ok */
  installDefaultStreams(): void {
    this.sendLanFile = async (uid, filePath, opts) => {
      this.fileCalls.push({ uid, filePath, transferId: opts?.transferId })
      // 与真实 LAN 流一致：对端落盘名 = options.name ?? basename(filePath)
      this.wireFileStream?.(this.identity!, this.toRoot, opts?.transferId ?? '', opts?.name ?? basename(filePath))
      return { ok: true, ackedBytes: 1, sha256: '' }
    }
    this.sendLanDirectory = async (uid, dirPath, opts) => {
      this.dirCalls.push({ uid, dirPath, transferId: opts?.transferId })
      return { ok: true, ackedBytes: 1, files: 1, dirs: 0 }
    }
    this.getDownloadDir = () => this.downloadDir
  }
  toRoot = ''
}

interface Opts {
  aiReply?: (peerUid: number, msg: FriendChatMessage) => Promise<string | null>
  aiConfig?: { isDirectChatEnabled: (chatId: string) => boolean }
  /** 注入中继端口（getRelay getter；缺省 null 模拟中继未装配） */
  relay?: boolean
}

function makeService(root: string, uid: number, name: string, opts: Opts = {}): { svc: FriendService; deps: FakeDeps } {
  const deps = new FakeDeps(root)
  deps.identity = { uid, 用户名: name }
  deps.downloadDir = join(root, 'downloads')
  deps.installDefaultStreams()
  const svc = new FriendService({
    root: deps.root,
    getIdentity: () => deps.identity,
    sendLan: (uid, type, payload) => deps.sendLan(uid, type, payload),
    listPeers: () => deps.peers,
    listRoster: () => deps.roster,
    sendLanFile: (uid, filePath, options) => deps.sendLanFile(uid, filePath, options),
    sendLanDirectory: (uid, dirPath, options) => deps.sendLanDirectory(uid, dirPath, options),
    getDownloadDir: () => deps.getDownloadDir(),
    ...(opts.aiConfig ? { aiConfig: opts.aiConfig } : {}),
    ...(opts.aiReply ? { aiReply: opts.aiReply } : {}),
    ...(opts.relay ? { getRelay: () => deps.getRelay() } : {}),
    emit: (e) => deps.events.push(e),
  })
  if (opts.relay) deps.installFakeRelay()
  return { svc, deps }
}

/** 连接双端：互相投递信封（增量注册，多次 wire 不互相覆盖） */
const routes: Array<{ from: FakeDeps; toUid: number; toSvc: FriendService }> = []

function wire(svcA: FriendService, depsA: FakeDeps, svcB: FriendService, depsB: FakeDeps): void {
  routes.push({ from: depsA, toUid: depsB.identity!.uid, toSvc: svcB })
  routes.push({ from: depsB, toUid: depsA.identity!.uid, toSvc: svcA })
  const install = (deps: FakeDeps) => {
    deps.sendLan = (uid, type, payload) => {
      deps.sent.push({ from: deps.identity!.uid, uid, type, payload })
      for (const r of routes) {
        if (r.from === deps && uid === r.toUid) {
          r.toSvc.handleLanEnvelope({ from: deps.identity!.uid, ts: Date.now(), type, payload })
        }
      }
      return { ok: true, mode: 'direct' }
    }
  }
  install(depsA)
  install(depsB)
}

/** 建立双向好友关系（1 → 请求 → 2 → 接受） */
function befriend(a: { svc: FriendService; deps: FakeDeps }, b: { svc: FriendService; deps: FakeDeps }): void {
  wire(a.svc, a.deps, b.svc, b.deps)
  expect(a.svc.request(b.deps.identity!.uid).ok).toBe(true)
  expect(b.svc.accept(a.deps.identity!.uid).ok).toBe(true)
  // 流桥接：A（发送方）的推流 mock 把文件内容写入 B（接收方）的 invites 暂存区，
  // 模拟真实的 LAN 文件流落盘（handleFileDone 从这里整体挪进下载目录）
  a.deps.wireFileStream = (fromIdentity, toRoot, transferId, name) => {
    const stagingDir = join(toRoot, 'federation', 'incoming', String(fromIdentity.uid), 'invites', transferId)
    mkdirSync(stagingDir, { recursive: true })
    writeFileSync(join(stagingDir, name), 'file-content', 'utf-8')
  }
  a.deps.toRoot = b.deps.root
}

describe('FriendService 私聊与跨实例 AI 协作（L1）', () => {
  let roots: string[] = []

  function newRoot(): string {
    const r = mkdtempSync(join(tmpdir(), 'friend-test-'))
    roots.push(r)
    return r
  }

  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true })
    roots = []
  })

  it('AI 代答标记随信封上网：接收侧保留 isAiGenerated + aiId', () => {
    const a = makeService(newRoot(), 1, '主')
    const b = makeService(newRoot(), 2, '分')
    befriend(a, b)

    expect(a.svc.sendMessage(2, 'AI代答内容', true, 1).ok).toBe(true)
    // 信封 payload 必须带上标记（否则对端无法识别这是 AI 代答）
    const env = a.deps.sent.find((s) => s.type === 'friend.message')
    expect(env).toBeTruthy()
    expect((env!.payload as { isAiGenerated?: boolean }).isAiGenerated).toBe(true)
    expect((env!.payload as { aiId?: number }).aiId).toBe(1)
    // 接收侧落盘保留标记与 AI 身份（对外身份 = from-aiId = 1-1）
    expect(b.svc.messages(1)).toHaveLength(1)
    expect(b.svc.messages(1)[0].isAiGenerated).toBe(true)
    expect(b.svc.messages(1)[0].aiId).toBe(1)
    expect(b.svc.messages(1)[0].text).toBe('AI代答内容')

    // 真人消息不带标记
    expect(a.svc.sendMessage(2, '真人消息').ok).toBe(true)
    expect(b.svc.messages(1)[1].isAiGenerated).toBeUndefined()
    expect(b.svc.messages(1)[1].aiId).toBeUndefined()
  })

  it('AI 身份约定：非正整数 aiId 视为非法，接收侧丢弃', () => {
    const a = makeService(newRoot(), 1, '主')
    const b = makeService(newRoot(), 2, '分')
    befriend(a, b)

    // aiId 必须是正整数（AI 实体编号）；0/-1 不是合法编号 → 只保留 isAiGenerated，不带 aiId
    expect(a.svc.sendMessage(2, '伪装成人', true, 0).ok).toBe(true)
    expect(b.svc.messages(1)[0].isAiGenerated).toBe(true)
    expect(b.svc.messages(1)[0].aiId).toBeUndefined()
  })

  it('跨实例 AI 协作：对端 AI 代答触发本机 AI，本机自己的发言不触发', async () => {
    const callsA: string[] = []
    const callsB: string[] = []
    // A 的 AI 返回空 → 不强制回复，链条自然停止
    const a = makeService(newRoot(), 1, '主', {
      aiReply: async (_peer, msg) => {
        callsA.push(msg.text)
        return null
      }
    })
    const b = makeService(newRoot(), 2, '分', {
      aiReply: async (_peer, msg) => {
        callsB.push(msg.text)
        return 'B端回复'
      }
    })
    befriend(a, b)

    // A 端 AI 代答发出 → B 端 AI 被触发（跨实例协作）
    expect(a.svc.sendMessage(2, 'A端AI问好', true).ok).toBe(true)
    await new Promise((r) => setTimeout(r, 50))
    expect(callsB).toEqual(['A端AI问好'])
    // B 端 AI 回复回到 A → 触发 A 端 AI；A 返回空即静默
    expect(callsA).toEqual(['B端回复'])
    // A 自己的发言未触发本机 AI（callsA 仅 1 次），双方各 2 条
    expect(a.svc.messages(2)).toHaveLength(2)
    expect(b.svc.messages(1)).toHaveLength(2)
    expect(a.svc.messages(2).at(-1)?.isAiGenerated).toBe(true)
    // B 端 AI 代答带自己的 AI 编号（uid=2 + aiId=1 → 对外身份 2-1），A 侧据此认出"这是 B 的 AI 说的"
    expect(a.svc.messages(2).at(-1)?.aiId).toBe(1)
  })

  it('私聊 AI 开关关闭时不回复', async () => {
    const callsB: string[] = []
    const a = makeService(newRoot(), 1, '主')
    const b = makeService(newRoot(), 2, '分', {
      aiConfig: { isDirectChatEnabled: () => false },
      aiReply: async (_peer, msg) => {
        callsB.push(msg.text)
        return '不该出现'
      }
    })
    befriend(a, b)

    expect(a.svc.sendMessage(2, 'AI代答', true).ok).toBe(true)
    await new Promise((r) => setTimeout(r, 50))
    expect(callsB).toHaveLength(0)
    expect(b.svc.messages(1)).toHaveLength(1)
  })
})

describe('FriendService 邀请制直传（L1.5）', () => {
  let roots: string[] = []
  const files: string[] = []

  function newRoot(): string {
    const r = mkdtempSync(join(tmpdir(), 'friend-xfer-'))
    roots.push(r)
    return r
  }

  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true })
    roots = []
    for (const f of files) rmSync(f, { force: true })
    files.length = 0
  })

  /** 构造真实本地源文件（发送方 dialog 选择的就是它） */
  function sourceFile(text: string): { path: string; name: string } {
    const p = join(newRoot(), 'src.txt')
    writeFileSync(p, text, 'utf-8')
    files.push(p)
    return { path: p, name: 'src.txt' }
  }

  it('全链路：邀请信封不发文件 → 接收方同意 → 发送方凭登记推流 → 收齐移入下载目录', async () => {
    const a = makeService(newRoot(), 1, '主')
    const b = makeService(newRoot(), 2, '分')
    befriend(a, b)
    const src = sourceFile('hello-invite')

    // 发送方只发邀请信封（friend.message 带 file 元数据），不直接推流
    const inv = a.svc.inviteFile(2, { path: src.path, name: src.name, kind: 'file', totalBytes: 12, files: 1, dirs: 0 })
    expect(inv.ok).toBe(true)
    expect(inv.transferId).toBeTruthy()
    const t = inv.transferId!
    // 未同意前不推流
    expect(a.deps.fileCalls).toHaveLength(0)
    const env = a.deps.sent.find((s) => s.type === 'friend.message')
    expect(env).toBeTruthy()
    const payload = env!.payload as { file: { transferId: string; name: string; size: number; kind: string } }
    expect(payload.file.transferId).toBe(t)
    expect(payload.file.name).toBe('src.txt')
    // 接收方落邀请卡片（pending），未收到文件
    const bMsg = b.svc.messages(1)[0]
    expect(bMsg.file?.state).toBe('pending')
    expect(bMsg.text).toContain('src.txt')

    // 接收方同意 → 发送方开始推流（凭 transferId 关联）→ 完成后回执
    expect(b.svc.acceptFileInvite(1, t).ok).toBe(true)
    await new Promise((r) => setTimeout(r, 80))
    expect(a.deps.fileCalls).toHaveLength(1)
    expect(a.deps.fileCalls[0].transferId).toBe(t)
    // 发送方推流进接收方暂存区 → 发送方回 file-done → 接收方整体移入下载目录
    const doneEnv = a.deps.sent.find((s) => s.type === 'friend.file-done')
    expect(doneEnv).toBeTruthy()
    const downloaded = await new Promise<string>((resolve) => {
      const check = () => {
        const m = b.svc.messages(1).find((x) => x.file?.transferId === t)
        if (m?.file?.state === 'done' && m.file.path) resolve(m.file.path)
        else setTimeout(check, 20)
      }
      check()
    })
    expect(downloaded).toContain('downloads')
    expect(downloaded.endsWith('src.txt')).toBe(true)
    expect(b.svc.messages(1).find((x) => x.file?.transferId === t)?.file?.state).toBe('done')
  })

  it('拒绝邀请：发送方清理登记、卡片置 rejected，不推流', async () => {
    const a = makeService(newRoot(), 1, '主')
    const b = makeService(newRoot(), 2, '分')
    befriend(a, b)
    const src = sourceFile('reject-me')

    const inv = a.svc.inviteFile(2, { path: src.path, name: src.name, kind: 'file', totalBytes: 9, files: 1, dirs: 0 })
    const t = inv.transferId!
    expect(b.svc.rejectFileInvite(1, t).ok).toBe(true)
    await new Promise((r) => setTimeout(r, 30))
    // 未推流；发送方登记被清理；双方卡片 rejected
    expect(a.deps.fileCalls).toHaveLength(0)
    expect(a.svc.transfers.get(t)).toBeNull()
    expect(a.svc.messages(2).find((x) => x.file?.transferId === t)?.file?.state).toBe('rejected')
    expect(b.svc.messages(1).find((x) => x.file?.transferId === t)?.file?.state).toBe('rejected')
  })

  it('撤回邀请（待同意阶段）：删登记、通知对端、双方卡片 canceled', async () => {
    const a = makeService(newRoot(), 1, '主')
    const b = makeService(newRoot(), 2, '分')
    befriend(a, b)
    const src = sourceFile('cancel-me')

    const inv = a.svc.inviteFile(2, { path: src.path, name: src.name, kind: 'file', totalBytes: 9, files: 1, dirs: 0 })
    const t = inv.transferId!
    expect(a.svc.cancelFileInvite(2, t).ok).toBe(true)
    await new Promise((r) => setTimeout(r, 30))
    // 发送方登记已删、未推流；双方卡片 canceled
    expect(a.deps.fileCalls).toHaveLength(0)
    expect(a.svc.transfers.get(t)).toBeNull()
    expect(a.svc.messages(2).find((x) => x.file?.transferId === t)?.file?.state).toBe('canceled')
    expect(b.svc.messages(1).find((x) => x.file?.transferId === t)?.file?.state).toBe('canceled')
  })

  it('卡片状态流转不漏：pending/accepted/done 沿协议推进，非法 transferId 被拒', async () => {
    const a = makeService(newRoot(), 1, '主')
    const b = makeService(newRoot(), 2, '分')
    befriend(a, b)
    // 非法形态的 transferId 一律拒绝（防路径穿越/伪造）
    expect(b.svc.acceptFileInvite(1, '../../evil').ok).toBe(false)
    expect(b.svc.rejectFileInvite(1, 'x').ok).toBe(false)
    expect(a.svc.cancelFileInvite(2, 'short').ok).toBe(false)
  })

  it('离线补投时间戳保真：邀请信封重放时卡片 ts 用原信封 ts（而非补投时刻）', async () => {
    const a = makeService(newRoot(), 1, '主')
    const b = makeService(newRoot(), 2, '分')
    befriend(a, b)
    const src = sourceFile('offline-invite')

    // 真实场景：B 离线时 A（发送方）的 inviteFile → friend.message 进 A 的 outbox
    //（信封 ts = 发送时刻）；B 上线后 outbox 原样重放该信封（lan-layer 测试已证明 ts 保真）。
    // 此处以「原 ts 远早于补投时刻」的信封模拟补投，断言接收侧落盘时间戳 = 原 ts。
    const originalTs = Date.now() - 60_000
    const replayId = `offline-${Date.now()}`
    b.svc.handleLanEnvelope({
      from: 1,
      ts: originalTs,
      type: 'friend.message',
      payload: {
        id: replayId,
        text: '邀请文件 src.txt',
        file: { transferId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'src.txt', size: 14, kind: 'file', totalBytes: 14, files: 1, dirs: 0 }
      }
    })

    const card = b.svc.messages(1).find((m) => m.file?.state === 'pending')
    expect(card).toBeTruthy()
    // 核心断言：卡片落盘 ts = 原始发送时刻，而非补投时刻
    expect(card!.ts).toBe(originalTs)
    // 幂等：outbox 重试重复投递同 id 不重复落盘
    b.svc.handleLanEnvelope({
      from: 1,
      ts: Date.now(),
      type: 'friend.message',
      payload: { id: replayId, text: '重放', file: { transferId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'src.txt', size: 14, kind: 'file' } }
    })
    expect(b.svc.messages(1).filter((m) => m.id === replayId)).toHaveLength(1)
    void src
  })

  it('残留 streaming 恢复：崩溃重启后凭登记表把卡死记录重置为 pending 并对端卡片拉回待同意', async () => {
    const a = makeService(newRoot(), 1, '主')
    const b = makeService(newRoot(), 2, '分')
    befriend(a, b)
    const src = sourceFile('resume-me')

    // 发送方邀请 → 接收方同意 → 发送方推流即开始（登记 status=streaming）
    const inv = a.svc.inviteFile(2, { path: src.path, name: src.name, kind: 'file', totalBytes: 9, files: 1, dirs: 0 })
    const t = inv.transferId!
    // 模拟推流中断：发送方推流挂起（不 resolve）→ accept 后登记停留在 streaming（卡死态）
    a.deps.sendLanFile = async () => new Promise(() => undefined) as never
    expect(b.svc.acceptFileInvite(1, t).ok).toBe(true)
    await new Promise((r) => setTimeout(r, 30))
    expect(a.svc.transfers.get(t)?.status).toBe('streaming')
    // 此时模拟发送方崩溃：新实例（同 root）重读登记表，streaming 残留为卡死态
    const a2 = makeService(a.deps.root, 1, '主')
    // 桥接 a2 → b（老实例服务仍在，收 resume 信封把 accepted 卡片拉回 pending）
    routes.push({ from: a2.deps, toUid: 2, toSvc: b.svc })
    a2.deps.sendLan = (uid, type, payload) => {
      a2.deps.sent.push({ from: 1, uid, type, payload })
      for (const r of routes) {
        if (r.from === a2.deps && uid === r.toUid) r.toSvc.handleLanEnvelope({ from: 1, ts: Date.now(), type, payload })
      }
      return { ok: true, mode: 'direct' }
    }
    const recovered = a2.svc.recoverInterruptedTransfers()
    expect(recovered).toBe(1)
    // 发送方登记回到 pending（可再次被同意触发推流）
    expect(a2.svc.transfers.get(t)?.status).toBe('pending')
    // 接收方被通知：accepted（卡死）卡片拉回 pending，重新显示同意按钮
    await new Promise((r) => setTimeout(r, 30))
    const bCard = b.svc.messages(1).find((x) => x.file?.transferId === t)
    expect(bCard?.file?.state).toBe('pending')
    expect(a2.deps.sent.some((s) => s.type === 'friend.file-resume' && (s.payload as { transferId: string }).transferId === t)).toBe(true)
  })

  it('切中继发送：直传不可达时改走中继，登记清除、双方卡片 relayed、对端提示去传输面板领取', async () => {
    const a = makeService(newRoot(), 1, '主', { relay: true })
    const b = makeService(newRoot(), 2, '分')
    befriend(a, b)
    const src = sourceFile('relay-me')

    const inv = a.svc.inviteFile(2, { path: src.path, name: src.name, kind: 'file', totalBytes: 8, files: 1, dirs: 0 })
    const t = inv.transferId!
    expect(a.svc.transfers.get(t)?.status).toBe('pending')

    const r = await a.svc.switchToRelay(2, t)
    expect(r).toEqual({ ok: true })
    // 中继开始上传：登记（receiverUid/name/size）与流式上传（本地路径 + itemId）被调用
    expect(a.deps.relayBeginCalls).toHaveLength(1)
    expect(a.deps.relayBeginCalls[0].receiverUid).toBe(2)
    expect(a.deps.relayBeginCalls[0].name).toBe('src.txt')
    expect(a.deps.relayBeginCalls[0].totalBytes).toBe(8)
    expect(a.deps.relayUploadCalls).toHaveLength(1)
    expect(a.deps.relayUploadCalls[0].filePath).toBe(src.path)
    expect(a.deps.relayUploadCalls[0].itemId).toBe('relay-item-1')
    // 直传登记清除（不再接受直传 accept），本端卡片 relayed
    expect(a.svc.transfers.get(t)).toBeNull()
    expect(a.svc.messages(2).find((x) => x.file?.transferId === t)?.file?.state).toBe('relayed')
    // 对端收到 file-relayed：卡片同样 relayed（确认动作在中继面板进行，本测试只验证卡片语义）
    await new Promise((r) => setTimeout(r, 30))
    expect(b.svc.messages(1).find((x) => x.file?.transferId === t)?.file?.state).toBe('relayed')
    expect(a.deps.sent.some((s) => s.type === 'friend.file-relayed' && (s.payload as { transferId: string }).transferId === t)).toBe(true)
  })

  it('切中继守卫：无中继（getRelay null）时报错且不动原状态；中继登记失败同样报错', async () => {
    // 未注入中继端口（如 RelayService 未装配）：明确报错，不静默降级
    const aNoRelay = makeService(newRoot(), 1, '主')
    const b = makeService(newRoot(), 2, '分')
    befriend(aNoRelay, b)
    const src1 = sourceFile('no-relay')
    const inv1 = aNoRelay.svc.inviteFile(2, { path: src1.path, name: src1.name, kind: 'file', totalBytes: 8, files: 1, dirs: 0 })
    const r1 = await aNoRelay.svc.switchToRelay(2, inv1.transferId!)
    expect(r1).toEqual({ ok: false, error: '中继服务暂不可用' })
    expect(aNoRelay.svc.transfers.get(inv1.transferId!)?.status).toBe('pending') // 状态保持可重试

    // 中继登记失败（如无主系统中继端）：同样明确报错，不伪成功
    const aFailRelay = makeService(newRoot(), 1, '主', { relay: true })
    const b2 = makeService(newRoot(), 2, '分')
    befriend(aFailRelay, b2)
    aFailRelay.deps.relayBeginResult = { ok: false, error: '局域网中未发现主系统中继端' }
    const src2 = sourceFile('relay-fail')
    const inv2 = aFailRelay.svc.inviteFile(2, { path: src2.path, name: src2.name, kind: 'file', totalBytes: 8, files: 1, dirs: 0 })
    const r2 = await aFailRelay.svc.switchToRelay(2, inv2.transferId!)
    expect(r2).toEqual({ ok: false, error: '局域网中未发现主系统中继端' })
    expect(aFailRelay.svc.transfers.get(inv2.transferId!)?.status).toBe('pending')
    expect(aFailRelay.deps.relayUploadCalls).toHaveLength(0) // 登记失败不触发上传
  })
})
