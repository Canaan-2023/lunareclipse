/**
 * 为什么存在：设置区与各面板里大量「提示条 N 秒后自动消失」的一次性计时器此前只用裸
 * `setTimeout` 触发，句柄既不保存也不清理——组件卸载后计时器仍在全局队列里跑到期，
 * 触发时对已卸载组件 setState（React 18 已不再告警，但句柄残留、白跑一趟）；
 * 同一提示源连续出现时，前一条的清除计时器还会把后一条提示提前清掉（提示条竞态）。
 * 作用：把这类计时器的句柄统一收进 ref——卸载时清理，重复调度时先取消上一个，
 * 同一组件同一提示源共用一个槽位（后到的提示重新计时，不会被旧计时器提前清掉）。
 * 适用范围：只为「一次性自动消失」提示设计。防抖落盘、重连退避、周期轮询等需要长期
 * 存活或跨渲染复用的计时器不适用——它们各自持有 ref（或走主进程 TimerRegistry）。
 */
import { useCallback, useEffect, useMemo, useRef } from 'react'

export interface TransientTimer {
  /** 调度一次自动消失：若上一个尚未触发则先取消（同一槽位只保留最新一次调度） */
  schedule: (fn: () => void, delayMs: number) => void
  /** 手动取消尚未触发的调度（组件卸载时自动调用） */
  cancel: () => void
}

export function useTransientTimer(): TransientTimer {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const schedule = useCallback(
    (fn: () => void, delayMs: number) => {
      // 同一槽位只保留最新一次调度：旧提示的清除计时器不得把新提示提前清掉
      cancel()
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        fn()
      }, delayMs)
    },
    [cancel]
  )

  // 卸载清理：句柄收在这里，组件消失后不再有计时器残留
  useEffect(() => cancel, [cancel])

  return useMemo(() => ({ schedule, cancel }), [schedule, cancel])
}