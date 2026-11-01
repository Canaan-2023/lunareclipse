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
 * `timerRegistry.stopAll` 必须最后（纯同步 clear；退出链整体 deadline 由本文件 QUIT_DEADLINE_MS 看门狗兜底）。
 */
import { app } from 'electron'
import type { AppState } from './app-state'
import type { BootstrapDeps } from './deps'
import { isGreenlight } from './deps'
import { closeApiServer, flushPendingInternalSessionJobs } from '../api/server'
import { recordShutdown } from '../api/restart-pending'
import { browserViewManager } from '../tools/browser-view-manager'
import { logError } from '../services/crash-logger'
import { stopAllManagedRuns } from '../services/tool-run-registry'

/**
 * 退出链总预算（毫秒）。
 * 为什么必须：清理步骤是十来个 `await`（LAN socket close / MCP 子进程 / 浏览器视图销毁…），
 * 任一步骤不 settle 就会把 `before-quit` 永久挂住；而重入守卫会把用户之后的每次关闭都
 * `preventDefault` —— 表现是"窗口关了、进程还在，而且再也关不掉"。
 * 15s 是「正常清理远小于它、异常时用户愿意等」的折中；到点强制退出并记日志。
 */
const QUIT_DEADLINE_MS = 15000

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

// 总 deadline 看门狗：任一步骤然不 settle 时强制退出，避免"进程永远退不掉"（见常量注释）
const quitDeadlineTimer = setTimeout(() => {
  console.error(`[quit] 清理超过 ${QUIT_DEADLINE_MS}ms 未完成，强制退出（剩余步骤可能未执行）`)
  try {
    detach()
  } catch {
    /* detach 只移除监听器，失败也拦不住强制退出 */
  }
  app.quit()
}, QUIT_DEADLINE_MS)

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
// 取消记忆/日记工作流的在飞批次（stop 只停调度，已启动的实例需显式取消，
// 否则被硬杀在中间态、只能靠下次启动的崩溃恢复兜底）
await safe('supervisor.abortInFlight', () => state.supervisor?.abortInFlight())
await safe('multiInstance.stopSync', () => state.multiInstance?.stopSync())
await safe('multiInstance.stopLan', () => state.multiInstance?.stopLan())
await safe('healthCheck.stop', () => state.healthCheck?.stop())
await safe('uiHealthMonitor.stop', () => state.uiHealthMonitor?.stop())
await safe('pathSyncMonitor.stop', () => state.pathSyncMonitor?.stop())
await safe('collaborationScheduler.stop', () => state.collaborationScheduler?.stop())
await safe('activationManager.stop', () => state.activationManager?.stop())
await safe('autoCleanup.stop', () => state.autoCleanup?.stop())
await safe('sessionStore.flush', () => deps.sessionStore.flush())
// 停止后台托管任务（run_command / code_run 的子进程树；否则窗口关闭后仍留孤儿进程）
await safe('toolRunRegistry.stopAll', () => stopAllManagedRuns())
// 派发并等待内部会话维护队列（500ms 合并窗口内的待办；必须早于 closeApiServer——
// releaseServiceRefs 会置空 flush 引用）
await safe('internalSession.flush', () => flushPendingInternalSessionJobs())
// 关闭 API server（HTTP + WebSocket）
await safe('closeApiServer', () => closeApiServer())
// 销毁浏览器视图（关闭 webContents 防止泄漏）
await safe('browserViewManager.destroyView', () => browserViewManager.destroyView())
// 断开所有 MCP server 连接（关闭子进程 / HTTP 连接）
await safe('mcpClientManager.disconnectAll', () => state.mcpClientManager?.disconnectAll())
// 沙箱 coeffect 句柄回滚（移除服务提供，触发依赖方重载回退）
await safe('sandboxCoeffect.dispose', () => state.sandboxCoeffectHandle?.dispose())
// 卸载全部已挂载 Cordis 模块（逆序卸载，清理 fiber 副作用）
await safe('detachCordis', () => state.detachCordis?.())
// 销毁人工评分器（构造时注册了 eval:submitHumanGrade IPC；释放 pending 请求定时器）
await safe('humanGrader.destroy', () => state.humanGrader?.destroy())
// 销毁插件加载器（关闭 fs.watch 与 500ms reload 定时器，注销插件工具）
await safe('pluginLoader.destroy', () => state.pluginLoader?.destroy())

// 统一清理所有定时器（纯同步 clear，不阻塞；整体 deadline 由 QUIT_DEADLINE_MS 看门狗兜底）
await safe('timerRegistry.stopAll', () => state.timerRegistry.stopAll())

// 清理完成，移除监听器并退出（避免循环触发 before-quit）
clearTimeout(quitDeadlineTimer)
detach()
app.quit()
}
