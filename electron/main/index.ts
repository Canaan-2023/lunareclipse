/**
 * @category 核心
 * @summary 主进程入口：生命周期注册与启动顺序编排（装配/退出链/重定向均已外移 bootstrap/）
 *
 * 为什么这么薄：入口只回答两个问题——**何时启动**（`whenReady` → 单实例守卫 → `runServiceAssembly`）
 * 与**何时退出**（`installQuitChain`）。所有装配、清理、路径解析都在 `bootstrap/` 下的具名模块里，
 * 见各模块头注释（ADR-01 六步拆分）。
 *
 * **顶层顺序即语义（改动前必读）**：
 * 1. `applyUserDataRedirect()` 必须最先——Electron 单实例锁按 userData 目录计算，
 *    config / session / 崩溃目录 / 缓存清理全部以 userData 为根；
 * 2. `createAppState()` 其次——`installPrelude` 的异常兜底要写 `state.healthCheck`、
 *    单实例锁的 `second-instance` 要读 `state.mainWindow`；
 * 3. `installPrelude(state)` 再其次——GPU 策略 / 崩溃上报 / 全局异常兜底 / 缓存清理 /
 *    媒体 scheme / 单实例锁，全部必须在 `app.ready` 之前；
 * 4. `createRootContext()` 与其后的 `configStore` / `sessionStore` 必须在 userData 重定向之后
 *    （它们用 `app.getPath('userData')` 推导落点）。
 *
 * 对外导出面不变（ADR-01 §4）：`CURRENT_INSTANCE_NAME` / `IS_CUSTOM_INSTANCE` / `BASE_USER_DATA`
 * / `rootCtx` 四个符号仍在，前三个由 `runtime-paths` 计算后 re-export。
 */
import { app, dialog } from 'electron'
import { join } from 'path'
import { applyUserDataRedirect } from './bootstrap/runtime-paths'
import { createAppState } from './bootstrap/app-state'
import { installPrelude } from './bootstrap/prelude'
import { runServiceAssembly } from './bootstrap/service-assembly'
import { installQuitChain } from './bootstrap/quit-chain'
import type { BootstrapDeps } from './bootstrap/deps'
import { createRootContext } from './kernel/cordis-runtime'
import { browserManager } from './tools/browser-manager'
import { logError } from './services/crash-logger'
import { registerRoomAssetScheme } from './room/asset-protocol'

// 实例与 userData 重定向（实现与理由见 bootstrap/runtime-paths.ts）。对外导出面见文件头注释。
export { CURRENT_INSTANCE_NAME, IS_CUSTOM_INSTANCE, BASE_USER_DATA } from './bootstrap/runtime-paths'
applyUserDataRedirect()

// 启动期跨原子共享状态：26 个进程级引用收进类型化容器（见 bootstrap/app-state.ts）
const state = createAppState()

// 进程级前置（GPU / 崩溃上报 / 异常兜底 / 缓存清理 / 媒体 scheme / 单实例锁，顺序见该模块头注释）
const { primaryInstance } = installPrelude(state)
// ROOM 本地资源协议：**必须在 app ready 之前登记**（Electron 的 scheme 注册限制）
registerRoomAssetScheme()

// 月蚀 Cordis 运行时（阶段 2/3：ctx 服务容器 + 基础/核心服务，架构重构总闸）
// 后续新增的 ctx 服务从这里挂载；index.ts/server.ts 逐步改走 ctx 取服务（薄壳化）
export const rootCtx = createRootContext()
const configStore = rootCtx.config.init(join(app.getPath('userData'), 'config.json'))
const sessionStore = rootCtx.sessions.init(join(app.getPath('userData'), 'sessions'))

// 组合根共享依赖（bootstrap/deps.ts）：模块级组装一次，供装配原子与 IPC 层共用
const deps: BootstrapDeps = { configStore, sessionStore, rootCtx }

// 浏览器登录态持久化（storageState 存 {userData}/browser-state.json，模式 B）
browserManager.setStorageStatePath(join(app.getPath('userData'), 'browser-state.json'))

app
  .whenReady()
  .then(async () => {
    // 单实例锁屏保：非主实例（已有实例在运行）不执行任何启动初始化。
    // 关键约束：app.quit()（installPrelude 的 lock 失败分支）不会阻止 ready 事件触发，
    // 若这里继续跑装配，会在退出过程中留下未收尾的原生句柄
    // → `FATAL ERROR: Error::ThrowAsJavaScriptException`（exit 134）。
    // 主实例（primaryInstance=true）流程逐字节不变。
    if (!primaryInstance) {
      console.log('[single-instance] 已有实例在运行，本进程不初始化并退出')
      app.exit(0)
      return
    }

    await runServiceAssembly(state, deps)
  })
  .catch((err) => {
    // M7：初始化失败时不能静默——窗口可能已打开但无 API server / 无 IPC handler，
    // 应用处于不可用的残破状态。记录日志 + 弹窗告知用户 + 退出，避免用户面对无响应界面。
    logError('app.whenReady', err)
    console.error('[main] app.whenReady initialization failed:', err)
    dialog.showErrorBox(
      '月蚀启动失败',
      `应用初始化过程中发生错误，无法继续运行：\n\n${(err as Error)?.message ?? String(err)}\n\n请查看日志文件：{userData}/logs/main-errors.log\n请联系开发者或重启应用。`
    )
    app.quit()
  })

// 退出链（window-all-closed + before-quit 逆序清理，见 bootstrap/quit-chain.ts）
installQuitChain(state, deps)
