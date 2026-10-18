---
name: workflow-guide
category: automation
description: 运行、创建或修改宿主工作流（模板查询、启动、等待结果、定义/编辑模板）时使用。模板清单用 `workflow_list` 查询；`workflow_run` 默认等待实例跑到终态并返回最终结果，长运行超出软超时后返回 instanceId 继续用 `workflow_status` 轮询（无硬截断）；用户要求把流程固化成工作流、新建或改动工作流模板时按正文步骤执行。
version: 1.0.0
author: ABYSSAC
license: MIT
context: inline
requires-tools: [workflow_list, workflow_run, workflow_status, workflow_define, workflow_edit, workflow_save, workflow_modify, workflow_io]
---

# 工作流使用指南（Workflow Guide）

## 为什么存在

`workflow_*` 工具的函数 schema 只描述了"怎么调"，没有描述"什么时候用、按什么语义用"。本技能是宿主工作流系统的行为指南：模板从哪查、实例如何启动并拿到最终结果、长运行如何处理、如何把流程固化为可复用模板。加载本技能后，按本文语义调用 `workflow_*` 工具。

## 什么时候用

- 需要运行已有工作流并等待最终结果（`workflow_run`）
- 需要查询实例状态或读取结果（`workflow_status`）
- 用户要求"把流程存成工作流 / 建个工作流 / 改一下工作流"（`workflow_define` / `workflow_edit` / `workflow_save`）
- 需要导出 / 导入模板（`workflow_io`）、需要中断或恢复实例（`workflow_modify`）

不使用：记忆工作流与日记（特例，由专用机制管理，不套用本指南）；纯聊天不涉及工作流工具时也不加载。

## 依赖宿主机制(run on host)

依赖宿主装配的 WorkflowManager：`workflow_*` 工具可用即视为已装配。工具不可用（引擎未装配或功能禁用）时：如实报告"工作流引擎不可用"，不虚构模板或运行结果。

## 步骤/流程

### A. 运行工作流并取得最终结果（主线）

1. 先用 `workflow_list` 查模板，拿到 `templateId`（可按 mode/tag 过滤缩小范围）。模板不确定时不要凭空 `workflow_run`。
2. 调用 `workflow_run(templateId="...", input="...")`——默认等待实例跑到终态：
   - `completed`：返回最终 `output`，直接作为结果使用
   - `failed`：返回 `error`，如实向用户报告失败原因
   - `cancelled`：返回已取消
   - `paused`：实例在等用户输入（human 节点），返回暂停信息（prompt/options）——不是失败，先响应用户，需要继续时用 `workflow_modify resume` 或对话流机制恢复
3. 若返回"实例仍在运行（instanceId=...）"（长运行超出软超时未完成）：
   - 引擎仍在后台继续跑，**没有被中断**（无硬截断）
   - 用 `workflow_status(instanceId="...")` 继续轮询，直到 `status=completed/failed`，再读取 `output` / `error`
   - 轮询间隔取数秒到数十秒，不要高频空转
4. 拿到终态结果后，把 `output` 作为工作流结果继续回答用户。

### B. 创建 / 修改模板

1. 明确目标流程：输入是什么、执行哪些步骤、输出什么、是否需要人机对话。
2. 新建用 `workflow_define`（name/description/mode/nodes/edges 必填）；增量改动用 `workflow_edit`（add_node/update_node/add_edge/rename 等 action）；固化保存用 `workflow_save`。
3. 节点类型：`llm`（调 AI）、`tool`（调工具含 MCP）、`skill`（加载 SKILL 正文）、`condition`（条件分支）、`human`（等用户输入）、`answer`（仅 chatflow 回复）、`end`（仅 workflow 输出）。
4. 约束：节点 ID 唯一；连线引用有效节点；`chatflow` 禁用 `end`（用 `answer`）、`workflow` 禁用 `answer`（用 `end`）；必须有起始节点。
5. 改动后可用 `workflow_list` 复核模板清单。

### C. 实例控制

`workflow_modify`：`pause`（暂停）/ `resume`（恢复）/ `cancel`（取消）/ `update_context`（合并上下文补丁）。

## 输出模板

运行成功：

```
工作流「<模板名>」运行完成（实例 <instanceId>）：
- 状态：completed
- 结果：<output 摘要>
```

运行失败：

```
工作流「<模板名>」运行失败（实例 <instanceId>）：<error>
```

## Gotchas

- `workflow_run` 的返回值必须等到终态（completed/failed/cancelled/paused），不要把启动确认当作最终结果
- 超时返回的 `instanceId` 要继续轮询，不能弃之不理——实例仍在后台跑
- `paused` 是等用户输入，不是失败；先响应用户再恢复
- `chatflow` 用 `answer` 结束、`workflow` 用 `end` 结束，搞反会校验失败
- 不为长工作流设硬性等待上限：等不到终态就转 `workflow_status` 轮询

## 完成标准

- [ ] 用 `workflow_list` 确认模板存在后再运行
- [ ] 每次 `workflow_run` 都拿到终态结果（或拿到 instanceId 并轮询到终态）
- [ ] 创建 / 修改模板符合节点与模式约束
- [ ] 失败场景如实报告 `error`，不编造结果