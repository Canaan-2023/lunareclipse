/**
 * @category 安全
 * @summary 授权范围输入的纯函数（解析 / 增删 / 规范化）——权限面与单测共用的唯一口径
 *
 * 为什么单独成文件：`SecurityPanel` 与 `ScopeEditor` 都要解析同一份范围文本；
 * 放在任一组件的模块里，另一方 import 就形成组件循环依赖（且「每行一项」的口径会出现两份）。
 *
 * 不删理由：删掉即范围解析散落在两个组件里，一处认逗号一处不认——授予看似成功、动作全被拒。
 */
import { GRANT_SCOPE_ENTRY_MAX } from '@shared/security/tiers'

/** 单条范围值最大长度（与主进程 `sanitizeScope` 同一常量；前端只提示，主进程才是关口） */
export const SCOPE_ENTRY_MAX = GRANT_SCOPE_ENTRY_MAX

/** 多行文本 → 去重后的非空条目（范围的输入格式：每行一项，逗号也认） */
export function splitScopeLines(raw: string): string[] {
  const seen = new Set<string>()
  for (const part of raw.split(/[\n,]/)) {
    const v = part.trim()
    if (v) seen.add(v)
  }
  return [...seen]
}

/** 规范化单条（去首尾空白、去包裹引号、截断到上限）；空串 → null */
export function normalizeScopeEntry(raw: string): string | null {
  let v = raw.trim().replace(/^["'`]|["'`]$/g, '').trim()
  if (!v) return null
  if (v.length > SCOPE_ENTRY_MAX) v = v.slice(0, SCOPE_ENTRY_MAX)
  return v
}

/** 追加一条（去重；返回新数组，不改入参） */
export function addScopeEntry(list: readonly string[], raw: string): string[] {
  const v = normalizeScopeEntry(raw)
  if (!v || list.includes(v)) return [...list]
  return [...list, v]
}

/** 移除一条（返回新数组） */
export function removeScopeEntry(list: readonly string[], entry: string): string[] {
  return list.filter((x) => x !== entry)
}

/** 数组 → 多行文本（写回 `SecurityPanel` 的草稿状态） */
export function joinScopeLines(list: readonly string[]): string {
  return list.join('\n')
}
