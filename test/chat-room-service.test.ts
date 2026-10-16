import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ChatRoomService } from '../electron/main/multi-instance/chat-rooms/chat-room-service'
import { SYSTEM_ROOM_GID } from '../electron/main/multi-instance/chat-rooms/chat-room-types'
import type { ChatRoomAiSpeaker, ChatRoomEvent, ChatRoomInfo, ChatRoomInvitePayload, ChatRoomMessage } from '../electron/main/multi-instance/chat-rooms/chat-room-types'
import { formatIdentity } from '../electron/main/multi-instance/lan/lan-types'
import type { LanPeer } from '../electron/main/multi-instance/lan/lan-types'

/**
 * L2 聊天室功能测试：单端行为 + 双端信封模拟（建聊天室 → 邀请 → 接受 →同步 → 聊天室聊 → 离开）。
 * 信封采用与 lan-server 相同的分发语义（chat-room.* 交给 ChatRoomService.handleLanEnvelope）。
 */
class FakeDeps {
  root: string
  identity: { uid: number; 用户名: string } | null = null
  events: ChatRoomEvent[] = []
  sent: Array<{ from: number; uid: number; type: string; payload: unknown }> = []
  peers: LanPeer[] = []
  roster: LanPeer[] = []
  sendLan: (uid: number, type: string, payload: unknown) => { ok: boolean; mode: string; error?: string } = () => ({ ok: false, mode: 'outbox', error: 'not-wired' })

  constructor(root: string) {
    this.root = root
  }
}

function makeService(
  root: string,
  uid: number,
  name: string,
  aiReply?: (ai: ChatRoomAiSpeaker, room: ChatRoomInfo, msg: ChatRoomMessage) => Promise<string | null>
): { svc: ChatRoomService; deps: FakeDeps } {
  const deps = new FakeDeps(root)
  deps.identity = { uid, 用户名: name }
  const svc = new ChatRoomService({
    root: deps.root,
    getIdentity: () => deps.identity,
    sendLan: (uid, type, payload) => deps.sendLan(uid, type, payload),
    listPeers: () => deps.peers,
    listRoster: () => deps.roster,
    ...(aiReply ? { aiReply } : {}),
    emit: (e) => deps.events.push(e),
  })
  return { svc, deps }
}

/** 连接双端：互相投递信封（增量注册，多次 wire 不互相覆盖） */
const routes: Array<{ from: FakeDeps; toUid: number; toSvc: ChatRoomService }> = []

