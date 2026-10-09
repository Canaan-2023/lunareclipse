/**
 * 工作流工具组：为什么存在——AI 需要把多步流程固化为可复用工作流（L8 引擎），
 * 而不是每次临时编排、不可沉淀。
 * 作用：workflow_define / run / modify / save / list 五工具，管理工作流的创建、执行与维护。
 */
import type { Tool, ToolResult, ToolContext } from './base-tool'
import type {
  WorkflowDefineParams,
  WorkflowSaveParams,
  WorkflowListParams,
  WorkflowEditParams,
  WorkflowRunParams,
  WorkflowModifyParams,
WorkflowTemplate,
} from '@shared/workflow/types'

/**
 * L8 工作流引擎：8 个 workflow_* AI 工具

 * 这组工具让 AI 能自主编排、运行、固化、复用工作流：
 * - workflow_define / workflow_save / workflow_edit：创建和修改模板
 * - workflow_list：查询可用模板
 * - workflow_run / workflow_modify：运行和控制实例
 * - workflow_io：导入导出模板（复用他人工作流）

 * 所有工具通过 ctx.getWorkflowManager() 访问 WorkflowManager（由 server.ts 注入）。
 * 工具本身是薄包装，业务逻辑在 WorkflowManager 中。
 */

/** 统一获取 WorkflowManager，不存在时返回错误结果 */
function getManager(ctx?: ToolContext): { ok: true; manager: import('../workflow/manager').WorkflowManager } | { ok: false; error: string } {
  const manager = ctx?.getWorkflowManager?.()
  if (!manager) {
    return { ok: false, error: 'WorkflowManager 未初始化（工作流引擎不可用）' }
  }
  return { ok: true, manager }
}

// ===== 1. workflow_define =====

export class WorkflowDefineTool implements Tool {
  name = 'workflow_define'
  description = `创建或更新工作流模板（AI 自主编排任务流程）。name/description/mode/nodes/edges 必填；mode=chatflow（有对话上下文，用 answer 节点回复）| workflow（一次性，用 end 节点终止）；templateId=更新模式（不传新建）。

节点类型：llm（config={prompt,tools?,stream?} 调 AI）、tool（config={toolId,args} 调工具含 MCP）、skill（config={skillId} 加载 SKILL 正文）、condition（config={} 条件分支，出边 condition 控制流向）、human（config={prompt,inputType,options?} 弹窗等用户输入）、answer（config={content} 仅 chatflow）、end（config={output} 仅 workflow）。edges={from,to,condition?}，condition 如 "context.xxx=='value'" / ">10" / "contains 'kw'" / default。hooks 支持 before_node/after_node/on_fail/on_complete/on_user_message。

约束：节点 ID 唯一；连线引用有效节点；chatflow 不能用 end（用 answer）；workflow 不能用 answer（用 end）；必须有起始节点（无入边的节点或 template.startNode 指定）。`
  parameters = [
    { name: 'name', type: 'string' as const, description: '工作流名称', required: true },
    { name: 'description', type: 'string' as const, description: '工作流描述', required: true },
    { name: 'mode', type: 'string' as const, description: '工作流模式：chatflow | workflow', required: true },
    { name: 'nodes', type: 'array' as const, description: '节点列表', required: true },
    { name: 'edges', type: 'array' as const, description: '连线列表', required: true },
    { name: 'tags', type: 'array' as const, description: '标签列表（可选）', required: false },
    { name: 'hooks', type: 'array' as const, description: 'HOOK 配置（可选）', required: false },
    { name: 'templateId', type: 'string' as const, description: '已有模板 ID（更新模式，可选）', required: false }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const m = getManager(ctx)
    if (!m.ok) return m

    try {
      const template = m.manager.defineTemplate(params as unknown as WorkflowDefineParams)
      return {
        ok: true,
        data: {
          templateId: template.id,
          name: template.name,
          mode: template.mode,
          nodeCount: template.nodes.length,
          message: `工作流模板 "${template.name}" 已${params.templateId ? '更新' : '创建'}（ID: ${template.id}）。可用 workflow_run 启动实例。`
        }
      }
    } catch (err) {
      return { ok: false, error: `创建工作流模板失败: ${(err as Error).message}` }
    }
  }
}

// ===== 2. workflow_run =====

