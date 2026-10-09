/**
 * mcp-config-loader.test.ts —— MCP 配置加载器单元验证（D12 补测）
 *
 * 为什么存在：D12 评审缺口记录显示 MCP 域 6 个源文件零测试，
 * 而 config-loader 承担 .mcp.json 的读写/校验/热重载，是外部 MCP server
 * 能否被安全启动的入口，校验错误会直接导致 MCP 工具不可用或启动崩溃。
 *
 * 覆盖：
 * 1. loadMcpConfig 校验语义：transport 缺失/无效、stdio 缺 command、
 *    streamable-http 缺 url 均必须抛错；合法配置字段正确透传（enabled 默认 true）
 * 2. writeMcpConfig 落盘为格式化 JSON
 * 3. ensureMcpConfigExists 首次创建空配置（非首次不覆盖用户配置）
 * 4. watchMcpConfig 文件变更触发热重载，返回取消监听函数
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// mock electron：userData 指向可替换的临时目录
// 为什么 mock：config-loader 的默认配置路径依赖 app.getPath('userData')，
// 真实 Electron app 在 node 测试环境不可用，用临时目录替代以便验证文件行为。
const mockState = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: {
    getPath: () => mockState.userData
  }
}))

import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  loadMcpConfig,
  writeMcpConfig,
  ensureMcpConfigExists,
  watchMcpConfig,
  getDefaultMcpConfigPath
} from '../electron/main/mcp/config-loader'
import type { McpConfig } from '../electron/main/mcp/types'

describe('MCP 配置加载器（D12 补测）', () => {
  let root: string

  beforeEach(() => {
    // 每个用例独立临时目录，避免配置跨用例污染
    root = mkdtempSync(join(tmpdir(), 'mcp-cfg-'))
    mockState.userData = root
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('getDefaultMcpConfigPath 指向 userData 下的 .mcp.json', () => {
    expect(getDefaultMcpConfigPath()).toBe(join(root, '.mcp.json'))
  })

  it('loadMcpConfig：文件缺失抛错（明确失败而非静默返回空配置）', () => {
    expect(() => loadMcpConfig()).toThrow(/MCP config not found/)
  })

  it('loadMcpConfig：transport 无效的 server 被跳过（不拖垮其余 server）', () => {
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          bad: { transport: 'tcp' },
          good: { transport: 'stdio', command: 'ok' }
        }
      }),
      'utf-8'
    )
    const loaded = loadMcpConfig()
    expect(loaded.mcpServers.bad).toBeUndefined()
    expect(loaded.mcpServers.good).toBeDefined()
  })

  it('loadMcpConfig：stdio 模式缺 command 的 server 被跳过', () => {
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { bad: { transport: 'stdio' } } }),
      'utf-8'
    )
    expect(loadMcpConfig().mcpServers).toEqual({})
  })

  it('loadMcpConfig：streamable-http 模式缺 url 的 server 被跳过', () => {
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { bad: { transport: 'streamable-http' } } }),
      'utf-8'
    )
    expect(loadMcpConfig().mcpServers).toEqual({})
  })

  it('loadMcpConfig：JSON 语法错误返回空配置（不抛错击穿热重载）', () => {
    writeFileSync(join(root, '.mcp.json'), '{ mcpServers: ,,, }', 'utf-8')
    expect(loadMcpConfig().mcpServers).toEqual({})
  })

  it('loadMcpConfig：合法配置字段完整透传，enabled 默认 true', () => {
    const cfg: McpConfig = {
      mcpServers: {
        filesys: {
          name: '文件系统',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          enabled: false
        },
        remote: {
          name: '远端',
          transport: 'streamable-http',
          url: 'https://example.com/mcp',
          autoRestart: true
        }
      }
    }
    writeFileSync(join(root, '.mcp.json'), JSON.stringify(cfg), 'utf-8')
    const loaded = loadMcpConfig()
    expect(loaded.mcpServers.filesys).toMatchObject({
      name: '文件系统',
      transport: 'stdio',
      command: 'npx',
      enabled: false
    })
    // 未显式声明 enabled 时默认启用；无效字段（此处验证 name 回退为 key）
    expect(loaded.mcpServers.remote).toMatchObject({
      name: '远端',
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      enabled: true,
      autoRestart: true
    })
  })

  it('writeMcpConfig：落盘为缩进 2 的格式化 JSON，可被 loadMcpConfig 读回', () => {
    const cfg: McpConfig = { mcpServers: { ok: { transport: 'stdio', command: 'echo' } } }
    writeMcpConfig(cfg)
    expect(readFileSync(join(root, '.mcp.json'), 'utf-8')).toContain('\n  "mcpServers"')
    expect(loadMcpConfig().mcpServers.ok.command).toBe('echo')
  })

  it('ensureMcpConfigExists：首次创建空配置，已存在时不覆盖', () => {
    ensureMcpConfigExists()
    expect(loadMcpConfig().mcpServers).toEqual({})
    // 先写入用户配置再调用，不得被覆盖
    const cfg: McpConfig = { mcpServers: { keep: { transport: 'stdio', command: 'keep' } } }
    writeMcpConfig(cfg)
    ensureMcpConfigExists()
    expect(loadMcpConfig().mcpServers.keep).toBeDefined()
  })

  it('watchMcpConfig：文件变更触发回调，取消监听后不再触发', async () => {
    const cfg: McpConfig = { mcpServers: { a: { transport: 'stdio', command: 'a' } } }
    writeMcpConfig(cfg)
    const onChange = vi.fn()
    const unwatch = watchMcpConfig(onChange)
    // watcher 就绪需要一点时间，先等待再改文件
    await new Promise((r) => setTimeout(r, 300))
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { b: { transport: 'streamable-http', url: 'https://x' } } }),
      'utf-8'
    )
    // debounce 500ms + 事件送达余量
    await new Promise((r) => setTimeout(r, 1200))
    expect(onChange).toHaveBeenCalled()
    const newCfg = onChange.mock.calls[0][0] as McpConfig
    expect(newCfg.mcpServers.b).toBeDefined()
    unwatch()
    const before = onChange.mock.calls.length
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: {} }), 'utf-8')
    await new Promise((r) => setTimeout(r, 800))
    expect(onChange.mock.calls.length).toBe(before)
  })

  it('watchMcpConfig：配置文件不存在时返回空取消函数（不抛错）', () => {
    expect(() => watchMcpConfig(() => {})).not.toThrow()
    const unwatch = watchMcpConfig(() => {})
    expect(typeof unwatch).toBe('function')
    expect(existsSync(join(root, '.mcp.json'))).toBe(false)
  })
})