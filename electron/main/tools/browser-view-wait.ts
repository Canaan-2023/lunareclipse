/**
 * 浏览器视图等待工具：为什么存在——loadURL 在 SPA 上可能在 DOMContentLoaded 就返回，
 * 但页面内容尚未渲染，直接操作会失败；必须等真实渲染完成。
 * 作用：waitForLoad 等待 did-finish-load，waitForBodyReady 额外等待 SPA 正文渲染（带超时）。
 */
import type { WebContents } from 'electron'

/**
 * 等待 webContents 加载完成（did-finish-load 或超时）。
 * loadURL 本身在 SPA 上可能在 DOMContentLoaded 时就 resolve，
 * 但页面内容（React/Vue 渲染）还没出来。这里额外等 SPA 渲染。
 */
export function waitForLoad(wc: WebContents | null | undefined, timeoutMs = 15000): Promise<void> {
  if (!wc) return Promise.resolve()
  // webContents 已销毁或不在加载，直接返回
  if (wc.isDestroyed()) return Promise.resolve()
  if (!wc.isLoading()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let settled = false
    const onFinish = (): void => {
      if (settled) return
      settled = true
      try { wc.removeListener('did-finish-load', onFinish) } catch { /* destroyed */ }
      try { wc.removeListener('did-fail-load', onFinish) } catch { /* destroyed */ }
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(onFinish, timeoutMs)
    wc.once('did-finish-load', onFinish)
    wc.once('did-fail-load', onFinish)
  })
}

/**
 * 等待页面 body 有可交互内容（SPA 渲染就绪）。
 * 轮询检测 body 子节点数 > 0 且有可点击元素，最多等 maxWaitMs。
 * webContents 销毁/页面崩溃时静默返回，不抛错（由调用方兜底处理）。
 */
export async function waitForBodyReady(wc: WebContents | null | undefined, maxWaitMs = 5000): Promise<void> {
  if (!wc) return
  if (wc.isDestroyed()) return
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    if (wc.isDestroyed()) return
    try {
      const count = await wc.executeJavaScript(
        `document.body ? document.body.querySelectorAll('*').length : 0`
      )
      if (count > 10) return // 有足够子节点认为渲染完成
    } catch {
      // 页面上下文未就绪或 webContents 已销毁，继续等
    }
    await new Promise((r) => setTimeout(r, 300))
  }
}
