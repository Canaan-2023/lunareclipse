/**
 * @category ROOM
 * @summary 像素形象 IPC：`room:avatar-get`（读 AI 拟人化像素规格）
 *
 * 为什么存在：`RoomScene`（渲染进程）需要读 AI 的像素规格才能画出房间与形象；单一真源在主进程
 * （`<data>/room/avatar.json`，经 `AvatarStore` 校验后回落默认）。
 *
 * 读通道**不设门控**：形象是本地可视化数据、只读且已校验（见 `@shared/room/avatar-spec`）。
 * 写通道（P3「AI 决定像素点」）才需要 `t2.room-avatar` 门控 + 审计。
 *
 * 不删理由：删掉即渲染端拿不到规格，房间只能显示写死的图。
 */
import type { ipcMain as IpcMainType } from 'electron'
import { join } from 'path'
import type { BaseDataPaths } from '../../models/paths'
import type { RoomAvatarSpec } from '@shared/room/avatar-spec'
import { AvatarStore } from '../../room/avatar-store'
import { DEFAULT_AVATAR_SPEC } from '../../room/default-art'
import { safeHandle } from './safe-handle'

export interface RoomAvatarHandlerDeps {
  getDataPaths: () => BaseDataPaths | null
}

export function registerRoomAvatarHandlers(ipc: typeof IpcMainType, deps: RoomAvatarHandlerDeps): void {
  const store = (): AvatarStore | null => {
    const paths = deps.getDataPaths()
    return paths ? new AvatarStore(join(paths.root, 'room')) : null
  }

  safeHandle<{ ok: boolean; spec: RoomAvatarSpec }>(
    ipc,
    'room:avatar-get',
    () => {
      const s = store()
      return { ok: true, spec: s ? s.load() : DEFAULT_AVATAR_SPEC }
    },
    { ok: false, spec: DEFAULT_AVATAR_SPEC }
  )
}
