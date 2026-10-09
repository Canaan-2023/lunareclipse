/**
 * 内核自省工具：为什么存在——AI 需要看清自身系统装了什么（工具/hook/提示词/配置/命令），
 * 才能理解能力边界并诊断异常。
 * 作用：kernel_inspect 提供 overview / detail 两种动作，汇总内核各扩展清单的数量与来源分布。
 */
import type { AnyTool, ToolContext, ToolResult } from './base-tool'
import { buildKernelStatus } from '../kernel/introspection'

/**
 * kernel_inspect：自我检视工具（合并原 kernel_inspect + config_effective）。
 *
 * - action=overview：扩展清单概览（工具/hook/提示词段/配置覆盖/命令 数量 + 来源分布）
 * - action=detail：按类别列出注册条目（可选 kind 过滤：tool/hook/prompt/configPatch/command）
 * - action=effective：当前生效配置结构（核心 + 覆盖层合并），可选 key 过滤
 */

function summarizeConfig(cfg: Record<string, unknown>, filterKey?: string): unknown {
  const KEYS = [
    'aiName', 'persona', 'theme',
    'frontendToolPolicy', 'dmn', 'lilith',
    'llm', 'dmnLlm', 'contextWindow',
    'webSearchEnabled', 'permissionGreenlight',
    'messaging', 'rawMaxChars'
  ]
  if (filterKey) {
    return { [filterKey]: cfg[filterKey] ?? '（不存在该 key）' }
  }
  const out: Record<string, unknown> = {}
  for (const k of KEYS) {
    if (k in cfg) out[k] = cfg[k]
  }
  return out
}

export class KernelInspectTool {
  name = 'kernel_inspect'
  description = `自我检视：看清自己的扩展清单和生效配置再动手改。
action=overview（默认）返回工具/hook/提示词段/配置覆盖/命令 各多少、来源分布；
action=detail 按类别列出注册条目（可选 kind 过滤：tool/hook/prompt/configPatch/command）；
action=effective 返回当前生效配置结构（核心+覆盖层合并），可选 key 过滤某配置项。`
  parameters = [
    { name: 'action', type: 'string' as const, description: 'overview（默认）/ detail / effective', required: false },
    { name: 'kind', type: 'string' as const, description: '注册类别（detail 模式：tool/hook/prompt/configPatch/command）', required: false },
    { name: 'key', type: 'string' as const, description: '配置项名（effective 模式：如 frontendToolPolicy / lilith / contextWindow）', required: false }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const action = String(params.action ?? 'overview').trim()

    if (action === 'effective') {
      const cfg = ctx?.config as Record<string, unknown> | undefined
      if (!cfg) return { ok: false, error: '无法访问生效配置（ctx.config 缺失）' }
      const key = params.key as string | undefined
      return { ok: true, data: summarizeConfig(cfg, key) }
    }

    const snap = buildKernelStatus()

    if (action === 'detail') {
      const kind = params.kind as string | undefined
      const pick = (k: string): boolean => !kind || k === kind
      const data: Record<string, unknown> = {}
      if (pick('tool')) data.tools = snap.tools
      if (pick('hook')) data.hooks = snap.hooks
      if (pick('prompt')) data.prompts = snap.prompts
      if (pick('configPatch')) data.configPatches = snap.configPatches
      if (pick('command')) data.commands = snap.commands
      return { ok: true, data }
    }

    // overview
    return {
      ok: true,
      data: {
        counts: snap.counts,
        bySource: snap.bySource,
        tip: '详细清单切 action=detail；生效配置切 action=effective'
      }
    }
  }
}

export type { AnyTool, ToolResult, ToolContext }
