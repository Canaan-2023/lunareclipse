/**
 * L8 工作流引擎：模板结构校验（纯函数）



 * 从 engine.ts 拆分出来的模板校验职责（手写 JSON Schema 替代）：
 * - 顶层必填字段：name/mode/nodes/edges
 * - 节点字段：id/type/config
 * - 连线字段：from/to
 * - 引用完整性：edge.from/to 必须引用已定义的 node id
 * - 节点 ID 唯一
 * - 有起始节点
 * - mode 与节点类型匹配（chatflow 无 end 节点 / workflow 无 answer 节点）
 */
import type { WorkflowTemplate } from '@shared/workflow/types'
import { findStartNode } from './dag-nav'

/** 合法节点类型（运行时校验用，与 NodeType 对齐） */
export const VALID_NODE_TYPES: readonly string[] = [
  'llm', 'tool', 'skill', 'condition', 'human', 'answer', 'end'
]

/** 合法工作流模式（运行时校验用，与 WorkflowMode 对齐） */
export const VALID_WORKFLOW_MODES: readonly string[] = ['chatflow', 'workflow']

/** 运行时类型断言：非空字符串 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** 运行时类型断言：普通对象（非 null、非数组） */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 校验模板结构，非法时抛错
 */
export function validateTemplate(template: WorkflowTemplate): void {
  // ===== 顶层必填字段 =====
  if (!isNonEmptyString(template.name)) {
    throw new Error('模板 name 必须为非空字符串')
  }
  if (!isNonEmptyString(template.mode) || !VALID_WORKFLOW_MODES.includes(template.mode)) {
    throw new Error(
      `模板 mode 非法: ${String(template.mode)}（合法: ${VALID_WORKFLOW_MODES.join('/')}）`
    )
  }
  if (!Array.isArray(template.nodes) || template.nodes.length === 0) {
    throw new Error('模板 nodes 必须为非空数组')
  }
  if (!Array.isArray(template.edges)) {
    throw new Error('模板 edges 必须为数组')
  }

  // ===== 节点字段校验 + ID 唯一 =====
  const nodeIds = new Set<string>()
  for (const [index, node] of template.nodes.entries()) {
    if (typeof node !== 'object' || node === null) {
      throw new Error(`节点必须为对象（索引 ${index}）`)
    }
    if (!isNonEmptyString(node.id)) {
      throw new Error(`节点 id 必须为非空字符串（索引 ${index}）`)
    }
    if (!isNonEmptyString(node.type) || !VALID_NODE_TYPES.includes(node.type)) {
      throw new Error(
        `节点 ${node.id} type 非法: ${String(node.type)}（合法: ${VALID_NODE_TYPES.join('/')}）`
      )
    }
    if (!isPlainObject(node.config)) {
      throw new Error(`节点 ${node.id} 的 config 必须为对象`)
    }
    if (nodeIds.has(node.id)) {
      throw new Error(`节点 ID 重复: ${node.id}`)
    }
    nodeIds.add(node.id)
  }

  // ===== 连线字段校验 + 引用完整性 =====
  for (const [index, edge] of template.edges.entries()) {
    if (typeof edge !== 'object' || edge === null) {
      throw new Error(`连线必须为对象（索引 ${index}）`)
    }
    if (!isNonEmptyString(edge.from)) {
      throw new Error(`连线 from 必须为非空字符串（索引 ${index}）`)
    }
    if (!isNonEmptyString(edge.to)) {
      throw new Error(`连线 to 必须为非空字符串（索引 ${index}）`)
    }
    if (!nodeIds.has(edge.from)) {
      throw new Error(`连线起点不存在: ${edge.from}`)
    }
    if (!nodeIds.has(edge.to)) {
      throw new Error(`连线终点不存在: ${edge.to}`)
    }
  }

  // ===== 起始节点 =====
  const startNode = findStartNode(template)
  if (!startNode) {
    throw new Error('工作流无起始节点（没有无入边的节点，可能存在循环）')
  }

  // ===== mode 与节点类型匹配 =====
  if (template.mode === 'chatflow') {
    if (template.nodes.some((n) => n.type === 'end')) {
      throw new Error('Chatflow 模式不应有 end 节点（用 answer 节点）')
    }
  } else {
    if (template.nodes.some((n) => n.type === 'answer')) {
      throw new Error('Workflow 模式不应有 answer 节点（用 end 节点）')
    }
  }

  // ===== HOOK 结构校验 =====
  // 为什么存在：HOOK 的 action 描述真实行为（command=外部命令 / javascript=同进程 JS），
  // 结构不合法（缺 command/code、type 非法）会让执行器在类型断言处静默出错或误判为
  // javascript 分支运行 undefined 代码；且 command 类型是命令执行入口，必须明示参数
  // 而不是靠运行时推断。作用：模板定义阶段即拦截非法 HOOK，与节点/连线校验同级。
  // 不删掉的理由：校验只查结构、不查命令内容——命令内容的安全性由 hook-runner 执行前
  // 的 assessCommandForBackgroundExec 统一把关（后台无审批通道，灰名单一律拒绝）。
  if (template.hooks !== undefined) {
    if (!Array.isArray(template.hooks)) {
      throw new Error('模板 hooks 必须为数组')
    }
    const validEvents = ['before_node', 'after_node', 'on_fail', 'on_complete', 'on_user_message']
    for (const [index, hook] of template.hooks.entries()) {
      if (!isPlainObject(hook)) {
        throw new Error(`HOOK 必须为对象（索引 ${index}）`)
      }
      if (!isNonEmptyString(hook.event) || !validEvents.includes(hook.event)) {
        throw new Error(`HOOK ${index} event 非法: ${String(hook?.event)}（合法: ${validEvents.join('/')}）`)
      }
      if (hook.matcher !== undefined && !isNonEmptyString(hook.matcher)) {
        throw new Error(`HOOK ${index} matcher 必须为非空字符串`)
      }
      const action = hook.action
      if (!isPlainObject(action)) {
        throw new Error(`HOOK ${index} action 必须为对象`)
      }
      if (action.type !== 'command' && action.type !== 'javascript') {
        throw new Error(`HOOK ${index} action.type 非法: ${String(action?.type)}（合法: command/javascript）`)
      }
      if (action.type === 'command' && !isNonEmptyString(action.command)) {
        throw new Error(`HOOK ${index} command 类型必须提供非空 command 字段`)
      }
      if (action.type === 'javascript' && !isNonEmptyString(action.code)) {
        throw new Error(`HOOK ${index} javascript 类型必须提供非空 code 字段`)
      }
      if (action.timeout !== undefined && (typeof action.timeout !== 'number' || action.timeout <= 0)) {
        throw new Error(`HOOK ${index} timeout 必须为正数（毫秒）`)
      }
    }
  }
}