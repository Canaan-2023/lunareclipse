/**
 * @category Workflow
 * @summary 内置工作流模板：日记撰写（workflow 模式）
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

/**
 * 日记撰写工作流：后端自主日记调度器使用。
 * 单 LLM 节点：读当天 RAW 全文 → 提炼 → 写 diary.md → 更新当月索引表。
 * 替代原 AI 侧 cron diary-daily-write + server.ts 启动补写检查。
 */
export const DIARY_WRITER_TEMPLATE: WorkflowTemplate = {
  id: 'wf_default_diary_writer',
  name: '日记撰写',
  description: '读当天 RAW 对话原文 → 提炼日记 → 写 diary.md → 更新当月索引表',
  tags: ['日记', '默认'],
  mode: 'workflow',
  source: 'default',
  createdAt: now,
  updatedAt: now,
  startNode: 'writer',
  nodes: [
    {
      id: 'writer',
      type: 'llm',
      name: '撰写日记',
      config: {
        stream: false,
        tools: ['Write', 'Read', 'Edit', 'LS'],
        outputVars: ['date', 'diary_path', 'summary', 'skipped'],
        prompt: `{{context.input.workflow_prompts}}

# 角色
你是 ABYSSAC 日记系统的日记撰写 agent。

# 任务
读一天的全部对话原文（RAW），提炼成一篇日记，写入 diary.md，并把该日记登记进当月索引表。

# 输入（已由调度器注入本条消息，直接使用注入内容即可，无需 Read）
- 日期：{{context.input.date}}
- RAW 目录：{{context.input.raw_dir}}
- RAW 全文（含多个对话对，每个含 时间戳/用户原话/AI回复/引用文件）：
{{context.input.raw_contents}}
- diary.md 写入路径：{{context.input.diary_path}}
- 当月索引表路径（按年月目录分层：diary/{年}/{月}/index.json）：{{context.input.index_path}}

# 执行步骤

## 步骤 1：阅读 RAW，判断是否值得写日记
- 当天完全没有对话内容（RAW 为空或只有系统标记）→ 输出 {"skipped": true, "reason": "当天无对话"} 结束
- 有对话但全是寒暄/无实质内容 → 可写一行"无事"或跳过（输出 skipped: true）
- 有实质对话 → 继续步骤 2

## 步骤 2：撰写 diary.md
用 Write 工具写入 {{context.input.diary_path}}，格式：
\`\`\`markdown
# {{context.input.date}} 日记

## 这天
一句话概括这天的主线。

## 对话
和用户聊了什么（主题级，不逐句）

## 值得记的
- 决定/事件/用户的话（每条一两句）

## 来源
raw_memory/{{context.input.date}}/1.md 等
\`\`\`
要求：摘要不是全量照抄——只记值得记的（决定、事件、关键结论）。细节以 RAW 为准。

## 步骤 3：登记当月索引表
先 Read {{context.input.index_path}} 查看当月表现状（文件不存在则视为空表）：
- 若 entries 中已有该日期条目 → 只更新其 summary（覆盖写入，不重复插入）
- 否则在 entries 数组**头部**插入新条目：{"date": "{{context.input.date}}", "file": "raw_memory/YYYY/MM/DD/diary.md", "summary": "一句话摘要"}
- 同步更新 meta.updatedAt 为当前时间
用 Write 写回 {{context.input.index_path}}，结构：
<json>
{"meta": {"updatedAt": "当前时间"}, "entries": [{"date": "...", "file": "...", "summary": "..."}]}
</json>
归档按年份月份自动分类：每个自然月一张表，存于 diary/{年}/{月}/index.json——分层方式与记忆系统 raw_memory/年/月/日 一致，年份再多也不堆积在同一个目录。

# 注意
- 日记不进记忆库，不注入每轮上下文
- 日记是摘要不是全量——细节永远以 RAW 为准
- 如果 diary.md 已存在（补写场景），覆盖写入
- AI 后续回忆某天时，先读对应月份的索引表（diary/{年}/{月}/index.json）定位日期、再读 file 字段指向的 diary.md

# 输出格式
完成后必须输出 <json> 块：
<json>
{"date": "{{context.input.date}}", "diary_path": "{{context.input.diary_path}}", "summary": "一句话日记摘要", "skipped": false}
</json>
跳过时：
<json>
{"date": "{{context.input.date}}", "skipped": true, "reason": "当天无实质对话"}
</json>`
      }
    },
    {
      id: 'end_node',
      type: 'end',
      name: '完成',
      config: {
        output: '日记撰写完成：{{context.writer_result}}'
      }
    }
  ],
  edges: [
    { from: 'writer', to: 'end_node' }
  ]
}
