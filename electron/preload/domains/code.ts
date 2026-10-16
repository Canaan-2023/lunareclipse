/**
 * 文件工坊代码执行 preload 域（通用执行器 + 流式输出）。
 * 为什么存在：代码必须在主进程沙箱子进程中执行（安全隔离），stdout/stderr 实时回传需要
 * 事件通道，渲染进程不能自行运行代码。
 * 作用：暴露 code:run / runStream、执行器管理与 Python 探测，及 onCodeStream 流式订阅。
 */
import { ipcRenderer } from 'electron'
import type { CodeSandboxResult } from '../../main/tools/code-sandbox'

export const api = {
  // ===== 文件工坊代码执行（通用执行器，支持流式输出） =====
  /** 同步执行代码（一次性返回结果） */
  codeRun: (language: string, code: string, timeoutMs?: number) =>
    ipcRenderer.invoke('code:run', language, code, timeoutMs) as Promise<{ ok: boolean; data?: CodeSandboxResult; error?: string }>,
  /** 流式执行：实时推送 stdout/stderr，监听 code:stdout/code:stderr/code:done */
  codeRunStream: (language: string, code: string, timeoutMs?: number) =>
    ipcRenderer.invoke('code:runStream', language, code, timeoutMs) as Promise<{ ok: boolean; error?: string }>,
  /** 检测 Python 是否可用 */
  codeDetectPython: () =>
    ipcRenderer.invoke('code:detectPython') as Promise<{ ok: boolean; version: string }>,
  /** 列出所有可用执行器 */
  codeListExecutors: () =>
    ipcRenderer.invoke('code:listExecutors') as Promise<{ ok: boolean; executors: Array<{ id: string; label: string; mode: string; builtin: boolean }> }>,
  /** 添加/更新自定义执行器 */
  codeUpsertExecutor: (config: { id: string; label: string; mode: 'subprocess'; command: string; argsTemplate?: string[]; stdinMode?: boolean; fileExtension?: string; timeoutMs?: number }) =>
    ipcRenderer.invoke('code:upsertExecutor', config) as Promise<{ ok: boolean; error?: string }>,
  /** 删除自定义执行器 */
  codeRemoveExecutor: (id: string) =>
    ipcRenderer.invoke('code:removeExecutor', id) as Promise<{ ok: boolean; error?: string }>,
  /** 订阅流式输出（ stdout / stderr / done 三种事件） */
  onCodeStream: (callbacks: {
    onStdout: (chunk: string) => void
    onStderr: (chunk: string) => void
    onDone: (result: CodeSandboxResult) => void
  }) => {
    const stdoutListener = (_e: Electron.IpcRendererEvent, chunk: string) => callbacks.onStdout(chunk)
    const stderrListener = (_e: Electron.IpcRendererEvent, chunk: string) => callbacks.onStderr(chunk)
    const doneListener = (_e: Electron.IpcRendererEvent, result: CodeSandboxResult) => callbacks.onDone(result)
    ipcRenderer.on('code:stdout', stdoutListener)
    ipcRenderer.on('code:stderr', stderrListener)
    ipcRenderer.on('code:done', doneListener)
    return () => {
      ipcRenderer.removeListener('code:stdout', stdoutListener)
      ipcRenderer.removeListener('code:stderr', stderrListener)
      ipcRenderer.removeListener('code:done', doneListener)
    }
  },
}