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

/** 翻译 hook：返回 t(key, vars?) 函数，语言切换时自动重渲染 */
export function useT(): TFunc {
  const lang = useAppStore((s) => s.lang)

  return useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const entry = getDictEntry(key)
      let text: string = entry?.[lang as Lang] ?? key
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
        }
      }
      return text
    },
    [lang]
  )
}
