/**
 * @category 核心
 * @summary 退出链：window-all-closed 与 before-quit 的逆序清理（含防重入与逐步容错）
 *
 * 为什么存在：退出清理此前内联在 `index.ts`（约 80 行），是**逆序释放**的长链——顺序错一步
 * 就会出现「已停的服务被再次调用」或「端口/句柄泄漏」。抽成独立模块后，退出链的顺序在本文件
 * 内作为阅读顺序显式可见，且与启动装配（`service-assembly.ts`）对称：启动正序装配、退出逆序拆卸。
 *
 * 什么作用：导出 `installQuitChain(state, deps)`，由 `index.ts` 顶层调用一次，注册两个监听器。
 *
 * 不删理由：删掉即这 80 行退回入口；且本链有两条**必须保留**的保底语义——
 * ①「每步独立 try/catch」：原实现无 try/catch，单步抛错会让应用永久挂死（`app.quit()` 永不执行）；
 * ②「权限绿通保底」：用户完全关闭时把绿通重置为 false，防止 AI 抽风无限重启。
 *
 * 与 ADR 预估的差异：ADR §3 写 `runQuitChain(state, deps, event)` + `installWindowAllClosed(app)`。
 * 落地为**单一入口** `installQuitChain` 且 `runQuitChain` 私有——清理末步要
 * `app.removeListener('before-quit', <同一函数引用>)`，把注册与卸载拆成两个导出函数会迫使调用方
 * 自己持有 handler 引用（更易错）。行为与顺序完全不变。
 *
 * 顺序约束：`recordShutdown` 必须最先（即使后续清理失败，AI 也能从提示词知道上次何时关闭）；
 * `timerRegistry.stopAll` 必须最后（带 5 秒超时保护，避免某个 stop 卡住退出流程）。
 */
import { app } from 'electron'
import type { AppState } from './app-state'
import type { BootstrapDeps } from './deps'
import { isGreenlight } from './deps'
import { closeApiServer } from '../api/server'
import { recordShutdown } from '../api/restart-pending'
import { browserViewManager } from '../tools/browser-view-manager'
import { logError } from '../services/crash-logger'

export function installQuitChain(state: AppState, deps: BootstrapDeps): void {
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  // 注册具名 handler：清理末步需要以同一引用 removeListener（避免循环触发 before-quit）。
  // **必须返回 runQuitChain 的 Promise**：原实现把 async 的 onBeforeQuit 直接注册，
  // 调用方 `await handler(event)` 会等清理完成；若包成不返回 Promise 的箭头函数，
  // await 立刻返回 undefined（startup-chain.test.ts 的释放链断言据此变红——实测抓到）。
  const handler = (event: Electron.Event): Promise<void> =>
    runQuitChain(state, deps, event, () => app.removeListener('before-quit', handler))
  app.on('before-quit', handler)
}

async function runQuitChain(
  state: AppState,
  deps: BootstrapDeps,
  event: Electron.Event,
  detach: () => void
): Promise<void> {
// 防重入：用户快速连点关闭或系统重复触发时，避免清理逻辑并发执行
if (state.quitting) {
  event.preventDefault()
  return
}
state.quitting = true
// 文档 15.5：应用退出时清理所有资源，避免端口/句柄泄漏
// 阻止默认退出流程，等异步清理完成后再退出（避免定时器/句柄泄漏）
event.preventDefault()

// 每个清理步骤独立 try/catch：任一步骤抛错不阻塞后续步骤，
// 确保 app.quit() 必执行（原实现无 try/catch，单步抛错会导致应用永久挂死）
const safe = async (label: string, fn: () => unknown | Promise<unknown>): Promise<void> => {
  try {
    await fn()
  } catch (err) {
    logError('onBeforeQuit:' + label, err)
  }
}

// 生命周期记录：关闭时间 + 原因（AI 自我重启 vs 用户关闭）
// 必须最先写——即使后续清理失败，AI 也能从提示词知道上次何时关闭
try {
  if (state.lifecycleActivationDir) {
    recordShutdown(state.lifecycleActivationDir, state.aiRestarting ? 'ai-restart' : 'user-quit')
  }
} catch (err) {
  console.error('[lifecycle] 写入关闭记录失败:', err)
}

// 权限绿通保底：用户完全关闭（非 AI 自我重启）→ 重置绿通为 false
// AI 自我重启（aiRestarting=true）→ 保留绿通（新进程继续可用）
// 这样即使 AI 抽风无限重启，只要用户手动关闭应用，下次打开绿通自动关闭
if (!state.aiRestarting && isGreenlight(deps.configStore)) {
  await safe('greenlight.reset', () => {
    const cfg = deps.configStore.get()
    deps.configStore.save({ ...cfg, permissionGreenlight: false })
    console.log('[greenlight] 用户完全关闭应用，权限绿通已重置为 false')
  })
}

await safe('supervisor.stop', () => state.supervisor?.stop())
await safe('multiInstance.stopSync', () => state.multiInstance?.stopSync())
await safe('multiInstance.stopLan', () => state.multiInstance?.stopLan())
await safe('healthCheck.stop', () => state.healthCheck?.stop())
await safe('uiHealthMonitor.stop', () => state.uiHealthMonitor?.stop())
await safe('pathSyncMonitor.stop', () => state.pathSyncMonitor?.stop())
await safe('collaborationScheduler.stop', () => state.collaborationScheduler?.stop())
await safe('activationManager.stop', () => state.activationManager?.stop())
await safe('autoCleanup.stop', () => state.autoCleanup?.stop())
await safe('sessionStore.flush', () => deps.sessionStore.flush())
// 关闭 API server（HTTP + WebSocket）
await safe('closeApiServer', () => closeApiServer())
// 关闭莉莉丝协议适配器（释放 6186 端口）
if (state.lilithAdapter) {
  await safe('lilithAdapter.stop', () => state.lilithAdapter!.stop())
  state.lilithAdapter = null
}
// 销毁浏览器视图（关闭 webContents 防止泄漏）
await safe('browserViewManager.destroyView', () => browserViewManager.destroyView())
// 断开所有 MCP server 连接（关闭子进程 / HTTP 连接）
await safe('mcpClientManager.disconnectAll', () => state.mcpClientManager?.disconnectAll())
// 沙箱 coeffect 句柄回滚（移除服务提供，触发依赖方重载回退）
await safe('sandboxCoeffect.dispose', () => state.sandboxCoeffectHandle?.dispose())
// 卸载全部已挂载 Cordis 模块（逆序卸载，清理 fiber 副作用）
await safe('detachCordis', () => state.detachCordis?.())

// 统一清理所有定时器（带 5 秒超时保护，避免某个 stop 卡住退出流程）
await safe('timerRegistry.stopAll', () => state.timerRegistry.stopAll())

// 清理完成，移除监听器并退出（避免循环触发 before-quit）
// 清理完成，移除监听器并退出（避免循环触发 before-quit）
detach()
app.quit()
}
