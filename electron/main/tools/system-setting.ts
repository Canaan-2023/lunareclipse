/**
 * 系统设置工具：为什么存在——AI 需要调音量、亮度并管理本机进程，这些系统级操控须按类别
 * 收敛并经过权限检查。
 * 作用：system_setting 支持 volume / brightness / process 三类（get/set/mute/list/kill）。
 */
import { spawn } from 'child_process'
import type { Tool, ToolResult, ToolContext, PermissionResponse } from './base-tool'

export interface SystemSettingToolParams {
  /** 设置类别：volume（音量）/ brightness（亮度）/ process（进程管理） */
  category: 'volume' | 'brightness' | 'process'
  /** 操作：get（查询）/ set（设置）/ mute（静音）/ list（列进程）/ kill（杀进程） */
  action: 'get' | 'set' | 'mute' | 'list' | 'kill'
  /** 设置值（action=set 时用，音量 0-100，亮度 0-100） */
  value?: number
  /** 进程标识（action=kill 时用，PID 或进程名） */
  processId?: string | number
}

export class SystemSettingTool implements Tool<SystemSettingToolParams> {
  name = 'system_setting'
  description =
    'Windows 系统设置。参数：category（volume/brightness/process，必填）/ action（get/set/mute/list/kill，必填）/ value（音量或亮度值 0-100，set 时用）/ processId（PID 或进程名，kill 时用）。所有操作都需要用户确认。音量调节用 nircmd（需用户预装），进程管理用 tasklist/taskkill。'
  parameters = [
    { name: 'category', type: 'string' as const, description: '设置类别：volume（音量）/ brightness（亮度）/ process（进程管理）', required: true },
    { name: 'action', type: 'string' as const, description: '操作：get（查询）/ set（设置）/ mute（静音）/ list（列进程）/ kill（杀进程）', required: true },
    { name: 'value', type: 'number' as const, description: '设置值（音量/亮度 0-100，action=set 时用）', required: false },
    { name: 'processId', type: 'string' as const, description: '进程 PID 或进程名（action=kill 时用）', required: false }
  ]

  async execute(params: SystemSettingToolParams, ctx?: ToolContext): Promise<ToolResult> {
    if (!params.category || !params.action) {
      return { ok: false, error: 'category 和 action 必填' }
    }

    // 所有系统设置操作都需要用户确认
    if (!ctx?.requestPermission) {
      return { ok: false, error: '系统设置需要用户授权，但 requestPermission 未初始化' }
    }

    const desc = this.buildDescription(params)
    const req = {
      type: 'setting' as const,
      description: desc,
      content: JSON.stringify(params),
      risk: this.assessRisk(params),
      timeoutMs: 30000
    }
    const resp: PermissionResponse = await ctx.requestPermission(req)
    if (!resp.allowed) {
      return { ok: false, error: `用户拒绝系统设置操作: ${resp.reason ?? '无原因'}` }
    }

    switch (params.category) {
      case 'volume':
        return this.handleVolume(params)
      case 'brightness':
        return this.handleBrightness(params)
      case 'process':
        return this.handleProcess(params)
      default:
        return { ok: false, error: `未知 category: ${params.category}` }
    }
  }

  private buildDescription(params: SystemSettingToolParams): string {
    switch (params.category) {
      case 'volume':
        if (params.action === 'get') return '查询系统音量'
        if (params.action === 'mute') return '静音/取消静音'
        return `设置系统音量为 ${params.value}%`
      case 'brightness':
        if (params.action === 'get') return '查询屏幕亮度'
        return `设置屏幕亮度为 ${params.value}%`
      case 'process':
        if (params.action === 'list') return '列出运行中的进程'
        if (params.action === 'kill') return `终止进程: ${params.processId}`
        return '进程操作'
      default:
        return '系统设置'
    }
  }

  private assessRisk(params: SystemSettingToolParams): 'low' | 'medium' | 'high' {
    if (params.category === 'process' && params.action === 'kill') return 'high'
    if (params.category === 'volume' && params.action === 'get') return 'low'
    if (params.category === 'process' && params.action === 'list') return 'low'
    return 'medium'
  }

