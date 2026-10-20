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
 * L8 工作流引擎：9 个 workflow_* AI 工具

 * 这组工具让 AI 能自主编排、运行、固化、复用工作流：
 * - workflow_define / workflow_save / workflow_edit：创建和修改模板
 * - workflow_list：查询可用模板
 * - workflow_run / workflow_status / workflow_modify：运行、查询结果、控制实例
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

/**
 * 默认等待时长：与子代理软超时一致（10 分钟）。
 * 语义对齐子代理软超时托管：不设时间硬截断——等待超过阈值后返回"仍在运行 + instanceId"，
 * 实例继续在后台执行，AI 用 workflow_status 轮询到终态。
 */
const DEFAULT_WORKFLOW_WAIT_MS = 600_000

/**
 * 等待工作流实例跑到可报告状态（completed/failed/cancelled/paused），返回最终结果。
 *
 * 为什么不把 workflow_run 当成"只负责启动"：AI 主动调用工作流的目的是运行并取得结果，
 * 与子代理（launchSubAgent 同步等待最终结果）一致——默认等到终态，失败/取消/暂停如实返回。
 * 无硬截断：等待超过 waitMs 后返回"仍在运行 + instanceId"，实例不被中断，继续轮询即可。
 *
 * 竞态防护：先注册事件监听，再查实例当前状态兜底（极快完成的实例，
 * wf:completed 事件可能在监听注册前已发射，不能依赖事件单独判定）。
 */
function waitForWorkflowResult(
  manager: import('../workflow/manager').WorkflowManager,
  instanceId: string,
  waitMs: number = DEFAULT_WORKFLOW_WAIT_MS
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let settled = false
    // 用对象持有 timer：finish 闭包在赋值前读取 handle（prefer-const 不适用于
    // "赋值前被读取"的 let 声明），对象属性赋值不受该规则约束且语义等价。
    const timerState: { handle: ReturnType<typeof setTimeout> | null } = { handle: null }

    const finish = (data: Record<string, unknown>) => {
      if (settled) return
      settled = true
      if (timerState.handle !== null) clearTimeout(timerState.handle)
      unlisten()
      resolve(data)
    }

    const unlisten = manager.onEvent((event) => {
      if (event.instanceId !== instanceId) return
      if (event.type === 'wf:completed') {
        finish({
          instanceId,
          status: 'completed',
          output: event.output ?? null,
          message: `工作流实例 ${instanceId} 已运行完成，output 为最终结果。`
        })
      } else if (event.type === 'wf:failed') {
        finish({
          instanceId,
          status: 'failed',
          error: event.error,
          message: `工作流实例 ${instanceId} 运行失败：${event.error}`
        })
      } else if (event.type === 'wf:cancelled') {
        finish({
          instanceId,
          status: 'cancelled',
          message: `工作流实例 ${instanceId} 已取消。`
        })
      } else if (event.type === 'wf:paused') {
        finish({
          instanceId,
          status: 'paused',
          pauseReason: event.reason,
          nodeId: event.nodeId ?? null,
          prompt: event.prompt ?? null,
          inputType: event.inputType ?? null,
          options: event.options ?? null,
          message: `工作流实例 ${instanceId} 已暂停（等待用户输入）：${event.prompt ?? event.reason}。响应用户后可恢复，不要持续等待。`
        })
      }
    })

    // 竞态兜底：终态事件可能在监听注册前已发射（实例极快完成/暂停），直接读实例状态
    const current = manager.getInstance(instanceId)
    if (current && (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled' || current.status === 'paused')) {
      finish({
        instanceId,
        status: current.status,
        output: current.output ?? null,
        error: current.error ?? null,
        pauseReason: current.pauseReason ?? null,
        message:
          current.status === 'completed'
            ? `工作流实例 ${instanceId} 已运行完成，output 为最终结果。`
            : current.status === 'failed'
              ? `工作流实例 ${instanceId} 运行失败：${current.error}`
              : current.status === 'cancelled'
                ? `工作流实例 ${instanceId} 已取消。`
                : `工作流实例 ${instanceId} 已暂停（等待用户输入），响应用户后可恢复。`
      })
      return
    }

    // 软超时：不硬断，转后台托管——实例继续跑，返回 instanceId 供 workflow_status 轮询
    timerState.handle = setTimeout(() => {
      const latest = manager.getInstance(instanceId)
      finish({
        instanceId,
        status: latest?.status ?? 'running',
        message: `工作流实例 ${instanceId} 仍在运行（已等待 ${waitMs}ms 未完成）。实例未被中断，继续在后台执行；请用 workflow_status(instance_id="${instanceId}") 继续查询，直到 status=completed 或 failed 再读取最终结果。`
      })
    }, waitMs)
  })
}

