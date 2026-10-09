/**
 * 插件管理工具：为什么存在——AI 需要自主安装/卸载/查看插件来扩展能力，但插件执行外部代码
 * 属高风险动作，必须先经用户确认。
 * 作用：plugin_manage 提供 list / install（建骨架）/ uninstall 等动作，含 30 秒权限确认。
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import type { AnyTool, ToolContext, ToolResult } from './base-tool'
import type { PluginLoader } from '../plugins/loader'

const PERMISSION_TIMEOUT_MS = 30000

function getLoader(ctx?: ToolContext): { loader: PluginLoader; root: string } | { error: string } {
  const loader = ctx?.getPluginLoader?.()
  if (!loader) return { error: '插件加载器不可用（未初始化或无权限）' }
  return { loader, root: loader.getRootDir() }
}

export class PluginManageTool {
  name = 'plugin_manage'
  description = `管理插件（AI 扩展自己的正规入口）。动作：list=列出全部插件；install=创建插件骨架；uninstall=卸载插件。

- list：返回插件目录名/名称/启用状态/工具数/模块/错误
- install：在插件目录建 {name}/plugin.json + tools.js 模板，创建后立即生效。创建后用 Write/Edit 填实现
- uninstall：先停用再从系统移除，然后删除目录，不可恢复

参数：
- action（必填）：list / install / uninstall
- name（install/uninstall 必填）：插件名（kebab-case）
- description（install 可选）：插件描述`
  parameters = [
    { name: 'action', type: 'string' as const, description: 'list / install / uninstall', required: true },
    { name: 'name', type: 'string' as const, description: '插件名（kebab-case，install/uninstall 必填）', required: false },
    { name: 'description', type: 'string' as const, description: '插件描述（install 可选）', required: false }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const action = String(params.action ?? '').trim()
    if (!['list', 'install', 'uninstall'].includes(action)) {
      return { ok: false, error: 'action 必填（list / install / uninstall）' }
    }
    if (action === 'list') return this.list(ctx)
    if (action === 'install') return this.install(params, ctx)
    return this.uninstall(params, ctx)
  }

  private async list(ctx?: ToolContext): Promise<ToolResult> {
    const r = getLoader(ctx)
    if ('error' in r) return { ok: false, error: r.error }
    const plugins = r.loader.list().map((p) => ({
      dirName: p.dirName,
      name: p.manifest.name,
      version: p.manifest.version,
      enabled: p.enabled,
      toolCount: p.tools.length,
      tools: p.tools.map((t) => t.name),
      loadedModules: p.loadedModules,
      errors: p.errors
    }))
    return { ok: true, data: { rootDir: r.root, plugins } }
  }

  private async install(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const r = getLoader(ctx)
    if ('error' in r) return { ok: false, error: r.error }
    const name = String(params.name ?? '').trim().replace(/[^a-z0-9-]/g, '-').toLowerCase()
    if (!name) return { ok: false, error: 'name 必填（kebab-case）' }
    const dirPath = join(r.root, name)
    if (existsSync(dirPath)) return { ok: false, error: `插件 ${name} 已存在` }
    if (!ctx?.requestPermission) return { ok: false, error: '安装操作需要用户授权' }
    const resp = await ctx.requestPermission({
      type: 'command',
      description: `创建插件 ${name}`,
      content: `将在插件目录创建 ${name}/plugin.json + tools.js 骨架`,
      risk: 'high',
      timeoutMs: PERMISSION_TIMEOUT_MS
    })
    if (!resp.allowed) return { ok: false, error: `用户拒绝创建插件 ${name}` }
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(join(dirPath, 'plugin.json'),
      JSON.stringify({ name, description: String(params.description ?? ''), version: '0.1.0', tools: [] }, null, 2), 'utf-8')
    writeFileSync(join(dirPath, 'tools.js'),
      `// 工具数组：{ name, description, parameters, execute }\nmodule.exports = []\n`, 'utf-8')
    await r.loader.reload()
    return { ok: true, data: { dirPath, note: `插件 ${name} 已创建并立即生效。用 Write/Edit 往 tools.js 加工具。` } }
  }

  private async uninstall(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const r = getLoader(ctx)
    if ('error' in r) return { ok: false, error: r.error }
    const name = String(params.name ?? '').trim()
    if (!name) return { ok: false, error: 'name 必填（插件目录名）' }
    const dirPath = join(r.root, name)
    if (!existsSync(dirPath)) return { ok: false, error: `未找到插件 ${name}` }
    if (!ctx?.requestPermission) return { ok: false, error: '卸载操作需要用户授权' }
    const resp = await ctx.requestPermission({
      type: 'command',
      description: `卸载插件 ${name}`,
      content: `将停用并删除插件目录 ${name}（不可恢复）`,
      risk: 'high',
      timeoutMs: PERMISSION_TIMEOUT_MS
    })
    if (!resp.allowed) return { ok: false, error: `用户拒绝卸载插件 ${name}` }
    const target = r.loader.list().find((p) => p.dirName === name)
    if (target?.enabled) await r.loader.setEnabled(name, false)
    rmSync(dirPath, { recursive: true, force: true })
    return { ok: true, data: { note: `插件 ${name} 已卸载` } }
  }
}

export type { AnyTool, ToolResult, ToolContext }
