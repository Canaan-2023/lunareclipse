/**
 * 为什么存在：长会话消息量大时用户需要在进度中获得位置感并快速跳转，
 * 用等距小点定位条提供轻量导航（从消息列表侧独立）。
 * 作用：渲染消息定位条——按消息数等距布点映射视口进度，
 * 点击滚动到对应消息并高亮视口内当前消息。
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { ChatMessage } from '@shared/types'

/** 消息锚点 id（与 MessageBubble 的 anchorId 一致：`msg-{sanitized id}`） */
function anchorId(id: string): string {
  return `msg-${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}`
}

/** 定位点渲染上限：展开全量历史时用户消息可能几千条，
 * 渲染几千个 DOM 点 + scroll 遍历全部 getBoundingClientRect → 卡死。超出只渲染最近 N 条。 */
const MAX_LOCATOR_DOTS = 200

/**
 * 侧边消息定位条（等间距一列点）
 *
 * - 每条真实用户消息（排除系统注入）一个点，等距竖排（flex-col + gap）
 * - 点击小点 → 平滑滚动到该消息（scrollIntoView block:center，复用 MessageBubble 锚点）
 * - 当前视口中央附近的用户消息对应的小点高亮（accent 实色 + 光晕），其余同色系半透明
 * - 垂直居中一列，不随消息位置偏移（用户明确要求等宽，不要位置映射）
 */
export function MessageLocator({
  messages,
  scrollRef
}: {
  messages: ChatMessage[]
  scrollRef: RefObject<HTMLDivElement | null>
}) {
  const userMsgs = messages.filter((m) => m.role === 'user' && m.activation !== true).slice(-MAX_LOCATOR_DOTS)
  // ref 持有最新列表：scroll 监听只挂一次，回调读 ref
  const userMsgsRef = useRef(userMsgs)
  userMsgsRef.current = userMsgs
  // 当前视口最近的用户消息索引（高亮）
  const [activeIdx, setActiveIdx] = useState(-1)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    const updateActive = () => {
      raf = 0
      const msgs = userMsgsRef.current
      if (msgs.length === 0) return
      const elRect = el.getBoundingClientRect()
      const mid = elRect.top + el.clientHeight / 2
      let best = -1
      let bestDist = Infinity
      for (let i = 0; i < msgs.length; i++) {
        const node = document.getElementById(anchorId(msgs[i].id))
        if (!node) continue
        const r = node.getBoundingClientRect()
        const d = Math.abs(r.top + r.height / 2 - mid)
        if (d < bestDist) {
          bestDist = d
          best = i
        }
      }
      setActiveIdx(best)
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(updateActive)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    // 初始计算（等一帧确保消息 DOM 已布局）
    const raf0 = requestAnimationFrame(updateActive)
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
      cancelAnimationFrame(raf0)
    }
  }, [scrollRef])

  if (userMsgs.length === 0) return null

  return (
    <div className="absolute right-2.5 top-1/2 z-10 flex -translate-y-1/2 flex-col items-center gap-[7px]">
{userMsgs.map((m, i) => (
        <button
          key={m.id}
          onClick={() => {
            const node = document.getElementById(anchorId(m.id))
            node?.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }}
          title={`定位到这条消息：${String(m.content ?? '').slice(0, 24)}`}
          aria-label={`定位到这条消息：${String(m.content ?? '').slice(0, 24)}`}
          className={`relative h-[6px] w-[6px] shrink-0 rounded-full transition-all duration-150 before:absolute before:-inset-[9px] before:rounded-full before:content-[''] hover:scale-150 ${
            i === activeIdx
              ? 'scale-125 bg-accent opacity-100 shadow-[0_0_6px_rgb(var(--color-accent))]'
              : 'bg-accent opacity-40 hover:opacity-75'
          }`}
        />
      ))}
    </div>
  )
}
