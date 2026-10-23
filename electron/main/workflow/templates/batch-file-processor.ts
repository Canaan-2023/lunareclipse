/**
 * @category Workflow
 * @summary 内置工作流模板：批量文件处理（workflow 模式）
 *
 * 为什么独立成文件：内置模板是「随新增模板 / 修改模板节点增长」的数据表，9 个模板互相无引用却
 * 曾共处 999 行的 default-templates.ts，任一模板改动都与其它模板构成 merge 冲突热点（ADR-08）。
 * 拆出后本文件只承载单个模板字面量；聚合与对外导出面在宿主 ./../default-templates.ts。
 *
 * 不删理由：删掉即该内置模板从开箱清单消失（DEFAULT_TEMPLATES 少一项，首启不再落盘该模板）。
 * 约束：createdAt/updatedAt 必须 import 同一 `now`（./shared），禁止本地重声明——否则 updatedAt
 * 抖动会触发 store.save() 回写与 .src 指纹漂移（ADR-08 §4 `now` 单源红线）。
 */
import type { WorkflowTemplate } from '@shared/workflow/types'
import { now } from './shared'

export const BATCH_FILE_PROCESSOR_TEMPLATE: WorkflowTemplate = {
  id: 'wf_default_batch',
  name: '批量文件处理',
  description: '列举文件 → AI 分析每个文件 → 按条件分支处理 → 输出汇总',
  tags: ['批量', '文件', '默认'],
  mode: 'workflow',
  source: 'default',
  createdAt: now,
  updatedAt: now,
  nodes: [
    {
      id: 'list_files',
      type: 'tool',
      name: '列举文件',
      config: {
        toolId: 'glob',
        args: { pattern: '**/*.{ts,tsx}', path: '.' }
      }
    },
    {
      id: 'analyze',
      type: 'llm',
      name: 'AI 分析',
      config: {
        prompt: '分析以下文件列表，判断是否需要处理，并给出处理建议：\n\n{{context.list_files}}',
        stream: false
      }
    },
    {
      id: 'branch',
      type: 'condition',
      name: '条件分支',
      config: {}
    },
    {
      id: 'process',
      type: 'llm',
      name: '执行处理',
      config: {
        prompt: '根据分析结果执行处理：\n\n{{context.analyze}}',
        stream: true
      }
    },
    {
      id: 'skip',
      type: 'llm',
      name: '跳过处理',
      config: {
        prompt: '无需处理，生成跳过说明：\n\n{{context.analyze}}',
        stream: false
      }
    },
    {
      id: 'summary',
      type: 'end',
      name: '输出汇总',
      config: {
        output: '处理结果：{{context.process}}\n\n或跳过说明：{{context.skip}}'
      }
    }
  ],
  edges: [
    { from: 'list_files', to: 'analyze' },
    { from: 'analyze', to: 'branch' },
    { from: 'branch', to: 'process', condition: "context.analyze contains '需要处理'" },
    { from: 'branch', to: 'skip', condition: 'default' },
    { from: 'process', to: 'summary' },
    { from: 'skip', to: 'summary' }
  ]
}
