import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PublishBoardService } from '../electron/main/multi-instance/publish-board/publish-board-service'
import type { PublishEvent, PublishPayload, PublishTombstonePayload } from '../electron/main/multi-instance/publish-board/publish-board-types'
import type { LanPeer } from '../electron/main/multi-instance/lan/lan-types'

/**
 * L3 内部发布板测试：单端行为 + 双端信封模拟（创建板块 → 发布 → 同步 → 评论 → 置顶/删除）。
 * 信封采用与 lan-server 相同的分发语义（publish-board.* 交给 PublishBoardService.handleLanEnvelope）。
 */
class FakeDeps {
  root: string
  identity: { uid: number; 用户名: string } | null = null
  events: PublishEvent[] = []
  sent: Array<{ from: number; uid: number; type: string; payload: unknown }> = []
  peers: LanPeer[] = []
  sendLan: (uid: number, type: string, payload: unknown) => { ok: boolean; mode: string; error?: string } = () => ({ ok: false, mode: 'outbox', error: 'not-wired' })

  constructor(root: string) {
    this.root = root
  }
}

function makeService(root: string, uid: number, name: string): { svc: PublishBoardService; deps: FakeDeps } {
  const deps = new FakeDeps(root)
  deps.identity = { uid, 用户名: name }
  const svc = new PublishBoardService({
    root: deps.root,
    getIdentity: () => deps.identity,
    sendLan: (uid, type, payload) => deps.sendLan(uid, type, payload),
    listPeers: () => deps.peers,
    emit: (e) => deps.events.push(e),
  })
  return { svc, deps }
}

/** 连接双端：互相投递信封（增量注册，多次 wire 不互相覆盖） */
const routes: Array<{ from: FakeDeps; toUid: number; toSvc: PublishBoardService }> = []

