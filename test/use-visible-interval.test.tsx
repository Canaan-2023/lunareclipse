// @vitest-environment jsdom
/**
 * useVisibleInterval 回归。
 *
 * 为什么测：窗口隐藏时暂停轮询、恢复可见立即补刷是本轮渲染层优化的行为契约，
 * 且依赖 document.visibilityState 与 visibilitychange 事件这类 jsdom 可模拟的真实浏览器行为。
 */
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVisibleInterval } from '../src/hooks/useVisibleInterval'

function Probe({ cb, enabled = true, delay = 2000 }: {
  cb: () => void
  enabled?: boolean
  delay?: number
}) {
  useVisibleInterval(cb, delay, enabled)
  return null
}

let container: HTMLDivElement
let root: Root
let visibility: DocumentVisibilityState

/** jsdom 的 visibilityState 是只读 getter，这里用实例自有属性覆盖以便模拟隐藏态 */
function setVisibility(next: DocumentVisibilityState) {
  visibility = next
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('useVisibleInterval', () => {
  it('可见时按周期执行回调', () => {
    const cb = vi.fn()
    act(() => { root.render(<Probe cb={cb} />) })
    expect(cb).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(2000) })
    expect(cb).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(4000) })
    expect(cb).toHaveBeenCalledTimes(3)
  })

  it('窗口隐藏时暂停，不再触发回调', () => {
    const cb = vi.fn()
    act(() => { root.render(<Probe cb={cb} />) })
    act(() => { vi.advanceTimersByTime(2000) })
    expect(cb).toHaveBeenCalledTimes(1)

    act(() => { setVisibility('hidden') })
    act(() => { vi.advanceTimersByTime(10000) })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('恢复可见时立即补刷一次，然后继续轮询', () => {
    const cb = vi.fn()
    act(() => { root.render(<Probe cb={cb} />) })
    act(() => { setVisibility('hidden') })
    act(() => { setVisibility('visible') })
    expect(cb).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(2000) })
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('enabled=false 时不轮询，重新启用后开始', () => {
    const cb = vi.fn()
    act(() => { root.render(<Probe cb={cb} enabled={false} />) })
    act(() => { vi.advanceTimersByTime(6000) })
    expect(cb).not.toHaveBeenCalled()

    act(() => { root.render(<Probe cb={cb} enabled />) })
    act(() => { vi.advanceTimersByTime(2000) })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('卸载后停止轮询且移除 visibilitychange 监听', () => {
    const cb = vi.fn()
    act(() => { root.render(<Probe cb={cb} />) })
    act(() => { root.unmount() })
    act(() => { setVisibility('hidden') })
    act(() => { setVisibility('visible') })
    expect(cb).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(4000) })
    expect(cb).not.toHaveBeenCalled()
    // 重新挂一个 root，避免 afterEach 再次 unmount 抛错
    root = createRoot(document.createElement('div'))
  })
})
