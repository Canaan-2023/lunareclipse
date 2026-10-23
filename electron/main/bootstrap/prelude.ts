/**
 * @category 核心
 * @summary 进程级前置：GPU 策略、崩溃上报、全局异常兜底、缓存清理、媒体 scheme、单实例锁
 *
 * 为什么存在：这些调用必须在 `app.ready` 之前按固定顺序执行，且顺序本身承载语义——
 * 抽成 `installPrelude(state)` 后，顺序作为本文件内的阅读顺序显式可见（ADR-01 第 6 步）。
 *
 * 什么作用：返回 `{ primaryInstance }` 供 `index.ts` 的 `whenReady` 守卫读取
 * （false = 已有实例在运行，本进程只负责唤醒已有窗口后退出）。
 *
 * 不删理由：删掉即这 6 段顺序敏感代码退回入口；顺序错一步的后果见下方逐条说明。
 *
 * **顺序约束（不得重排）**：
 * 1. `uncaughtException` / `unhandledRejection` 处理器必须**早于** `cleanStaleCaches`——
 *    缓存清理遇文件被占用会抛 EBUSY，无人兜底则 Electron 直接弹框退出（"打不开"）；
 * 2. `cleanStaleCaches` 必须在 Chromium 真正使用缓存目录之前（即 app ready 前）；
 * 3. `registerMediaScheme()` 必须在 app ready 前（`registerSchemesAsPrivileged` 硬性要求）；
 * 4. 单实例锁必须在 userData 重定向**之后**（锁按 userData 目录计算，见 `runtime-paths.applyUserDataRedirect`）。
 */
import { app } from 'electron'
import type { AppState } from './app-state'
import { startCrashReporter, logError } from '../services/crash-logger'
import { cleanStaleCaches } from '../startup-helpers'
import { registerMediaScheme } from '../api/gen/media-protocol'

/** 单实例锁结果：false = 已有实例在运行（本进程仅负责唤醒已有窗口后退出） */
export interface PreludeResult {
  primaryInstance: boolean
}

/** 执行进程级前置；必须在 `app.ready` 之前、且 userData 重定向之后调用一次 */
export function installPrelude(state: AppState): PreludeResult {
  // GPU 策略：恢复硬件加速。
  // 历史：曾全局 disable-gpu 规避 Windows 下 Chromium 创建/迁移 GPU 缓存目录的权限问题，
  // 但 cleanStaleCaches()（下方）已在启动时清理缓存目录，权限问题主因已兜住。
  // 保留 shader/program 磁盘缓存禁用（不让 Chromium 写缓存目录，继续规避权限问题），
  // 移除 disable-gpu 与 enable-unsafe-swiftshader：
  // ①硬件 GPU（本机 RTX 4060）可用，主窗口合成走硬件加速，内存稳定；
  // ②实测 enable-unsafe-swiftshader 全局开启会让 GPU 进程整条合成管线走软件渲染，
  // 主窗口 2D 合成/CSS 动画全吃进程内存，11 分钟暴涨 13GB → renderer OOM（15:43/15:57/16:06 三连崩），
  // webPreferences.webgl=false 只禁 JS WebGL API、禁不了合成管线，挡不住；
  // ③各窗口 WebGL 上下文在硬件加速下正常创建，不再需要 swiftshader 软渲染。
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
  app.commandLine.appendSwitch('disable-gpu-program-cache')

  // 禁用网络服务沙箱：Chromium 网络服务沙箱在 Windows 上对自定义 userData 路径下的
  // Network/Cache/Shared Dictionary 目录设置 ACL 时报 0x5（拒绝访问），即使 cleanStaleCaches
  // 清理了残留文件仍可能因父目录权限继承失败。禁用沙箱后网络服务以进程级权限运行，
  // 对本地桌面应用安全风险可接受。
  app.commandLine.appendSwitch('disable-features', 'NetworkServiceSandbox')

  // 启用原生崩溃捕获（必须在 app.ready 前调用）：dump 写入 {userData}/crashes
  // 解决原生层崩溃（segfault/OOM/Chromium 级）无 dump、无线索的"静默闪退"问题
  startCrashReporter()

  // 全局异常处理器：捕获未处理的异常和 Promise rejection，避免进程静默崩溃
  // 长时间运行的应用中，定时器回调、WebSocket 处理、记忆工作流工具执行都可能抛出异步错误，
  // 没有这些处理器会导致进程直接退出（闪退）
  // 持久化到 {userData}/logs/main-errors.log，重启后可回溯崩溃原因
  // 注意：必须最先注册（早于 cleanStaleCaches 等启动期有副作用的调用），
  // 否则启动早期抛出的异常（如缓存目录被占用 EBUSY）无人兜底 → Electron 弹框且进程退出
  process.on('uncaughtException', (err) => {
    logError('uncaughtException', err)
    // 接入健康检查：指纹去重 + 冷却 + 事件唤醒 AI（healthCheck 在 whenReady 后初始化，此前触发走可选链安全跳过）
    state.healthCheck?.reportRuntimeEvent(
      'uncaughtException',
      err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
    )
  })
  process.on('unhandledRejection', (reason) => {
    logError('unhandledRejection', reason)
    state.healthCheck?.reportRuntimeEvent(
      'unhandledRejection',
      reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason)
    )
  })

  // 清理上次运行残留的 Chromium 缓存目录（GPUCache/Network/Cache 等）。
  // 必须在异常处理器注册之后执行：rmSync 遇文件被占用（已有实例仍在运行）时抛 EBUSY，
  // 若无人兜底会直接弹 "A JavaScript error occurred" 并退出（"打不开"）。已实例级容错 + handler 双保险。
  cleanStaleCaches(app.getPath('userData'))

  // ===== 单实例锁：防止多开导致 62002 端口冲突 → 新实例 API 起不来 → 前端显示登录界面 =====
  // 事故根因：无锁时可开多个实例，旧实例占 62002，新实例监听失败，
  // 前端连不上 WebSocket → authGetCurrentUser 失败 → 显示登录界面（无任何提示）。
  // 第二个实例启动时自动聚焦已有窗口并退出自身。
  // lune-media:// 特权 scheme 注册：必须在 app ready 之前（registerSchemesAsPrivileged 硬性要求）
  registerMediaScheme()
  const primaryInstance = app.requestSingleInstanceLock()
  if (!primaryInstance) {
    app.quit()
  } else {
    app.on('second-instance', () => {
      if (state.mainWindow) {
        if (state.mainWindow.isMinimized()) state.mainWindow.restore()
        state.mainWindow.focus()
      }
    })
  }

  return { primaryInstance }
}