export class WorkflowRunTool implements Tool {
  name = 'workflow_run'
  description = `启动工作流实例（templateId 必填，须已存在）。input=输入参数（写进 context.input，节点可用 {{context.input}} 引用）；sessionId=Chatflow 模式关联会话（用于回复前端）。

行为：异步启动立即返回实例 ID（不等待完成）；执行过程经事件流推送（token/tool_start/tool_end 等）；状态流 running → paused（human 节点）→ completed/failed/cancelled；可用 workflow_modify 控制（pause/resume/cancel）。`
  parameters = [
    { name: 'templateId', type: 'string' as const, description: '工作流模板 ID', required: true },
    { name: 'input', type: 'string' as const, description: '输入参数（可选，写进 context.input）', required: false },
    { name: 'sessionId', type: 'string' as const, description: '会话 ID（Chatflow 模式用，可选）', required: false }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const m = getManager(ctx)
    if (!m.ok) return m

    try {
      const instance = await m.manager.runInstance(params as unknown as WorkflowRunParams)
      return {
        ok: true,
        data: {
          instanceId: instance.id,
          status: instance.status,
          templateId: instance.templateId,
          message: `工作流实例已启动（ID: ${instance.id}）。执行过程将通过事件流推送。`
        }
      }
    } catch (err) {
      return { ok: false, error: `启动工作流失败: ${(err as Error).message}` }
    }
  }
}

// ===== 3. workflow_modify =====

export class WorkflowModifyTool implements Tool {
  name = 'workflow_modify'
  description = `修改运行中的工作流实例（运行时动态调整）。instanceId 必填（workflow_run 返回）。
action：pause（手动暂停，pauseReason=manual）| resume（从 paused 恢复）| cancel（取消并停止）| update_context（把 contextPatch 键值对合并进实例的上下文）。
约束：实例必须存在且未完成。`
  parameters = [
    { name: 'instanceId', type: 'string' as const, description: '实例 ID', required: true },
    { name: 'action', type: 'string' as const, description: '操作：pause | resume | cancel | update_context', required: true },
    { name: 'contextPatch', type: 'object' as const, description: 'context 补丁（action=update_context 时用）', required: false }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const m = getManager(ctx)
    if (!m.ok) return m

    try {
      const instance = await m.manager.modifyInstance(params as unknown as WorkflowModifyParams)
      return {
        ok: true,
        data: {
          instanceId: instance?.id,
          status: instance?.status,
          message: `实例 ${params.instanceId} 已执行 ${params.action} 操作`
        }
      }
    } catch (err) {
      return { ok: false, error: `修改实例失败: ${(err as Error).message}` }
    }
  }
}

// ===== 4. workflow_save =====

export class WorkflowSaveTool implements Tool {
  name = 'workflow_save'
  description = `保存工作流模板（固化已编排的流程供复用）。templateId=覆盖更新（不传新建）；name/description/mode/nodes/edges 必填；hooks/tags 可选。
与 workflow_define 区别：save 强调"固化保存"，define 强调"定义创建"。
约束：节点 ID 唯一；连线引用有效；模式与节点类型匹配（chatflow 用 answer / workflow 用 end）。`
  parameters = [
    { name: 'templateId', type: 'string' as const, description: '已有模板 ID（覆盖更新，可选）', required: false },
    { name: 'name', type: 'string' as const, description: '工作流名称', required: true },
    { name: 'description', type: 'string' as const, description: '工作流描述', required: true },
    { name: 'mode', type: 'string' as const, description: '工作流模式：chatflow | workflow', required: true },
    { name: 'nodes', type: 'array' as const, description: '节点列表', required: true },
    { name: 'edges', type: 'array' as const, description: '连线列表', required: true },
    { name: 'tags', type: 'array' as const, description: '标签（可选）', required: false },
    { name: 'hooks', type: 'array' as const, description: 'HOOK 配置（可选）', required: false }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const m = getManager(ctx)
    if (!m.ok) return m

    try {
      const template = m.manager.saveTemplate(params as unknown as WorkflowSaveParams)
      return {
        ok: true,
        data: {
          templateId: template.id,
          name: template.name,
          message: `工作流模板 "${template.name}" 已保存（ID: ${template.id}）`
        }
      }
    } catch (err) {
      return { ok: false, error: `保存工作流失败: ${(err as Error).message}` }
    }
  }
}

// ===== 5. workflow_list =====

