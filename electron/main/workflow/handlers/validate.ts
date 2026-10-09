/**
 * L8 工作流引擎：节点配置参数校验

 * 职责：在 handler 执行前校验 config 字段，给出清晰的错误信息
 * 避免配置缺失导致后续流程出现难以定位的 TypeError

 * 设计：
 * - 轻量：不引入 zod 等运行时校验库，手写字段检查即可
 * - 失败即抛错：引擎 catch 后标记节点 failed，错误信息直达用户
 * - 错误信息格式：`节点 "{name}"({id}) 配置无效: {detail}`
 */
import type { WorkflowNode, NodeConfig } from '@shared/workflow/types'

/**
 * 校验节点 config 存在且必填字段非空

 * @param node 工作流节点
 * @param requiredFields 必填字段名列表（按 config 的 key）
 * @returns 断言为 T 类型的 config（调用方用于类型收窄）
 * @throws Error 当 config 缺失或必填字段为空时
 */
export function validateConfig<T extends NodeConfig>(
  node: WorkflowNode,
  requiredFields: string[]
): T {
  const { config, id, name, type } = node

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`节点 "${name}"(${id}) 配置无效: config 不存在或非对象`)
  }

  for (const field of requiredFields) {
    const value = (config as Record<string, unknown>)[field]
    if (value === undefined || value === null) {
      throw new Error(`节点 "${name}"(${id}) 配置无效: 缺少必填字段 "${field}"（${type} 节点需要）`)
    }
    if (typeof value === 'string' && value.trim() === '') {
      throw new Error(`节点 "${name}"(${id}) 配置无效: 字段 "${field}" 不能为空字符串`)
    }
  }

  return config as T
}

/**
 * 断言字段值是对象类型（非 null/数组/原始值）
 * 用于校验 config.args 这类要求对象类型的字段
 */
export function assertObject(
  node: WorkflowNode,
  field: string,
  value: unknown
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `节点 "${node.name}"(${node.id}) 配置无效: 字段 "${field}" 必须是对象，实际为 ${Array.isArray(value) ? '数组' : typeof value}`
    )
  }
}

/**
 * 断言字段值在允许的枚举集合内
 */
export function assertEnum<T extends string>(
  node: WorkflowNode,
  field: string,
  value: unknown,
  allowed: readonly T[]
): asserts value is T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(
      `节点 "${node.name}"(${node.id}) 配置无效: 字段 "${field}" 必须是 ${allowed.join(' / ')} 之一，实际为 ${JSON.stringify(value)}`
    )
  }
}
