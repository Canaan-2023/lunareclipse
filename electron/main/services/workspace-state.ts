// ============================================================
// 工作区状态服务：聚合"用户当前正在查看的内容"，供 AI 上下文注入
// ------------------------------------------------------------
// 数据源：
// 1. 浏览器面板状态（URL/标题/可见性/加载中）—— 由 BrowserViewManager 同步提供
// 2. 文件预览状态（当前预览的文件路径）—— 由前端 FileWorkshopPanel 通过 IPC 推送
// 3. 文件工坊代码执行状态（语言/代码摘要/结果）—— 由前端 sandboxRun 完成后推送
//
// 输出：getWorkspaceContext() 返回拼接好的 system 消息文本；
// 浏览器/文件/沙箱均未打开时返回空字符串，调用方据此决定是否注入。
// 为什么存在：AI 上下文注入依赖"用户此刻在看什么"，浏览器/文件/沙箱三路状态散在各处，需聚合为单一上下文源。
// ============================================================

import { browserViewManager } from '../tools/browser-view-manager'

let currentPreviewFile: string | null = null
let currentPreviewSession: string | null = null

let currentSandboxState: SandboxState | null = null

interface SandboxState {
  language: string
  code: string
  ok: boolean
  durationMs: number
  timedOut: boolean
  outputSummary: string
}

export function setPreviewFile(path: string | null, sessionId?: string): void {
  currentPreviewFile = path
  currentPreviewSession = sessionId ?? null
}

export function clearPreviewFile(): void {
  currentPreviewFile = null
  currentPreviewSession = null
}

export function getPreviewFile(): string | null {
  return currentPreviewFile
}

export function getPreviewSession(): string | null {
  return currentPreviewSession
}

export function setSandboxState(state: SandboxState | null): void {
  currentSandboxState = state
}

export function clearSandboxState(): void {
  currentSandboxState = null
}

/**
 * 生成工作区上下文文本（元信息级，不含完整文件内容/页面快照，token 友好）。
 * 浏览器、文件预览、沙箱均未打开时返回空字符串。
 */
export function getWorkspaceContext(): string {
  const lines: string[] = []

  // 浏览器面板状态（同步读取，不执行 snapshot 脚本，避免阻塞注入流程）
  const browserState = browserViewManager.getStateSummary()
  if (browserState.visible) {
    const urlDisplay = browserState.url || '(about:blank)'
    const titleDisplay = browserState.title || '(无标题)'
    const loadingTag = browserState.loading ? ' [加载中]' : ''
    lines.push(`- 浏览器面板: 已打开${loadingTag} | URL: ${urlDisplay} | 标题: ${titleDisplay}`)
  }

  // 文件工坊——文件预览状态
  if (currentPreviewFile) {
    lines.push(`- 文件工坊（预览中）: ${currentPreviewFile}`)
    lines.push(`  需要文件内容时调 Read 工具读取`)
  }

  // 文件工坊——代码执行状态（只注入一行状态信号，不注入代码/输出全文——AI 按需 Read 或 code_run 查询）
  if (currentSandboxState) {
    const { language, ok, durationMs, timedOut } = currentSandboxState
    const status = ok ? '成功' : '失败'
    const timeoutTag = timedOut ? ' (超时)' : ''
    lines.push(`- 文件工坊（代码执行）: 用户刚用 ${language} 执行代码，结果${status}${timeoutTag}，耗时 ${durationMs}ms`)
  }

  if (lines.length === 0) return ''

  return `## 当前工作区状态（用户此刻正在查看/操作，可作为对话背景参考）\n${lines.join('\n')}`
}
