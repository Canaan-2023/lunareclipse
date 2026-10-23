/**
 * Hook 事件列举工具：为什么存在——AI 需要知道系统支持哪些 hook 事件、当前已启用哪些 hook，
 * 才能正确配置治理与审计能力。
 * 作用：hook_list 返回全部事件清单与当前已注册 hook 信息（经 kernelRegistry 查询）。
 */
import type { ToolContext, ToolResult } from './base-tool'
import { kernelRegistry } from '../kernel'
import type { HookEvent } from '../../../shared/types'

/** 全部 Hook 事件（遍历用） */
const ALL_EVENTS: HookEvent[] = [
  'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'PreLLMCall', 'Stop', 'SubagentStop', 'Notification'
]

/**
 * hook_list 工具：检视全部生效 hook（三源合并）
 *
 * - config hooks：用户配置文件（hooks.json）注册的 command/javascript hook
 * - 内核 hook：LXK 治理机制（空转抑制/查证提醒/收尾反思/失败止损，builtin 来源）
 * - 插件 hook：插件 hooks.js 注册的函数 hook（plugin 来源）
 *
 * 用途：AI 想知道"自己身上有哪些机制在跑"——治理闭环的检视面。
 * 与 kernel_inspect（内核注册表视角）互补：本工具是"hook 专面"。
 */
export class HookListTool {
  name = 'hook_list'
  description = `列出当前生效的钩子（hook）机制：配置文件注册的 + 系统内置治理机制 + 插件注册的，按事件分组显示（事件/匹配规则/类型/来源）。
想知道自己身上有哪类钩子机制（拦截事件/附加处理）正在运行时用本工具；与 kernel_inspect（运行状态检视）互补。`
  parameters = []

  async execute(_params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const out: Array<Record<string, unknown>> = []
    const hm = ctx?.hookManager

    for (const event of ALL_EVENTS) {
      // 1. config hooks（文件配置）
      const configHooks = hm?.listByEvent(event) ?? []
      for (const h of configHooks) {
        out.push({
          event,
          matcher: h.matcher ?? '.*',
          type: h.handler.type,
          source: 'config'
        })
      }
      // 2. 内核 + 插件 hook（registry）
      const kernelHooks = kernelRegistry
        .getHandles('hook')
        .filter((hh) => (hh.value as { event: string }).event === event)
      for (const hh of kernelHooks) {
        const v = hh.value as { matcher?: string }
        out.push({
          event,
          matcher: v.matcher ?? '.*',
          type: 'function',
          source: hh.source.kind === 'plugin' ? `plugin:${hh.source.pluginName}` : 'kernel'
        })
      }
    }

    return {
      ok: true,
      data: {
        total: out.length,
        hooks: out,
        tip: 'config=配置文件注册；kernel=内置治理机制；plugin:xxx=插件注册。停用单个治理机制用 config_patch 写 governance.{机制名}=false'
      }
    }
  }
}
