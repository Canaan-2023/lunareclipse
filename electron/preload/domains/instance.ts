/**
 * 多实例多开（P5）preload 域。
 * 为什么存在：多开实例的 userData/dataDir 由主进程管理（spawn 新进程、迁移目录、拒绝删除
 * 运行中实例），渲染进程只能查询状态并下发启动/删除/改名指令。
 * 作用：暴露 window.lunareclipse.instance* 的实例信息/启动/删除/改名方法（调用面见下方原注释）。
 */
import { ipcRenderer } from 'electron'

/**
 * 多实例多开 preload 域（P5）。
 * window.lunareclipse.instance* 由本域暴露（spread 组合进主 api 对象）。
 * 调用面：InstanceSection（settings 多开入口：当前实例名 + 实例列表 + 启动新实例）。
 */
export const api = {
  /** 当前实例信息：name / isDefault / baseUserData / 已创建实例列表 */
  instanceGetInfo: () =>
    ipcRenderer.invoke('instance:info') as Promise<{
      ok: boolean
      name?: string
      isDefault?: boolean
      baseUserData?: string
      instances?: string[]
      error?: string
    }>,
  /** 启动（多开）新实例：spawn 本应用带 --instance=<name> */
  instanceLaunch: (name: string) =>
    ipcRenderer.invoke('instance:launch', name) as Promise<{ ok: boolean; name?: string; error?: string }>,
  /** 删除已创建的实例（userData + dataDir 两目录；拒绝 default / 当前运行实例） */
  instanceDelete: (name: string) =>
    ipcRenderer.invoke('instance:delete', name) as Promise<{ ok: boolean; name?: string; error?: string }>,
  /** 改名已创建的实例（两目录同步迁移；拒绝 default / 当前运行实例） */
  instanceRename: (oldName: string, newName: string) =>
    ipcRenderer.invoke('instance:rename', oldName, newName) as Promise<{
      ok: boolean
      oldName?: string
      name?: string
      error?: string
    }>
}