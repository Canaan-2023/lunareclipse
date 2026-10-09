/**
 * @category 工具
 * @summary 多实例好友系统 IPC 注册（L1，LAN 直连；未启动时返回 unready）
 * 为什么存在：好友面板需经 IPC 访问好友操作，且 LAN 未启动时应明确返回 unready 而非静默出错。
 * 邀请制直传：文件/文件夹选择在主进程 dialog 完成（渲染层无 Node 权限），统计口径复用 sendDirectory；
 * 发送方只发邀请信封，接收方同意后才推流，全程不阻塞聊天通道。
 */
import { dialog, shell } from 'electron'
import type { BrowserWindow, ipcMain as ipcMainType } from 'electron'
import { statSync } from 'fs'
import { basename } from 'path'
import { safeHandle } from '../../ipc/handlers/safe-handle'
import { walkDirectorySafe } from '../lan/lan-stream'
import type { FriendService, FriendFilePick } from '../friends/friend-service'

/** 好友域所需上下文：以 getter 形式注入 MultiInstanceService 私有状态 */
export interface FriendIpcCtx {
  getFriends(): FriendService | null
  /** dialog 父窗口（未创建时退化为无父窗口 dialog） */
  getMainWindow(): BrowserWindow | null
}

/** 打开系统选择器并统计传输对象（文件或整目录）；取消返回 null */
async function pickTransferObject(win: BrowserWindow | null, mode: 'file' | 'dir'): Promise<FriendFilePick | null> {
  const title = mode === 'dir' ? '选择要发给好友的文件夹' : '选择要发给好友的文件'
  const options = {
    title,
    properties: (mode === 'dir' ? ['openDirectory'] : ['openFile']) as ('openFile' | 'openDirectory')[]
  }
  const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  if (picked.canceled || picked.filePaths.length === 0) return null
  const targetPath = picked.filePaths[0]
  if (mode === 'file') {
    const st = statSync(targetPath, { throwIfNoEntry: false })
    if (!st?.isFile()) throw new Error('所选对象不是可读文件')
    return { path: targetPath, name: basename(targetPath), kind: 'file', totalBytes: st.size, files: 1, dirs: 0 }
  }
  const entries = await walkDirectorySafe(targetPath)
  if (!entries) throw new Error('目录遍历失败（可能包含过多条目或不可读）')
  const files = entries.filter((e) => e.kind === 'file')
  const dirs = entries.filter((e) => e.kind === 'dir')
  return {
    path: targetPath,
    name: basename(targetPath),
    kind: 'dir',
    totalBytes: files.reduce((acc, f) => acc + f.size, 0),
    files: files.length,
    dirs: dirs.length
  }
}

