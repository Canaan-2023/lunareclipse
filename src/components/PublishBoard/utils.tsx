/**
 * 为什么存在：发布板内容来自局域网（不可信文本），正文里的链接打开需统一走
 * 主进程白名单通道，避免直接 window.open 开放任意 URL。
 * 作用：提供发布板纯函数——时间格式化、正文链接提取（splitLinks）与
 * 链接点击打开（白名单 + 主进程 openExternal）。
 */
import type { ReactNode } from 'react'
import { formatDateTime } from '../../utils/time'

export function formatTime(ts: number): string {
  return formatDateTime(ts)
}

// 正文/评论中的链接自动识别（LAN 内容为不可信输入：仅展示，打开走主进程 http/https 白名单）
const URL_RE = /(https?:\/\/[^\s<>"']+)/g

/** 把文本中的 http/https URL 渲染为可点击链接，其余原样保留 */
export function splitLinks(text: string): ReactNode[] {
  const parts = text.split(URL_RE)
  const nodes: ReactNode[] = []
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // URL 片段：去掉尾部常见标点，避免句号/括号粘进链接
      const clean = part.replace(/[.,;:!?)\]}>，。；：！？）'""]+$/, '')
      nodes.push(
        <a
          key={i}
          href={clean}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            void window.lunareclipse.openExternal(clean)
          }}
          className="break-all text-accent underline underline-offset-2 hover:text-accent/80"
        >
          {clean}
        </a>,
      )
    } else {
      nodes.push(part)
    }
  })
  return nodes
}