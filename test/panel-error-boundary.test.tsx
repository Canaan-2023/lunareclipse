// @vitest-environment jsdom
/**
 * 面板级错误隔离回归。
 *
 * 为什么测：根错误边界只能兜整窗，任一面板抛错会白屏并连带其他区域不可用；
 * 本用例锁三件事——
 * 1. 某面板渲染抛错时，**其他区域仍然可用**（不白屏）；
 * 2. 错误卡片提供“重试”，修好后该面板恢复渲染；
 * 3. 面板关闭（active=false）时错误卡片不占位（不残留一块错误 UI）。
 */
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from '../src/components/ErrorBoundary'
import { PanelErrorBoundary } from '../src/components/PanelErrorBoundary'

function Bomb({ armed }: { armed: boolean }) {
  if (armed) throw new Error('面板炸了')
  return <div data-testid="panel-content">面板正常</div>
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  // React 19 的 act 需要显式声明测试环境
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // 错误边界会把异常打到 console.error；测试里静音，避免污染输出
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ErrorBoundary · fallback 契约', () => {
  it('不传 fallback 时保留原整屏错误页（行为不变）', () => {
    act(() => {
      root.render(<ErrorBoundary><Bomb armed /></ErrorBoundary>)
    })
    expect(container.textContent).toContain('月蚀遇到问题')
  })

  it('传入 fallback 时渲染调用方的错误 UI，并给出 reset 入口', () => {
    act(() => {
      root.render(
        <ErrorBoundary fallback={({ error }) => <div>自定义错误：{error.message}</div>}>
          <Bomb armed />
        </ErrorBoundary>
      )
    })
    expect(container.textContent).toContain('自定义错误：面板炸了')
  })
})

describe('PanelErrorBoundary · 面板级隔离', () => {
  it('某面板抛错时其他区域仍可用，错误卡片只出现在该面板', () => {
    act(() => {
      root.render(
        <div>
          <div data-testid="other-area">其他区域仍可用</div>
          <PanelErrorBoundary label="测试面板">
            <Bomb armed />
          </PanelErrorBoundary>
        </div>
      )
    })
    expect(container.querySelector('[data-testid="other-area"]')?.textContent).toBe('其他区域仍可用')
    const alert = container.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert?.textContent).toContain('测试面板加载出错')
    expect(alert?.textContent).toContain('重试')
    expect(alert?.textContent).toContain('复制错误信息')
  })

  it('点“重试”重置边界状态：子组件修好后重新渲染', () => {
    const rerender = (armed: boolean) => {
      act(() => {
        root.render(
          <PanelErrorBoundary label="测试面板">
            <Bomb armed={armed} />
          </PanelErrorBoundary>
        )
      })
    }

    rerender(true)
    const retry = [...container.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('重试'))
    expect(retry).toBeTruthy()

    rerender(false)
    act(() => retry!.click())
    expect(container.querySelector('[data-testid="panel-content"]')).not.toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('面板已关闭（active=false）时错误卡片不渲染，避免残留占位', () => {
    act(() => {
      root.render(
        <PanelErrorBoundary label="测试面板" active={false}>
          <Bomb armed />
        </PanelErrorBoundary>
      )
    })
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('onDismiss 提供独立关闭出口（覆盖层坏掉时仍能退出）', () => {
    const onDismiss = vi.fn()
    act(() => {
      root.render(
        <PanelErrorBoundary label="测试面板" variant="overlay" onDismiss={onDismiss}>
          <Bomb armed />
        </PanelErrorBoundary>
      )
    })
    const close = [...container.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === '关闭')
    expect(close).toBeTruthy()
    act(() => close!.click())
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
