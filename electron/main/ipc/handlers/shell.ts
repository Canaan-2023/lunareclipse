/**
 * 系统 shell IPC：打开外部链接/打开文件/在资源管理器中显示等系统操作通道；
 * 读取侧按白名单根目录（userData + appPath + 工作区）与敏感路径阻断
 * 双重校验，防止渲染进程越权访问本地文件。
 */
import { ipcMain, shell, app, clipboard } from 'electron'
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { validateWithinDir } from '../../tools/security-engine/path-security'
import { loadWorkspaceConfig, getDefaultWorkspaceConfigPath } from '../../services/workspace-config'

/** 获取允许的文件读取根目录列表（userData + appPath + 所有工作区路径） */
function getAllowedRoots(): string[] {
  const roots: string[] = [
    app.getPath('userData'),
    app.getAppPath()
  ]
  // 工作区清单路径与 workspace-config 的 getDefaultWorkspaceConfigPath() 保持同源，
  // 不直接用 userData 拼接，避免与 IPC 侧（workspace:list 等）读到两份不同配置。
  const configPath = getDefaultWorkspaceConfigPath()
  const config = loadWorkspaceConfig(configPath)
  for (const ws of config.workspaces) {
    if (ws.path) roots.push(ws.path)
  }
  return roots
}

/** 敏感路径阻断：SSH 密钥、环境变量凭证、Windows 凭证库、证书密钥等 */
function isSensitivePath(pathStr: string): boolean {
  const lower = pathStr.toLowerCase().replace(/\\/g, '/')
  const sensitivePatterns = [
    '/.ssh/',
    '/.env',
    '/.aws/credentials',
    '/.gnupg/',
    '/config/sam',
    '/config/systemprofile',
    '/.npmrc',
    '/.pypirc',
    '/.docker/config.json',
    // 证书/密钥文件
    '.pem',
    '.pfx',
    '.p12',
    '.key',
    // Windows 凭证
    'microsoft/credentials/',
    'microsoft/protect/',
    'ntuser.dat',
    // 浏览器敏感数据
    'login data',
    'logins.json',
    'cookies',
  ]
  return sensitivePatterns.some((p) => lower.includes(p))
}

/** 可执行文件扩展名阻断：防止 shell:openFile 被用于启动任意程序 */
const EXECUTABLE_EXTS = ['exe', 'bat', 'cmd', 'ps1', 'vbs', 'scr', 'msi', 'com', 'sh', 'jar']
function isExecutable(pathStr: string): boolean {
  const ext = pathStr.toLowerCase().match(/\.([^.]+)$/)?.[1]
  return ext ? EXECUTABLE_EXTS.includes(ext) : false
}

/** 校验路径是否在允许的根目录内且非敏感路径 */
function validateReadPath(pathStr: string): string | null {
  if (isSensitivePath(pathStr)) {
    return '路径包含敏感文件，禁止读取'
  }
  const roots = getAllowedRoots()
  for (const root of roots) {
    const err = validateWithinDir(pathStr, root)
    if (!err) return null
  }
  return `路径不在允许的目录内: ${pathStr}`
}

export function registerShellHandlers(ipc: typeof ipcMain): void {
  // 外部链接：仅放行 http/https 协议，统一交给系统默认浏览器打开。
  // 安全：新闻正文/评论内容来自局域网其他节点，属不可信输入，链接不能直接在应用内导航。
  ipc.handle('shell:openExternal', async (_event, input: string) => {
    let url: URL
    try {
      url = new URL(input)
    } catch {
      return false
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      console.warn('[shell:openExternal] blocked protocol:', url.protocol)
      return false
    }
    await shell.openExternal(url.toString()).catch(() => { /* 打开失败忽略 */ })
    return true
  })

  // 文档 15.6：打开 file:/// 链接指向的文件，用系统默认程序
  // 安全限制：阻断敏感路径 + 阻止可执行文件 + 路径在允许根目录内
  ipc.handle('shell:openFile', async (_event, input: string) => {
    const path = input.startsWith('file:///') ? input.slice('file:///'.length) : input
    if (isSensitivePath(path)) {
      console.warn('[shell:openFile] blocked sensitive path:', path)
      return false
    }
    if (isExecutable(path)) {
      console.warn('[shell:openFile] blocked executable:', path)
      return false
    }
    const pathErr = validateReadPath(path)
    if (pathErr) {
      console.warn('[shell:openFile] blocked:', pathErr)
      return false
    }
    const err = await shell.openPath(path)
    return !err
  })

  // 在系统文件管理器中显示文件（跳转实际路径，记忆/文件浏览用）
  ipc.handle('shell:showItemInFolder', async (_event, input: string) => {
    const path = input.startsWith('file:///') ? input.slice('file:///'.length) : input
    if (isSensitivePath(path)) {
      console.warn('[shell:showItemInFolder] blocked sensitive path:', path)
      return false
    }
    const pathErr = validateReadPath(path)
    if (pathErr) {
      console.warn('[shell:showItemInFolder] blocked:', pathErr)
      return false
    }
    shell.showItemInFolder(path)
    return true
  })

  // 读取文件内容（应用内预览用，只读）
  // 限制：路径必须在允许根目录内 + 非敏感路径 + 只读文本文件 + 最大 2MB
  ipc.handle('file:read', async (_event, input: string) => {
    try {
      const path = input.startsWith('file:///') ? input.slice('file:///'.length) : input
      const pathErr = validateReadPath(path)
      if (pathErr) {
        return { ok: false, error: pathErr }
      }
      const stat = statSync(path)
      if (stat.size > 2 * 1024 * 1024) {
        return { ok: false, error: '文件超过 2MB，请用外部编辑器打开' }
      }
      const content = readFileSync(path, 'utf-8')
      const totalLines = content.split('\n').length
      return { ok: true, content, totalLines }
    } catch (err) {
      console.error('[file:read] failed:', err)
      return { ok: false, error: (err as Error).message }
    }
  })

  // 文本写入系统剪贴板：渲染进程 file:// 协议下 navigator.clipboard 不可用
  // （非 secure context），统一走主进程 Electron clipboard 模块。
  // 安全：写入是用户主动复制动作（消息/代码块/链接），无越权风险。
  ipc.handle('shell:clipboardWriteText', async (_event, text: string) => {
    try {
      clipboard.writeText(typeof text === 'string' ? text : '')
      return true
    } catch (err) {
      console.error('[shell:clipboardWriteText] failed:', err)
      return false
    }
  })

  // 粘贴图片落盘：渲染进程 Ctrl+V 的剪贴板图片没有磁盘路径，
  // 先解码 data URL 写入临时文件拿到 path（主进程发送时按 path 读内容，预览用 dataUrl）
  ipc.handle('attachment:saveClipboardImage', async (_event, dataUrl: string) => {
    try {
      const match = /^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/.exec(dataUrl)
      if (!match) return { ok: false, error: '无效的图片 data URL' }
      const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
      const buf = Buffer.from(match[2], 'base64')
      if (buf.length > 8 * 1024 * 1024) return { ok: false, error: '图片超过 8MB' }
      const dir = join(app.getPath('userData'), 'clipboard')
      mkdirSync(dir, { recursive: true })
      const path = join(dir, `clip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`)
      writeFileSync(path, buf)
      return { ok: true, path }
    } catch (err) {
      console.error('[attachment:saveClipboardImage] failed:', err)
      return { ok: false, error: (err as Error).message }
    }
  })
}