export class WorkflowListTool implements Tool {
  name = 'workflow_list'
  description = `列出已保存的工作流模板。mode?: 按 chatflow | workflow 过滤；tag?: 按标签过滤（均不传则全部）。
返回：模板列表每项含 templateId / name / description / mode / tags / nodeCount / source；复用时拿到 templateId 后用 workflow_run 启动。`
  parameters = [
    { name: 'mode', type: 'string' as const, description: '按模式过滤：chatflow | workflow（可选）', required: false },
    { name: 'tag', type: 'string' as const, description: '按标签过滤（可选）', required: false }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const m = getManager(ctx)
    if (!m.ok) return m

    try {
      const templates = m.manager.listTemplates(params as unknown as WorkflowListParams)
      return {
        ok: true,
        data: {
          count: templates.length,
          templates: templates.map((t: WorkflowTemplate) => ({
            templateId: t.id,
            name: t.name,
            description: t.description,
            mode: t.mode,
            tags: t.tags ?? [],
            nodeCount: t.nodes.length,
            source: t.source ?? 'unknown'
          }))
        }
      }
    } catch (err) {
      return { ok: false, error: `列出工作流失败: ${(err as Error).message}` }
    }
  }
}

// ===== 6. workflow_edit =====

export class WorkflowEditTool implements Tool {
  name = 'workflow_edit'
  description = `编辑已有工作流模板（增量修改，无需重传整个模板）。templateId 必填须存在；action + payload：
- add_node（payload={id,type,name,config}）/ remove_node（payload={nodeId} 同时删相关连线）/ update_node（payload={nodeId,config?,name?}）
- add_edge（payload={from,to,condition?}）/ remove_edge（payload={from,to}）/ update_edge（payload={from,to,condition}）
- add_hook（payload={event,matcher?,action}）/ remove_hook（payload={index}）/ rename（payload={name?,description?,tags?}）
约束：payload 结构必须与 action 匹配。`
  parameters = [
    { name: 'templateId', type: 'string' as const, description: '模板 ID', required: true },
    { name: 'action', type: 'string' as const, description: '操作类型', required: true },
    { name: 'payload', type: 'object' as const, description: '操作负载', required: true }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const m = getManager(ctx)
    if (!m.ok) return m

    try {
      const template = m.manager.editTemplate(params as unknown as WorkflowEditParams)
      return {
        ok: true,
        data: {
          templateId: template.id,
          name: template.name,
          nodeCount: template.nodes.length,
          message: `模板 ${template.name} 已执行 ${params.action} 操作`
        }
      }
    } catch (err) {
      return { ok: false, error: `编辑工作流失败: ${(err as Error).message}` }
    }
  }
}

// ===== 7. workflow_io（导出/导入合并） =====

export class WorkflowIoTool implements Tool {
  name = 'workflow_io'
  description = `工作流模板导出/导入（分享或备份）。
action=export：导出模板为 JSON 字符串（可分享给他人，用 import 导入）。
action=import：从 JSON 字符串导入模板（复用他人工作流，生成新 ID 避免冲突）。
参数：
- action（可选，默认 export）
- templateId（export 必填）：模板 ID
- json（import 必填）：模板 JSON 字符串
- newName（import 可选）：新名称（不传则用原名）`
  parameters = [
    { name: 'action', type: 'string' as const, description: 'export（默认，导出）/ import（导入）', required: false },
    { name: 'templateId', type: 'string' as const, description: '模板 ID（export 必填）', required: false },
    { name: 'json', type: 'string' as const, description: '模板 JSON 字符串（import 必填）', required: false },
    { name: 'newName', type: 'string' as const, description: '新名称（import 可选，不传则用原名）', required: false }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const m = getManager(ctx)
    if (!m.ok) return m

    const action = params.action === 'import' ? 'import' : 'export'

    try {
      if (action === 'export') {
        const json = m.manager.exportTemplate(params.templateId as string)
        if (json === null) {
          return { ok: false, error: `模板 ${params.templateId} 不存在` }
        }
        return {
          ok: true,
          data: {
            templateId: params.templateId,
            json,
            message: `模板已导出为 JSON 字符串（可通过 workflow_io action=import 导入）`
          }
        }
      } else {
        const template = m.manager.importTemplate(params.json as string, params.newName as string | undefined)
        return {
          ok: true,
          data: {
            templateId: template.id,
            name: template.name,
            mode: template.mode,
            nodeCount: template.nodes.length,
            message: `工作流模板 "${template.name}" 已导入（ID: ${template.id}）`
          }
        }
      }
    } catch (err) {
      return { ok: false, error: `工作流${action === 'export' ? '导出' : '导入'}失败: ${(err as Error).message}` }
    }
  }
}