export class WorkflowRunTool implements Tool {
  name = 'workflow_run'
  description = `启动工作流实例并默认等待最终结果（templateId 必填，须已存在）。input=输入参数（写进 context.input，节点可用 {{context.input}} 引用）；sessionId=Chatflow 模式关联会话（用于回复前端）。

行为（默认 wait=true，对齐子代理软超时语义）：
- 等待实例跑到可报告状态后返回：completed 返回 output（最终结果）；failed 返回 error；cancelled 返回已取消；paused 表示实例在等用户输入（human 节点），返回暂停信息，响应用户后可恢复。
- 不设时间硬截断：长运行超过软超时（10 分钟）仍未完成时，返回"仍在运行 + instanceId"——实例不被中断、继续后台执行，用 workflow_status(instance_id=...) 继续轮询直到 status=completed/failed，再读取最终结果。
- wait=false：立即返回启动确认（不等待），之后一律用 workflow_status 轮询。
状态流：running → paused（human 节点）→ completed/failed/cancelled；可用 workflow_modify 控制（pause/resume/cancel/update_context）。`
  parameters = [
    { name: 'templateId', type: 'string' as const, description: '工作流模板 ID', required: true },
    { name: 'input', type: 'string' as const, description: '输入参数（可选，写进 context.input）', required: false },
    { name: 'sessionId', type: 'string' as const, description: '会话 ID（Chatflow 模式用，可选）', required: false },
    { name: 'wait', type: 'boolean' as const, description: '是否等待实例跑到终态返回最终结果（默认 true；false 则立即返回启动确认，用 workflow_status 轮询）', required: false }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const m = getManager(ctx)
    if (!m.ok) return m

    // wait 是工具层参数，不传给引擎（WorkflowRunParams 无此字段）
    const { wait, ...runParams } = params
    const shouldWait = wait !== false

    try {
      const instance = await m.manager.runInstance(runParams as unknown as WorkflowRunParams)
      const instanceId = instance.id

      if (!shouldWait) {
        return {
          ok: true,
          data: {
            instanceId,
            status: instance.status,
            templateId: instance.templateId,
            message: `工作流实例已异步启动（ID: ${instanceId}，wait=false）。执行过程经事件流推送，用 workflow_status 轮询到终态。`
          }
        }
      }

      const result = await waitForWorkflowResult(m.manager, instanceId)
      return {
        ok: true,
        data: {
          templateId: instance.templateId,
          templateName: instance.templateName,
          ...result
        }
      }
    } catch (err) {
      return { ok: false, error: `启动工作流失败: ${(err as Error).message}` }
    }
  }
}

// ===== 2.5 workflow_status =====

export class WorkflowStatusTool implements Tool {
  name = 'workflow_status'
  description = `查询工作流实例的运行状态与输出（instanceId 必填，workflow_run 返回）。
workflow_run 默认已等待终态并直接返回最终结果；仅在以下情况用本工具继续查询：
- workflow_run 长运行超过软超时返回了"仍在运行 + instanceId"（实例未被中断，后台继续执行）
- workflow_run(wait=false) 异步启动模式
- 需要查看节点历史、当前节点或中途状态
状态解读：
- status=running/paused：执行中或等待（human 节点等用户输入），可稍后再查
- status=completed：返回最终 output（end 节点输出）
- status=failed/cancelled：返回 error 或已取消
- currentNode：当前执行到的节点 ID；history：已执行节点列表（nodeId/nodeName/nodeType/status/output/error）
用途：拿到 workflow_run 未等待完成的实例的最终结果。`
  parameters = [
    { name: 'instanceId', type: 'string' as const, description: '工作流实例 ID（workflow_run 返回）', required: true }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const m = getManager(ctx)
    if (!m.ok) return m

    const instanceId = params.instanceId as string
    if (!instanceId) {
      return { ok: false, error: 'instanceId 必填' }
    }
    try {
      const instance = m.manager.getInstance(instanceId)
      if (!instance) {
        return { ok: false, error: `实例 ${instanceId} 不存在（可能已清理）` }
      }
      return {
        ok: true,
        data: {
          instanceId: instance.id,
          templateId: instance.templateId,
          templateName: instance.templateName,
          status: instance.status,
          currentNode: instance.currentNode,
          mode: instance.mode,
          output: instance.output,
          error: instance.error,
          pauseReason: instance.pauseReason ?? undefined,
          startedAt: instance.startedAt,
          completedAt: instance.completedAt,
          history: instance.history.map((h) => ({
            nodeId: h.nodeId,
            nodeName: h.nodeName,
            nodeType: h.nodeType,
            status: h.status,
            output: h.output,
            error: h.error
          })),
          message: `实例 ${instanceId} 状态：${instance.status}${instance.status === 'completed' ? '（已完成，可在 output 读取最终结果）' : instance.status === 'failed' ? `（失败：${instance.error ?? '未知原因'}）` : ''}`
        }
      }
    } catch (err) {
      return { ok: false, error: `查询工作流实例失败: ${(err as Error).message}` }
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


