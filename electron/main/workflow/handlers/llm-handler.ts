/**
 * L8 工作流引擎：llm 节点处理器



 * 职责：调 AI（用 config.llm 配置）执行 prompt，收结果写进 context

 * 复用现有能力：
 * - LLMClient.streamWithTools（api/llm.ts）：流式带工具调用循环
 * - RawMemoryWriter：stream 结束时自动写 raw_memory（由上层注入的 onDone 回调触发）
 * - 完整输出：AI 输出整体作为节点 output 写进 context（无截断、不落盘）

 * 行为：
 * - 解析 prompt 中的 {{context.xxx}} 变量
 * - Chatflow 模式：把对话历史 messages 拼进 LLM 上下文
 * - stream=true（默认）：走 streamWithTools，流式输出 token 给前端，onDone 时写 raw_memory
 * - stream=false：走 chatWithTools 非流式（仅返回结果，不写 raw_memory，用于中间步骤）
 * - AI 完整输出作为 output（写进 context）
 * 为什么存在：LLM 节点是工作流的核心执行单元（调 AI 收结果写 context），独立成 handler 便于复用流式/非流式与 raw_memory 回写。
 */
import { existsSync, readFileSync } from 'fs'
import type { NodeHandler, NodeHandlerContext, LlmConfig } from '@shared/workflow/types'
import { validateConfig } from './validate'
import { validateWithinDir } from '../../tools/security-engine/path-security'
import { WORKFLOW_GUARDRAIL_KEY } from '../../api/message-guardrail'

