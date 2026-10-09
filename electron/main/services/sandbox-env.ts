// ============================================================
// 文件工坊执行器配置系统
// ------------------------------------------------------------
// sandbox-env.json 管理可用的代码执行器。
// JavaScript 走 worker_threads（Node.js 内置，无需安装）。
// Python 需系统已安装解释器（不在 PATH 时给出友好提示）。
// 其他语言（Go/Bash/Node 等）由 AI 通过 code_run 的 upsert_executor 添加。
// 下载的运行时环境放在固定目录 sandboxRuntimes/。
// 为什么存在：不同机器的代码执行器可用性不同且运行时体积大，需配置化声明并固定下载目录，避免每次探测与散落安装。
// ============================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import type { BaseDataPaths } from '../models/paths'

export interface ExecutorConfig {
  /** 执行器 ID（如 javascript / python / go / bash） */
  id: string
  /** 显示名称 */
  label: string
  /** 执行模式：worker = worker_threads 隔离（仅 JS），subprocess = 子进程 */
  mode: 'worker' | 'subprocess'
  /** 子进程模式：可执行命令（如 python3 / go run / bash） */
  command?: string
  /** 子进程模式：参数模板，{code} 占位符替换为脚本路径或 -c 参数 */
  argsTemplate?: string[]
  /** 子进程模式：通过 stdin 传代码（true）还是写临时文件（false） */
  stdinMode?: boolean
  /** 文件扩展名（写临时文件时使用，如 .py / .go / .sh） */
  fileExtension?: string
  /** 默认超时（毫秒） */
  timeoutMs?: number
  /** 是否默认配置（不可删除）：JS 是 Node.js 内置，Python 依赖系统安装但默认提供配置 */
  builtin: boolean
}

const DEFAULT_EXECUTORS: ExecutorConfig[] = [
  {
    id: 'javascript',
    label: 'JavaScript',
    mode: 'worker',
    builtin: true,
    timeoutMs: 5000
  },
  {
    id: 'python',
    label: 'Python',
    mode: 'subprocess',
    command: 'python',
    argsTemplate: ['-u', '-c', '{code}'],
    stdinMode: false,
    fileExtension: '.py',
    builtin: true,
    timeoutMs: 5000
  }
]

let _executors: ExecutorConfig[] | null = null
let _configPath: string | null = null
let _runtimesDir: string | null = null

export function initSandboxEnv(paths: BaseDataPaths): void {
  _configPath = paths.sandboxEnv
  _runtimesDir = paths.sandboxRuntimes
  _executors = loadConfig()
}

function loadConfig(): ExecutorConfig[] {
  if (!_configPath) return [...DEFAULT_EXECUTORS]
  try {
    if (existsSync(_configPath)) {
      const raw = readFileSync(_configPath, 'utf-8')
      const userConfig = JSON.parse(raw) as ExecutorConfig[]
      // 合并：内置执行器始终保留，用户自定义的追加
      const userCustom = userConfig.filter((e) => !DEFAULT_EXECUTORS.some((d) => d.id === e.id))
      return [...DEFAULT_EXECUTORS, ...userCustom]
    }
  } catch (err) {
    // 用户配置文件损坏/不可读时降级为内置执行器，不中断启动（buildInjected 里 getExecutors 也走同一路径）
    console.error('[sandbox-env] 沙箱执行器配置读取失败，回退内置执行器:', err)
  }
  return [...DEFAULT_EXECUTORS]
}

function saveConfig(): void {
  if (!_configPath) return
  const dir = dirname(_configPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  // 只保存用户自定义的执行器（内置的代码里硬编码）
  const custom = (_executors ?? []).filter((e) => !e.builtin)
  writeFileSync(_configPath, JSON.stringify(custom, null, 2), 'utf-8')
}

export function getExecutors(): ExecutorConfig[] {
  if (_executors === null) _executors = loadConfig()
  return _executors
}

export function getExecutor(id: string): ExecutorConfig | null {
  return getExecutors().find((e) => e.id === id) ?? null
}

export function listExecutorIds(): string[] {
  return getExecutors().map((e) => e.id)
}

export function getRuntimesDir(): string {
  return _runtimesDir ?? join(process.cwd(), 'runtimes')
}

/**
 * 添加或更新自定义执行器（AI 可调用）。
 * 同 ID 覆盖；builtin=true 的执行器不可覆盖。
 */
export function upsertExecutor(config: ExecutorConfig): { ok: boolean; error?: string } {
  if (!_executors) return { ok: false, error: 'sandbox env not initialized' }
  const idx = _executors.findIndex((e) => e.id === config.id)
  if (idx >= 0 && _executors[idx].builtin) {
    return { ok: false, error: `cannot modify builtin executor: ${config.id}` }
  }
  const newConfig = { ...config, builtin: false }
  if (idx >= 0) {
    _executors[idx] = newConfig
  } else {
    _executors.push(newConfig)
  }
  saveConfig()
  return { ok: true }
}

export function removeExecutor(id: string): { ok: boolean; error?: string } {
  if (!_executors) return { ok: false, error: 'sandbox env not initialized' }
  const idx = _executors.findIndex((e) => e.id === id)
  if (idx < 0) return { ok: false, error: `executor not found: ${id}` }
  if (_executors[idx].builtin) return { ok: false, error: `cannot remove builtin executor: ${id}` }
  _executors.splice(idx, 1)
  saveConfig()
  return { ok: true }
}
