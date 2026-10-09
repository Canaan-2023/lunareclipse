/**
 * JSON → MD 视图转换器

 * 背景：记忆/NNG/缓存是 JSON 存储（工具写入、同步器、文件系统都基于 JSON），
 * 但 AI 直接读 JSON 费 token（引号/花括号/逗号/路径转义 \\）且不直观。
 * 本模块把 JSON 转为 MD 视图：字段全保留、数组每项一行、嵌套缩进、路径天然去转义
 * （JSON.parse 后字符串就是真实值）。

 * 用途：
 * 1. read_md 工具：AI 想直观读 JSON 文件（记忆/NNG/缓存）时用
 * 2. 缓存注入前端 AI 时默认过滤（AI 看到的直接是 MD）

 * 存储格式不变（仍 JSON），转换只发生在"读的呈现层"。
 */

/**
 * 通用 JSON → MD 视图
 * 规则：
 * - 标量字段：`字段名: 值`
 * - 数组：`字段名:` + 每项 `- 值`（对象项用 `- #N` 块 + 子字段缩进）
 * - 对象：`字段名:` + 子字段缩进
 * - 空数组/空对象：`字段名: []` / `字段名: {}`
 * - 根对象：字段从根展开（无根标题）
 */
export function jsonToMdView(value: unknown, depth = 0): string {
  const indent = '  '.repeat(depth)
  if (value === null) return `${indent}null`
  if (value === undefined) return `${indent}undefined`
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}[]`
    const lines: string[] = []
    value.forEach((item, i) => {
      if (typeof item === 'object' && item !== null) {
        // 对象数组项：- #N 块 + 子字段（保留项边界）
        lines.push(`${indent}- #${i + 1}`)
        lines.push(renderObject(item as Record<string, unknown>, depth + 2))
      } else {
        lines.push(`${indent}- ${String(item)}`)
      }
    })
    return lines.join('\n')
  }
  if (typeof value === 'object') {
    return renderObject(value as Record<string, unknown>, depth)
  }
  return `${indent}${String(value)}`
}

/** 对象渲染：`字段名: 值`（子对象/数组递归展开） */
function renderObject(obj: Record<string, unknown>, depth: number): string {
  const indent = '  '.repeat(depth)
  const entries = Object.entries(obj)
  if (entries.length === 0) return `${indent}{}`
  return entries
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        if (v.length === 0) return `${indent}${k}: []`
        return `${indent}${k}:\n${jsonToMdView(v, depth + 1)}`
      }
      if (typeof v === 'object' && v !== null) {
        const inner = renderObject(v as Record<string, unknown>, depth + 1)
        return `${indent}${k}:\n${inner}`
      }
      return `${indent}${k}: ${String(v)}`
    })
    .join('\n')
}

/** 判断路径是否为 JSON 文件 */
export function isJsonPath(path: string): boolean {
  return path.toLowerCase().endsWith('.json')
}

/**
 * 读取 JSON 文件并转为 MD 视图（read_md 工具核心）。
 * 非 JSON 文件返回 null（调用方决定如何处理）。
 */
export function jsonFileToMdView(rawContent: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawContent)
  } catch {
    return null // 非 JSON 或损坏
  }
  return jsonToMdView(parsed)
}
