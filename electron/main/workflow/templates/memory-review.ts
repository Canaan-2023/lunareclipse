/**
 * @category Workflow
 * @summary 内置工作流模板：记忆质量审查（workflow 模式）
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
 * 记忆主调度器审查工作流（用户设计）：子 AGENT 全部完成后，主调度审查。
 * 检查记忆与 NNG 格式疏漏 → 直接修复 → 输出审查结果。
 */
export const MEMORY_REVIEW_TEMPLATE: WorkflowTemplate = {
  id: 'wf_default_memory_review',
  name: '记忆质量审查',
  description: '审查主调度器生成的记忆 + 子 AGENT 的 NNG 处理，修复格式疏漏',
  tags: ['记忆', '质检', '默认'],
  mode: 'workflow',
  source: 'default',
  createdAt: now,
  updatedAt: now,
  startNode: 'review',
  nodes: [
    {
      id: 'review',
      type: 'llm',
      name: '审查与修复',
      config: {
        stream: false,
        tools: ['read_md', 'Read', 'Glob', 'nng_graph', 'Edit', 'create_memory', 'create_nng', 'MoveFile', 'DeleteFile'],
        outputVars: ['通过', '修复项', '遗留问题'],
        prompt: `{{context.input.workflow_prompts}}

# 角色
你是 ABYSSAC 记忆系统的质量审查 agent。

# 任务
审查本批次全部产物（主调度器生成的记忆 + 各子 AGENT 的 NNG 处理），检查结构疏漏并修复。

# 输入
- 任务清单（主调度器输出）：{{context.input.task_list}}
- 子 AGENT 处理结果：{{context.input.agent_results}}
- RAW 路径：{{context.input.raw_path}}

# 检查标准（只查结构健康，不查价值——价值判断是主调度器的事）

## 记忆格式（逐条 Read 记忆文件）
- type 合法（normal/meta/high）
- normal：用户原话（≤500 字应为原文，>500 字可为精炼）与 AI回复（精炼结论 ≤800 字）非空
- **AI身份**：normal 记忆应有 AI身份 字段（工具自动从 RAW 路径作用域解析 AI 编号 → 名字）；缺失 → 检查修正
- **用户字段**：normal 记忆应有 用户（UID+用户名，工具自动从 RAW 路径作用域解析）；缺失 → 检查修正
- high/meta：精炼内容 非空；备注 注明场景 + 涉及的 NNG 路径（high=张力冲突双方，meta=桥接源/目标，追溯来源）
- RAW来源 非空且指向存在的 RAW 文件（可溯源）
- 描述 符合命名范式 {域词}_{主题词}_{状态词}（文件名 = 序号 + 描述，序号由工具从 RAW来源 自动解析，不由 描述 带入）：无流水账长句、无非法字符（只允许汉字/字母/数字/下划线）
- 备注 非空（生成场景/原因）
- 时间戳 与对话时间一致（记忆归到对话发生日期）
- **序号对齐 RAW**：记忆文件名序号应等于其 RAW来源 的 RAW 序号（RAW#3 → 3_xxx.json）。发现序号与 RAW 不对齐（如 RAW#3 的记忆却是 5_xxx）说明生成异常，检查修正。

## NNG 结构（nng_graph + Read 检查）
- 每条记忆都有归属（关联NNG 由监控器同步，检查记忆是否已归位到语义相关节点）
- 无孤儿记忆（建了记忆没归位）
- NNG 命名合规（文件形如 {类型前缀}{语义名}_nng.json：普通无前缀、meta 加 meta_、high 加 high_；同名文件夹去掉 _nng.json；不带层级序号——层级只由文件夹位置表达）、**描述必填且覆盖当前关联记忆范围**（描述留空 = 节点不存在）
- **描述 ≤200 字（硬上限）**：任何 NNG 的 描述 不得超过 200 字。发现超长描述 → 拆分：新建子 NNG 承接部分关联记忆 + 精简原描述（拆子节点分层收纳，不堆描述）
- 类型对应：normal 记忆→普通 NNG、meta 记忆→meta NNG、high 记忆→high NNG（不能混）
- **结构克制**：无碎片化（同主题多个节点）、无一级膨胀（零散单条不该建一级——发现"杂碎一级"（描述太具体/只装一条记忆的一级）→ 归并到抽象父级或聚合 meta）
- **high 层级合规**：high NNG 不在 NNG 一级节点目录（{NNG 一级节点目录}）一级（没上级的 high = 伪 high）；high/meta NNG 有对应记忆、下级NNG 已填（跨文件夹必须手动填）
- 归档分流正确：归档 NNG（archive/ 内）只装被归档的记忆，保留 NNG 装其余记忆（不混装）；归档 NNG 有 归档记录 字段
- 聚合 meta（收纳零散）的节点：描述注明覆盖范围，后续同类可继续归入

# 修复
- 有疏漏 → 用工具直接修复：Edit 补描述/备注/下级NNG、MoveFile 调整位置、DeleteFile 删除孤儿、create_nng 补建节点
- 无法修复的 → 在结果里标注遗留问题

# 输出格式
完成后必须输出 <json> 块：
<json>
{"通过": true, "修复项": ["..."], "遗留问题": []}
</json>
- 通过=false 时列出遗留问题（供调度器记录）；已修复的不算遗留`
      }
    },
    {
      id: 'end_node',
      type: 'end',
      name: '完成',
      config: {
        output: '审查完成：{{context.review_result}}'
      }
    }
  ],
  edges: [
    { from: 'review', to: 'end_node' }
  ]
}
