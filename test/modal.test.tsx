// @vitest-environment jsdom
/**
 * Modal 回归。
 *
 * 为什么测：统一弹层承担可访问名、焦点陷阱、Esc/遮罩关闭与关闭后焦点还原四条契约，
 * 这些行为都发生在 document 级事件与真实的 DOM 焦点状态上，只能靠组件测试锁住。
 */
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Modal } from '../src/components/Modal'

let container: HTMLDivElement
let root: Root | null = null

function render(node: React.ReactNode) {
  if (!root) root = createRoot(container)
  act(() => {
    root!.render(node)
  })
}

function pressKey(key: string, shiftKey = false) {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }))
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container.remove()
})

describe('Modal', () => {
  it('打开时聚焦弹层内首个可聚焦元素，并提供 dialog 语义', () => {
    render(
      <Modal open onClose={() => {}} label="测试弹层">
        <button>第一个</button>
        <button>第二个</button>
      </Modal>
    )
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog!.getAttribute('aria-modal')).toBe('true')
    expect(dialog!.getAttribute('aria-label')).toBe('测试弹层')
    expect(document.activeElement).toBe(document.querySelector('button'))
  })

  it('labelledBy 优先于 label，作为可访问名称来源', () => {
    render(
      <Modal open onClose={() => {}} labelledBy="modal-title" label="应被忽略">
        <h2 id="modal-title">标题</h2>
        <button>确定</button>
      </Modal>
    )
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-labelledby')).toBe('modal-title')
    expect(dialog.getAttribute('aria-label')).toBeNull()
  })

  it('Tab 在弹层内循环：末位 Tab 回到首位，首位 Shift+Tab 回末位', () => {
    render(
      <Modal open onClose={() => {}} label="循环">
        <button id="first">第一</button>
        <button id="last">最后</button>
      </Modal>
    )
    const first = document.getElementById('first')!
    const last = document.getElementById('last')!
    last.focus()
    pressKey('Tab')
    expect(document.activeElement).toBe(first)
    first.focus()
    pressKey('Tab', true)
    expect(document.activeElement).toBe(last)
  })

  it('Esc 关闭；closeDisabled 时 Esc 不关闭', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} label="Esc">
        <button>关闭</button>
      </Modal>
    )
    pressKey('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)

    onClose.mockClear()
    render(
      <Modal open onClose={onClose} label="Esc" closeDisabled>
        <button>关闭</button>
      </Modal>
    )
    pressKey('Escape')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('点遮罩关闭，点卡片不关闭；closeOnBackdrop=false 时遮罩也不关闭', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} label="遮罩">
        <button>按钮</button>
      </Modal>
    )
    const dialog = document.querySelector('[role="dialog"]')!
    act(() => {
      dialog.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(onClose).not.toHaveBeenCalled()
    act(() => {
      dialog.parentElement!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)

    onClose.mockClear()
    render(
      <Modal open onClose={onClose} label="遮罩" closeOnBackdrop={false}>
        <button>按钮</button>
      </Modal>
    )
    act(() => {
      document.querySelector('[role="dialog"]')!.parentElement!.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true })
      )
    })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('关闭后把焦点还原到打开前聚焦的元素', () => {
    const trigger = document.createElement('button')
    trigger.textContent = '触发'
    document.body.appendChild(trigger)
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    render(
      <Modal open onClose={() => {}} label="还原">
        <button id="inside">内部</button>
      </Modal>
    )
    expect(document.activeElement).toBe(document.getElementById('inside'))

    act(() => root!.unmount())
    root = null
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('open=false 时不渲染任何内容', () => {
    render(
      <Modal open={false} onClose={() => {}} label="关闭态">
        <button>不应出现</button>
      </Modal>
    )
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
