import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MultiInstanceService } from '../electron/main/multi-instance'
import { OplogCapture } from '../electron/main/multi-instance/satellite/oplog-capture'
import { SyncEngine } from '../electron/main/multi-instance/satellite/sync-engine'
import { LanService } from '../electron/main/multi-instance/lan/lan-service'

function makeIpcMock(): { handle: ReturnType<typeof vi.fn>; handlers: Map<string, (...args: unknown[]) => unknown> } {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const handle = vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
    handlers.set(channel, fn)
  })
  return { handle, handlers }
}

describe('MultiInstanceService 门面：角色与同步生命周期', () => {
  let root: string
  let svc: MultiInstanceService

  const spyOplogStart = vi.spyOn(OplogCapture.prototype, 'start')
  const spyEngineStart = vi.spyOn(SyncEngine.prototype, 'start')

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mi-index-test-'))
    spyOplogStart.mockClear()
    spyEngineStart.mockClear()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('standalone：startSync/stopSync 空操作，getStatus 返回单机角色', async () => {
    svc = new MultiInstanceService(root)
    await expect(svc.startSync()).resolves.toBeUndefined()
    await expect(svc.stopSync()).resolves.toBeUndefined()
    expect(svc.getStatus()).toEqual({ role: 'standalone', master: null })
    expect(spyOplogStart).not.toHaveBeenCalled()
    expect(spyEngineStart).not.toHaveBeenCalled()
  })

  it('standalone：startLan 直接返回成功且不装配业务门面', async () => {
    svc = new MultiInstanceService(root)
    const userStore = { getCurrentUser: () => null } as never
    const result = await svc.startLan(userStore)
    expect(result).toEqual({ ok: true })
    expect(svc.getFriends()).toBeNull()
    expect(svc.getChatRooms()).toBeNull()
    expect(svc.getPublishBoard()).toBeNull()
  })

  it('satellite：startSync 幂等（重复 start 不重入），stop 后可重新装配', async () => {
    writeFileSync(
      join(root, 'instance.json'),
      JSON.stringify({ role: 'satellite', master: { baseUrl: 'http://127.0.0.1:39999', instanceId: 'master-1' } }),
      'utf-8'
    )
    svc = new MultiInstanceService(root)
    expect(svc.getStatus().role).toBe('satellite')

    await svc.startSync()
    expect(spyOplogStart).toHaveBeenCalledTimes(1)
    expect(spyEngineStart).toHaveBeenCalledTimes(1)

    // 重复 start 不重入
    await svc.startSync()
    expect(spyOplogStart).toHaveBeenCalledTimes(1)
    expect(spyEngineStart).toHaveBeenCalledTimes(1)

    // stop 清空后再次 start 可重新装配
    await svc.stopSync()
    await svc.startSync()
    expect(spyOplogStart).toHaveBeenCalledTimes(2)
    expect(spyEngineStart).toHaveBeenCalledTimes(2)
  })

  it('satellite：instance.json 缺 master 配置时 startSync 空操作', async () => {
    writeFileSync(join(root, 'instance.json'), JSON.stringify({ role: 'satellite' }), 'utf-8')
    svc = new MultiInstanceService(root)
    await expect(svc.startSync()).resolves.toBeUndefined()
    expect(spyOplogStart).not.toHaveBeenCalled()
    expect(spyEngineStart).not.toHaveBeenCalled()
  })

  it('master：getStatus 带 master 接入信息、startSync 空操作', async () => {
    writeFileSync(join(root, 'instance.json'), JSON.stringify({ role: 'master' }), 'utf-8')
    svc = new MultiInstanceService(root)
    expect(svc.getStatus()).toEqual({ role: 'master', master: null })
    await expect(svc.startSync()).resolves.toBeUndefined()
    expect(spyOplogStart).not.toHaveBeenCalled()
    expect(spyEngineStart).not.toHaveBeenCalled()
  })

  it('satellite：startLan 装配业务门面（好友/聊天室/发布板）后可 stopLan 清理', async () => {
    writeFileSync(
      join(root, 'instance.json'),
      JSON.stringify({ role: 'satellite', master: { baseUrl: 'http://127.0.0.1:39999', instanceId: 'master-1' } }),
      'utf-8'
    )
    // 不真实绑定端口：mock LanService.start
    const lanStartSpy = vi.spyOn(LanService.prototype, 'start').mockResolvedValue({ ok: true, port: 39999 } as never)
    const lanStopSpy = vi.spyOn(LanService.prototype, 'stop').mockResolvedValue(undefined as never)
    svc = new MultiInstanceService(root)
    const userStore = {
      getCurrentUser: () => ({ UID: 1, 用户名: 'u1' })
    } as never

    const result = await svc.startLan(userStore)
    expect(result).toEqual({ ok: true, port: 39999 })
    expect(lanStartSpy).toHaveBeenCalledTimes(1)
    // 业务门面已装配（running 标志由 LanService 内部状态维护，mock start 不置位，不作断言）
    expect(svc.getFriends()).not.toBeNull()
    expect(svc.getChatRooms()).not.toBeNull()
    expect(svc.getPublishBoard()).not.toBeNull()

    await svc.stopLan()
    expect(lanStopSpy).toHaveBeenCalledTimes(1)
    expect(svc.getFriends()).toBeNull()
    expect(svc.getChatRooms()).toBeNull()
    expect(svc.getPublishBoard()).toBeNull()

    lanStartSpy.mockRestore()
    lanStopSpy.mockRestore()
  })
})

