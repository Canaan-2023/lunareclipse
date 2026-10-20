/**
 * @category Workflow
 * @summary 内置工作流模板：研究助手（chatflow 模式）
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

export const RESEARCH_ASSISTANT_TEMPLATE: WorkflowTemplate = {
  id: 'wf_default_research',
  name: '研究助手',
  description: '对话式研究助手，理解问题 → 搜索资料 → 综合分析 → 回复用户',
  tags: ['研究', '搜索', '默认'],
  mode: 'chatflow',
  source: 'default',
  createdAt: now,
  updatedAt: now,
  nodes: [
    {
      id: 'understand',
      type: 'llm',
      name: '理解问题',
      config: {
        prompt: '分析用户的问题，提取搜索关键词和调研方向：\n\n用户问题：{{context.user_message}}',
        stream: false
      }
    },
    {
      id: 'search',
      type: 'tool',
      name: '搜索资料',
      config: {
        toolId: 'web_search',
        args: { query: '{{context.understand}}', num: '5' }
      }
    },
    {
      id: 'synthesize',
      type: 'llm',
      name: '综合分析',
      config: {
        prompt: '基于搜索结果，综合分析并回答用户问题：\n\n用户问题：{{context.user_message}}\n\n搜索结果：{{context.search}}',
        stream: true
      }
    },
    {
      id: 'reply',
      type: 'answer',
      name: '回复用户',
      config: {
        content: '{{context.synthesize}}'
      }
    }
  ],
  edges: [
    { from: 'understand', to: 'search' },
    { from: 'search', to: 'synthesize' },
    { from: 'synthesize', to: 'reply' }
  ]
}