export class LlmHandler implements NodeHandler {
async handle(ctx: NodeHandlerContext): Promise<{ output: string }> {
    const config = validateConfig<LlmConfig>(ctx.node, [])
    if (!config.prompt && !config.promptFile) {
      throw new Error(
        `节点 "${ctx.node.name}"(${ctx.node.id}) 配置无效: llm 节点需要 prompt 或 promptFile 至少其一（提示词 MD 缺失且无内嵌回退）`
      )
    }
    const instance = ctx.instance

    // 提示词外置：promptFile 存在且可读 → 用文件内容（用户可编辑 MD 副本优先），否则回退 prompt 字段
    let promptText = config.prompt
    if (config.promptFile) {
      const allowedRoot = ctx.workflowsRoot
      if (!allowedRoot) {
        console.warn('[workflow] workflowsRoot 未注入，promptFile 路径校验跳过（回退内嵌 prompt）')
      } else {
        const pathError = validateWithinDir(config.promptFile, allowedRoot)
        if (pathError) {
          console.warn(
            `[workflow] promptFile 路径越界（回退内嵌 prompt）: ${config.promptFile} → ${pathError}`
          )
        } else {
          try {
            if (existsSync(config.promptFile)) {
              const fileContent = readFileSync(config.promptFile, 'utf-8')
              if (fileContent.trim().length > 0) {
                promptText = fileContent
              }
            }
          } catch (err) {
            console.warn(
              `[workflow] 提示词文件读取失败（回退内嵌 prompt）: ${config.promptFile}`,
              (err as Error).message
            )
          }
        }
      }
    }
    if (!promptText || promptText.trim().length === 0) {
      throw new Error(
        `节点 "${ctx.node.name}"(${ctx.node.id}) 提示词为空：promptFile 不可读且无内嵌 prompt 回退`
      )
    }

    // 解析 prompt 模板变量
    const resolvedPrompt = ctx.resolveTemplate(promptText)

    // Chatflow 模式：构建包含对话历史的消息列表
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
    if (instance.mode === 'chatflow' && instance.messages && instance.messages.length > 0) {
      for (const msg of instance.messages) {
        messages.push({ role: msg.role, content: msg.content })
      }
    }
    // 当前节点的 prompt 作为新的 user 消息
    messages.push({ role: 'user', content: resolvedPrompt })

    // 默认走 stream
    const useStream = config.stream !== false

    if (!ctx.llm) {
      throw new Error('llm 节点处理器需要 llm.streamWithTools 能力，但未注入')
    }

    let tokenBuf = ''

    // 工具集过滤：按 config.tools 从工具池取出可用工具子集
    // - config.tools 不填或空数组 → 空数组（纯文本生成）
    // - 工具池未注入 → 空数组（兼容旧调用方）
    const tools = ctx.toolPool?.filter(config.tools) ?? []

    // 透传 maxRounds（节点配置优先；未配置则用 LLMClient 默认：2026-10-02 起不限制）
    const streamOptions: { maxRounds?: number; modelOverride?: string; guardrailSessionId?: string } = {}
    if (config.maxRounds !== undefined) {
      streamOptions.maxRounds = config.maxRounds
    }
    // 消息来源护栏：工作流 LLM 节点（记忆/日记调度等无人值守自动化）统一用固定作用域键。
    // 幂等设计：工作流节点不依赖用户会话 id，用 __workflow__ 键即可——哈希进程启动时随机生成，
    // 进程内固定、跨进程变化；hover 到 streamWithTools/chatWithTools 后按同一键派生符号包裹。
    streamOptions.guardrailSessionId = WORKFLOW_GUARDRAIL_KEY

    if (useStream) {
      // 流式调用：token 实时推给前端
      await new Promise<void>((resolve, reject) => {
        ctx
          .llm!.streamWithTools(
            messages,
            tools,
            {
              onToken: (token) => {
                tokenBuf += token
                ctx.emit({ type: 'wf:token', instanceId: instance.id, token, nodeId: ctx.node.id })
              },
              onReasoning: (token) => {
                ctx.emit({
                  type: 'wf:reasoning',
                  instanceId: instance.id,
                  token,
                  nodeId: ctx.node.id
                })
              },
              onToolStart: (toolName, toolCallId, args) => {
                ctx.emit({
                  type: 'wf:tool_start',
                  instanceId: instance.id,
                  toolName,
                  toolCallId,
                  args,
                  nodeId: ctx.node.id
                })
              },
              onToolEnd: (toolName, toolCallId, result) => {
                ctx.emit({
                  type: 'wf:tool_end',
                  instanceId: instance.id,
                  toolName,
                  toolCallId,
                  result,
                  nodeId: ctx.node.id
                })
              },
              onDone: () => resolve(),
              onError: (err) => reject(err)
            },
            streamOptions
          )
          .catch(reject)
      })
    } else {
      if (ctx.llm!.chatWithTools) {
        const result = await ctx.llm!.chatWithTools(messages, tools, streamOptions)
        tokenBuf = result.content ?? ''
      } else {
        await new Promise<void>((resolve, reject) => {
          ctx
            .llm!.streamWithTools(
              messages,
              tools,
              {
                onToken: (token) => {
                  tokenBuf += token
                },
                onDone: () => resolve(),
                onError: (err) => reject(err)
              },
              streamOptions
            )
            .catch(reject)
        })
      }
    }

    // 输出变量提取：从 <json>...</json> 块解析字段写入 context
    // 用于 condition 分支评估（如 DMN-6 质检输出 qa_result/redo_target/redo_count）
    if (config.outputVars && config.outputVars.length > 0) {
      extractOutputVars(tokenBuf, config.outputVars, ctx.instance.context, ctx.node.id)
    }

    // 修复：outputVars 节点（决策节点）空输出 = 失败，不是成功。
    // 前置事实：dispatcher 这类节点必须产出 <json> 决策块；LLM 空输出时 extractOutputVars
    // 静默 return（无 decision/tasks），节点却仍 completed → 调度器判"解析失败"→
    // 失败重跑。但实例 completed 后恢复逻辑再次"推进"→ decision 缺失 → 无限失败循环。
    // 治本：空输出直接抛错 → 节点 failed → 实例 failed → 调度器走"失败重跑本批次"分支。
    if (config.outputVars && config.outputVars.length > 0 && tokenBuf.trim().length === 0) {
      throw new Error(
        `节点 ${ctx.node.id} 配置了 outputVars 但 LLM 输出为空（空输出 = 节点失败，按失败重跑）`
      )
    }

    // output 是 AI 的完整输出（结论），写进 context 给后续节点用
    return { output: tokenBuf }
  }
}