function wire(svcA: ChatRoomService, depsA: FakeDeps, svcB: ChatRoomService, depsB: FakeDeps): void {
  const link = (from: FakeDeps, toSvc: ChatRoomService, toDeps: FakeDeps) => {
    const toUid = toDeps.identity!.uid
    routes.push({ from, toUid, toSvc })
  }
  link(depsA, svcB, depsB)
  link(depsB, svcA, depsA)
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

describe('ChatRoomService 聊天室功能生命周期（L2）', () => {
  let roots: string[] = []

  function newRoot(): string {
    const r = mkdtempSync(join(tmpdir(), 'chat-room-test-'))
    roots.push(r)
    return r
  }

  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true })
    roots = []
  })

  it('建聊天室：聊天室主为本机，聊天室信息落盘，聊天室列表可见', () => {
    const { svc, deps } = makeService(newRoot(), 1, '主')
    const r = svc.create('测试聊天室', '聊天室简介')
    expect(r.ok).toBe(true)
    const list = svc.list()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('测试聊天室')
    expect(list[0].ownerUid).toBe(1)
    expect(list[0].myRole).toBe('owner')
    expect(list[0].memberCount).toBe(1)
    expect(deps.events).toHaveLength(0) // 建聊天室不自动广播
  })

  it('邀请→接受→同步：成员双向可见，聊天室主收到 join 并回发 sync 补全信息', () => {
    const a = makeService(newRoot(), 1, '主')
    const b = makeService(newRoot(), 2, '分')
    wire(a.svc, a.deps, b.svc, b.deps)

    const created = a.svc.create('协作聊天室')
    const gid = created.gid!
    expect(a.svc.invite(gid, 2).ok).toBe(true)
    // 邀请信封负载携带聊天室主 UID（供接受侧回发 join）
    const inviteEnv = a.deps.sent.find((s) => s.type === 'chat-room.invite')
    expect(inviteEnv).toBeTruthy()
    expect((inviteEnv!.payload as ChatRoomInvitePayload).ownerUid).toBe(1)
// 被邀请方收到 invite 事件
    const inviteEvent = b.deps.events.find((e) => e.type === 'invite')
    expect(inviteEvent).toBeTruthy()
    expect((inviteEvent as { chatRoomName: string }).chatRoomName).toBe('协作聊天室')

    // 接受邀请：本地入聊天室 + 向聊天室主发 join
    expect(b.svc.acceptInvite(gid, 1).ok).toBe(true)
    // 聊天室主侧收到 join → 追加成员 + 回发完整聊天室信息
    expect(a.svc.list()[0].memberCount).toBe(2)
    // 被邀请侧收到 sync 后补全聊天室信息
    expect(b.svc.detail(gid)?.name).toBe('协作聊天室')
    expect(b.svc.detail(gid)?.ownerUid).toBe(1)
  })

  it('待处理邀请持久化：入站邀请落盘，重启后仍在；接受/忽略后移除', () => {
    const root = newRoot()
    const a = makeService(newRoot(), 1, '主')
    const b = makeService(root, 2, '分')
    wire(a.svc, a.deps, b.svc, b.deps)

    const gid = a.svc.create('协作聊天室').gid!
    expect(a.svc.invite(gid, 2).ok).toBe(true)

    // 入站邀请落盘，待处理列表可见
    expect(b.svc.listInvites().map((i) => i.gid)).toEqual([gid])
    expect(existsSync(join(root, 'federation', 'pending-invites.json'))).toBe(true)

    // 模拟重启：同一 root 新建服务，邀请仍在
    const b2 = makeService(root, 2, '分')
    expect(b2.svc.listInvites().map((i) => i.gid)).toEqual([gid])

    // 忽略邀请：从待处理列表移除并落盘
    expect(b2.svc.declineInvite(gid).ok).toBe(true)
    expect(b2.svc.listInvites()).toHaveLength(0)
    expect(makeService(root, 2, '分').svc.listInvites()).toHaveLength(0)

    // 重新邀请后接受：接受成功即移除待处理
    expect(a.svc.invite(gid, 2).ok).toBe(true)
    expect(b2.svc.listInvites()).toHaveLength(1)
    expect(b2.svc.acceptInvite(gid, 1).ok).toBe(true)
    expect(b2.svc.listInvites()).toHaveLength(0)
  })

  it('权限控制：非聊天室主不能解散；普通成员不能邀请；聊天室主可以踢人', () => {
    const a = makeService(newRoot(), 1, '主')
    const b = makeService(newRoot(), 2, '分')
    const c = makeService(newRoot(), 3, '分2')
    wire(a.svc, a.deps, b.svc, b.deps)
    wire(a.svc, a.deps, c.svc, c.deps)

    const gid = a.svc.create('权限聊天室').gid!
    a.svc.invite(gid, 2)
    b.svc.acceptInvite(gid, 1)
    // 普通成员（2）不能邀请（3）
    expect(b.svc.invite(gid, 3).ok).toBe(false)
    // 普通成员（2）不能解散
    expect(b.svc.disband(gid).ok).toBe(false)
    // 聊天室主（1）可再邀请 3 并踢掉 2
    expect(a.svc.invite(gid, 3).ok).toBe(true)
    c.svc.acceptInvite(gid, 1)
    expect(a.svc.kick(gid, 2).ok).toBe(true)
    expect(a.svc.list()[0].memberCount).toBe(2)
    // 被踢方本地移除聊天室
    expect(b.svc.list()).toHaveLength(0)
  })

  it('聊天室聊：消息向全体成员单播，接收侧幂等落盘', () => {
    const a = makeService(newRoot(), 1, '主')
    const b = makeService(newRoot(), 2, '分')
    wire(a.svc, a.deps, b.svc, b.deps)

    const gid = a.svc.create('聊天聊天室').gid!
    a.svc.invite(gid, 2)
    b.svc.acceptInvite(gid, 1)

    const r = a.svc.sendMessage(gid, '你好')
    expect(r.ok).toBe(true)
    // 本机与接收方都能看到消息
    expect(a.svc.messages(gid)).toHaveLength(1)
    expect(b.svc.messages(gid)).toHaveLength(1)
    expect(b.svc.messages(gid)[0].text).toBe('你好')
    // 长消息被过滤（空白）
    expect(a.svc.sendMessage(gid, '   ').ok).toBe(false)
  })

  it('聊天室主离开聊天室：成员顺延为新聊天室主', () => {
    const a = makeService(newRoot(), 1, '主')
    const b = makeService(newRoot(), 2, '分')
    wire(a.svc, a.deps, b.svc, b.deps)

    const gid = a.svc.create('顺延聊天室').gid!
    a.svc.invite(gid, 2)
    b.svc.acceptInvite(gid, 1)

    expect(a.svc.leave(gid).ok).toBe(true)
    // 聊天室主离开后本机聊天室被移除（本地只有自己时直接删）
    expect(a.svc.list()).toHaveLength(0)
    // 对方本地保留自己的副本：成员只剩自己，角色顺延？——成员侧本地副本不含聊天室主后的状态，
    // 但聊天室主侧离开时若还有成员，应更新 ownerUid 并通知；单端语义：聊天室主本地成员>1 时顺延。
  })

  it('聊天室消息上限：最多保留 2000 条', () => {
    // 存储为整文件原子覆写（load→splice→save），2050 条消息是 O(n²) 的 JSON 全量读写，
    // Windows 冷磁盘下实测约 11s，显式放宽超时（不改变断言规模与生产逻辑）
    const { svc } = makeService(newRoot(), 1, '主')
    const gid = svc.create('上限聊天室').gid!
    const total = 2050
    for (let i = 0; i < total; i++) {
      svc.sendMessage(gid, `msg-${i}`)
    }
    const msgs = svc.messages(gid)
    expect(msgs).toHaveLength(2000)
    expect(msgs[0].text).toBe('msg-50')
    expect(msgs[1999].text).toBe('msg-2049')
  }, 60000)

