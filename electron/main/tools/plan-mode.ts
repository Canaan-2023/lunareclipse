/**
 * 计划模式：为什么存在——复杂任务应先探索设计与权衡方案、获批后再动手，
 * 避免 AI 边想边改造成不可控破坏。作用：提供 enter_plan_mode / exit_plan_mode 两个工具
 * 与会话级计划状态（Map<sessionKey, boolean>）；执行链（execute-tool.ts）的只读闸消费
 * 本模块状态：计划模式下拦截一切有副作用的工具调用，只放行只读探索与批量只读。
 */
import type { Tool, ToolContext, ToolResult } from './base-tool'

/** 会话级计划模式状态：key 与执行链同一口径（sessionId ?? dmnId ?? 'global'） */
const planModeSessions = new Map<string, boolean>()

/** 会话是否处于计划模式（execute-tool 只读闸消费） */
export function isPlanModeActive(sessionKey: string): boolean {
  return planModeSessions.get(sessionKey) ?? false
}

/** 进入计划模式 */
export function enterPlanMode(sessionKey: string): void {
  planModeSessions.set(sessionKey, true)
}

/** 退出计划模式（用户批准后） */
export function exitPlanMode(sessionKey: string): void {
  planModeSessions.delete(sessionKey)
}

/** 清理全部会话计划状态（应用重启 / 测试隔离用） */
export function resetPlanModeState(): void {
  planModeSessions.clear()
}

/** 会话 key：与 execute-tool 执行链的 sessionKey 同一口径 */
function sessionKeyOf(ctx?: ToolContext): string {
  return ctx?.sessionId ?? ctx?.dmnId ?? 'global'
}

export class EnterPlanModeTool implements Tool {
  name = 'enter_plan_mode'
  description =
    '进入计划模式：切换到只读探索与设计阶段。何时用：任务复杂、需要先摸清现状并权衡多种实现方案再动手时进入；进入后只允许调用只读工具（读文件/搜索内容/列出目录等）与批量只读，任何会改动文件、执行命令或产生其他影响的操作都会被拒绝。就绪后调用 exit_plan_mode 把已设计的方案呈交用户批准，批准后自动退出计划模式、恢复全部能力。'
  parameters: Tool['parameters'] = []
  behavior = {
    readOnly: true,
    concurrencySafe: true
  }
  execute(_params: Record<string, unknown>, ctx?: ToolContext): ToolResult {
    const key = sessionKeyOf(ctx)
    const already = isPlanModeActive(key)
    enterPlanMode(key)
    return {
      ok: true,
      data: {
        message: already
          ? '已在计划模式中。继续只读探索：通读代码库现状、识别可复用模式、比较多种方案利弊；设计完成后调用 exit_plan_mode 提交方案。'
          : '已进入计划模式。本阶段只允许只读操作（读文件/搜索/列表等），禁止写文件或执行命令。请依次：1) 通读相关代码与配置，摸清现状；2) 识别已有的相似实现与架构约定；3) 比较多种做法并说明取舍；4) 方案确定后调用 exit_plan_mode 提交并等待用户批准；批准后自动退出计划模式开始实现。'
      }
    }
  }
}

export class ExitPlanModeTool implements Tool {
  name = 'exit_plan_mode'
  description =
    '退出计划模式：把已设计好的实现方案呈交用户批准。参数 plan（选填）：方案全文，随批准请求展示给用户、批准后回显供后续执行参考。何时用：计划模式下完成探索设计、方案已就绪时调用；用户批准后自动退出计划模式，即可开始写文件、执行命令等实际操作。用户取消则保持在计划模式，继续完善方案。'
  parameters = [
    {
      name: 'plan',
      type: 'string' as const,
      description: '实现方案全文（选填；批准后回显给后续执行参考）',
      required: false
    }
  ]
  behavior = {
    readOnly: true,
    concurrencySafe: true
  }
  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const key = sessionKeyOf(ctx)
    if (!isPlanModeActive(key)) {
      return { ok: false, error: '当前不在计划模式，无需退出。请先调用 enter_plan_mode 进入计划模式；直接实现时继续调用所需工具即可。' }
    }
    // 审批通道：经 WorkflowManager.askUser 弹出确认（前端 wf:paused 弹窗），
    // 用户确认才退出；审批通道不可用或用户取消时 fail-closed 保持计划模式。
    const wf = ctx?.getWorkflowManager?.()
    if (!wf) {
      return { ok: false, error: '当前环境不支持用户审批，无法退出计划模式（保持只读状态）' }
    }
    const plan = typeof params.plan === 'string' && params.plan.length > 0 ? params.plan : undefined
    const requestId = wf.askUser({
      question: plan ? `批准以下方案并退出计划模式开始实现？\n\n${plan}` : '批准退出计划模式并开始实现？',
      inputType: 'confirm'
    })
    try {
      await wf.waitForAskUserResponse(requestId)
    } catch {
      // 用户取消审批：保持计划模式，AI 继续完善方案
      return { ok: false, error: '用户未批准，继续保持在计划模式；可继续完善方案后再次调用 exit_plan_mode' }
    }
    exitPlanMode(key)
    const data: Record<string, unknown> = {
      message: '方案已获用户批准，已退出计划模式，现在可以开始实现。'
    }
    if (plan) data.plan = plan
    return { ok: true, data }
  }
}