function wire(svcA: PublishBoardService, depsA: FakeDeps, svcB: PublishBoardService, depsB: FakeDeps): void {
  const link = (from: FakeDeps, toSvc: PublishBoardService, toDeps: FakeDeps) => {
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

describe('PublishBoardService 内部发布板（L3）', () => {
  let roots: string[] = []

  function newRoot(): string {
    const r = mkdtempSync(join(tmpdir(), 'publish-board-test-'))
    roots.push(r)
    return r
  }

  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true })
    roots = []
  })

  it('创建板块：落盘、事件推送、列表可见', () => {
    const { svc, deps } = makeService(newRoot(), 1, '主')
    const r = svc.createBoard('公告', '主系统公告栏')
    expect(r.ok).toBe(true)
    expect(svc.listBoards()).toHaveLength(1)
    expect(svc.listBoards()[0].name).toBe('公告')
    expect(deps.events.some((e) => e.type === 'board-updated')).toBe(true)
  })

  it('发布条目：作者校验、落盘、（在线）向对端广播', () => {
    const a = makeService(newRoot(), 1, '主')
    const b = makeService(newRoot(), 2, '分')
    wire(a.svc, a.deps, b.svc, b.deps)
    // 对端在线才广播
    b.deps.peers = [{ uid: 1, 用户名: '主', role: 'master', lanIp: '127.0.0.1', lanPort: 62003, online: true, lastSeen: Date.now() }]
    a.deps.peers = [{ uid: 2, 用户名: '分', role: 'satellite', lanIp: '127.0.0.1', lanPort: 62003, online: true, lastSeen: Date.now() }]

    const board = a.svc.createBoard('公告').board!
    const r = a.svc.publish(board.boardId, '标题', '摘要', '正文')
    expect(r.ok).toBe(true)
    // 本机列表可见
    expect(a.svc.listArticles(board.boardId)).toHaveLength(1)
    expect(a.svc.listArticles()[0].title).toBe('标题')
    // 对端通过信封收到文章并落盘
    expect(b.svc.listArticles()).toHaveLength(1)
    expect(b.svc.getArticle(board.boardId, r.article!.articleId)?.body).toBe('正文')
  })

  it('防伪造：非作者发来的文章信封被拒绝，不落盘不广播', () => {
    const a = makeService(newRoot(), 1, '主')
    const b = makeService(newRoot(), 2, '分')
    wire(a.svc, a.deps, b.svc, b.deps)
    const board = a.svc.createBoard('公告').board!
    // 伪造信封：authorUid=2（B 是发件人），但文章声称作者 999
    const forged: PublishPayload = {
      article: {
        articleId: 'fake-1',
        boardId: board.boardId,
        title: '伪造发布',
        summary: '',
        body: '不应被接收',
        authorUid: 999,
        authorName: '黑客',
        pinned: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    }
    b.svc.handleLanEnvelope({ from: 2, ts: Date.now(), type: 'publish-board.publish', payload: forged })
    // 对端与本机都未落盘
    expect(a.svc.listArticles()).toHaveLength(0)
    expect(b.svc.listArticles()).toHaveLength(0)
  })

  it('同步：新终端上线拉取缺失文章与板块', () => {
    const a = makeService(newRoot(), 1, '主')
    const b = makeService(newRoot(), 2, '分')
    wire(a.svc, a.deps, b.svc, b.deps)
    const board = a.svc.createBoard('公告').board!
    a.svc.publish(board.boardId, '标题A', '', '正文A')
    a.svc.publish(board.boardId, '标题B', '', '正文B')
    // 真实场景：B 上线时两端都会收到对端上线事件，各自向对方发起 syncWant
    // A 感知到 B 上线（A have 已有数据 → B 无缺失可回）；B 感知到 A 上线（B have 为空 → A 回发全部）
    a.svc.handlePeerStatus({ peer: { uid: 2, 用户名: '分', role: 'satellite', lanIp: '127.0.0.1', lanPort: 62003, online: true, lastSeen: Date.now() }, online: true })
    b.svc.handlePeerStatus({ peer: { uid: 1, 用户名: '主', role: 'master', lanIp: '127.0.0.1', lanPort: 62003, online: true, lastSeen: Date.now() }, online: true })
    // B 通过 A 回发的 sync 数据补全板块与文章
    expect(b.svc.listBoards()).toHaveLength(1)
    expect(b.svc.listArticles()).toHaveLength(2)
  })

  it('评论：发表落盘、去重幂等、列表可见', () => {
    const { svc, deps } = makeService(newRoot(), 1, '主')
    const board = svc.createBoard('公告').board!
    const art = svc.publish(board.boardId, '标题', '', '正文').article!
    const c1 = svc.postComment(art.articleId, '第一条评论')
    expect(c1.ok).toBe(true)
    // 重复评论 ID 幂等（伪造重复信封）
    svc.handleLanEnvelope({ from: 1, ts: Date.now(), type: 'publish-board.comment', payload: { comment: c1.comment! } })
    expect(svc.listComments(art.articleId)).toHaveLength(1)
    expect(svc.listComments(art.articleId)[0].text).toBe('第一条评论')
    expect(deps.events.some((e) => e.type === 'comment')).toBe(true)
  })

  it('评论上限 500：超限裁剪旧评论', () => {
    const { svc } = makeService(newRoot(), 1, '主')
    const board = svc.createBoard('公告').board!
    const art = svc.publish(board.boardId, '标题', '', '正文').article!
    for (let i = 0; i < 505; i++) {
      svc.postComment(art.articleId, `评论${i}`)
    }
    const list = svc.listComments(art.articleId, 500)
    expect(list).toHaveLength(500)
    // 最早的 5 条被裁剪，最新的是 评论504
    expect(list[0].text).toBe('评论5')
    expect(list[list.length - 1].text).toBe('评论504')
  })

  it('置顶与删除：仅作者可操作；列表置顶优先排序', () => {
    const a = makeService(newRoot(), 1, '主')
    const b = makeService(newRoot(), 2, '分')
    wire(a.svc, a.deps, b.svc, b.deps)
    b.deps.peers = [{ uid: 1, 用户名: '主', role: 'master', lanIp: '127.0.0.1', lanPort: 62003, online: true, lastSeen: Date.now() }]
    a.deps.peers = [{ uid: 2, 用户名: '分', role: 'satellite', lanIp: '127.0.0.1', lanPort: 62003, online: true, lastSeen: Date.now() }]
    const board = a.svc.createBoard('公告').board!
    const artA = a.svc.publish(board.boardId, '文章A', '', '正文A').article!
    // B 发布文章（作者=B），经广播落入 A 端
    const artB = b.svc.publish(board.boardId, '文章B', '', '正文B').article!
    expect(a.svc.getArticle(board.boardId, artB.articleId)).not.toBeNull()
    // 非作者（B）不能置顶/删除 A 的文章
    expect(b.svc.togglePin(board.boardId, artA.articleId).error).toMatch(/无权/)
    expect(b.svc.deleteArticle(board.boardId, artA.articleId).error).toMatch(/无权/)
    // 作者 A 置顶 B 的文章会被拒绝，置顶自己的可以
    expect(a.svc.togglePin(board.boardId, artB.articleId).error).toMatch(/无权/)
    expect(a.svc.togglePin(board.boardId, artA.articleId).ok).toBe(true)
    // 置顶文章排最前
    const list = a.svc.listArticles(board.boardId)
    expect(list[0].articleId).toBe(artA.articleId)
    // B 端同步收到置顶状态（setInterval 之外由信封转发获知）
    expect(b.svc.getArticle(board.boardId, artA.articleId)?.pinned).toBe(true)
  })

  it('编辑文章：仅作者本人可改，字段更新并广播；超长/空字段被拒', () => {
    const a = makeService(newRoot(), 1, '主')
    const b = makeService(newRoot(), 2, '分')
    wire(a.svc, a.deps, b.svc, b.deps)
    a.deps.peers = [{ uid: 2, 用户名: '分', role: 'satellite', lanIp: '127.0.0.1', lanPort: 62003, online: true, lastSeen: Date.now() }]
    b.deps.peers = [{ uid: 1, 用户名: '主', role: 'master', lanIp: '127.0.0.1', lanPort: 62003, online: true, lastSeen: Date.now() }]
    const board = a.svc.createBoard('公告').board!
    const art = a.svc.publish(board.boardId, '原标题', '原摘要', '原正文').article!

    // 非作者不能编辑
    expect(b.svc.updateArticle(board.boardId, art.articleId, { title: '改标题' }).error).toMatch(/仅作者/)
    // 作者编辑：只更新传入字段
    const res = a.svc.updateArticle(board.boardId, art.articleId, { title: '新标题', body: '新正文' })
    expect(res.ok).toBe(true)
    expect(res.article?.title).toBe('新标题')
    expect(res.article?.body).toBe('新正文')
    expect(res.article?.summary).toBe('原摘要')
    expect(res.article?.updatedAt).toBeGreaterThanOrEqual(art.updatedAt)
    // 更新经广播同步到对端
    expect(b.svc.getArticle(board.boardId, art.articleId)?.title).toBe('新标题')
    // 空标题 / 超长正文被拒
    expect(a.svc.updateArticle(board.boardId, art.articleId, { title: '  ' }).ok).toBe(false)
    expect(a.svc.updateArticle(board.boardId, art.articleId, { body: 'x'.repeat(20001) }).error).toMatch(/正文过长/)
    // 不存在的文章
    expect(a.svc.updateArticle(board.boardId, 'no-such-id', { title: 'x' }).error).toMatch(/不存在/)
  })

  it('删除同步：作者删除后，新上线端经同步拉取墓碑，文章被清除', () => {
    const a = makeService(newRoot(), 1, '主')
    const b = makeService(newRoot(), 2, '分')
    wire(a.svc, a.deps, b.svc, b.deps)
    const board = a.svc.createBoard('公告').board!
    const art = a.svc.publish(board.boardId, '将删除', '', '正文').article!
    // B 离线状态下 A 删除文章（无在线 peer 广播，仅本机落墓碑）
    a.svc.deleteArticle(board.boardId, art.articleId)
    expect(a.svc.listArticles()).toHaveLength(0)
    // B 上线 → 两端互发 syncWant → B 通过墓碑清除该文章
    a.svc.handlePeerStatus({ peer: { uid: 2, 用户名: '分', role: 'satellite', lanIp: '127.0.0.1', lanPort: 62003, online: true, lastSeen: Date.now() }, online: true })
    // 注意 B 端从未收到文章，仅收到墓碑 → 不应落盘文章
    expect(b.svc.listArticles()).toHaveLength(0)

    // 反向场景：A 删除前 B 已在线收到文章；A 删除后 B 经同步墓碑清除
    const a2 = makeService(newRoot(), 1, '主')
    const b2 = makeService(newRoot(), 2, '分')
    wire(a2.svc, a2.deps, b2.svc, b2.deps)
    b2.deps.peers = [{ uid: 1, 用户名: '主', role: 'master', lanIp: '127.0.0.1', lanPort: 62003, online: true, lastSeen: Date.now() }]
    a2.deps.peers = [{ uid: 2, 用户名: '分', role: 'satellite', lanIp: '127.0.0.1', lanPort: 62003, online: true, lastSeen: Date.now() }]
    const board2 = a2.svc.createBoard('公告').board!
    const art2 = a2.svc.publish(board2.boardId, '将删除2', '', '正文2').article!
    expect(b2.svc.listArticles()).toHaveLength(1)
    a2.svc.deleteArticle(board2.boardId, art2.articleId)
    expect(b2.svc.listArticles()).toHaveLength(0)
  })

  it('评论同步：新上线端通过 syncWant 拉取评论', () => {
    const a = makeService(newRoot(), 1, '主')
    const b = makeService(newRoot(), 2, '分')
    wire(a.svc, a.deps, b.svc, b.deps)
    const board = a.svc.createBoard('公告').board!
    const art = a.svc.publish(board.boardId, '标题', '', '正文').article!
    a.svc.postComment(art.articleId, '评论一')
    a.svc.postComment(art.articleId, '评论二')
    // B 上线 → 互发 syncWant → B 拉到文章与评论
    a.svc.handlePeerStatus({ peer: { uid: 2, 用户名: '分', role: 'satellite', lanIp: '127.0.0.1', lanPort: 62003, online: true, lastSeen: Date.now() }, online: true })
    b.svc.handlePeerStatus({ peer: { uid: 1, 用户名: '主', role: 'master', lanIp: '127.0.0.1', lanPort: 62003, online: true, lastSeen: Date.now() }, online: true })
    expect(b.svc.listComments(art.articleId)).toHaveLength(2)
    expect(b.svc.listComments(art.articleId)[0].text).toBe('评论一')
  })

  it('墓碑防线：作者归属不一致或版本回退的删除广播被拒', () => {
    const a = makeService(newRoot(), 1, '主')
    const b = makeService(newRoot(), 2, '分')
    wire(a.svc, a.deps, b.svc, b.deps)
    const board = a.svc.createBoard('公告').board!
    const art = a.svc.publish(board.boardId, '标题', '', '正文').article!
    // B 上线互相同步，拿到 A 的文章副本
    a.svc.handlePeerStatus({ peer: { uid: 2, 用户名: '分', role: 'satellite', lanIp: '127.0.0.1', lanPort: 62003, online: true, lastSeen: Date.now() }, online: true })
    b.svc.handlePeerStatus({ peer: { uid: 1, 用户名: '主', role: 'master', lanIp: '127.0.0.1', lanPort: 62003, online: true, lastSeen: Date.now() }, online: true })
    expect(b.svc.getArticle(board.boardId, art.articleId)?.title).toBe('标题')
    // 1) 作者归属不一致：墓碑声称作者是他人（≠ 本地文章作者 1）→ 拒绝
    const wrongAuthor: PublishTombstonePayload = { articleId: art.articleId, deletedAt: Date.now(), authorUid: 999 }
    b.svc.handleLanEnvelope({ from: 2, ts: Date.now(), type: 'publish-board.tombstone', payload: wrongAuthor })
    expect(b.svc.getArticle(board.boardId, art.articleId)?.title).toBe('标题')
    // 2) 版本回退：墓碑删除时间早于文章更新时间 → 拒绝
    const stale: PublishTombstonePayload = { articleId: art.articleId, deletedAt: art.createdAt - 1, authorUid: 1 }
    b.svc.handleLanEnvelope({ from: 2, ts: Date.now(), type: 'publish-board.tombstone', payload: stale })
    expect(b.svc.getArticle(board.boardId, art.articleId)?.title).toBe('标题')
    // 3) 合法的作者删除广播 → 接受并清除
    b.svc.handleLanEnvelope({ from: 1, ts: Date.now(), type: 'publish-board.tombstone', payload: { articleId: art.articleId, deletedAt: art.updatedAt + 1, authorUid: 1 } })
    expect(b.svc.getArticle(board.boardId, art.articleId)).toBeNull()
  })
})