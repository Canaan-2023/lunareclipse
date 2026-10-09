/**
 * 剪贴板工具：为什么存在——AI 需要读写系统剪贴板作为复制粘贴类交互的桥梁，
 * 属于系统级能力；读操作可能暴露敏感信息，须经用户确认。
 * 作用：clipboard 支持 read / write 两种动作，Windows 下经 PowerShell 读写剪贴板文本。
 */
import { spawn } from 'child_process'
import type { Tool, ToolResult, ToolContext, PermissionResponse } from './base-tool'

export interface ClipboardToolParams {
  /** 操作：read（读剪贴板）/ write（写剪贴板） */
  action: 'read' | 'write'
  /** 写入内容（action=write 必填） */
  text?: string
}

export class ClipboardTool implements Tool<ClipboardToolParams> {
  name = 'clipboard'
  description =
    '读写系统剪贴板（Windows）。参数：action（read/write，必填）/ text（写入的文本，action=write 时必填）。读剪贴板需要用户确认（可能含密码等敏感信息），写剪贴板直接执行。'
  parameters = [
    { name: 'action', type: 'string' as const, description: '操作：read（读剪贴板）/ write（写剪贴板）', required: true },
    { name: 'text', type: 'string' as const, description: '写入的文本内容（action=write 时必填）', required: false }
  ]

  async execute(params: ClipboardToolParams, ctx?: ToolContext): Promise<ToolResult> {
    if (!params.action) {
      return { ok: false, error: 'action 必填（read 或 write）' }
    }

    if (params.action === 'read') {
      // 读剪贴板需要用户确认
      if (!ctx?.requestPermission) {
        return { ok: false, error: '读剪贴板需要用户授权，但 requestPermission 未初始化' }
      }
      const req = {
        type: 'clipboard_read' as const,
        description: '读取系统剪贴板内容',
        content: '',
        risk: 'medium' as const,
        timeoutMs: 30000
      }
      const resp: PermissionResponse = await ctx.requestPermission(req)
      if (!resp.allowed) {
        return { ok: false, error: `用户拒绝读取剪贴板: ${resp.reason ?? '无原因'}` }
      }
      return this.readClipboard()
    }

    if (params.action === 'write') {
      if (!params.text) {
        return { ok: false, error: 'action=write 时 text 必填' }
      }
      return this.writeClipboard(params.text)
    }

    return { ok: false, error: `未知 action: ${params.action}（应为 read 或 write）` }
  }

  private readClipboard(): Promise<ToolResult> {
    return new Promise((resolve) => {
      // 用 PowerShell 读剪贴板
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard'], {
        windowsHide: true
      })
      let stdout = ''
      let settled = false
      child.stdout.on('data', (d) => { stdout += d.toString('utf-8') })
      // 10 秒超时，防止 PowerShell 挂起导致工具永久阻塞
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { child.kill() } catch { /* 忽略 */ }
        resolve({ ok: false, error: '读取剪贴板超时（PowerShell 未响应）' })
      }, 10000)
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code !== 0) {
          resolve({ ok: false, error: `读取剪贴板失败（退出码 ${code}）` })
          return
        }
        resolve({
          ok: true,
          data: {
            text: stdout,
            length: stdout.length,
            message: '剪贴板内容已读取'
          }
        })
      })
      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ ok: false, error: `读取剪贴板失败: ${err.message}` })
      })
    })
  }

  private writeClipboard(text: string): Promise<ToolResult> {
    return new Promise((resolve) => {
      // 用 PowerShell 写剪贴板（转义单引号）
      const escaped = text.replace(/'/g, "''")
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', `Set-Clipboard -Value '${escaped}'`], {
        windowsHide: true
      })
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { child.kill() } catch { /* 忽略 */ }
        resolve({ ok: false, error: '写入剪贴板超时（PowerShell 未响应）' })
      }, 10000)
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code !== 0) {
          resolve({ ok: false, error: `写入剪贴板失败（退出码 ${code}）` })
          return
        }
        resolve({
          ok: true,
          data: {
            length: text.length,
            message: '内容已写入剪贴板'
          }
        })
      })
      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ ok: false, error: `写入剪贴板失败: ${err.message}` })
      })
    })
  }
}
