/**
 * 内置工具 MCP 化：为什么存在——让月蚀内置工具池能通过 MCP 协议被外部客户端调用，
 * 与外向接入（client-manager）形成"工具进出双向打通"。
 * 作用：把内置工具的参数/结果翻译为 MCP schema 注册到 McpServer，
 * 并提供 startBuiltinMcpServer 启动独立 MCP server 的入口。
 * 不删理由：此模块是「内置工具外向暴露」的唯一对外契约，index.ts 依赖其导出
 * （startBuiltinMcpServer / registerBuiltinToolsToMcp 供未来外部客户端调用）。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createAllTools } from '../tools'
import type { AnyTool, ToolContext, ToolResult } from '../tools/base-tool'

/**
 * 内置工具 MCP 化（expose-builtin）

 * 自暴露 MCP server：自身既是 MCP client（连接外部 server），
 * 也作为 MCP server 暴露能力给外部客户端。月蚀采用同样的双向 MCP 设计——
 * 此模块把月蚀的内置工具（基础文件操作 + 图工具 + DMN 专属工具）暴露为
 * 标准 MCP server，让外部 MCP 客户端可连接月蚀复用其工具集。

 * 设计要点：
 * - 用 SDK 高级 McpServer + zod raw shape（SDK 推荐 peerDep）
 * - 工具参数 ToolParameter[] → zod raw shape 自动转换
 * - 默认不启动（无实际外部客户端场景时避免占用 stdio）
 * - 暴露 startBuiltinMcpServer 入口供未来按需启动
 */

/** 月蚀 ToolParameter 的 type 联合 */
type ParamType = 'string' | 'number' | 'boolean' | 'array' | 'object'

/** 单个 ToolParameter → zod schema */
function paramToZod(param: AnyTool['parameters'][number]): z.ZodType {
  let zodType: z.ZodType
  switch (param.type as ParamType) {
    case 'number':
      zodType = z.number()
      break
    case 'boolean':
      zodType = z.boolean()
      break
    case 'array':
      zodType = z.array(z.unknown())
      break
    case 'object':
      // zod v4 的 z.record 需显式 key 类型
      zodType = z.record(z.string(), z.unknown())
      break
    default:
      zodType = z.string()
  }
  if (!param.required) {
    zodType = zodType.optional()
  }
  if (param.description) {
    zodType = zodType.describe(param.description)
  }
  return zodType
}

/** ToolParameter[] → zod raw shape（SDK 的 tool() 期望 raw shape 而非 z.object()） */
function paramsToZodShape(params: AnyTool['parameters']): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {}
  for (const p of params) {
    shape[p.name] = paramToZod(p)
  }
  return shape
}

/** ToolResult → MCP tool 响应内容 */
function resultToMcpContent(result: ToolResult): { content: Array<{ type: 'text'; text: string }>; isError: boolean } {
  const isError = !result.ok
  let text: string
  if (result.ok) {
    text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)
  } else {
    text = `错误: ${result.error ?? '未知错误'}`
  }
  return { content: [{ type: 'text', text }], isError }
}

/** 将月蚀内置工具注册到 MCP server */
export function registerBuiltinToolsToMcp(server: McpServer, ctx: ToolContext): void {
  const tools = createAllTools()
  for (const tool of tools) {
    const shape = paramsToZodShape(tool.parameters)
    server.tool(
      tool.name,
      tool.description,
      shape,
      async (args) => {
        const result = await tool.execute(args as Record<string, unknown>, ctx)
        return resultToMcpContent(result)
      }
    )
  }
}

/**
 * 启动内置工具 MCP server（stdio 传输）
 *
 * 用途：被外部 MCP 客户端连接，复用月蚀内置工具。
 * 默认不启动——仅在需要时（如未来模块化场景）显式调用。
 */
export async function startBuiltinMcpServer(ctx: ToolContext): Promise<McpServer> {
  const server = new McpServer({ name: 'yue-shi-builtin', version: '1.0.0' })
  registerBuiltinToolsToMcp(server, ctx)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  return server
}
