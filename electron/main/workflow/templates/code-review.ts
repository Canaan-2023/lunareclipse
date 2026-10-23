/**
 * @category Workflow
 * @summary 内置工作流模板：代码审查（workflow 模式）
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

/** 代码审查工作流（Workflow 模式） */
export const CODE_REVIEW_TEMPLATE: WorkflowTemplate = {
  id: 'wf_default_code_review',
  name: '代码审查',
  description: '读取工作区源码文件，AI 审查问题，人工确认后输出审查报告',
  tags: ['代码', '审查', '默认'],
  mode: 'workflow',
  source: 'default',
  createdAt: now,
  updatedAt: now,
  nodes: [
    {
      id: 'read_diff',
      type: 'tool',
      name: '列出源码文件',
      config: {
        toolId: 'run_command',
        args: {
          command: 'Get-ChildItem -Recurse -Include *.ts,*.tsx,*.js,*.jsx -File -Name',
          description: '列出工作区源码文件供 AI 审查'
        }
      }
    },
    {
      id: 'review',
      type: 'llm',
      name: 'AI 审查',
      config: {
        prompt: '请审查以下源码文件，指出潜在问题、改进建议和优秀实践：\n\n{{context.read_diff}}',
        stream: false
      }
    },
    {
      id: 'confirm',
      type: 'human',
      name: '人工确认',
      config: {
        prompt: 'AI 审查结果如下，是否采纳？\n\n{{context.review}}',
        inputType: 'choice',
        options: ['采纳', '修改后采纳', '驳回'],
        timeoutMs: 300000
      }
    },
    {
      id: 'output',
      type: 'end',
      name: '输出报告',
      config: {
        output: '审查结论：{{context.confirm}}\n\n详细审查：{{context.review}}'
      }
    }
  ],
  edges: [
    { from: 'read_diff', to: 'review' },
    { from: 'review', to: 'confirm' },
    { from: 'confirm', to: 'output' }
  ]
}
