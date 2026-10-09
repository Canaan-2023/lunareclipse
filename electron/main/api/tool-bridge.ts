/**
 * 工具桥：按工具策略过滤启用项（内置 + MCP 动态工具，渐进式披露控制上下文），
 * 组装成送给 LLM 的工具描述，并转发 AI 发起的工具调用给统一工具执行器；
 * 隔离描述构建与调用转发，供对话各链路复用。
 */
import type { ToolExecutor } from './llm'
import type { AnyTool, ToolRegistry } from '../tools'
import { executeTool } from '../tools'
import type { FrontendToolPolicy, ToolCallSummary } from '@shared/types'
import type { McpClientManager } from '../mcp/client-manager'
import { adaptMcpToolMeta } from '../mcp/tool-adapter'
import {
  getFrontendTools,
  isToolEnabled,
  type McpToolMeta
} from '@shared/tools/registry'
import { redactToolResult } from '../services/redact'

// 工具描述缓存：避免每条消息都重新构建（policy + MCP 工具集变化时才重建）
let toolDescCache: { policyHash: string; mcpToolsHash: string; desc: string } | null = null

export function clearToolDescCache(): void {
  toolDescCache = null
}

/**
 * 动态构建工具描述 system 消息（替代 frontend-ai.md 静态工具段）。
 * 按 frontendToolPolicy 过滤启用的工具，按分类组织描述。
 */
