/**
 * 为什么存在：设置、选择器、删除确认、执行器管理等弹层此前各自手写 `fixed inset-0` 遮罩，
 * 多数只补了 role/aria-modal，却没有焦点陷阱与关闭后焦点还原——键盘 Tab 会跑到遮罩背后的页面，
 * Esc/遮罩关闭后焦点丢到 body，读屏与键盘用户都会迷路。
 * 作用：统一弹层容器——role="dialog" + aria-modal + aria-labelledby/aria-label、
 * 打开时聚焦首个可聚焦元素、Tab 在弹层内循环、Esc 关闭、点遮罩关闭、关闭后焦点还原。
 * 视觉完全由调用方的 backdropClassName / cardClassName 决定，替换时不改变外观。
 * 不引入焦点陷阱库：Tab 循环只需查询弹层内的可聚焦元素，浏览器原生 API 足够。
 */
import { useEffect, useRef, type ReactNode } from 'react'

/** 可聚焦元素选择器：排除禁用控件与 tabindex=-1 的程序化聚焦容器 */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * 弹层栈：多层弹窗嵌套时只有最上层响应 Esc/Tab 循环。
 * 为什么需要：Esc 监听挂在 document 上，若每层都响应，一次 Esc 会把整栈全部关掉。
 */
const modalStack: number[] = []
let modalSeq = 0

interface ModalProps {
  open: boolean
  onClose: () => void
  /** 标题元素的 id（优先使用；与 aria-label 二选一） */
  labelledBy?: string
  /** 无标题 id 时的可访问名称 */
  label?: string
  /** 遮罩层类名：包含 fixed inset-0 定位、z-index 与背景，保持各调用点原视觉 */
  backdropClassName?: string
  /** 卡片类名：宽度/圆角/边框/背景，保持各调用点原视觉 */
  cardClassName?: string
  /** 关闭抑制（删除中/清空中）：Esc 与遮罩点击不关闭，关闭按钮由调用方自行禁用 */
  closeDisabled?: boolean
  /** 点击遮罩是否关闭，默认 true */
  closeOnBackdrop?: boolean
  children: ReactNode
}

export function Modal({
  open,
  onClose,
  labelledBy,
  label,
  backdropClassName = 'fixed inset-0 z-50 flex items-center justify-center bg-black/40',
  cardClassName,
  closeDisabled = false,
  closeOnBackdrop = true,
  children
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const closeDisabledRef = useRef(closeDisabled)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    closeDisabledRef.current = closeDisabled
  }, [closeDisabled])
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open) return
    const id = ++modalSeq
    modalStack.push(id)
    // 记录打开前的焦点（通常是触发按钮），关闭时还原
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const panel = panelRef.current
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE)
    if (first) first.focus()
    else panel?.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      // 只让最上层弹窗处理键盘事件
      if (modalStack[modalStack.length - 1] !== id) return
      if (e.key === 'Escape') {
        if (!closeDisabledRef.current) {
          e.preventDefault()
          onCloseRef.current()
        }
        return
      }
      if (e.key !== 'Tab' || !panel) return
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) {
        // 没有可聚焦元素时把焦点锁在卡片上，避免 Tab 逃到背后页面
        e.preventDefault()
        panel.focus()
        return
      }
      const firstEl = items[0]
      const lastEl = items[items.length - 1]
      const active = document.activeElement
      const inside = active instanceof HTMLElement && panel.contains(active)
      if (e.shiftKey && (!inside || active === firstEl)) {
        e.preventDefault()
        lastEl.focus()
      } else if (!e.shiftKey && (!inside || active === lastEl)) {
        e.preventDefault()
        firstEl.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      const idx = modalStack.indexOf(id)
      if (idx >= 0) modalStack.splice(idx, 1)
      const prev = restoreRef.current
      if (prev && prev.isConnected) prev.focus()
    }
  }, [open])

  if (!open) return null

  return (
    <div
      className={backdropClassName}
      // 遮罩只作为点击关闭的命中区，语义务必放在卡片上
      onMouseDown={(e) => {
        if (closeOnBackdrop && !closeDisabledRef.current && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        tabIndex={-1}
        className={cardClassName}
        // 卡片内按下不触发遮罩关闭（鼠标从卡片内拖到遮罩上松开的场景也安全）
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
