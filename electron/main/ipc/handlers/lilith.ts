/**
 * 莉莉丝 IPC：设置页「莉莉丝」Tab 的检测/保存/启动/状态查询通道，
 * 桥接 lilith-launcher 服务与渲染进程，让用户配置游戏路径并拉起 companion。
 */
import { app, type IpcMainInvokeEvent } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import type { ConfigStore } from '../../api/config-store'
import type { ToolPolicy } from '@shared/types/tool-policy'
import type { LilithConfig } from '@shared/types/lilith'
import { detectGame, hasMod, getStatus, launch } from '../../services/lilith-launcher'

/**
 * 莉莉丝 IPC handler：设置页「莉莉丝」Tab 的检测/保存/启动/状态。
 *
 * 前端调用面（SettingsPanel LilithConnectSection）：
 * lilith:detect → { found, dir, hasMod, path }
 * lilith:save → 写 config.lilith { gamePath, autoStart }（持久化）
 * lilith:launch → 拉起 Lilith.exe（MOD 完整时）
 * lilith:status → { gamePath, gameExists, modExists, gameRunning, gamePid, companionRunning, companionPort, modValid }
 */
export function registerLilithHandlers(
  ipc: typeof import('electron').ipcMain,
  configStore: ConfigStore,
  /**
   * 启动前补同步 MOD 配置（把月蚀端口写进 %APPDATA%\LilithAI\config.json 并通知已在跑的 companion）。
   * 为什么放在 handler 参数里：桥接的冷启动执行挂在「随月蚀启动」开关上——关了就完全不碰莉莉丝；
   * 但用户仍可手动启动桌宠，那一刻必须补一次，否则 companion 读到旧 provider → 游戏内莉莉丝连不上月蚀。
   */
  onBeforeLaunch?: () => void
): void {
  // 自动检测游戏本体（扫描常见路径）
  ipc.handle('lilith:detect', () => {
    const r = detectGame()
    return { found: r.found, dir: r.dir, hasMod: r.hasMod, path: r.path }
  })

// 保存连接配置（gamePath + autoStart + 总开关 + 人设等，持久化到 config.lilith）
  ipc.handle('lilith:save', async (_e: IpcMainInvokeEvent, opts: {
    gamePath?: string
    autoStart?: boolean
    enabled?: boolean
    persona?: string
    mode?: 'character' | 'agent'
    toolPolicy?: Record<string, ToolPolicy>
    useAdapter?: boolean
    apiPort?: number
  } = {}) => {
    try {
      const cfg = configStore.get()
      const prev: LilithConfig = cfg.lilith ?? { gamePath: '', autoStart: false }
      const gamePath = String(opts.gamePath ?? prev.gamePath ?? '').trim()
      const autoStart = opts.autoStart ?? prev.autoStart ?? false
      const next = {
        ...cfg,
        lilith: {
          // 展开式合并：不能整体赋值——lilith 配置还有 mode/persona/toolPolicy/useAdapter，
          // 只写传入字段，未传入的保留现值（原实现：lilith:save 只认三字段 →
          // 用户点「保存连接」后 enabled/persona 等高级配置静默丢失，开关/人设不生效）
          ...prev,
          gamePath,
          autoStart,
          apiPort: prev.apiPort ?? 62002,
          // 仅当显式传入时更新（避免 `??` 把 undefined 与 false 混淆：enabled 显式 false 必须落盘）
          ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
          ...(opts.persona !== undefined ? { persona: opts.persona } : {}),
          ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
          ...(opts.toolPolicy !== undefined ? { toolPolicy: opts.toolPolicy } : {}),
          ...(opts.useAdapter !== undefined ? { useAdapter: opts.useAdapter } : {}),
          ...(opts.apiPort !== undefined ? { apiPort: opts.apiPort } : {})
        }
      }
      configStore.save(next)
      return { ok: true, gamePath, autoStart }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // 启动莉莉丝桌宠（MOD 完整时；已运行则返回 alreadyRunning）
  ipc.handle('lilith:launch', async () => {
    const cfg = configStore.get()
    const gameDir = cfg.lilith?.gamePath ?? ''
    if (!gameDir || !hasMod(gameDir)) {
      return { ok: false, error: 'MOD 缺失或路径未配置，无法以桌宠模式启动' }
    }
    // 用户主动启动了 → 先把月蚀端口同步进 MOD 配置，再拉起（关着「随月蚀启动」时冷启动不会写）
    onBeforeLaunch?.()
    return launch(gameDir)
  })

  // 连接状态（设置页状态灯 + 检测后用）
  ipc.handle('lilith:status', async () => {
    const cfg = configStore.get()
    const appDataDir = app.getPath('appData')
    const detected = detectGame()
    // getStatus 为 async（进程探测走子进程，不阻塞主进程）；ipcMain.handle 本身就支持返回 Promise
    const status = await getStatus(appDataDir)
    // 已配置路径优先显示；未配置时显示检测结果
    const gamePath = cfg.lilith?.gamePath || detected.dir || ''
    // gameExists 原实现 `hasMod(...) || true` 恒 true（配置了路径就绿灯，
    // 路径是垃圾也显示「已找到」）——改为真实校验：gameExists=目录有 Lilith.exe（本体），
    // modExists=目录有 MOD 插件（hasMod）。两灯独立，排查时能分清「本体缺」还是「MOD 缺」
    const gamePathReal = cfg.lilith?.gamePath ?? ''
    const gameExists = gamePathReal
      ? existsSync(join(gamePathReal, 'Lilith.exe'))
      : detected.found
    const modExists = gamePathReal ? hasMod(gamePathReal) : detected.hasMod
    return {
      gamePath,
      gameExists,
      modExists,
      // 复用 getStatus 已算好的进程探测结果：原先这里再调一次 isGameRunning()，
      // 两次调用落在同一个 5s 缓存窗口内，纯属重复（见 lilith-launcher 的 probeGameProc）
      gameRunning: status.gameRunning,
      gamePid: status.gamePid,
      companionRunning: status.companionRunning,
      companionPort: status.companionPort,
      modValid: modExists
    }
  })
}
