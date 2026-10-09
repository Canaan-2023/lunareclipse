/**
 * L8 工作流引擎：模板变量解析
 *
 * 职责：把节点配置里的 {{context.xxx}} 引用替换成 context 中的实际值
 *
 * 支持的变量路径：
 * - {{context.input}} → 启动时传入的 input
 * - {{context.user_message}} → Chatflow 用户最新消息
 * - {{context.节点id}} → 某节点的完整输出
 * - {{context.节点id.字段}} → 某节点输出的某个字段（支持嵌套对象 + 数组下标）
 *
 * 替换规则：
 * - 字符串内的 {{context.xxx}} 占位符被替换为对应值的字符串形式
 * - 整个字符串恰好是 "{{context.xxx}}" 时，返回原始值（保留类型：对象/数组/数字等）
 * - 未找到的变量替换为空字符串
 * 为什么存在：模板要被不同实例复用，节点配置中的 {{context.xxx}} 必须按实例运行时上下文解析替换，模板才可参数化。
 * 不删理由：所有 %{{context.*}}% 引用、hidden 提示词模板与 condition 分支条件都经本模块解析；
 * 删除它则模板只能写死字面量，工作流编排失去参数化能力。
 */
import type { WorkflowInstance } from '@shared/workflow/types'

/** 变量路径正则：{{context.xxx.yyy[0].zzz}} */
const VAR_REGEX = /\{\{\s*context\.([^}]+?)\s*\}\}/g

/**
 * 按点号 + 方括号路径读取嵌套值
 * 支持：input.user.name / items[0].title / data.list[2].name
 */
function getValueByPath(obj: unknown, path: string): unknown {
  if (obj == null) return undefined
  // 拆分路径：a.b[0].c → ['a', 'b', '0', 'c']（split 的捕获组把 [n] 里的数字提为独立元素）
  const parts = path.split(/\.|\[(\d+)\]/).filter((s) => s !== '' && s !== undefined)
  let cur: unknown = obj
  for (const p of parts) {
    if (cur == null) return undefined
    // 原型链防护：__proto__/constructor/prototype 是 JS 内置对象属性而非工作流数据，
    // 若放行，模板作者可用 {{context.__proto__.xxx}} 读到 Object.prototype 等内置属性
    // （信息泄露面：仅内置函数/默认值，无敏感数据，但按纵深防御原则显式拦截）。
    if (p === '__proto__' || p === 'constructor' || p === 'prototype') return undefined
    if (Array.isArray(cur)) {
      const idx = parseInt(p, 10)
      if (isNaN(idx)) return undefined
      cur = cur[idx]
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[p]
    } else {
      return undefined
    }
  }
  return cur
}

/** 把任意值转成字符串（用于嵌入到文本中） */
function valueToString(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/**
 * 解析模板变量
 * @param text 待解析的文本（含 {{context.xxx}} 占位符）
 * @param context 工作流实例的共享上下文
 * @returns 解析后的值（字符串替换；若整段恰好是单个占位符则返回原始类型值）
 */
export function resolveTemplate(text: string, context: Record<string, unknown>): string
export function resolveTemplate(
  text: string,
  context: Record<string, unknown>,
  preserveType: true
): unknown
export function resolveTemplate(
  text: string,
  context: Record<string, unknown>,
  preserveType?: boolean
): unknown {
  if (typeof text !== 'string') return text

  // 整段恰好是单个占位符：返回原始类型值（保留对象/数组/数字等）
  const singleMatch = /^\{\{\s*context\.([^}]+?)\s*\}\}$/.exec(text.trim())
  if (singleMatch && preserveType) {
    const val = getValueByPath(context, singleMatch[1])
    return val
  }

  // 字符串内替换：所有 {{context.xxx}} 占位符
  return text.replace(VAR_REGEX, (full, path: string) => {
    const val = getValueByPath(context, path.trim())
    return valueToString(val)
  })
}

/**
 * 创建绑定到特定实例的解析器（节点处理器用）
 */
export function createTemplateResolver(instance: WorkflowInstance) {
  return {
    /** 解析文本，返回字符串（占位符被替换） */
    resolve: (text: string): string => resolveTemplate(text, instance.context),
    /** 解析文本，若整段是单个占位符则保留原始类型 */
    resolveValue: (text: string): unknown => resolveTemplate(text, instance.context, true)
  }
}

// ===== 条件表达式评估（condition 节点出边用） =====

/**
 * 评估条件表达式
 *
 * 支持语法（简化版）：
 * - context.xxx == 'value' 字面量相等
 * - context.xxx != 'value' 字面量不等
 * - context.xxx > 10 数值大于
 * - context.xxx >= 10 数值大于等于
 * - context.xxx < 10 数值小于
 * - context.xxx <= 10 数值小于等于
 * - context.xxx contains 'kw' 字符串包含
 * - context.xxx exists 变量存在
 * - context.xxx not exists 变量不存在
 * - default 兜底分支
 *
 * 不支持的：&& / || / 嵌套表达式（保持简单，AI 编排时避免复杂条件）
 *
 * @returns true=条件满足，false=不满足
 */
export function evaluateCondition(condition: string, context: Record<string, unknown>): boolean {
  const expr = condition.trim()

  if (!expr || expr === 'default') return true

  // exists / not exists
  const existsMatch = /^context\.([^\s]+)\s+(not\s+)?exists$/.exec(expr)
  if (existsMatch) {
    const path = existsMatch[1]
    const negate = !!existsMatch[2]
    const val = getValueByPath(context, path)
    const exists = val !== undefined && val !== null
    return negate ? !exists : exists
  }

  // contains
  const containsMatch =
    /^context\.([^\s]+)\s+contains\s+'([^']*)'$/.exec(expr) ??
    /^context\.([^\s]+)\s+contains\s+"([^"]*)"$/.exec(expr)
  if (containsMatch) {
    const path = containsMatch[1]
    const needle = containsMatch[2]
    const val = getValueByPath(context, path)
    if (val == null) return false
    if (typeof val === 'string') return val.includes(needle)
    if (Array.isArray(val)) return val.some((item) => String(item).includes(needle))
    try {
      return JSON.stringify(val).includes(needle)
    } catch {
      return false
    }
  }

  // 数值比较 >= / <= / > / <
  const numMatch = /^context\.([^\s]+)\s*(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/.exec(expr)
  if (numMatch) {
    const path = numMatch[1]
    const op = numMatch[2]
    const threshold = parseFloat(numMatch[3])
    const val = getValueByPath(context, path)
    if (val == null) return false
    const num = typeof val === 'number' ? val : parseFloat(String(val))
    if (isNaN(num)) return false
    switch (op) {
      case '>':
        return num > threshold
      case '>=':
        return num >= threshold
      case '<':
        return num < threshold
      case '<=':
        return num <= threshold
    }
  }

  // 字面量相等 / 不等
  const eqMatch =
    /^context\.([^\s]+)\s*(==|!=)\s*'([^']*)'$/.exec(expr) ??
    /^context\.([^\s]+)\s*(==|!=)\s+"([^"]*)"$/.exec(expr)
  if (eqMatch) {
    const path = eqMatch[1]
    const op = eqMatch[2]
    const expected = eqMatch[3]
    const val = getValueByPath(context, path)
    const actual = val == null ? '' : String(val)
    return op === '==' ? actual === expected : actual !== expected
  }

  // 无法识别的表达式：返回 false（保守，避免误走分支）
  console.warn(`[workflow] 无法识别的条件表达式: ${expr}`)
  return false
}