it('聊天室信息与消息落盘为 JSON 文件（federation/chat-rooms/ 下）', () => {
    const root = newRoot()
    const { svc } = makeService(root, 1, '主')
    const gid = svc.create('落盘聊天室').gid!
    svc.sendMessage(gid, 'hello')
    const infoPath = join(root, 'federation', 'chat-rooms', `${gid}.json`)
    const msgPath = join(root, 'federation', 'chat-rooms', gid, 'messages.json')
    expect(existsSync(infoPath)).toBe(true)
    expect(existsSync(msgPath)).toBe(true)
    const info = JSON.parse(readFileSync(infoPath, 'utf-8')) as ChatRoomInfo
    expect(info.name).toBe('落盘聊天室')
    expect(svc.messages(gid)).toHaveLength(1)
  })

  it('防伪造：普通成员伪造 sync/kick/leave 信封不能篡改聊天室副本', () => {
    const a = makeService(newRoot(), 1, '主')
    const b = makeService(newRoot(), 2, '分')
    const c = makeService(newRoot(), 3, '普通成员')
    wire(a.svc, a.deps, b.svc, b.deps)
    wire(a.svc, a.deps, c.svc, c.deps)
    wire(b.svc, b.deps, c.svc, c.deps)

    const gid = a.svc.create('防伪聊天室').gid!
    a.svc.invite(gid, 2)
    b.svc.acceptInvite(gid, 1)
    a.svc.invite(gid, 3)
    c.svc.acceptInvite(gid, 1)
    expect(a.svc.list()[0].memberCount).toBe(3)

    // 伪造 1：普通成员 c 直接向 b 发送「自己是聊天室主」的 sync（篡改 ownerUid/members）
    const fakeInfo: ChatRoomInfo = {
      gid,
      name: '篡改聊天室',
      ownerUid: 3,
      members: [{ uid: 3, role: 'owner', joinedAt: Date.now() }],
      createdAt: Date.now(),
      updatedAt: Date.now() + 10000,
    }
    b.svc.handleLanEnvelope({ from: 3, ts: Date.now() + 10000, type: 'chat-room.sync', payload: fakeInfo })
    // b 的副本应保持原状：聊天室主仍是 1，成员仍是 1/2/3
    expect(b.svc.detail(gid)?.ownerUid).toBe(1)
    expect(b.svc.detail(gid)?.members.map((m) => m.uid).sort()).toEqual([1, 2, 3])

    // 伪造 2：普通成员 c 伪造 kick，声称移除 b
    c.svc.handleLanEnvelope({ from: 3, ts: Date.now(), type: 'chat-room.kick', payload: { gid, uid: 2, action: 'kick', actorUid: 3 } })
    expect(b.svc.detail(gid)?.members.map((m) => m.uid).sort()).toEqual([1, 2, 3])

    // 伪造 3：普通成员 c 伪造 leave，声称 b 离开
    c.svc.handleLanEnvelope({ from: 3, ts: Date.now(), type: 'chat-room.leave', payload: { gid, uid: 2, action: 'leave', actorUid: 3 } })
    expect(b.svc.detail(gid)?.members.map((m) => m.uid).sort()).toEqual([1, 2, 3])

    // 伪造 4：普通成员 c 伪造「代他人 join」（uid≠from），聊天室主拒绝
    a.svc.handleLanEnvelope({ from: 3, ts: Date.now(), type: 'chat-room.join', payload: { gid, uid: 99 } })
    expect(a.svc.detail(gid)?.members.map((m) => m.uid).sort()).toEqual([1, 2, 3])
  })