describe('MultiInstanceService registerIpc：LAN 未启动时业务通道 fallback', () => {
  let root: string
  let svc: MultiInstanceService
  let mock: ReturnType<typeof makeIpcMock>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mi-ipc-test-'))
    mock = makeIpcMock()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function register(): void {
    svc = new MultiInstanceService(root)
    svc.registerIpc(mock as never, {
      getUserStore: () => null,
      getMainWindow: () => null
    })
  }

  // 声明式通道清单：与 registerIpc 注册序列一一对应，新增/删除通道时在此同步，
  // 数量断言由清单长度推导，避免手写魔法数字在分发后失配。
  // 分组与 register-*.ts 各域注册函数对应：getStatus(1) + friend(13) + chat-room(16) +
  // publish-board(13) + ai-social(6) + account(ai-agent 8 / admin 10 / 接入 5) + backup(7)。
  const MULTI_IPC_CHANNELS = [
    // index.ts registerIpc
    'multi:getStatus',
    // register-friend-ipc.ts（含局域网文件传输 6 通道：inviteFile/acceptFileInvite/rejectFileInvite/
    // cancelFileInvite/openFileLocation/switchToRelay——早期清单未同步，注册数与清单失配即失败）
    'friend:accept', 'friend:block', 'friend:candidates', 'friend:list', 'friend:markRead',
    'friend:messages', 'friend:reject', 'friend:remove', 'friend:request', 'friend:search',
    'friend:sendMessage', 'friend:unblock', 'friend:update',
    'friend:acceptFileInvite', 'friend:cancelFileInvite', 'friend:inviteFile',
    'friend:openFileLocation', 'friend:rejectFileInvite', 'friend:switchToRelay',
    // register-chat-room-ipc.ts
    'chat-room:acceptInvite', 'chat-room:addAiSpeaker', 'chat-room:create',
    'chat-room:declineInvite', 'chat-room:detail', 'chat-room:disband', 'chat-room:invite',
    'chat-room:kick', 'chat-room:leave', 'chat-room:list', 'chat-room:listInvites',
    'chat-room:messages', 'chat-room:removeAiSpeaker', 'chat-room:search',
    'chat-room:sendMessage', 'chat-room:update',
    // register-publish-board-ipc.ts
    'publish-board:createBoard', 'publish-board:deleteArticle', 'publish-board:deleteBoard',
    'publish-board:getArticle', 'publish-board:listArticles', 'publish-board:listBoards',
    'publish-board:listComments', 'publish-board:postComment', 'publish-board:publish',
    'publish-board:requestSync', 'publish-board:searchArticles', 'publish-board:togglePin',
    'publish-board:updateArticle',
    // register-ai-social-ipc.ts
    'ai-social:aiSend', 'ai-social:chats', 'ai-social:contacts', 'ai-social:markRead',
    'ai-social:messages', 'ai-social:send',
    // register-relay-ipc.ts：中继异步传输 5（上传/确认/撤回/清单/信息）
    'relay:confirm', 'relay:info', 'relay:list', 'relay:pickAndUpload', 'relay:revoke',
    // register-account-ipc.ts：ai-agent 配置 8
    'ai-agent:getChatRoom', 'ai-agent:getDirectChat', 'ai-agent:getGlobal',
    'ai-agent:getProactive', 'ai-agent:setChatRoom', 'ai-agent:setDirectChat',
    'ai-agent:setGlobal', 'ai-agent:setProactive',
    // register-account-ipc.ts：账号管理局 admin 10
    'multi:adminAccounts', 'multi:adminAnomalies', 'multi:adminGetUserProfile',
    'multi:adminOpenMemory', 'multi:adminPurgeUser', 'multi:adminRevoke',
    'multi:adminSatellites', 'multi:adminSearchUsers', 'multi:adminSetAccountDisabled',
    'multi:adminSetStatus',
    // register-account-ipc.ts：接入管理 5
    'multi:getJoinInfo', 'multi:probeMaster', 'multi:resetRole', 'multi:rotateJoinCode',
    'multi:setPendingSatellite',
    // register-backup-ipc.ts：本机备份 3 + 分系统备份 4（无条件注册）
    'multi:localBackupInspect', 'multi:localBackupRestoreOverwrite', 'multi:localBackupStatus',
    'multi:satBackupArchives', 'multi:satBackupInspect', 'multi:satBackupRestoreOverwrite',
    'multi:satBackupSave'
  ] as const

  it('注册全部业务/管理/备份通道，未启动 LAN 时业务通道返回 unready', async () => {
    register()
    // 数量断言从声明式清单推导：通道清单与实际注册数失配即失败（新增/删除通道时同步改清单）
    // 备份 7 通道（localBackup* 3 + satBackup* 4）无条件注册——历史 BUG 修复：按角色条件注册会让
    // 「运行时注册成为主系统/接入分系统」后的通道永不补注册（打包版账号管理局/备份中心失效的根因），
    // 改为无条件注册 + handler 内角色守卫（见 register-backup-ipc.ts 头注释）。
    expect(mock.handlers.size).toBe(MULTI_IPC_CHANNELS.length)
    for (const ch of MULTI_IPC_CHANNELS) {
      expect(mock.handlers.has(ch)).toBe(true)
    }
    expect(new Set(MULTI_IPC_CHANNELS).size).toBe(MULTI_IPC_CHANNELS.length)
    expect(mock.handlers.has('multi:getStatus')).toBe(true)
    expect(mock.handlers.has('multi:adminSatellites')).toBe(true)
    expect(mock.handlers.has('multi:adminAccounts')).toBe(true)
    expect(mock.handlers.has('multi:localBackupStatus')).toBe(true)
    expect(mock.handlers.has('multi:satBackupArchives')).toBe(true)

    // multi:getStatus
    expect(await mock.handlers.get('multi:getStatus')!()).toEqual({ role: 'standalone', master: null })

    // 好友/聊天室/发布板：LAN 未启动 → 结构化 unready
    const unready = { ok: false, error: '局域网协作未启动' }
    expect(await mock.handlers.get('friend:list')!()).toEqual(unready)
    expect(await mock.handlers.get('friend:candidates')!()).toEqual(unready)
    expect(await mock.handlers.get('friend:search')!(null, 'a', 1, 5)).toEqual(unready)
    expect(await mock.handlers.get('chat-room:list')!()).toEqual(unready)
    expect(await mock.handlers.get('chat-room:search')!(null, 'a', undefined, 5)).toEqual(unready)
    expect(await mock.handlers.get('publish-board:listBoards')!()).toEqual(unready)
    expect(await mock.handlers.get('publish-board:listArticles')!(null, undefined, 10)).toEqual(unready)
  })

  it('参数校验：业务通道对非法参数返回参数不合法，不触碰服务', async () => {
    register()
    expect(await mock.handlers.get('friend:search')!(null, 123)).toEqual({ ok: false, error: '参数不合法' })
    expect(await mock.handlers.get('chat-room:create')!(null, 42)).toEqual({ ok: false, error: '参数不合法' })
    expect(await mock.handlers.get('publish-board:getArticle')!(null, 'b1', 7)).toEqual({ ok: false, error: '参数不合法' })
  })

  it('管理员通道：standalone 非主系统返回非主系统错误', async () => {
    register()
    expect(await mock.handlers.get('multi:adminSatellites')!()).toEqual({ ok: false, error: '非主系统' })
    expect(await mock.handlers.get('multi:adminSetStatus')!(null, 'i1', 'active')).toEqual({ ok: false, error: '非主系统' })
    expect(await mock.handlers.get('multi:adminRevoke')!(null, 'i1')).toEqual({ ok: false, error: '非主系统' })
    expect(await mock.handlers.get('multi:adminAnomalies')!()).toEqual({ ok: false, error: '非主系统' })
  })

  it('AI 代理配置通道：standalone 下可读写全局开关（不依赖 LAN）', async () => {
    register()
    expect(await mock.handlers.get('ai-agent:getGlobal')!()).toEqual({ ok: true, enabled: false })
    expect(await mock.handlers.get('ai-agent:setGlobal')!(null, true)).toEqual({ ok: true })
    expect(await mock.handlers.get('ai-agent:getGlobal')!()).toEqual({ ok: true, enabled: true })
    // 非法参数
    expect(await mock.handlers.get('ai-agent:setGlobal')!(null, 'yes')).toEqual({ ok: false, error: '参数不合法' })
  })

  it('satellite：本地与分系统备份通道都注册，角色守卫各归其位', async () => {
    writeFileSync(
      join(root, 'instance.json'),
      JSON.stringify({ role: 'satellite', master: { baseUrl: 'http://127.0.0.1:39999', instanceId: 'master-1' } }),
      'utf-8'
    )
    register()
    // 无条件注册（历史 BUG 修复）：分系统备份通道（satBackup*）与主系统本机备份通道（localBackup*）均存在
    expect(mock.handlers.has('multi:satBackupArchives')).toBe(true)
    expect(mock.handlers.has('multi:satBackupInspect')).toBe(true)
    expect(mock.handlers.has('multi:localBackupStatus')).toBe(true)
    // 角色守卫：分系统调用主系统本机备份通道 → 非主系统（不触碰 null store，不抛 TypeError）
    expect(await mock.handlers.get('multi:localBackupStatus')!()).toEqual({ ok: false, error: '非主系统' })
  })

  it('master：本机与分系统备份通道都注册，好友/聊天室业务通道仍走 unready fallback', async () => {
    writeFileSync(join(root, 'instance.json'), JSON.stringify({ role: 'master' }), 'utf-8')
    register()
    expect(mock.handlers.has('multi:localBackupStatus')).toBe(true)
    expect(mock.handlers.has('multi:localBackupInspect')).toBe(true)
    expect(mock.handlers.has('multi:satBackupArchives')).toBe(true)
    expect(await mock.handlers.get('friend:list')!()).toEqual({ ok: false, error: '局域网协作未启动' })
    // 角色守卫：主系统调用分系统提取通道 → 非分系统
    expect(await mock.handlers.get('multi:satBackupArchives')!()).toEqual({ ok: false, error: '非分系统' })
    // 本机备份通道：master 已装配 → 不会被"非主系统"拦截（userStore 为 null 仅提示账号库未就绪）
    expect(await mock.handlers.get('multi:localBackupStatus')!()).toEqual({ ok: false, error: '账号库未就绪' })
  })

  it('运行时注册成为主系统 → 账号管理局与备份中心立即可用（热装配回归：历史打包版 BUG）', async () => {
    // 模拟真实升级路径：standalone 启动后，用户在注册页选择「注册成为主系统」——
    // MasterAuth.register(intent=createMaster) 只写 instance.json（becomeMaster），不改内存态。
    // 旧实现：构造器按启动时角色装配一次 registry/satelliteStore，运行时升级后 getRegistry() 仍为
    // null → 账号管理局全链路 403、备份中心 localBackup* 通道不注册（打包版不可用的根因）。
    // 新实现：ctx.getRegistry()/getSatelliteStore() 惰性调 ensureMasterAssets()，升级后即插即用。
    register() // 以 standalone 启动并注册全部 IPC 通道
    expect(await mock.handlers.get('multi:adminSatellites')!()).toEqual({ ok: false, error: '非主系统' })

    // 升级为主系统：走与 MasterAuth.register(createMaster) 完全相同的运行时路径（becomeMaster 写盘 + 更新内存缓存）
    svc.config.becomeMaster()
    // 不重建服务实例：ctx.getRegistry() 惰性调用 ensureMasterAssets()，原通道即插即用
    // 账号管理局：热装配后不再是"非主系统"（userStore 缺席仅影响真实数据读取，不阻断路由）
    const adminResult = (await mock.handlers.get('multi:adminSatellites')!()) as {
      ok: boolean
      error?: string
    }
    expect(adminResult.ok).toBe(true)
    // 备份中心：localBackup* 通道可用（装配后走到账号库未就绪分支，而非被"非主系统"拦截）
    expect(await mock.handlers.get('multi:localBackupStatus')!()).toEqual({ ok: false, error: '账号库未就绪' })
  })
})