/** 注册好友系统 IPC 通道（13 个 friend:* + 5 个文件传输） */
export function registerFriendIpc(ipc: typeof ipcMainType, ctx: FriendIpcCtx): void {
  // ===== 好友系统（L1，LAN 直连；未启动时返回 unready） =====
  const withFriends = <T>(fn: (f: FriendService) => T): T | { ok: false; error: string } => {
    const friends = ctx.getFriends()
    if (!friends) return { ok: false, error: '局域网协作未启动' }
    try {
      return fn(friends)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  safeHandle(
    ipc, 'friend:list',
    () => withFriends((f) => ({ ok: true as const, list: f.list() })),
    { ok: false, error: '读取好友列表失败' }
  )
  safeHandle(
    ipc, 'friend:candidates',
    () => withFriends((f) => ({ ok: true as const, candidates: f.candidates() })),
    { ok: false, error: '读取候选失败' }
  )
  safeHandle(
    ipc, 'friend:search',
    (_e, keyword: unknown, uid?: unknown, limit?: unknown) => {
      if (typeof keyword !== 'string') return { ok: false, error: '参数不合法' }
      return withFriends((f) => {
        const res = f.search(keyword, typeof uid === 'number' ? uid : undefined, typeof limit === 'number' ? limit : undefined)
        return { ok: true as const, contacts: res.contacts, messages: res.messages }
      })
    },
    { ok: false, error: '搜索好友失败' }
  )
  safeHandle(
    ipc, 'friend:request',
    (_e, uid: unknown, note?: unknown) => {
      if (typeof uid !== 'number') return { ok: false, error: '参数不合法' }
      return withFriends((f) => f.request(uid, typeof note === 'string' ? note : undefined))
    },
    { ok: false, error: '请求发送失败' }
  )
  safeHandle(
    ipc, 'friend:accept',
    (_e, uid: unknown) => {
      if (typeof uid !== 'number') return { ok: false, error: '参数不合法' }
      return withFriends((f) => f.accept(uid))
    },
    { ok: false, error: '接受失败' }
  )
  safeHandle(
    ipc, 'friend:reject',
    (_e, uid: unknown) => {
      if (typeof uid !== 'number') return { ok: false, error: '参数不合法' }
      return withFriends((f) => f.reject(uid))
    },
    { ok: false, error: '拒绝失败' }
  )
  safeHandle(
    ipc, 'friend:block',
    (_e, uid: unknown) => {
      if (typeof uid !== 'number') return { ok: false, error: '参数不合法' }
      return withFriends((f) => f.block(uid))
    },
    { ok: false, error: '拉黑失败' }
  )
  safeHandle(
    ipc, 'friend:unblock',
    (_e, uid: unknown) => {
      if (typeof uid !== 'number') return { ok: false, error: '参数不合法' }
      return withFriends((f) => f.unblock(uid))
    },
    { ok: false, error: '解除拉黑失败' }
  )
  safeHandle(
    ipc, 'friend:remove',
    (_e, uid: unknown) => {
      if (typeof uid !== 'number') return { ok: false, error: '参数不合法' }
      return withFriends((f) => f.remove(uid))
    },
    { ok: false, error: '删除失败' }
  )
  safeHandle(
    ipc, 'friend:update',
    (_e, uid: unknown, patch: unknown) => {
      if (typeof uid !== 'number' || typeof patch !== 'object' || patch === null) {
        return { ok: false, error: '参数不合法' }
      }
      const p = patch as { 备注?: unknown; 分组?: unknown }
      return withFriends((f) =>
        f.update(uid, {
          备注: typeof p.备注 === 'string' ? p.备注 : undefined,
          分组: typeof p.分组 === 'string' ? p.分组 : undefined
        })
      )
    },
    { ok: false, error: '更新失败' }
  )
  safeHandle(
    ipc, 'friend:messages',
    (_e, uid: unknown) => {
      if (typeof uid !== 'number') return { ok: false, error: '参数不合法' }
      return withFriends((f) => ({ ok: true as const, messages: f.messages(uid) }))
    },
    { ok: false, error: '读取消息失败' }
  )
  safeHandle(
    ipc, 'friend:markRead',
    (_e, uid: unknown) => {
      if (typeof uid !== 'number') return { ok: false, error: '参数不合法' }
      return withFriends((f) => {
        f.markRead(uid)
        return { ok: true as const }
      })
    },
    { ok: false, error: '标记失败' }
  )
  safeHandle(
    ipc, 'friend:sendMessage',
    (_e, uid: unknown, text: unknown) => {
      if (typeof uid !== 'number' || typeof text !== 'string') return { ok: false, error: '参数不合法' }
      return withFriends((f) => f.sendMessage(uid, text))
    },
    { ok: false, error: '发送失败' }
  )

  // ===== 邀请制文件/文件夹传输（发送方选文件 → 发邀请信封；接收方同意后本端推流） =====

  // 选择文件/文件夹并发邀请（发送方）：dialog 选对象 + 统计 → FriendService 登记 + 落卡片 + 发信封
  safeHandle(
    ipc, 'friend:inviteFile',
    async (_e, uid: unknown, mode: unknown) => {
      if (typeof uid !== 'number' || (mode !== 'file' && mode !== 'dir')) {
        return { ok: false, error: '参数不合法' }
      }
      const win = ctx.getMainWindow()
      const picked = await pickTransferObject(win, mode)
      if (!picked) return { ok: false, canceled: true }
      return withFriends((f) => f.inviteFile(uid, picked))
    },
    { ok: false, error: '邀请发送失败' }
  )

  // 接收方同意：回发 accept（对方离线自动补投），对方凭登记表推流
  safeHandle(
    ipc, 'friend:acceptFileInvite',
    (_e, uid: unknown, transferId: unknown) => {
      if (typeof uid !== 'number' || typeof transferId !== 'string') return { ok: false, error: '参数不合法' }
      return withFriends((f) => f.acceptFileInvite(uid, transferId))
    },
    { ok: false, error: '接受失败' }
  )

  // 接收方拒绝：回发 reject（发送方清理登记与卡片）
  safeHandle(
    ipc, 'friend:rejectFileInvite',
    (_e, uid: unknown, transferId: unknown) => {
      if (typeof uid !== 'number' || typeof transferId !== 'string') return { ok: false, error: '参数不合法' }
      return withFriends((f) => f.rejectFileInvite(uid, transferId))
    },
    { ok: false, error: '拒绝失败' }
  )

  // 发送方切换中继：直传不可达时把同一文件改走中继通道（接收方在中继面板确认后领取）
  safeHandle(
    ipc, 'friend:switchToRelay',
    (_e, uid: unknown, transferId: unknown) => {
      if (typeof uid !== 'number' || typeof transferId !== 'string') return { ok: false, error: '参数不合法' }
      return withFriends((f) => f.switchToRelay(uid, transferId))
    },
    { ok: false, error: '切换中继失败' }
  )

  // 发送方撤回待同意邀请：删登记 + 通知对端 + 本端卡片置 canceled
  safeHandle(
    ipc, 'friend:cancelFileInvite',
    (_e, uid: unknown, transferId: unknown) => {
      if (typeof uid !== 'number' || typeof transferId !== 'string') return { ok: false, error: '参数不合法' }
      return withFriends((f) => f.cancelFileInvite(uid, transferId))
    },
    { ok: false, error: '撤回失败' }
  )

  // 定位已下载文件（done 卡片上的"打开位置"）：resolve 后在系统文件管理器中展示
  safeHandle(
    ipc, 'friend:openFileLocation',
    (_e, uid: unknown, transferId: unknown) => {
      if (typeof uid !== 'number' || typeof transferId !== 'string') return { ok: false, error: '参数不合法' }
      const res = withFriends((f) => f.openFileLocation(uid, transferId))
      if (!res.ok || !res.path) return res
      const p = res.path
      void shell.showItemInFolder(p)
      return { ok: true as const }
    },
    { ok: false, error: '打开位置失败' }
  )
}