/**
 * 输出变量提取（导出供测试）：从 LLM 输出中提取 JSON 块，
 * 按 outputVars 列表写入 context

 * AI 在输出中嵌入 JSON 块（用 <json> 标签包裹），handler 提取并解析。
 * 写入的 context 字段供后续节点的 {{context.field}} 引用和 condition 出边评估使用。

 * 容错策略（按优先级）：
 * 1. 提取 <json>...</json> 标签块（首选，prompt 约定格式）
 * 2. 提取 ```json 代码围栏块（兼容 LLM 用 markdown 围栏）
 * 3. 整段截取第一个 { 到最后一个 }（兼容前后夹说明文字）
 * - JSON 解析失败 → warn 但不阻断节点（输出仍存为 context[nodeId]）
 * - outputVars 中列出的字段在 JSON 中不存在 → 跳过该字段（不报错）
 */
export function extractOutputVars(
  output: string,
  outputVars: string[],
  context: Record<string, unknown>,
  nodeId: string
): void {
  let jsonStr: string | null = null

  // 1. 首选：<json>...</json> 标签块
  const jsonMatch = output.match(/<json>\s*([\s\S]*?)\s*<\/json>/i)
  if (jsonMatch) {
    jsonStr = jsonMatch[1]
  }

  // 2. 兼容：```json 代码围栏块
  if (!jsonStr) {
    const fenceMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fenceMatch) {
      jsonStr = fenceMatch[1]
    }
  }

  // 3. 兜底：整段截取第一个 { 到最后一个 }（容忍前后说明文字/摘要）
  if (!jsonStr) {
    const firstBrace = output.indexOf('{')
    const lastBrace = output.lastIndexOf('}')
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      jsonStr = output.slice(firstBrace, lastBrace + 1)
    }
  }

  if (!jsonStr) {
    console.warn(`[llm-handler] 节点 ${nodeId} 配置了 outputVars 但输出中未找到 JSON 块`)
    return
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonStr)
  } catch (err) {
    // 容错（实测根因）：LLM 生成 JSON 时字符串值内嵌未转义英文双引号（如 主题:"搜索"不存在的你"gal"），
    // JSON.parse 直接失败 → outputVars 丢失 → 调度器误判"无任务"→ 记忆建了但 NNG 没人建、进度却标记完成。
    // 修复：扫描字符串值，内容引号（后跟非结构字符）自动转义后重试。
    const repaired = repairJsonStringQuotes(jsonStr)
    if (repaired !== jsonStr) {
      try {
        parsed = JSON.parse(repaired)
console.warn(`[llm-handler] 节点 ${nodeId} outputVars JSON 含未转义引号，已自动修复解析`)
      } catch {
        console.warn(
          `[llm-handler] 节点 ${nodeId} outputVars JSON 解析失败:`,
          (err as Error).message
        )
        return
      }
    } else {
      console.warn(`[llm-handler] 节点 ${nodeId} outputVars JSON 解析失败:`, (err as Error).message)
      return
    }
  }

  // 按 outputVars 列表提取字段写入 context
  for (const field of outputVars) {
    if (field in parsed) {
      context[field] = parsed[field]
    }
  }
}

/**
 * 修复 JSON 字符串值内未转义的引号（LLM 输出 JSON 的常见瑕疵）。
 * 原理：逐字符扫描，跟踪字符串状态；字符串内遇到匹配的引号时，向后看（跳过空白）
 * 若下一个非空白字符是 , } ] 或结尾 → 视为闭合引号；否则视为内容引号 → 转义为 \"
 * 同时处理单引号字符串：单引号开头/闭合归一化为双引号，内部的双引号转义为 \"
 */
export function repairJsonStringQuotes(s: string): string {
  let out = ''
  let inStr = false
  let strChar = '"'
  let escaped = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (escaped) {
        out += c
        escaped = false
        continue
      }
      if (c === '\\') {
        out += c
        escaped = true
        continue
      }
      if (c === strChar) {
        let j = i + 1
        while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r'))
          j++
        if (j >= s.length || s[j] === ',' || s[j] === '}' || s[j] === ']' || s[j] === ':') {
          out += '"'
          inStr = false
        } else {
          out += strChar === '"' ? '\\"' : c
        }
        continue
      }
      if (strChar === "'" && c === '"') {
        out += '\\"'
        continue
      }
      out += c
    } else {
      if (c === '"' || c === "'") {
        inStr = true
        strChar = c
        out += '"'
        continue
      }
      out += c
    }
  }
  return out
}
