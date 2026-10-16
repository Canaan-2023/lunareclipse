/**
 * 自我检视（introspection）

 * kernel 段：让月蚀 AI 看清系统与自己——模块、记忆工作流、记忆构造、
 * 能力边界与改造自己的正规通道。全部由代码拼装（不需要 AI 维护），
 * 不写死数量统计（AI 会改自己，数量随注册动态变化，对 AI 无用）。

 * 段结构（设计依据：kernel 段按注入时点分层——kernel 常驻原位、session 级随会话注入、
 * prefix 段放最前，顺序决定 AI 读到各层信息的先后与稳定性）：
 * 1. 系统认知（静态铁律 + 精简系统认知）
 * 2. 插件注册的 prompt 段（prompts.md）
 * 注：AI.md（ABYSS/U{uid}/AI{aiId}/AI.md）不再注入 kernel——由 update_abyss_md 维护，放 prompt 最后注入
 */
import { kernelRegistry } from './registry'
import type { RegistrySnapshot } from './extension'
// 系统认知静态文案统一集中管理（prompts/self-awareness.ts）；
// re-export 保持 kernel/index.ts 与测试的旧 import 面兼容
import { SELF_AWARENESS_RULES } from '../prompts/self-awareness'

export { SELF_AWARENESS_RULES }

/**
 * 构建自我认知段（系统认知 + 系统构造脉络 + 插件注册的 prompt 段）。
 * 系统构造不在提示词内铺全量：启动自动扫描生成的 MD 清单放 {root}/system-catalog/，
 * AI 需要时 Read index.md 按类别取（常驻只放入口路径，满足按需披露）。
 */
export function buildSelfAwarenessSection(dataRoot: string): string {
  const parts = [
    SELF_AWARENESS_RULES +
      `\n\n### 系统构造（代码自动生成，权威清单）\n` +
      `- 系统内置模块与已装插件清单由启动时自动扫描代码文件头摘要生成，路径：${dataRoot}/system-catalog/index.md\n` +
      `- index.md 列出全部类别与插件清单入口；每类一个 {类别}.md（如 核心.md、工具.md）；插件清单在 插件清单.md\n` +
      `- 查看某个模块/插件前先 Read 上述对应文档拿到信息与文件路径，再按路径读源码，不要凭手写印象`
  ]

  // 插件注册的 prompt 段（prompts.md，动态内容，非数量统计）
  const pluginPrompts = kernelRegistry.get<{ name: string; content: string }>('prompt')
  if (pluginPrompts.length > 0) {
    parts.push(
      '## 插件须知\n' +
        pluginPrompts.map((p) => `### ${p.name}\n${p.content}`).join('\n\n')
    )
  }

  return parts.join('\n\n')
}

/** 结构化状态快照（kernel_inspect action=overview 用） */
export function buildKernelStatus(): RegistrySnapshot {
  return kernelRegistry.inspect()
}