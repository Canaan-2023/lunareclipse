/**
 * @category 工具
 * @summary 中继异步传输（L1.5 大云盘）IPC 注册
 * 为什么存在：渲染层经 IPC 发起"选择文件并上传到主系统中继""确认取件""撤回""刷新清单"，
 * 文件/文件夹选择在主进程 dialog 完成（渲染层无 Node 权限拿不到路径），统计与流式上传
 * 复用 RelayService 的流式能力；进度经 'relay:event' 事件推送（progress/entry/error）。
 */
import { dialog, BrowserWindow } from 'electron'
import type { ipcMain as ipcMainType } from 'electron'
import { statSync } from 'fs'
import { basename } from 'path'
import { safeHandle } from '../../ipc/handlers/safe-handle'
import { walkDirectorySafe } from '../lan/lan-stream'
import type { RelayService } from '../relay/relay-service'

/** 中继域所需上下文：RelayService 门面 getter + 主窗口（作为 dialog 父窗口） */
export interface RelayIpcCtx {
  getRelay(): RelayService | null
  getMainWindow(): BrowserWindow | null
}

/** 选择器返回的上传对象统计（登记与展示共用；与 sendDirectory 统计口径一致） */
interface PickedUpload {
  path: string
  name: string
  kind: 'file' | 'dir'
  totalBytes: number
  files: number
  dirs: number
}

/** 打开系统选择器并统计上传对象（文件或整目录）；取消返回 null */
async function pickUploadObject(win: BrowserWindow | null, mode: 'file' | 'dir'): Promise<PickedUpload | null> {
  const title = mode === 'dir' ? '选择要上传到主系统中继的文件夹' : '选择要上传到主系统中继的文件'
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

/** 注册中继传输 IPC 通道 */
export function registerRelayIpc(ipc: typeof ipcMainType, ctx: RelayIpcCtx): void {
  const withRelay = <T>(fn: (r: RelayService) => T): T | { ok: false; error: string } => {
    const relay = ctx.getRelay()
    if (!relay) return { ok: false, error: '局域网协作未启动' }
    try {
      return fn(relay)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  // 清单 + 运行信息（角色/下载位置/保留策略；UI 首屏与设置区共用）
  safeHandle(
    ipc, 'relay:list',
    () =>
      withRelay((r) => ({
        ok: true as const,
        list: r.list(),
        info: r.getInfo()
      })),
    { ok: false, error: '读取中继清单失败' }
  )

  // 选择文件/文件夹并上传到主系统中继（一次性：选择 → 统计 → 登记 → 流式上传；进度经事件推送）
  safeHandle(
    ipc, 'relay:pickAndUpload',
    async (_e, receiverUid: unknown, mode: unknown) => {
      if (typeof receiverUid !== 'number' || (mode !== 'file' && mode !== 'dir')) {
        return { ok: false, error: '参数不合法' }
      }
      const win = ctx.getMainWindow()
      const picked = await pickUploadObject(win, mode)
      if (!picked) return { ok: false, canceled: true }
      return withRelay(async (r) => {
        const begin = r.beginUpload({
          receiverUid,
          kind: picked.kind,
          name: picked.name,
          totalBytes: picked.totalBytes,
          files: picked.files,
          dirs: picked.dirs
        })
        if (!begin.ok || !begin.itemId) return begin
        const itemId = begin.itemId
        const up =
          mode === 'dir'
            ? await r.uploadDirectory(picked.path, { itemId, name: picked.name })
            : await r.uploadFile(picked.path, { itemId, name: picked.name })
        if (!up.ok) return { ok: false, itemId, error: up.error ?? '上传失败' }
        return {
          ok: true as const,
          itemId,
          name: picked.name,
          kind: picked.kind,
          totalBytes: picked.totalBytes,
          files: picked.files,
          dirs: picked.dirs
        }
      })
    },
    { ok: false, error: '上传失败' }
  )

  // 确认取件：接收端确认后主系统把中继文件流式回发到自定义下载位置（下载独立于上传）
  safeHandle(
    ipc, 'relay:confirm',
    (_e, itemId: unknown) => {
      if (typeof itemId !== 'string') return { ok: false, error: '参数不合法' }
      return withRelay((r) => r.confirm(itemId))
    },
    { ok: false, error: '确认失败' }
  )

  // 撤回未取件的上传（文件已下载则拒绝退回）
  safeHandle(
    ipc, 'relay:revoke',
    (_e, itemId: unknown) => {
      if (typeof itemId !== 'string') return { ok: false, error: '参数不合法' }
      return withRelay((r) => r.revoke(itemId))
    },
    { ok: false, error: '撤回失败' }
  )

  // 运行信息（独立通道：设置面板轮询/初始化用，不依赖清单）
  safeHandle(
    ipc, 'relay:info',
    () => withRelay((r) => ({ ok: true as const, info: r.getInfo() })),
    { ok: false, error: '读取中继信息失败' }
  )
}