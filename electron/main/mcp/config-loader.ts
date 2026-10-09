/**
 * MCP 配置加载器：为什么存在——外部 MCP server 需要声明式配置（.mcp.json）才能被启动连接，
 * 用户可随时增删改；本模块统一管理这份配置的读写与热更新。
 * 作用：读写/校验 userData 下的 .mcp.json（loadMcpConfig / writeMcpConfig），
 * 监听文件变化触发热重载，首次使用时创建空配置。
 */
import { readFileSync, writeFileSync, existsSync, watch } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { McpConfig, McpServerConfig } from './types'

/**
 * MCP 配置加载器

 * 配置文件约定参考编辑器工作区配置（.vscode/settings.json）与桌面客户端 MCP 配置的生态惯例。
 * 月蚀用 .mcp.json 存放 MCP server 配置，放在 userData 目录下。

 * 功能：
 * - loadMcpConfig：读取并校验 .mcp.json
 * - writeMcpConfig：写入 .mcp.json（前端 UI 编辑后保存）
 * - watchMcpConfig：监听文件变化，触发热重载
 * - ensureMcpConfigExists：首次使用时创建空配置文件
 */

/** .mcp.json 默认路径：用户数据目录下 */
export function getDefaultMcpConfigPath(): string {
  return join(app.getPath('userData'), '.mcp.json')
}

/** 校验单个 server 配置，返回错误消息或 null（通过） */
function validateServerConfig(key: string, server: Partial<McpServerConfig>): string | null {
  if (!server.transport || !['stdio', 'streamable-http'].includes(server.transport)) {
    return `[MCP] 跳过无效配置 ${key}: transport 缺失或无效`
  }
  if (server.transport === 'stdio' && !server.command) {
    return `[MCP] 跳过无效配置 ${key}: stdio 模式需要 command`
  }
  if (server.transport === 'streamable-http' && !server.url) {
    return `[MCP] 跳过无效配置 ${key}: streamable-http 模式需要 url`
  }
  return null
}

/** 加载 .mcp.json 配置 */
export function loadMcpConfig(): McpConfig {
  const configPath = getDefaultMcpConfigPath()
  if (!existsSync(configPath)) {
    throw new Error('MCP config not found: ' + configPath)
  }
  let parsed: Partial<McpConfig>
  try {
    const content = readFileSync(configPath, 'utf-8')
    parsed = JSON.parse(content) as Partial<McpConfig>
  } catch (err) {
    // 语法错误软失败：记录后按空配置返回，避免单个坏配置击穿热重载监听循环
    console.error(`[MCP] 配置解析失败（按空配置处理）: ${(err as Error).message}`)
    return { mcpServers: {} }
  }
  const validated: Record<string, McpServerConfig> = {}
  for (const [key, server] of Object.entries(parsed.mcpServers ?? {})) {
    const err = validateServerConfig(key, server)
    if (err) {
      // 单 server 无效只跳过该 server，不拖垮整份配置（其余 server 正常生效）
      console.error(err)
      continue
    }
    validated[key] = {
      name: server.name ?? key,
      transport: server.transport!,
      command: server.command,
      args: server.args,
      env: server.env,
      url: server.url,
      enabled: server.enabled ?? true,
      autoRestart: server.autoRestart
    }
  }
  return { mcpServers: validated }
}

/** 写入 .mcp.json 配置 */
export function writeMcpConfig(config: McpConfig): void {
  const configPath = getDefaultMcpConfigPath()
  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  } catch (err) {
    console.error('[MCP] 配置写入失败:', err)
    throw err
  }
}

/** 监听 .mcp.json 变化，触发回调（热重载）。返回取消监听函数 */
export function watchMcpConfig(onChange: (config: McpConfig) => void): () => void {
  const configPath = getDefaultMcpConfigPath()
  if (!existsSync(configPath)) return () => {}
  let debounceTimer: NodeJS.Timeout | null = null
  const watcher = watch(configPath, () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      try {
        const newConfig = loadMcpConfig()
        onChange(newConfig)
      } catch (err) {
        // 读取/解析异常记录后跳过本轮：不让监听回调异常击穿 watch 循环
        console.error(`[MCP] 热重载读取配置失败（保持旧配置）: ${(err as Error).message}`)
      }
    }, 500)
  })
  return () => watcher.close()
}

/** 写入默认 .mcp.json（首次使用时） */
export function ensureMcpConfigExists(): void {
  const configPath = getDefaultMcpConfigPath()
  if (!existsSync(configPath)) {
    const defaultConfig: McpConfig = { mcpServers: {} }
    writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8')
  }
}
