/**
 * 为什么存在：生产环境加载 file:// 协议，渲染进程 navigator.clipboard 在非
 * secure context 下不可用（且写入静默失败无反馈）；统一走主进程 Electron
 * clipboard 桥，非 Electron 环境（如纯浏览器调试）回退 navigator.clipboard。
 * 作用：文本复制统一入口，返回是否成功供调用方做 UI 反馈（不再静默吞错）。
 */
export async function copyText(text: string): Promise<boolean> {
  const bridge = (window as unknown as { lunareclipse?: { clipboardWriteText?: (t: string) => Promise<boolean> } })
    .lunareclipse?.clipboardWriteText
  if (bridge) {
    try {
      const ok = await bridge(text)
      if (ok) return true
    } catch {
      // 桥调用失败（主进程未就绪等）继续走回退
    }
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // writeText 被拒绝（权限/非 secure context）继续走 execCommand 兜底
    }
  }
  // 最后兜底：execCommand 兼容极老 WebView（极少见，保底可复制）
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}