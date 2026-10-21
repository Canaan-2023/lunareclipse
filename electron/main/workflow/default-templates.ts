/**
 * L8 工作流引擎：内置默认工作流模板



 * 3 个开箱即用的模板，覆盖典型场景：
 * - code-review：Workflow 模式，代码审查（读 diff → 审查 → 人工确认 → 输出）
 * - research-assistant：Chatflow 模式，研究助手（理解 → 搜索 → 综合 → 回复）
 * - batch-file-processor：Workflow 模式，批量文件处理（列举 → 分析 → 分支 → 输出）

 * 使用固定 ID（wf_default_*），ensureDefaultTemplates 扫描时已存在则跳过（不覆盖用户修改）

 * 提示词真源说明（去 JSON 化规范）：
 * - 本文件（含其聚合的 ./templates/*.ts）的 llm 节点 config.prompt 是内置模板提示词的**唯一真源（内置层）**。
 * - manager.ensureDefaultTemplates() 在启动时对 source=default 模板调用 store.save()，
 * save() 会把 prompt 外置为 workflows/prompts/{模板id}/{节点id}.md（生效层），
 * 并在 MD 旁写 .src 指纹：MD 未被编辑时内置更新自动同步到 MD，被编辑则保留用户版本。
 * - 磁盘 JSON 模板副本（templates/{id}.json）不内嵌 prompt 正文，仅保留 promptFile 引用。
 * - 请勿在上述文件以外维护提示词副本——内置更新以它们为源，经 save() 单向同步到 MD。
 * 为什么存在：引擎需要开箱即用的预置模板（代码审查/研究助手/批量处理），让用户不经手自建即可跑通两种流程模式。
 *
 * 目录化（ADR-08）：9 个模板已逐文件外移到 ./templates/*.ts，本文件只作聚合与 re-export。
 * 「提示词唯一真源」语义不变——内置层 = ./templates/*.ts，经本文件聚合后仍由 save() 单向同步到外置 MD。
 */
import type { WorkflowTemplate } from '@shared/workflow/types'
import { CODE_REVIEW_TEMPLATE } from './templates/code-review'
import { RESEARCH_ASSISTANT_TEMPLATE } from './templates/research-assistant'
import { BATCH_FILE_PROCESSOR_TEMPLATE } from './templates/batch-file-processor'
import { MEMORY_DISPATCHER_TEMPLATE } from './templates/memory-dispatcher'
import { MEMORY_AGENT_TEMPLATE } from './templates/memory-agent'
import { MEMORY_REVIEW_TEMPLATE } from './templates/memory-review'
import { DIARY_WRITER_TEMPLATE } from './templates/diary-writer'
import { ASSET_CREATOR_TEMPLATE } from './templates/asset-creator'
import { ATTACK_CHAIN_TEMPLATE } from './templates/attack-chain'

// 逐常量 re-export：原文件导出面逐字保留（消费方 manager.ts / test 零改动）
export {
  CODE_REVIEW_TEMPLATE,
  RESEARCH_ASSISTANT_TEMPLATE,
  BATCH_FILE_PROCESSOR_TEMPLATE,
  MEMORY_DISPATCHER_TEMPLATE,
  MEMORY_AGENT_TEMPLATE,
  MEMORY_REVIEW_TEMPLATE,
  DIARY_WRITER_TEMPLATE,
  ASSET_CREATOR_TEMPLATE,
  ATTACK_CHAIN_TEMPLATE
}

/** 所有默认模板列表 */
export const DEFAULT_TEMPLATES: WorkflowTemplate[] = [
  CODE_REVIEW_TEMPLATE,
  RESEARCH_ASSISTANT_TEMPLATE,
  BATCH_FILE_PROCESSOR_TEMPLATE,
  MEMORY_DISPATCHER_TEMPLATE,
  MEMORY_AGENT_TEMPLATE,
  MEMORY_REVIEW_TEMPLATE,
  DIARY_WRITER_TEMPLATE,
  ASSET_CREATOR_TEMPLATE,
  ATTACK_CHAIN_TEMPLATE
]