function buildToolDescription(
  policy: FrontendToolPolicy,
  mcpClientManager: McpClientManager | undefined,
  cfg: { webSearchEnabled?: boolean }
): string {
  // 计算缓存键：policy 序列化 + MCP 工具 ID 列表 + 联网开关（web_search 可见性依赖它）
  // aiMode 影响任务模式可见性（team_* 工具 visible 依赖 cfg.aiMode）——缺它会导致切到任务模式后
  // 缓存命中旧描述，团队工具不注入，Lead 提示词在但工具不在
  const policyHash =
    JSON.stringify(policy) +
    `|web=${cfg.webSearchEnabled ?? true}|mode=${(cfg as { aiMode?: string }).aiMode ?? 'coding'}`
  const mcpToolsList = mcpClientManager?.getAllTools() ?? []
  const mcpToolsHash = mcpToolsList
    .map((t) => `${t.serverName}/${t.tool.name}`)
    .sort()
    .join(',')
  if (
    toolDescCache &&
    toolDescCache.policyHash === policyHash &&
    toolDescCache.mcpToolsHash === mcpToolsHash
  ) {
    return toolDescCache.desc
  }

  // 内置工具（按 policy 过滤 + visible 条件过滤；机制工具不列出）
  const builtinTools = getFrontendTools().filter((t) => {
    if (t.isMechanism) return false
    if (!isToolEnabled(t.id, policy.tools)) return false
    // visible 条件：配置不允许时（如关闭联网）不列出，避免 AI 看到但调用必失败
    return !t.visible || t.visible(cfg)
  })

  // MCP 工具（动态发现的 MCP server 工具）
  let mcpTools: McpToolMeta[] = []
  if (mcpClientManager) {
    mcpTools = mcpToolsList
      .map(({ serverName, tool }) => adaptMcpToolMeta(serverName, tool))
      .filter((meta) => isToolEnabled(meta.id, policy.tools))
  }

  // 渐进式披露：
  // MCP/插件工具较多（>8）时不全量注入（省上下文），改为注入 tool_search 桥提示
  // AI 需要动态工具时用 tool_search 查找激活。内置工具保持全量注入（核心稳定）。
  const PROGRESSIVE_THRESHOLD = 8
  const progressiveDynamic = mcpTools.length > PROGRESSIVE_THRESHOLD

  const enabledTools = [...builtinTools, ...(progressiveDynamic ? [] : mcpTools)]

  let desc: string
  if (enabledTools.length === 0) {
    desc = '## 可用工具\n\n当前无可用工具。'
  } else {
    const sections: string[] = ['## 可用工具']

    // 调用机制说明（直接注入：所有启用工具的 schema 已直接注入，AI 直接调用）
    sections.push(
      '### 调用机制',
      '所有启用工具的 schema 已直接注入，你可以直接调用。'
    )

    // 工具 schema 已通过 llm.ts 的 tools 参数注入（function calling），此处不重复列清单
    // 只保留「场景速查」这类 schema 无法表达的映射引导。
    // 场景速查
    sections.push(
      '### 场景速查',
      '| 场景 | 该调什么 |',
      '|------|---------|',
      '| 读/写/改文件 | Read / Write / Edit |',
      '| 找文件 | Glob / LS |',
      '| 搜文件内容 | Grep |',
      '| 联网查实时信息 | web_search |',
      '| 浏览/操作网页 | browser_navigate 打开 → browser_snapshot 看页面结构 → browser_click/type 操作 |',
      '| 用真实浏览器（带登录态） | browser_takeover 接管系统默认浏览器后操作 |',
      '| 在文件工坊中运行代码 | code_run action=run（language 填执行器 ID，code 填代码） |',
      '| 查看可用执行器 | code_run action=list_executors |',
      '| 添加新语言环境 | code_run action=upsert_executor（需 executor 参数） |',
      '| 读文件内容 | Read（文本/代码文件返回带行号内容；图片/二进制返回提示） |',
      '| 执行系统命令 | run_command（需用户确认） |',
      '| 长命令超时（外墙 30s） | 自动转后台继续跑（未中断）；tool_watch 传 taskId 设定检查时间取结果，到期未完成继续 watch 或 tool_stop 主动停止 |',
      '| 复杂任务拆步骤 | TodoWrite |',
      '| 派发独立子任务 | Agent |',
      '| 加载领域 SOP / 操作流程 | use_skill |',
      '| 管理技能（创建/更新/删除） | skill_manage |',
      '| 更新自我认知 / 更新用户偏好 / 改名字 | update_abyss_md / update_user_preference / update_ai_name |',
      '| 按姓名查账号 UID / 按 UID 查用户资料 | search_users / get_user_profile |',
      '| 查看自身扩展清单/生效配置 | kernel_inspect |',
      '| 查看架构模块/维护规则 | module_inspect |',
      '| 查记忆系统 | nng_graph / cache_graph |',
      '| 回溯历史对话/经验 | read_md / nng_graph（记忆库）/ session_search（历史会话原文） |',
      '| 自查上下文用量 | context_usage |',
      '| 编排/运行/复用工作流 | workflow_* 系列 |',
      '',
      '判断原则：当你发现自己不知道答案、需要外部信息、或用户明确要求操作时，就该调工具。'
    )

    // 渐进式披露：MCP/插件工具多时提示用 tool_search 查找（不全量注入省上下文）
    if (progressiveDynamic) {
      sections.push(
        '### 动态工具（渐进披露）',
        `当前有 ${mcpTools.length} 个 MCP/插件工具未全量注入（上下文优化）。需要用到外部/动态工具时，先调 \`tool_search\` 按关键词查找可用工具并获取其 schema（如 "tool_search: 搜索关键词"），找到后直接调用。`,
        `可用动态工具（共 ${mcpTools.length} 个）：${mcpTools.map((t) => `\`${t.id}\``).join(', ')}`
      )
    }

    desc = sections.join('\n\n')
  }

  toolDescCache = { policyHash, mcpToolsHash, desc }
  return desc
}

/**
 * 从工具执行结果（JSON 字符串）提取摘要，供前端卡片第二/三层显示。
 * resultStr 是 ToolResult 的 JSON 字符串（toToolExecutor.execute 内 JSON.stringify(result)）。
 * 按工具类型提取 primary/secondary/addedLines/removedLines/terminalOutput/exitCode。
 */
function buildToolSummary(toolName: string, resultStr: string): ToolCallSummary {
  const fallback: ToolCallSummary = { primary: toolName }
  let parsed: { ok?: boolean; data?: Record<string, unknown>; error?: string }
  try {
    parsed = JSON.parse(resultStr)
  } catch {
    return fallback
  }
  const data = (parsed.data ?? {}) as Record<string, unknown>
  // ok 默认 true（工具返回 ok:true）；工具抛异常时 result 为 { error } 无 ok 字段，视为失败
  const ok = parsed.ok !== false && !(!parsed.ok && parsed.error)

  // 文件类：path + 行 diff
  if (typeof data.path === 'string') {
    const summary: ToolCallSummary = { primary: data.path }
    if (typeof data.addedLines === 'number' || typeof data.removedLines === 'number') {
      summary.addedLines = typeof data.addedLines === 'number' ? data.addedLines : 0
      summary.removedLines = typeof data.removedLines === 'number' ? data.removedLines : 0
    }
    if (typeof data.replacements === 'number') {
      summary.secondary = `${data.replacements} 处替换`
    } else if (typeof data.lines === 'number') {
      summary.secondary = `${data.lines} 行`
    } else if (typeof data.bytes === 'number') {
      summary.secondary = `${data.bytes} 字节`
    }
    if (!ok && parsed.error) summary.secondary = parsed.error
    return summary
  }

  // 命令类：command + exitCode + terminalOutput
  if (typeof data.command === 'string' || toolName === 'run_command' || toolName === 'code_run') {
    const summary: ToolCallSummary = {
      primary: typeof data.command === 'string' ? data.command : toolName
    }
    if (typeof data.exitCode === 'number') {
      summary.exitCode = data.exitCode
      summary.secondary = `退出码 ${data.exitCode}`
    }
    const stdout = typeof data.stdout === 'string' ? data.stdout : ''
    const stderr = typeof data.stderr === 'string' ? data.stderr : ''
    const output = typeof data.output === 'string' ? data.output : ''
    const terminal = stdout || stderr || output
    if (terminal) {
      // 截断保存，避免超大输出撑爆 WS 消息和持久化文件
      summary.terminalOutput =
        terminal.length > 4000 ? terminal.slice(0, 4000) + '\n... (已截断)' : terminal
    }
    if (!ok && parsed.error) summary.secondary = parsed.error
    return summary
  }

  // 浏览器类：url + title
  if (typeof data.url === 'string') {
    const summary: ToolCallSummary = { primary: data.url }
    if (typeof data.title === 'string') summary.secondary = data.title
    return summary
  }

  // 列表类：files/matches/entries 数量
  if (Array.isArray(data.files)) {
    return { primary: `${data.files.length} 个文件` }
  }
  if (Array.isArray(data.matches)) {
    return { primary: `${data.matches.length} 处匹配` }
  }
  if (Array.isArray(data.entries)) {
    return { primary: `${data.entries.length} 项` }
  }
  // web_search 特化：results 是搜索结果数组，映射到 searchResults 供 UI 展开查看
  if (Array.isArray(data.results) && toolName === 'web_search') {
    const results = data.results as Array<Record<string, unknown>>
    const searchResults = results.slice(0, 10).map((r) => ({
      title: typeof r.title === 'string' ? r.title : undefined,
      url: typeof r.url === 'string' ? r.url : undefined,
      snippet: typeof r.snippet === 'string' ? r.snippet : undefined,
      source: typeof r.source === 'string' ? r.source : undefined
    }))
    const summary: ToolCallSummary = {
      primary: typeof data.query === 'string' ? data.query : `${results.length} 条结果`,
      secondary: `${results.length} 条结果`
    }
    if (searchResults.length > 0) summary.searchResults = searchResults
    if (!ok && parsed.error) summary.secondary = parsed.error
    return summary
  }
  if (Array.isArray(data.results)) {
    return { primary: `${data.results.length} 条结果` }
  }
  if (Array.isArray(data.todos)) {
    return { primary: '任务清单已更新', secondary: `${data.todos.length} 项` }
  }

  // 兜底
  if (!ok && parsed.error) {
    return { primary: toolName, secondary: parsed.error }
  }
  return fallback
}

/**
 * 从工具执行结果提取前台卡片摘要（供组件层调用）。
 * 与 buildToolSummary 同源语义，补充软超时托管状态显示：
 * managed=true 表示工具转后台继续运行，卡片展示"后台运行中 + taskId"，
 * 让用户对"没被打断、还在跑"有直觉可感知的反馈（而不是看到超时报错）。
 */
function buildToolCallSummary(toolName: string, resultStr: string): ToolCallSummary {
  const base = buildToolSummary(toolName, resultStr)
  try {
    const parsed = JSON.parse(resultStr) as { managed?: boolean; taskId?: string; tool?: string }
    if (parsed.managed && typeof parsed.taskId === 'string') {
      return {
        primary: `${parsed.tool ?? toolName} 转后台运行中`,
        secondary: `taskId: ${parsed.taskId}（未中断，可用 tool_watch 查询进度、tool_stop 停止）`
      }
    }
  } catch {
    /* 非 JSON 结果不处理托管态 */
  }
  return base
}

// 把内部 AnyTool 转成 LLMClient 期望的 ToolExecutor
// 行动层：execute 走 executeTool 统一入口，触发 PreToolUse/PostToolUse Hook
// 与 DMN 走同一执行路径，保证 Hook 机制对前端 AI 同样生效
function toToolExecutor(tool: AnyTool, registry: ToolRegistry): ToolExecutor {
  return {
    name: tool.name,
    description: tool.description,
    // AnyTool.parameters 是数组，转成 JSON schema object
    parameters: toolParametersToJsonSchema(tool.parameters),
    execute: async (args) => {
      const result = await executeTool(registry, tool.name, args)
      // 敏感信息脱敏：工具结果进 LLM 上下文前扫密钥形态，防止密钥泄漏给模型/落盘
      return JSON.stringify(redactToolResult(result))
    }
  }
}

function toolParametersToJsonSchema(
  params: Array<{ name: string; type: string; description: string; required?: boolean }>
): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const p of params) {
    properties[p.name] = {
      type: p.type,
      description: p.description
    }
    if (p.required) required.push(p.name)
  }
  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined
  }
}

export {
  buildToolDescription,
  buildToolSummary,
  buildToolCallSummary,
  toToolExecutor,
  toolParametersToJsonSchema
}