  /** 音量控制：依赖 nircmd（用户需预装，放入 PATH） */
  private handleVolume(params: SystemSettingToolParams): Promise<ToolResult> {
    switch (params.action) {
      case 'get':
        // 音量查询需要 CoreAudio COM API（PowerShell 原生不支持简单查询）
        // 不用 SendKeys(173) —— 那会切换静音状态，是有副作用的操作
        return Promise.resolve({
          ok: true,
          data: { action: 'get', message: '音量查询暂不支持，仅支持 set/mute（需 nircmd）' }
        })
      case 'set': {
        const v = Math.max(0, Math.min(100, params.value ?? 50))
        // nircmd setsysvolume 接受 0-65535
        const scaled = Math.round((v / 100) * 65535)
        return this.execPowerShell(`nircmd setsysvolume ${scaled}`)
          .then(() => ({ ok: true, data: { action: 'set', value: v, message: `音量已设置为 ${v}%` } }))
          .catch((err) => ({ ok: false, error: `设置音量失败（需安装 nircmd 并加入 PATH）: ${err.message}` }))
      }
      case 'mute':
        return this.execPowerShell('nircmd mutesysvolume 2')
          .then(() => ({ ok: true, data: { action: 'mute', message: '静音状态已切换' } }))
          .catch((err) => ({ ok: false, error: `静音切换失败（需安装 nircmd）: ${err.message}` }))
      default:
        return Promise.resolve({ ok: false, error: `音量不支持的操作: ${params.action}` })
    }
  }

  /** 亮度控制：用 WMI 调 WmiSetBrightness（仅笔记本有效） */
  private handleBrightness(params: SystemSettingToolParams): Promise<ToolResult> {
    switch (params.action) {
      case 'get':
        return this.execPowerShell(
          `(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightness).CurrentBrightness`
        ).then((out) => ({ ok: true, data: { action: 'get', value: parseInt(out.stdout.trim(), 10) || 0 } }))
          .catch((err) => ({ ok: false, error: `查询亮度失败（仅笔记本支持）: ${err.message}` }))
      case 'set': {
        const v = Math.max(0, Math.min(100, params.value ?? 50))
        return this.execPowerShell(
          `(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1,${v})`
        ).then(() => ({ ok: true, data: { action: 'set', value: v, message: `亮度已设置为 ${v}%` } }))
          .catch((err) => ({ ok: false, error: `设置亮度失败（仅笔记本支持）: ${err.message}` }))
      }
      default:
        return Promise.resolve({ ok: false, error: `亮度不支持的操作: ${params.action}` })
    }
  }

  /** 进程管理：tasklist 列出，taskkill 终止 */
  private handleProcess(params: SystemSettingToolParams): Promise<ToolResult> {
    switch (params.action) {
      case 'list':
        return this.execPowerShell('tasklist /FO CSV /NH')
          .then((out) => {
            const lines = out.stdout.split('\n').filter((l) => l.trim())
            const processes = lines.slice(0, 100).map((line) => {
              const parts = line.replace(/"/g, '').split(',')
              return { name: parts[0], pid: parseInt(parts[1], 10) || 0, session: parts[2], mem: parts[4] }
            })
            return { ok: true, data: { action: 'list', count: processes.length, processes } }
          })
          .catch((err) => ({ ok: false, error: `列出进程失败: ${err.message}` }))
      case 'kill': {
        const target = params.processId
        if (!target) {
          return Promise.resolve({ ok: false, error: 'action=kill 时 processId 必填（PID 或进程名）' })
        }
        const targetStr = String(target)
        // 数字 → 按 PID 杀，字符串 → 按进程名杀
        const isPid = /^\d+$/.test(targetStr)
        if (isPid) {
          // PID 纯数字，无注入风险
          const cmd = `taskkill /F /PID ${targetStr}`
          return this.execPowerShell(cmd)
            .then((out) => ({ ok: true, data: { action: 'kill', target, stdout: out.stdout, stderr: out.stderr } }))
            .catch((err) => ({ ok: false, error: `终止进程失败: ${err.message}` }))
        }
        // 进程名：校验只允许字母/数字/点/下划线/连字符，防止命令注入
        if (!/^[A-Za-z0-9._-]+$/.test(targetStr)) {
          return Promise.resolve({
            ok: false,
            error: `进程名含非法字符（仅允许字母/数字/./_/-）: ${targetStr}`
          })
        }
        const cmd = `taskkill /F /IM ${targetStr}`
        return this.execPowerShell(cmd)
          .then((out) => ({ ok: true, data: { action: 'kill', target, stdout: out.stdout, stderr: out.stderr } }))
          .catch((err) => ({ ok: false, error: `终止进程失败: ${err.message}` }))
      }
      default:
        return Promise.resolve({ ok: false, error: `进程管理不支持的操作: ${params.action}` })
    }
  }

  private execPowerShell(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', command], {
        windowsHide: true
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => { stdout += d.toString('utf-8') })
      child.stderr.on('data', (d) => { stderr += d.toString('utf-8') })
      child.on('close', (code) => {
        // 非零退出码即视为失败（原逻辑 `code !== 0 && stderr` 会在无 stderr 时误判为成功）
        if (code !== 0) {
          reject(new Error(stderr || `命令失败，退出码 ${code}`))
          return
        }
        resolve({ stdout, stderr, exitCode: code ?? 0 })
      })
      child.on('error', (err) => reject(err))
    })
  }
}