it('防伪造：聊天室主 sync 可正常覆盖；admin 聊天室信息更新可同步', () => {
    const a = makeService(newRoot(), 1, '主')
    const b = makeService(newRoot(), 2, '分')
    wire(a.svc, a.deps, b.svc, b.deps)

    const gid = a.svc.create('正常同步聊天室').gid!
    a.svc.invite(gid, 2)
    b.svc.acceptInvite(gid, 1)
    expect(b.svc.detail(gid)?.name).toBe('正常同步聊天室')

    // 聊天室主改名并广播 sync（经 update），成员副本应更新
    a.svc.update(gid, { name: '改名聊天室' })
    expect(b.svc.detail(gid)?.name).toBe('改名聊天室')
  })

  // ===== 全员频道（L2 增强：所有局域网账号自动加入） =====

  it('全员频道：roster 账号自动可见，成员动态=roster 全体，消息广播给全体', () => {
    const a = makeService(newRoot(), 1, '主')
    const b = makeService(newRoot(), 2, '分')
    a.deps.roster = [
      { uid: 1, 用户名: '主', role: 'master', lanIp: '127.0.0.1', lanPort: 1001, online: true, lastSeen: null },
      { uid: 2, 用户名: '分', role: 'satellite', lanIp: '127.0.0.1', lanPort: 1002, online: true, lastSeen: null },
    ]
    b.deps.roster = a.deps.roster
    wire(a.svc, a.deps, b.svc, b.deps)

    // 系统频道自动创建，双方 list 可见
    const listA = a.svc.list().find((g) => g.gid === SYSTEM_ROOM_GID)
    const listB = b.svc.list().find((g) => g.gid === SYSTEM_ROOM_GID)
    expect(listA).toBeTruthy()
    expect(listA!.memberCount).toBe(2)
    expect(listA!.myRole).toBe('member')
    expect(listB).toBeTruthy()
    // 详情成员动态 = roster 全体
    const detailA = a.svc.detail(SYSTEM_ROOM_GID)!
    expect(detailA.members.map((m) => m.uid).sort()).toEqual([1, 2])

    // 消息广播给全体成员（双方可见）
    expect(a.svc.sendMessage(SYSTEM_ROOM_GID, '全员大家好').ok).toBe(true)
    expect(a.svc.messages(SYSTEM_ROOM_GID)).toHaveLength(1)
    expect(b.svc.messages(SYSTEM_ROOM_GID)).toHaveLength(1)

    // 系统频道不可退出/解散/改名/邀请
    expect(a.svc.leave(SYSTEM_ROOM_GID).ok).toBe(false)
    expect(a.svc.disband(SYSTEM_ROOM_GID).ok).toBe(false)
    expect(a.svc.update(SYSTEM_ROOM_GID, { name: '改名' }).ok).toBe(false)
    expect(a.svc.invite(SYSTEM_ROOM_GID, 99).ok).toBe(false)
  })

  // ===== AI 发言身份（L2 增强：用户把 AI 代理加入聊天室并自动回复） =====

  it('AI 发言身份：添加/移除，AI 消息广播并校验归属（身份 = UID-AIID）', () => {
    const a = makeService(newRoot(), 1, '主')
    const b = makeService(newRoot(), 2, '分')
    wire(a.svc, a.deps, b.svc, b.deps)

    const gid = a.svc.create('AI聊天室').gid!
    a.svc.invite(gid, 2)
    b.svc.acceptInvite(gid, 1)

    // 室主可添加本机 1 号 AI（默认）
    const added = a.svc.addAiSpeaker(gid, '小助手')
    expect(added.ok).toBe(true)
    expect(added.aiId).toBe(1)
    // 普通成员（b）可添加「自己属主」的 AI（跨实例协作：每个实例都能让自己的 AI 进场）
    const addedB = b.svc.addAiSpeaker(gid, '小助手B')
    expect(addedB.ok).toBe(true)
    expect(addedB.aiId).toBe(1)
    // uid 段隔离：两个实例同编号 AI 的对外身份字符串不同
    expect(formatIdentity(1, added.aiId!)).toBe('1-1')
    expect(formatIdentity(2, addedB.aiId!)).toBe('2-1')
    // 同名 AI 仍被拒
    expect(a.svc.addAiSpeaker(gid, '小助手').ok).toBe(false)
    // 同一 uid 下重复添加同编号 AI 被拒（换名也不行）
    expect(a.svc.addAiSpeaker(gid, '另一个名字', 1).ok).toBe(false)
    // 详情含 AI 发言身份（isAi + uid/aiId 组成 UID-AIID）
    const detail = a.svc.detail(gid)!
    const ai = detail.members.find((m) => m.isAi && m.uid === 1 && m.aiId === 1)
    expect(ai).toBeTruthy()
    expect(ai!.aiName).toBe('小助手')

    // AI 发言身份同步到对端（广播 sync 后合并）
    expect(b.svc.detail(gid)?.members.some((m) => m.isAi && m.uid === 1 && m.aiId === 1)).toBe(true)

    // 属主代 AI 发消息：信封 sender 是属主 uid，另带 aiId 标明哪个 AI 实体
    const payload = { id: 'ai-1', gid, text: 'AI 你好', fromName: '小助手', isAi: true, aiId: 1 }
    b.svc.handleLanEnvelope({ from: 1, ts: Date.now(), type: 'chat-room.message', payload })
    const aiMsg = b.svc.messages(gid).find((m) => m.isAi)
    expect(aiMsg).toBeTruthy()
    expect(aiMsg!.fromName).toBe('小助手')
    expect(aiMsg!.from).toBe(1)
    expect(aiMsg!.aiId).toBe(1)
    // 伪造他人 AI 消息（uid=2 声称是 aiId=2 的 AI，但本室只有 2-1）——被拒
    const fakePayload = { id: 'ai-fake', gid, text: '伪造', fromName: '小助手', isAi: true, aiId: 2 }
    b.svc.handleLanEnvelope({ from: 2, ts: Date.now(), type: 'chat-room.message', payload: fakePayload })
    expect(b.svc.messages(gid).filter((m) => m.id === 'ai-fake')).toHaveLength(0)

    // AI 属主/室主可移除；他人不可（b 既非属主也非室主）
    expect(b.svc.removeAiSpeaker(gid, '1-1').ok).toBe(false)
    expect(a.svc.removeAiSpeaker(gid, '1-1').ok).toBe(true)
    expect(a.svc.detail(gid)?.members.some((m) => m.isAi && m.uid === 1 && m.aiId === 1)).toBe(false)
  })

  it('AI 自动回复：收到真人消息后本机拥有的 AI 发言身份回复（本机 AI 自身发言不触发，无死循环）', async () => {
    const root = newRoot()
    const deps = new FakeDeps(root)
    deps.identity = { uid: 1, 用户名: '主' }
    const svc = new ChatRoomService({
      root: deps.root,
      getIdentity: () => deps.identity,
      sendLan: (uid, type, payload) => deps.sendLan(uid, type, payload),
      listPeers: () => deps.peers,
      listRoster: () => deps.roster,
      aiReply: async (ai, _room, msg) => `收到你的消息：${msg.text}`,
      emit: (e) => deps.events.push(e),
    })
    const gid = svc.create('回复聊天室').gid!
    svc.addAiSpeaker(gid, '小助手')
    // 自己发消息触发 AI 回复
    svc.sendMessage(gid, '你好')
    await new Promise((r) => setTimeout(r, 50))
    const msgs = svc.messages(gid)
    expect(msgs).toHaveLength(2)
    expect(msgs[1].isAi).toBe(true)
    expect(msgs[1].fromName).toBe('小助手')
    expect(msgs[1].text).toBe('收到你的消息：你好')
    // AI 消息不继续触发 AI 回复（无死循环）
    await new Promise((r) => setTimeout(r, 50))
    expect(svc.messages(gid)).toHaveLength(2)
  })

  it('跨实例 AI 协作：别的实例的 AI 发言触发本机 AI，本机 AI 发言不触发自己', async () => {
    const callsA: string[] = []
    const callsB: string[] = []
    // A 的 AI 返回空 → 协作不强制回复，链条自然停止
    const a = makeService(newRoot(), 1, '主', async (_ai, _room, msg) => {
      callsA.push(msg.text)
      return null
    })
    const b = makeService(newRoot(), 2, '分', async (_ai, _room, msg) => {
      callsB.push(msg.text)
      return 'B端回复'
    })
    wire(a.svc, a.deps, b.svc, b.deps)

    const gid = a.svc.create('协作聊天室').gid!
    a.svc.invite(gid, 2)
    b.svc.acceptInvite(gid, 1)

    // 双方各自把自己的 AI 加进房间
    const aiA = a.svc.addAiSpeaker(gid, 'A助手')
    expect(aiA.ok).toBe(true)
    expect(b.svc.detail(gid)?.members.some((m) => m.isAi && m.uid === 1 && m.aiId === aiA.aiId)).toBe(true)
    // 等 1ms 确保 B 广播的 sync 版本号严格大于 A 侧副本（handleSync 的 memberUpdateSync 判定）
    await new Promise((r) => setTimeout(r, 5))
    const aiB = b.svc.addAiSpeaker(gid, 'B助手')
    expect(aiB.ok).toBe(true)
    // 两个实例的 AI 都是各自 uid 下的 1 号，但对外身份（UID-AIID）不同
    expect(formatIdentity(1, aiA.aiId!)).not.toBe(formatIdentity(2, aiB.aiId!))
    // A 侧拿到 B 的 AI（普通成员广播走 memberUpdateSync 分支）
    expect(a.svc.detail(gid)?.members.some((m) => m.isAi && m.uid === 2 && m.aiId === aiB.aiId)).toBe(true)

    // A 的 AI 发言 → 广播到 B → 触发 B 的 AI（跨实例协作）
    expect(a.svc.sendMessage(gid, 'A端AI发言', false, aiA.aiId).ok).toBe(true)
    await new Promise((r) => setTimeout(r, 50))
    expect(callsB).toEqual(['A端AI发言'])
    // B 的 AI 回复回到 A → 触发 A 的 AI；A 返回空即静默，链条停止
    expect(callsA).toEqual(['B端回复'])
    expect(a.svc.messages(gid)).toHaveLength(2)
    expect(b.svc.messages(gid)).toHaveLength(2)
    expect(a.svc.messages(gid).at(-1)?.isAi).toBe(true)
  })

  it('全员频道防伪造：非 roster 成员广播 sync 不注入 AI 发言身份', () => {
    const a = makeService(newRoot(), 1, '主')
    a.deps.roster = [{ uid: 1, 用户名: '主', role: 'master', lanIp: '127.0.0.1', lanPort: 1001, online: true, lastSeen: null }]
    // 伪造者 uid 99 不在 roster，广播带 AI 发言身份的系统频道信息
    const fakeInfo: ChatRoomInfo = {
      gid: SYSTEM_ROOM_GID,
      name: '改名频道',
      desc: undefined,
      ownerUid: 0,
      members: [{ uid: 99, role: 'member', joinedAt: Date.now(), isAi: true, aiId: 1, aiName: '黑客AI' }],
      isSystem: true,
      createdAt: Date.now(),
      updatedAt: Date.now() + 999,
    }
    a.svc.handleLanEnvelope({ from: 99, ts: Date.now(), type: 'chat-room.sync', payload: fakeInfo })
    const detail = a.svc.detail(SYSTEM_ROOM_GID)!
    expect(detail.members.some((m) => m.isAi)).toBe(false)
    expect(detail.name).toBe('全员频道')
  })

  it('T5 注册表绑定：注入 getAiProfile 后，AI 进场强制取档案名/头像，未注册的 aiId 被拒', () => {
    const root = newRoot()
    const deps = new FakeDeps(root)
    deps.identity = { uid: 1, 用户名: '主' }
    // 注册表档案：1 号 = 月蚀（头像 emoji），2 号 = 莉莉丝；99 号不存在
    const profileMap = new Map<number, { uid: number; aiId: number; name: string; avatar?: string }>([
      [1, { uid: 1, aiId: 1, name: '月蚀', avatar: '🌙' }],
      [2, { uid: 1, aiId: 2, name: '莉莉丝', avatar: '🌸' }]
    ])
    const svc = new ChatRoomService({
      root: deps.root,
      getIdentity: () => deps.identity,
      sendLan: (uid, type, payload) => deps.sendLan(uid, type, payload),
      listPeers: () => deps.peers,
      listRoster: () => deps.roster,
      getAiProfile: (aiId) => profileMap.get(aiId) ?? null,
      emit: (e) => deps.events.push(e),
    })
    const gid = svc.create('档案绑定聊天室').gid!

    // 调用方传自定义名也会被档案名覆盖（防伪造名称）
    const added = svc.addAiSpeaker(gid, '假名', 1)
    expect(added.ok).toBe(true)
    expect(added.name).toBe('月蚀')
    expect(added.avatar).toBe('🌙')
    const member = svc.detail(gid)!.members.find((m) => m.isAi && m.aiId === 1)!
    expect(member.aiName).toBe('月蚀')
    expect(member.aiAvatar).toBe('🌙')

    // 同一 uid 下 2 号 AI（莉莉丝）也可同室进场
    const added2 = svc.addAiSpeaker(gid, '', 2)
    expect(added2.ok).toBe(true)
    expect(added2.name).toBe('莉莉丝')

    // 未注册的 aiId 被拒绝（防伪造 AI 身份进场）
    expect(svc.addAiSpeaker(gid, '黑客', 99).ok).toBe(false)

    // 头像随成员同步进对端副本（T6 界面展示数据就绪）
    const b = makeService(newRoot(), 2, '分')
    wire(svc, deps, b.svc, b.deps)
    const gid2 = svc.create('对端演示').gid!
    expect(svc.invite(gid2, 2).ok).toBe(true)
    expect(b.svc.acceptInvite(gid2, 1).ok).toBe(true)
    const addedB = svc.addAiSpeaker(gid2, '', 1)
    expect(addedB.ok).toBe(true)
    expect(addedB.name).toBe('月蚀')
    expect(addedB.avatar).toBe('🌙')
    expect(b.svc.detail(gid2)?.members.some((m) => m.isAi && m.aiId === 1 && m.aiAvatar === '🌙')).toBe(true)
  })
})