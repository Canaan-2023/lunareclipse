/**
 * @category 核心
 * @summary 工具区 IPC：AI 自造工具（声明式组合）的登记 / 启停 / 删除
 *
 * 为什么存在：交接单 §7 的工具区需要承载面；本通道是渲染进程读写工具区条目的入口。
 *
 * 不删理由：删掉即工具区只能手改 JSON。
 *
 * 权限口径：登记/启停是**用户路径**；AI 侧使用工具区产物走 `t1.tool-zone-enable`（执行器门控）。
 */
import type { ipcMain as IpcMainType } from 'electron'
import { join } from 'path'
import type { BaseDataPaths } from '../../models/paths'
import { ToolZoneStore, validateEntry, type ToolZoneEntry } from '../../room/tool-zone'
import { safeHandle, errorFallback } from './safe-handle'

export interface RoomToolZoneHandlerDeps {
  getDataPaths: () => BaseDataPaths | null
  /** 当前可调用的工具名（校验步骤工具用）；缺省空集合（则一切步骤都会被拒——安全默认） */
  getAllowedTools: () => readonly string[]
}

export function registerRoomToolZoneHandlers(ipc: typeof IpcMainType, deps: RoomToolZoneHandlerDeps): void {
  const store = (): ToolZoneStore | null => {
    const paths = deps.getDataPaths()
    return paths ? new ToolZoneStore(join(paths.root, 'room')) : null
  }

  safeHandle<{ ok: boolean; entries: ToolZoneEntry[] }>(
    ipc,
    'room:tool-zone-list',
    () => ({ ok: true, entries: store()?.load() ?? [] }),
    { ok: false, entries: [] }
  )

  /** 新增或更新（按 id 命中则覆盖） */
  safeHandle<{ ok: boolean; entries?: ToolZoneEntry[]; error?: string }>(
    ipc,
    'room:tool-zone-upsert',
    (_event, raw: unknown) => {
      const s = store()
      if (!s) return { ok: false, error: '数据目录未就绪' }
      const v = validateEntry(raw, deps.getAllowedTools(), Date.now())
      if (!v.ok) return { ok: false, error: v.error }
      const entries = s.load()
      const idx = entries.findIndex((e) => e.id === v.entry.id)
      if (idx >= 0) entries[idx] = v.entry
      else entries.push(v.entry)
      s.save(entries)
      return { ok: true, entries }
    },
    errorFallback('工具区保存失败')
  )

  safeHandle<{ ok: boolean; entries?: ToolZoneEntry[]; error?: string }>(
    ipc,
    'room:tool-zone-remove',
    (_event, id: unknown) => {
      const s = store()
      if (!s) return { ok: false, error: '数据目录未就绪' }
      const key = typeof id === 'string' ? id : ''
      const entries = s.load().filter((e) => e.id !== key)
      s.save(entries)
      return { ok: true, entries }
    },
    errorFallback('工具区删除失败')
  )

  safeHandle<{ ok: boolean; entries?: ToolZoneEntry[]; error?: string }>(
    ipc,
    'room:tool-zone-toggle',
    (_event, payload: unknown) => {
      const s = store()
      if (!s) return { ok: false, error: '数据目录未就绪' }
      const p = (payload ?? {}) as { id?: unknown; enabled?: unknown }
      const id = typeof p.id === 'string' ? p.id : ''
      const entries = s.load().map((e) => (e.id === id ? { ...e, enabled: p.enabled === true } : e))
      s.save(entries)
      return { ok: true, entries }
    },
    errorFallback('工具区启停失败')
  )
}
