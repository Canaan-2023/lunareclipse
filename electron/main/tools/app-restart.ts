/**
 * 应用重启工具：为什么存在——AI 修改配置/补丁后需要重启应用才能生效，但重启是高影响
 * 动作，必须走权限检查或绿通授权，不能由 AI 静默执行。
 * 作用：app_restart 触发应用重启，reason 会出现在授权弹窗与日志中。
 */
import type { Tool, ToolResult, ToolContext } from './base-tool'

export interface AppRestartToolParams {
  /** 重启原因（可选，会出现在授权弹窗和日志中） */
  reason?: string
}

/**
 * AI 自我重启应用（权限绿通模式配套工具）。
 *
 * 行为：
 * - 权限绿通开启（ctx.requestAppRestart 内部处理）：直接 app.relaunch + quit，新进程保留绿通
 * - 权限绿通关闭：通过 requestPermission 弹窗请求用户授权，用户允许才重启
 *
 * 安全边界（保底防死循环）：
 * - 用户完全关闭应用（非 AI 自我重启）→ before-quit 重置绿通为 false → 下次启动绿通自动关闭
 * - 黑名单命令拦截在 run_command 工具内部，与本工具无关
 */
export class AppRestartTool implements Tool<AppRestartToolParams> {
  name = 'app_restart'
  description =
    '重启月蚀应用。已开启"应用自动重启授权"时直接重启；未开启时需用户确认。参数：reason（可选，重启原因，会显示在授权弹窗中）。仅用于需要重新加载主进程代码或恢复异常状态时，慎用。'
  parameters = [
    { name: 'reason', type: 'string' as const, description: '重启原因（可选，显示在授权弹窗和日志中）', required: false }
  ]

  async execute(params: AppRestartToolParams, ctx?: ToolContext): Promise<ToolResult> {
    const reason = params.reason?.trim() || 'AI 请求重启应用'

    if (!ctx?.requestAppRestart) {
      return { ok: false, error: 'app_restart 工具需要 requestAppRestart 上下文（未注入）' }
    }

    // 绿通开启时 ctx.requestAppRestart 内部直接重启；关闭时先请求用户授权
    // 授权逻辑放在 requestAppRestart 实现里，保证前后端 AI 行为一致
    return ctx.requestAppRestart(reason)
  }
}
