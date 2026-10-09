/**
 * @category 核心
 * @summary 多实例（P5）IPC：当前实例信息 + 启动新实例（多开入口）+ 删除/改名实例（实例管理）
 *
 * - instance:info → 当前实例名 / 是否 default / 已创建实例列表（扫默认 userData/instances/）
 * - instance:launch <name> → spawn 新进程带 --instance=<name>（多开：不同 userData → 不同单实例锁）
 * - instance:delete <name> → 删除实例（userData + dataDir 两目录；拒绝 default / 当前运行实例）
 * - instance:rename <old> <new> → 改名实例（两目录同步迁移；拒绝 default / 当前运行实例）
 *
 * 为什么存在：用户需要多开月蚀（不同配置/角色分配到不同实例），
 * 实例删除/改名涉及 userData + dataDir 两目录联动，集中在此处理——
 *
 * spawn 形态：
 * - dev（electron-vite）：process.execPath = electron.exe，需传 app 锚点目录
 * - 打包：process.execPath = 打包后 exe，直接带 --instance 参数
 * 继承 process.env（ELECTRON_RENDERER_URL 等 dev 环境变量原样传递），detached 独立于本进程生命周期。
 */
import { ipcMain, app } from 'electron'
import { spawn } from 'child_process'
import { mkdirSync } from 'fs'
import {
  INSTANCE_NAME_PATTERN,
  DEFAULT_INSTANCE,
  instanceUserData,
  listInstanceNames,
  removeInstanceDirs,
  renameInstanceDirs
} from '../../multi-instance/instance-args'
import { getInstanceRuntime } from '../../multi-instance/instance-runtime'
import { getAppAnchor } from '../../startup-helpers'

function instanceError(error?: string): { ok: false; error: string } {
  return { ok: false, error: error ?? '操作失败' }
}

export function registerInstanceHandlers(ipc: typeof ipcMain): void {
  // 当前实例信息 + 已创建实例列表（settings UI 多开入口展示用）
  ipc.handle('instance:info', () => {
    const rt = getInstanceRuntime()
    return {
      ok: true,
      name: rt.name,
      isDefault: rt.isDefault,
      baseUserData: rt.baseUserData,
      instances: listInstanceNames(rt.baseUserData)
    }
  })

  // 启动新实例：spawn 本应用带 --instance=<name>（多开）
  ipc.handle('instance:launch', (_event, rawName) => {
    const name = typeof rawName === 'string' ? rawName.trim() : ''
    if (!name) return { ok: false, error: '实例名不能为空' }
    if (name === DEFAULT_INSTANCE) return { ok: false, error: 'default 实例即当前应用，无需重复启动' }
    if (!INSTANCE_NAME_PATTERN.test(name)) {
      return { ok: false, error: '实例名仅允许字母/数字/下划线/连字符，长度 1-32' }
    }
    try {
      // 先建目录再起进程：新实例启动时 userData 已存在，避免 config/存储首次写盘路径断言
      const rt = getInstanceRuntime()
      mkdirSync(instanceUserData(rt.baseUserData, name), { recursive: true })
      const args = app.isPackaged
        ? [`--instance=${name}`]
        : [getAppAnchor(), `--instance=${name}`]
      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: 'ignore',
        env: process.env
      })
      // spawn 失败（exe 不可用/权限等）时不会同步抛错，而是异步 emit 'error'；
      // 无监听器会导致 unhandled 'error' 拖垮主进程，必须挂上并转为可回报的错误。
      child.on('error', (err) => {
        console.error(`[instance] spawn ${name} 失败:`, err.message)
      })
      child.unref()
      return { ok: true, name }
    } catch (err) {
      return { ok: false, error: `启动失败: ${(err as Error).message}` }
    }
  })

  // 删除实例：校验（非 default / 非当前运行 / 白名单 / 存在）后移除 userData + dataDir 两目录
  ipc.handle('instance:delete', (_event, rawName) => {
    const name = typeof rawName === 'string' ? rawName.trim() : ''
    if (!name) return instanceError('实例名不能为空')
    if (name === DEFAULT_INSTANCE) return instanceError('default 实例即当前应用，不能删除')
    if (!INSTANCE_NAME_PATTERN.test(name)) {
      return instanceError('实例名仅允许字母/数字/下划线/连字符，长度 1-32')
    }
    const rt = getInstanceRuntime()
    if (name === rt.name) return instanceError('不能删除当前正在运行的实例')
    if (!listInstanceNames(rt.baseUserData).includes(name)) {
      return instanceError(`实例 "${name}" 不存在`)
    }
    const res = removeInstanceDirs(rt.baseUserData, rt.baseDataDir, name)
    return res.ok ? { ok: true, name } : instanceError(`删除失败: ${res.error}`)
  })

  // 改名实例：校验（旧非 default/当前运行/存在，新白名单/不冲突）后同步迁移 userData + dataDir 两目录
  ipc.handle('instance:rename', (_event, rawOld, rawNew) => {
    const oldName = typeof rawOld === 'string' ? rawOld.trim() : ''
    const newName = typeof rawNew === 'string' ? rawNew.trim() : ''
    if (!oldName || !newName) return instanceError('实例名不能为空')
    if (oldName === DEFAULT_INSTANCE) return instanceError('default 实例即当前应用，不能改名')
    if (newName === DEFAULT_INSTANCE) return instanceError('新名称不能为 default（保留为默认实例）')
    if (oldName === newName) return instanceError('新旧名称相同')
    if (!INSTANCE_NAME_PATTERN.test(newName)) {
      return instanceError('实例名仅允许字母/数字/下划线/连字符，长度 1-32')
    }
    const rt = getInstanceRuntime()
    if (oldName === rt.name) return instanceError('不能改当前正在运行的实例名')
    const existing = listInstanceNames(rt.baseUserData)
    if (!existing.includes(oldName)) return instanceError(`实例 "${oldName}" 不存在`)
    if (existing.includes(newName)) return instanceError(`实例 "${newName}" 已存在`)
    const res = renameInstanceDirs(rt.baseUserData, rt.baseDataDir, oldName, newName)
    return res.ok ? { ok: true, oldName, name: newName } : instanceError(`改名失败: ${res.error}`)
  })
}