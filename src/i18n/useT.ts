/**
 * 为什么存在：组件需要随语言切换自动重渲染的翻译函数，且要支持
 * {var} 占位符替换，封装成 hook 避免各组件手写查询逻辑。
 * 作用：提供 useT hook——返回 t(key, vars?) 翻译函数，语言切换时自动重渲染。
 */
import { useCallback } from 'react'
import { useAppStore } from '../stores/appStore'
import { getDictEntry, type Lang } from './locales'

/** t 函数类型 */
export type TFunc = (key: string, vars?: Record<string, string | number>) => string

/**
 * 占位符匹配：单次扫描整串替换全部变量。
 * 旧实现按变量个数逐个 new RegExp——t() 全仓约 2894 次调用，多变量时每次都要新建正则。
 * 用 replace 回调返回值（而非替换串）还能让变量值里的 `$&`、`$1` 等按字面量处理。
 * 模块级常量：String.replace 每次调用会把 lastIndex 归零，不存在 'g' 标志的跨调用泄漏。
 */
const PLACEHOLDER_RE = /\{([^{}]+)\}/g

/** 占位符替换：仅替换 vars 中存在的键，缺失的占位符原样保留（与旧行为一致） */
export function interpolate(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text
  return text.replace(PLACEHOLDER_RE, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
  )
}

/** 翻译 hook：返回 t(key, vars?) 函数，语言切换时自动重渲染 */
export function useT(): TFunc {
  const lang = useAppStore((s) => s.lang)

  return useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const entry = getDictEntry(key)
      const text: string = entry?.[lang as Lang] ?? key
      return interpolate(text, vars)
    },
    [lang]
  )
}
