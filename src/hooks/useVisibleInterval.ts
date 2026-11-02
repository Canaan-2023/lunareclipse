/**
 * 为什么存在：监控可视化、消息服务状态、MCP 连接状态等面板都用 setInterval 轮询，
 * 但窗口最小化/切到后台（document.visibilityState === 'hidden'）时仍然照跑 IPC，
 * 纯后台开销且没有用户在看。本 hook 统一把「可见才轮询、恢复立即补一次」封装起来，
 * 避免每个调用点各写一遍 visibilitychange 监听与清理。
 * 作用：enabled 为 true 时按 delayMs 轮询；窗口隐藏时暂停，恢复可见时先立即执行一次再继续轮询；
 * 卸载或 disabled 时清理计时器与监听。
 * 回调经 ref 持有：调用方传入内联箭头函数也不会因每次渲染重建而重置计时器。
 */
import { useEffect, useRef } from 'react'

export function useVisibleInterval(
  callback: () => void,
  delayMs: number,
  enabled = true
): void {
  const cbRef = useRef(callback)
  useEffect(() => {
    cbRef.current = callback
  }, [callback])

  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setInterval> | null = null

    const start = () => {
      if (timer !== null) return
      timer = setInterval(() => {
        // 双保险：个别平台切后台时 visibilitychange 可能晚于下一次 tick
        if (document.visibilityState === 'visible') cbRef.current()
      }, delayMs)
    }
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // 恢复可见时立即补一次，避免等满一个周期才看到新数据
        cbRef.current()
        start()
      } else {
        stop()
      }
    }

    // 初始若就是隐藏态（后台启动），等首次变为可见再开始，期间不做无谓轮询
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [delayMs, enabled])
}
