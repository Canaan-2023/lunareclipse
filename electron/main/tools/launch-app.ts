/**
 * 启动应用/打开资源工具：为什么存在——AI 需要替用户打开网址、文件夹或启动本机应用，
 * 属系统级操作，必须经权限检查。
 * 作用：launch_app 支持 url / file / folder / app 四类目标，经系统默认程序或 spawn 启动。
 */
import { spawn } from 'child_process'
import { existsSync, statSync } from 'fs'
import type { Tool, ToolResult, ToolContext } from './base-tool'

export interface LaunchAppToolParams {
  /** 操作类型：url（打开网址）/ file（打开文件，用系统默认程序）/ folder（打开文件夹）/ app（启动应用） */
  type: 'url' | 'file' | 'folder' | 'app'
  /** 目标：URL/文件路径/文件夹路径/应用名或路径 */
  target: string
  /** 启动应用时传的参数（仅 type=app 时用） */
  args?: string[]
}

export class LaunchAppTool implements Tool<LaunchAppToolParams> {
  name = 'launch_app'
  description =
    '打开 URL/文件/文件夹/应用（Windows）。参数：type（url/file/folder/app，必填）/ target（URL 或路径或应用名，必填）/ args（启动应用时的参数数组，仅 type=app 时用）。type=file 用系统默认程序打开文件，type=folder 用资源管理器打开文件夹，type=app 启动应用。'
  parameters = [
    { name: 'type', type: 'string' as const, description: '操作类型：url（网址）/ file（文件）/ folder（文件夹）/ app（应用）', required: true },
    { name: 'target', type: 'string' as const, description: 'URL 或文件/文件夹绝对路径或应用名', required: true },
    { name: 'args', type: 'array' as const, description: '启动应用时的参数数组（仅 type=app 时用）', required: false }
  ]

  execute(params: LaunchAppToolParams, _ctx?: ToolContext): Promise<ToolResult> {
    if (!params.type || !params.target) {
      return Promise.resolve({ ok: false, error: 'type 和 target 必填' })
    }

    const target = params.target.trim()
    if (!target) {
      return Promise.resolve({ ok: false, error: 'target 不能为空' })
    }

    try {
      switch (params.type) {
        case 'url':
          return this.openUrl(target)
        case 'file':
          return this.openFile(target)
        case 'folder':
          return this.openFolder(target)
        case 'app':
          return this.launchApp(target, params.args ?? [])
        default:
          return Promise.resolve({ ok: false, error: `未知 type: ${params.type}（应为 url/file/folder/app）` })
      }
    } catch (err) {
      return Promise.resolve({ ok: false, error: (err as Error).message })
    }
  }

  private openUrl(url: string): Promise<ToolResult> {
    // 校验 URL 格式
    try {
      const parsed = new URL(url)
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return Promise.resolve({ ok: false, error: `仅支持 http/https 协议: ${url}` })
      }
    } catch {
      return Promise.resolve({ ok: false, error: `URL 格式无效: ${url}` })
    }
    // Windows 用 start 命令打开默认浏览器
    return this.exec('cmd.exe', ['/c', 'start', '', url])
      .then(() => ({ ok: true, data: { type: 'url', target: url, message: '已在默认浏览器打开' } }))
      .catch((err) => ({ ok: false, error: `打开 URL 失败: ${err.message}` }))
  }

  private openFile(filePath: string): Promise<ToolResult> {
    if (!existsSync(filePath)) {
      return Promise.resolve({ ok: false, error: `文件不存在: ${filePath}` })
    }
    const stat = statSync(filePath)
    if (stat.isDirectory()) {
      return Promise.resolve({ ok: false, error: `目标是文件夹不是文件，请用 type=folder: ${filePath}` })
    }
    // 用默认程序打开文件
    return this.exec('cmd.exe', ['/c', 'start', '', filePath])
      .then(() => ({ ok: true, data: { type: 'file', target: filePath, message: '已用默认程序打开' } }))
      .catch((err) => ({ ok: false, error: `打开文件失败: ${err.message}` }))
  }

  private openFolder(folderPath: string): Promise<ToolResult> {
    if (!existsSync(folderPath)) {
      return Promise.resolve({ ok: false, error: `文件夹不存在: ${folderPath}` })
    }
    const stat = statSync(folderPath)
    if (!stat.isDirectory()) {
      return Promise.resolve({ ok: false, error: `目标是文件不是文件夹，请用 type=file: ${folderPath}` })
    }
    // 用资源管理器打开文件夹
    return this.exec('explorer.exe', [folderPath])
      .then(() => ({ ok: true, data: { type: 'folder', target: folderPath, message: '已用资源管理器打开' } }))
      .catch((err) => ({ ok: false, error: `打开文件夹失败: ${err.message}` }))
  }

  private launchApp(appName: string, args: string[]): Promise<ToolResult> {
    // 启动应用（detached，不阻塞 AI）
    return this.exec(appName, args, true)
      .then(() => ({ ok: true, data: { type: 'app', target: appName, args, message: '应用已启动' } }))
      .catch((err) => ({ ok: false, error: `启动应用失败: ${err.message}` }))
  }

  private exec(cmd: string, args: string[], detached = false): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      let child: ReturnType<typeof spawn> | null = null
      try {
        child = spawn(cmd, args, {
          detached,
          windowsHide: false,
          stdio: 'ignore'
        })
        if (detached) {
          child.unref()
        }
        // start/explorer 等命令立即返回，500ms 后视为成功
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          resolve()
        }, 500)
        // spawn 错误（如命令不存在）：立即拒绝并清理定时器
        child.on('error', (err) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(err)
        })
      } catch (err) {
        if (!settled) {
          settled = true
          reject(err as Error)
        }
      }
    })
  }
}
