/**
 * @category 工具
 * @summary 工具分类展示标签（shared）
 *
 * 为什么存在：分类的中文名与图标被配置面板分组标题、工具卡片汇总条共同使用，需与 `ToolCategory` 键集严格一致（缺键即 typecheck 报错）。
 * 不删理由：本模块由 `shared/tools/registry.ts` 按 ADR-06 拆分而来，宿主降级为 barrel
 * 保全部消费方零改动；职责单一化后，改动面互不干扰（原单文件同时承载类型/目录/动态注册/
 * 策略/标签五类职责，任一处改动都会与其它职责在 merge 上冲突）。
 */

import type { ToolCategory } from '../types'


/** 工具分类的中文名（用于配置面板分组标题） */
export const CATEGORY_LABELS: Record<ToolCategory, string> = {
  'file-read': '读取文件',
  'file-write': '修改文件',
  browser: '浏览器',
'self-shape': '自我塑造',
  account: '账号管理',
  system: '系统调用',
  network: '联网',
  graph: '图工具',
  mechanism: '机制入口',
  'memory-workflow-exclusive': '记忆工作流专属',
  workflow: '工作流',
  plugin: '插件',
  'task-mode': '任务模式',
  generation: '内容生成',
  lan: '局域网协作',
  device: '设备接入',
}

/** 工具分类的图标（emoji，用于卡片汇总条） */
export const CATEGORY_ICONS: Record<ToolCategory, string> = {
  'file-read': '📄',
  'file-write': '✏️',
  browser: '🌐',
'self-shape': '🎭',
  account: '👤',
  system: '⚙️',
  network: '🔗',
  graph: '📊',
  mechanism: '🔧',
  'memory-workflow-exclusive': '🧩',
  workflow: '🔄',
  plugin: '🧰',
  'task-mode': '👥',
  generation: '🎬',
  lan: '📡',
  device: '🖥️',
}

