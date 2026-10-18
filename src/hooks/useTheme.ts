/**
 * 为什么存在：主题切换影响全局 html class 且需防首帧闪白（FOUC，localStorage 供
 * index.html 内联脚本预读），集中成 hook 管理切换副作用与持久化。
 * 作用：监听 config.theme 变化，应用/清理 html class、持久化选择并过度动画过渡。
 */
import { useEffect } from 'react'
import { useAppStore } from '../stores/appStore'
import type { ThemeName } from '@shared/types'

/** 全部主题 html class 名（= 主题 ID），用于切换前清理 */
const THEME_CLASSES: ThemeName[] = ['frost-glass', 'parchment', 'night', 'violet-night', 'eclipse', 'gilded']
/** localStorage 键：index.html 内联脚本在 React 挂载前同步读取，消除暗色主题首帧闪白（FOUC） */
const THEME_STORAGE_KEY = 'lunareclipse.theme'

export function useTheme() {
  const theme = useAppStore((s) => s.config.theme)
  const authReady = useAppStore((s) => s.authReady)

  useEffect(() => {
    // 守卫：config 异步返回前，html class 由 index.html 内联脚本恢复；
    // 若此时切到 DEFAULT_CONFIG.theme（初始值），暗色用户会先闪一帧素笺亮色再跳变。
    // authReady=true 时 config 已是真实值，一次切换到位。
    if (!authReady) return

    const html = document.documentElement
    // 清理全部主题 class + 历史脏 class（'dark' 来自 index.html 初始、'undefined' 来自早期 add(undefined) 遗留）
    html.classList.remove(...THEME_CLASSES, 'theme-transitioning', 'dark', 'undefined')
    // 触发短暂过渡动画，让用户感知主题切换
    html.classList.add('theme-transitioning')
    html.classList.add(theme)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      // localStorage 不可用（隐私模式等）时静默降级，主题切换本身不受影响
    }
    const t = setTimeout(() => html.classList.remove('theme-transitioning'), 400)
    return () => clearTimeout(t)
  }, [theme, authReady])

  return theme
}
