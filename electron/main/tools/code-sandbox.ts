/**
 * 代码执行沙箱：为什么存在——AI 需要运行代码（JS/Python/Go/Bash 等）验证想法或处理数据，
 * 但裸执行不可控，必须统一加隔离、超时与资源限制。
 * 作用：JS 走 worker_threads 隔离执行、其他语言走子进程（stdin/临时文件），
 * 统一超时/CPU 互斥/输出回调，并支持执行器配置增删。
 */
import { Worker } from 'worker_threads'
import { spawn } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { IpcMain } from 'electron'
import type { Tool, ToolResult } from './base-tool'
import { runHeavyExclusive } from './heavy-mutex'
import { formatValue } from '@shared/utils/format-value'
import { getExecutor, getExecutors, upsertExecutor, removeExecutor, getRuntimesDir } from '../services/sandbox-env'
import type { ExecutorConfig } from '../services/sandbox-env'

// ============================================================
// 文件工坊代码执行引擎
// ------------------------------------------------------------
// JS 通过 worker_threads 隔离执行（Node.js 内置，无需安装）。
// 其他语言（Python/Go/Bash 等）通过子进程执行，需系统已安装对应运行时。
// AI 可通过 code_run 的 action 参数增删执行器配置。
// 安全策略：
// 1. JS：worker_threads 独立 V8 isolate，不使用 vm 模块
// 2. 子进程语言：stdin 脚本或临时文件，超时杀进程，CPU 互斥
// 3. 默认超时 5 秒，最大 30 秒
// 4. 输出通过回调实时推送（前端面板 + AI 工具结果）
// ============================================================

const DEFAULT_SANDBOX_TIMEOUT_MS = 5000
export const MAX_SANDBOX_TIMEOUT_MS = 30000
const STDIO_IDLE_TIMEOUT_MS = 3000  // stdout/stderr 空闲后等待刷新的毫秒数
const SANDBOX_WORKER_MAX_OLD_GEN_MB = 64   // Worker V8 老生代堆上限
const SANDBOX_WORKER_MAX_YOUNG_GEN_MB = 16 // Worker V8 新生代堆上限
const SANDBOX_WORKER_STACK_MB = 4          // Worker 栈大小上限
const WINDOWS_STORE_ALIAS_EXIT_CODE = 9009 // Windows Store 别名（未安装 Python）典型退出码
const MAX_CODE_LENGTH = 100_000            // 输入代码长度上限（字符数）
const SENSITIVE_ENV_PATTERNS = [           // Python 子进程环境变量敏感键过滤
  /API_?KEY/i, /TOKEN/i, /SECRET/i, /PASSWORD/i, /CREDENTIAL/i, /^(API_)?AUTH$/i, /PRIVATE_?KEY/i
]

export type CodeLanguage = string

export interface CodeSandboxResult {
  ok: boolean
  stdout: string
  stderr: string
  /** JS 执行返回值（最后一个表达式的值，仅 JS 有） */
  result?: unknown
  /** 执行耗时（毫秒） */
  durationMs: number
  /** 是否超时 */
  timedOut: boolean
  errorMessage?: string
}

export interface CodeSandboxOptions {
  /** 执行超时（毫秒），默认 5000，最大 30000 */
  timeoutMs?: number
  /** stdout/stderr 实时回调（用于前端流式输出） */
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  /**
   * 额外上下文注入（hook 场景）：作为 Function 参数传给用户代码，可按名引用（如 ctx）。
   * 仅供可信调用方（hook-manager）使用，与 shadowNames 冲突的名字会被忽略（消毒优先）。
   */
  globals?: Record<string, unknown>
}

/**
 * 沙箱执行服务（coeffect key: 'sandbox:exec'）。
 * 插件在 plugin.json 声明 deps: ['sandbox:exec'] 后，cordis-mounter 按需注入到 config.sandbox。
 * 未声明该 deps 的模块不会拿到此服务（按需注入，不乱注入）。
 */
export interface SandboxExecService {
  /** 在 JS Worker 沙箱中执行代码（V8 隔离 + 全局消毒） */
  runJavaScript(code: string, options?: CodeSandboxOptions): Promise<CodeSandboxResult>
  /** 执行 Python 代码（子进程 + builtins 限制 + CPU 互斥） */
  runPython(code: string, options?: CodeSandboxOptions): Promise<CodeSandboxResult>
  /** 执行任意语言代码（自动选择执行器：JS→Worker，其他→子进程） */
  runCode(language: CodeLanguage, code: string, options?: CodeSandboxOptions): Promise<CodeSandboxResult>
}

function filterSensitiveEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const filtered: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    if (SENSITIVE_ENV_PATTERNS.some((p) => p.test(key))) continue
    filtered[key] = value
  }
  return filtered
}

const WORKER_SCRIPT = `
const { parentPort } = require('worker_threads')

${formatValue.toString()}

function safeSerialize(v) {
  if (v === undefined || v === null) return v
  if (typeof v !== 'object') return v
  try { return JSON.parse(JSON.stringify(v)) } catch { return '[Unserializable Object]' }
}

// Sanitize globalThis: remove / neutralize all dangerous Node.js and Web API
// globals so that even if user code reaches the real globalThis via prototype
// chain escape (e.g. [].constructor.constructor), there is no require /
// process / fs / fetch to grab.
var DANGEROUS_GLOBALS = [
  'require', 'process', 'module', 'exports', '__dirname', '__filename',
  'eval', // 经全局消毒处理：strict 模式下函数参数名不能为 eval，无法用 shadowNames 遮蔽
  'Buffer', 'setTimeout', 'setInterval', 'setImmediate',
  'clearTimeout', 'clearInterval', 'clearImmediate',
  'queueMicrotask', 'structuredClone', 'TextEncoder', 'TextDecoder',
  'URL', 'URLSearchParams', 'atob', 'btoa',
  'AbortController', 'AbortSignal', 'MessageChannel', 'MessagePort',
  'MessageEvent', 'Worker', 'Blob', 'File', 'FormData',
  'Headers', 'Request', 'Response', 'fetch', 'navigator',
  'performance', 'console', 'addEventListener', 'removeEventListener',
  'Event', 'EventTarget', 'CustomEvent', 'DOMException',
  'ReadableStream', 'WritableStream', 'TransformStream'
]
for (var i = 0; i < DANGEROUS_GLOBALS.length; i++) {
  var gk = DANGEROUS_GLOBALS[i]
  try { delete globalThis[gk] } catch { /* 不可配置的全局属性删除失败是预期的：defineProperty 兜底覆盖 */ }
  try {
    Object.defineProperty(globalThis, gk, {
      value: undefined, writable: false, configurable: false, enumerable: false
    })
} catch { /* 已冻结/不可配置的属性无法重新定义：保留原样即满足隔离（原值已被置 undefined） */ }
}
try { Object.freeze(Object) } catch { /* 若已被更早注入冻结，再次冻结幂等，无需处理 */ }
try { Object.freeze(Function) } catch { /* 同上：冻结失败说明环境已更严格 */ }
try { Object.freeze(Array) } catch { /* 同上：冻结失败说明环境已更严格 */ }

function makeConsole(stdoutChunks, stderrChunks) {
  function emit(target, chunks) {
    return function() {
      var line = Array.prototype.map.call(arguments, formatValue).join(' ') + '\\n'
      chunks.push(line)
      parentPort.postMessage({ type: target, data: line })
    }
  }
  return {
    log: emit('stdout', stdoutChunks),
    info: emit('stdout', stdoutChunks),
    error: emit('stderr', stderrChunks),
    warn: emit('stderr', stderrChunks)
  }
}

parentPort.on('message', function(data) {
  var code = data.code
  var stdoutChunks = []
  var stderrChunks = []
  var sandboxConsole = makeConsole(stdoutChunks, stderrChunks)

  // Safe globals passed as Function parameters — they shadow the global scope
  // so user code sees only these (not the real require/process/etc.).
  var safeGlobals = {
    console: sandboxConsole,
    Math: Math, JSON: JSON, Date: Date,
    parseInt: parseInt, parseFloat: parseFloat,
    isNaN: isNaN, isFinite: isFinite,
    encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
    RegExp: RegExp, Array: Array, Object: Object,
    String: String, Number: Number, Boolean: Boolean,
    Map: Map, Set: Set, Promise: Promise, Symbol: Symbol,
    Error: Error, TypeError: TypeError, RangeError: RangeError
  }

  // Names shadowed as undefined inside the Function body so user code cannot
  // directly reference them (defense in depth on top of globalThis sanitization).
  // Note: 'import' and 'this' are reserved words — cannot be parameter names.
  // 'import()' is blocked by a regex check in the main thread before posting.
  var shadowNames = [
    'globalThis', 'global', 'self', 'window',
    'process', 'require', 'module', 'exports', 'Buffer',
    'setTimeout', 'setInterval', 'setImmediate',
    'clearTimeout', 'clearInterval', 'clearImmediate',
    'queueMicrotask', 'structuredClone', 'fetch',
    '__dirname', '__filename', 'Function',
    'navigator', 'performance'
  ]

  // Extra context injection (hook scenario): data.globals is a plain data object
  // provided by the trusted caller (hook-manager), passed in as extra Function
  // parameters so user code can reference them by name (e.g. 'ctx').
  // Names colliding with sanitized globals are ignored — the sanitization wins.
  var extraGlobals = (data && data.globals) || {}
  if (typeof extraGlobals === 'object') {
    var extraKeys = Object.keys(extraGlobals)
    for (var ei = 0; ei < extraKeys.length; ei++) {
      var ek = extraKeys[ei]
      if (shadowNames.indexOf(ek) !== -1 || Object.prototype.hasOwnProperty.call(safeGlobals, ek)) continue
      safeGlobals[ek] = extraGlobals[ek]
    }
  }

  var paramNames = Object.keys(safeGlobals).concat(shadowNames)
  var paramValues = Object.values(safeGlobals).concat(shadowNames.map(function() { return undefined }))

try {
    // health-scan: ignore-eval 沙箱执行器核心：shadowNames 已把 eval/Function/process 等 20+ 敏感全局
    // 遮蔽为 undefined（globalThis 亦已消毒），import() 由主线程正则拦截，属设计内安全机制
    var fn = new Function(paramNames.join(','), '"use strict"; ' + code)
    var result = fn.apply(undefined, paramValues)

    if (result instanceof Promise) {
      result.then(function(r) {
        parentPort.postMessage({
          type: 'done', ok: true,
          stdout: stdoutChunks.join(''),
          stderr: stderrChunks.join(''),
          result: safeSerialize(r)
        })
      }).catch(function(err) {
        parentPort.postMessage({
          type: 'done', ok: false,
          stdout: stdoutChunks.join(''),
          stderr: stderrChunks.join('') + ((err && err.stack) || (err && err.message) || String(err)) + '\\n',
          errorMessage: (err && err.message) || String(err)
        })
      })
    } else {
      parentPort.postMessage({
        type: 'done', ok: true,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
        result: safeSerialize(result)
      })
    }
  } catch (err) {
    parentPort.postMessage({
      type: 'done', ok: false,
      stdout: stdoutChunks.join(''),
      stderr: stderrChunks.join('') + ((err && err.stack) || (err && err.message) || String(err)) + '\\n',
      errorMessage: (err && err.message) || String(err)
    })
  }
})
`

/**
 * 执行 JavaScript 代码（Worker 线程隔离沙箱，不使用 vm 模块）
 */
export async function runJavaScript(
  code: string,
  options: CodeSandboxOptions = {}
): Promise<CodeSandboxResult> {
  const start = Date.now()
  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS, MAX_SANDBOX_TIMEOUT_MS)

  if (/(?:^|[^\w$.'"`])\bimport\s*\(/.test(code)) {
    return {
      ok: false,
      stdout: '',
      stderr: '沙箱不支持动态 import()：JS 沙箱仅提供纯计算 API（Math/JSON/Date 等），' +
        '如需文件/网络/进程操作，请改用其他工具（Read/Write/web_search/run_command 等）。\n',
      durationMs: Date.now() - start,
      timedOut: false,
      errorMessage: 'sandbox does not support dynamic import()'
    }
  }

  return new Promise<CodeSandboxResult>((resolve) => {
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    let settled = false

    const worker = new Worker(WORKER_SCRIPT, {
      eval: true,
      resourceLimits: {
        maxOldGenerationSizeMb: SANDBOX_WORKER_MAX_OLD_GEN_MB,
        maxYoungGenerationSizeMb: SANDBOX_WORKER_MAX_YOUNG_GEN_MB,
        stackSizeMb: SANDBOX_WORKER_STACK_MB
      }
    })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      worker.terminate()
      resolve({
        ok: false,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join('') + `\n[超时] JS 沙箱执行超过 ${timeoutMs}ms 被强制终止\n`,
        durationMs: Date.now() - start,
        timedOut: true,
        errorMessage: `Script execution timed out after ${timeoutMs}ms`
      })
    }, timeoutMs)

    worker.on('message', (msg: { type: string; data?: string; ok?: boolean; result?: unknown; errorMessage?: string; timedOut?: boolean }) => {
      if (msg.type === 'stdout') {
        stdoutChunks.push(msg.data!)
        options.onStdout?.(msg.data!)
      } else if (msg.type === 'stderr') {
        stderrChunks.push(msg.data!)
        options.onStderr?.(msg.data!)
      } else if (msg.type === 'done') {
        if (settled) return
        settled = true
        clearTimeout(timer)
        worker.terminate()
        resolve({
          ok: msg.ok ?? false,
          stdout: stdoutChunks.join(''),
          stderr: stderrChunks.join(''),
          result: msg.result,
          durationMs: Date.now() - start,
          timedOut: msg.timedOut ?? false,
          errorMessage: msg.errorMessage
        })
      }
    })

    worker.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate()
      resolve({
        ok: false,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join('') + err.message + '\n',
        durationMs: Date.now() - start,
        timedOut: false,
        errorMessage: err.message
      })
    })

    worker.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        ok: false,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join('') + `\n[Worker 异常退出] code=${code}\n`,
        durationMs: Date.now() - start,
        timedOut: false,
        errorMessage: `Worker exited with code ${code}`
      })
    })

    worker.postMessage({ code, globals: options.globals })
  })
}

// ============================================================
// Python 可执行文件探测
// ------------------------------------------------------------
// Windows 上 `python` 可能指向 Microsoft Store 的 App Execution Alias
// （非交互调用会静默失败、无输出、非 0 退出码），因此需要探测真实
// 可用的解释器：python → py（Python Launcher）→ 都不行返回 'python'
// 由调用方给出友好报错。探测结果缓存 60 秒，失败不缓存（用户装好
// Python 后下一次调用可重新探测到）。
// ============================================================

let cachedPyExe: string | null = null
let cachedPyExeAt = 0
const PY_EXE_CACHE_TTL = 60_000

/** 探测单个候选命令是否真的能跑（执行 --version 且退出码为 0） */
function probePython(candidate: string): Promise<boolean> {
  return new Promise((resolve) => {
    let proc
    try {
      proc = spawn(candidate, ['--version'], { windowsHide: true })
    } catch {
      resolve(false)
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { proc.kill() } catch { /* 忽略 */ }
      resolve(false)
    }, STDIO_IDLE_TIMEOUT_MS)
    proc.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(false)
    })
    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

/**
 * 解析可用的 Python 可执行文件命令
 * - 非 Windows：python3
 * - Windows：python → py（Python Launcher）→ 都不行返回 'python'
 * 探测成功结果缓存 60 秒；失败不缓存
 */
async function resolvePyExe(): Promise<string> {
  if (process.platform !== 'win32') return 'python3'
  if (cachedPyExe && Date.now() - cachedPyExeAt < PY_EXE_CACHE_TTL) {
    if (await probePython(cachedPyExe)) {
      return cachedPyExe
    }
    cachedPyExe = null
  }
  for (const candidate of ['python', 'py']) {
    if (await probePython(candidate)) {
      cachedPyExe = candidate
      cachedPyExeAt = Date.now()
      return candidate
    }
  }
  // 都不行：兜底返回 'python'，由调用方给出友好报错（不缓存）
  return 'python'
}

/** 探测 Python 版本号（供 IPC detectPython 复用） */
function detectPythonVersion(pyExe: string): Promise<{ ok: boolean; version: string }> {
  return new Promise((resolve) => {
    let proc
    try {
      proc = spawn(pyExe, ['--version'], { windowsHide: true })
    } catch {
      resolve({ ok: false, version: '' })
      return
    }
    let output = ''
    let settled = false
    proc.stdout?.on('data', (c) => { output += c.toString() })
    proc.stderr?.on('data', (c) => { output += c.toString() })
    // 3 秒超时
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { proc.kill() } catch { /* 忽略 */ }
      resolve({ ok: false, version: '' })
    }, STDIO_IDLE_TIMEOUT_MS)
    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0, version: output.trim() })
    })
    proc.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, version: '' })
    })
  })
}

/**
 * 执行 Python 代码（子进程）

 * 性能保护：Python 子进程裸奔会吃满 CPU 卡死 UI（真实案例：
 * AI 批量脚本 + 同步回填 IO 风暴 → eventloop 阻塞 19.3s）。对策：
 * 1. 全局互斥队列——与 run_command 重型命令共用同一队列，同一时刻只允许一个重活
 * 2. 子进程降为 BelowNormal 优先级（spawn 后按 PID 设置，竞态窗口内失败无害）
 */
export async function runPython(
  code: string,
  options: CodeSandboxOptions = {}
): Promise<CodeSandboxResult> {
  // 检测可用 python 可执行（Windows 上 `python` 可能是 Store 别名，探测真实解释器）
  // 注意：await 必须放在 async 函数体顶层，不能放在 Promise executor 回调里
  const pyExe = await resolvePyExe()

  // Python 脚本可能重活（死循环/大数据处理），走全局互斥队列削 CPU 峰值
  return runHeavyExclusive(() => executePython(pyExe, code, options))
}

function executePython(
  pyExe: string,
  code: string,
  options: CodeSandboxOptions = {}
): Promise<CodeSandboxResult> {
  return new Promise((resolve) => {
    const start = Date.now()
    const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS, MAX_SANDBOX_TIMEOUT_MS)
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []

    const PYTHON_RESTRICT_PREAMBLE = [
      'import builtins',
      '_blocked = {"open": None, "exec": None, "eval": None, "compile": None,',
      '  "__import__": None, "getattr": None, "setattr": None, "delattr": None,',
      '  "globals": None, "locals": None, "vars": None, "dir": None}',
      'builtins.__dict__.update(_blocked)',
      'del builtins, _blocked',
      ''
    ].join('\n')

    const sandboxedCode = PYTHON_RESTRICT_PREAMBLE + '\n' + code

    let proc
    try {
      proc = spawn(pyExe, ['-u', '-c', sandboxedCode], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...filterSensitiveEnv(process.env),
          PYTHONIOENCODING: 'utf-8',
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONPATH: ''
        }
      })
      // 降优先级：防止 Python 重活饿死 Electron 主进程（与 run_command 同构）
      if (process.platform === 'win32' && proc.pid) {
        try {
          spawn('powershell.exe', [
            '-NoProfile', '-Command',
            "(Get-Process -Id $args[0]).PriorityClass='BelowNormal'",
            String(proc.pid)
          ], { windowsHide: true, stdio: 'ignore' })
        } catch { /* 降优先级失败无害，互斥队列仍兜底 */ }
      }
    } catch (err) {
      resolve({
        ok: false,
        stdout: '',
        stderr: `无法启动 ${pyExe}: ${(err as Error).message}\n请确保系统已安装 Python`,
        durationMs: Date.now() - start,
        timedOut: false,
        errorMessage: (err as Error).message
      })
      return
    }

    // settled 标志：防止 close 事件和 timeout 同时触发导致重复 resolve
    // 与同文件 detectPython 的实现保持一致
    let settled = false

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      stdoutChunks.push(text)
      options.onStdout?.(text)
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      stderrChunks.push(text)
      options.onStderr?.(text)
    })

    proc.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // ENOENT = 解释器不存在，给出可操作的提示
      const isMissing = /ENOENT|spawn .* ENOENT/.test(err.message)
      const friendly = isMissing
        ? `找不到 Python 解释器（${pyExe}）。请安装 Python 3（https://www.python.org/downloads/），`
          + `或确保其已加入 PATH；Windows 也可使用 py launcher 自动匹配。`
        : err.message
      resolve({
        ok: false,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join('') + friendly + '\n',
        durationMs: Date.now() - start,
        timedOut: false,
        errorMessage: friendly
      })
    })

    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const ok = code === 0
      // 非 0 退出：给用户可操作的提示（Windows 上 9009 = Store 别名未装 Python 的典型表现）
      const friendly = !ok && (code === WINDOWS_STORE_ALIAS_EXIT_CODE || code === 1)
        ? `Python 解释器（${pyExe}）执行失败（退出码 ${code}）。`
          + `Windows 上常见原因是 'python' 指向 Microsoft Store 别名但未安装 Python，`
          + `或解释器不在 PATH 中。请安装 Python 3（https://www.python.org/downloads/）后重试。`
        : undefined
      resolve({
        ok,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join('') + (friendly ? friendly + '\n' : ''),
        durationMs: Date.now() - start,
        timedOut: false,
        errorMessage: friendly
      })
    })

    // 超时杀进程
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        proc.kill('SIGKILL')
      } catch { /* 忽略 */ }
      resolve({
        ok: false,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join('') + `\n[超时] 代码执行超过 ${timeoutMs}ms 被强制终止\n`,
        durationMs: Date.now() - start,
        timedOut: true
      })
    }, timeoutMs)
  })
}

/**
 * 通用子进程执行器：根据 ExecutorConfig 执行任意语言代码。

 * 两种模式：
 * - stdinMode=true：通过 stdin 传代码（如 bash -s、node --input-type=module）
 * - stdinMode=false：写临时文件，命令模板中 {code} 替换为文件路径
 */
function runGenericSubprocess(
  executor: import('../services/sandbox-env').ExecutorConfig,
  code: string,
  options: CodeSandboxOptions = {}
): Promise<CodeSandboxResult> {
  return new Promise((resolve) => {
    const start = Date.now()
    const timeoutMs = Math.min(
      options.timeoutMs ?? executor.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
      MAX_SANDBOX_TIMEOUT_MS
    )
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    let settled = false
    let tempFile: string | null = null

    try {
      const command = executor.command ?? executor.id
      let args: string[]
      let useStdin = executor.stdinMode ?? false

      if (useStdin) {
        // stdin 模式：args 不含 {code}
        args = executor.argsTemplate ?? []
      } else if (executor.argsTemplate && executor.argsTemplate.includes('{code}')) {
        // 临时文件模式：{code} 替换为临时文件路径
        const ext = executor.fileExtension ?? '.txt'
        const tempPath = join(tmpdir(), `sandbox_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`)
        tempFile = tempPath
        writeFileSync(tempPath, code, 'utf-8')
        args = executor.argsTemplate.map((a) => a.replace('{code}', tempPath))
      } else if (executor.argsTemplate) {
        // 直接传代码作为参数（如 python -c "code"）
        args = executor.argsTemplate.map((a) => a.replace('{code}', code))
      } else {
        // 默认 stdin
        useStdin = true
        args = []
      }

      const proc = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: filterSensitiveEnv(process.env),
        windowsHide: true
      })

      // 降优先级
      if (process.platform === 'win32' && proc.pid) {
        try {
          spawn('powershell.exe', [
            '-NoProfile', '-Command',
            "(Get-Process -Id $args[0]).PriorityClass='BelowNormal'",
            String(proc.pid)
          ], { windowsHide: true, stdio: 'ignore' })
        } catch { /* 降优先级失败无害 */ }
      }

      if (useStdin) {
        proc.stdin?.write(code)
        proc.stdin?.end()
      }

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8')
        stdoutChunks.push(text)
        options.onStdout?.(text)
      })
      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8')
        stderrChunks.push(text)
        options.onStderr?.(text)
      })

      proc.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer as ReturnType<typeof setTimeout>)
        const isMissing = /ENOENT|spawn .* ENOENT/.test(err.message)
        const friendly = isMissing
          ? `找不到执行器命令: ${command}。请确保已安装 ${executor.label} 并加入 PATH，` +
            `或通过 AI 配置自定义执行器（修改 sandbox-env.json）。`
          : err.message
        if (tempFile) try { unlinkSync(tempFile) } catch { /* 清理失败不影响结果 */ }
        resolve({
          ok: false,
          stdout: stdoutChunks.join(''),
          stderr: stderrChunks.join('') + friendly + '\n',
          durationMs: Date.now() - start,
          timedOut: false,
          errorMessage: friendly
        })
      })

      proc.on('close', (exitCode) => {
        if (settled) return
        settled = true
        clearTimeout(timer as ReturnType<typeof setTimeout>)
        if (tempFile) try { unlinkSync(tempFile) } catch { /* 清理失败不影响结果 */ }
        resolve({
          ok: exitCode === 0,
          stdout: stdoutChunks.join(''),
          stderr: stderrChunks.join(''),
          durationMs: Date.now() - start,
          timedOut: false
        })
      })

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { proc.kill('SIGKILL') } catch { /* 进程可能已退出 */ }
        if (tempFile) try { unlinkSync(tempFile) } catch { /* 清理失败不影响结果 */ }
        resolve({
          ok: false,
          stdout: stdoutChunks.join(''),
          stderr: stderrChunks.join('') + `\n[超时] ${executor.label} 代码执行超过 ${timeoutMs}ms 被强制终止\n`,
          durationMs: Date.now() - start,
          timedOut: true
        })
      }, timeoutMs)
    } catch (err) {
      if (tempFile) try { unlinkSync(tempFile) } catch { /* 清理失败不影响结果 */ }
      if (!settled) {
        settled = true
        resolve({
          ok: false,
          stdout: stdoutChunks.join(''),
          stderr: `无法启动 ${executor.command ?? executor.id}: ${(err as Error).message}\n`,
          durationMs: Date.now() - start,
          timedOut: false,
          errorMessage: (err as Error).message
        })
      }
    }
  })
}

/** 主入口：根据语言选择执行器 */
export async function runCode(
  language: CodeLanguage,
  code: string,
  options: CodeSandboxOptions = {}
): Promise<CodeSandboxResult> {
  if (code.length > MAX_CODE_LENGTH) {
    return {
      ok: false,
      stdout: '',
      stderr: `代码长度超限（${code.length} > ${MAX_CODE_LENGTH} 字符）\n`,
      durationMs: 0,
      timedOut: false,
      errorMessage: `code length ${code.length} exceeds limit ${MAX_CODE_LENGTH}`
    }
  }
  // JS 始终走 worker 隔离沙箱
  if (language === 'javascript') {
    return runJavaScript(code, options)
  }
  // 其他语言从执行器配置查找
  const executor = getExecutor(language)
  if (!executor) {
    const available = getExecutors().map((e) => e.id).join(', ')
    return {
      ok: false,
      stdout: '',
      stderr: `不支持的执行器: ${language}（可用: ${available}）\n提示：可通过配置 sandbox-env.json 添加自定义执行器。`,
      durationMs: 0,
      timedOut: false,
      errorMessage: `unsupported executor: ${language}`
    }
  }
  // 内置 python 走专用路径（有 Python 探测 + 安全 preamble）
  if (language === 'python') {
    return runPython(code, options)
  }
  // 自定义执行器走通用子进程
  return runHeavyExclusive(() => runGenericSubprocess(executor, code, options))
}

// ============================================================
// AI 工具：code_run（代码执行 + 执行器管理，合并原 configure_sandbox_env）
// ============================================================

export interface CodeRunToolParams {
  /** 操作类型：run（执行代码，默认）/ list_executors / upsert_executor / remove_executor */
  action?: 'run' | 'list_executors' | 'upsert_executor' | 'remove_executor'
  language?: CodeLanguage
  code?: string
  timeoutMs?: number
  /** upsert_executor 时必填 */
  executor?: ExecutorConfig
  /** remove_executor 时必填 */
  id?: string
}

export class CodeRunTool implements Tool<CodeRunToolParams> {
  name = 'code_run'
  description =
    '代码执行与执行器管理。action=run（默认）执行代码：JS 走 worker 隔离沙箱（Node.js 内置），其他语言走子进程（需系统已安装运行时）。' +
    'action=list_executors 列出所有可用执行器及运行时目录；action=upsert_executor 添加/更新执行器（需 executor 参数）；action=remove_executor 删除执行器（需 id 参数）。' +
    '参数：action（可选，默认 run）/ language（执行器 ID，run 时必填）/ code（代码，run 时必填）/ timeoutMs（默认 5000 最大 30000）/ executor（upsert_executor 时必填）/ id（remove_executor 时必填）。' +
    '返回 stdout/stderr/返回值/耗时/是否超时，或执行器管理结果。'
  parameters = [
    { name: 'action', type: 'string' as const, description: '操作类型：run（默认）/ list_executors / upsert_executor / remove_executor', required: false },
    { name: 'language', type: 'string' as const, description: '执行器 ID（如 javascript / python / go / bash，run 时必填）', required: false },
    { name: 'code', type: 'string' as const, description: '要执行的代码（多行字符串，run 时必填）', required: false },
    { name: 'timeoutMs', type: 'number' as const, description: '超时毫秒（默认 5000，最大 30000）', required: false },
    { name: 'executor', type: 'object' as const, description: '执行器配置（upsert_executor 时必填：id/label/mode/command/argsTemplate/stdinMode/fileExtension/timeoutMs）', required: false },
    { name: 'id', type: 'string' as const, description: '执行器 ID（remove_executor 时必填）', required: false }
  ]

  async execute(params: CodeRunToolParams): Promise<ToolResult> {
    const action = params.action ?? 'run'

    // 执行器管理（原 configure_sandbox_env 功能）
    if (action === 'list_executors') {
      const executors = getExecutors()
      return {
        ok: true,
        data: {
          executors: executors.map((e) => ({
            id: e.id, label: e.label, mode: e.mode, command: e.command,
            argsTemplate: e.argsTemplate, stdinMode: e.stdinMode,
            fileExtension: e.fileExtension, timeoutMs: e.timeoutMs, builtin: e.builtin
          })),
          runtimesDir: getRuntimesDir()
        }
      }
    }

    if (action === 'upsert_executor') {
      if (!params.executor) return { ok: false, error: 'upsert_executor 需要 executor 参数' }
      const exec = params.executor
      if (!exec.id || !exec.label) return { ok: false, error: 'executor 必须包含 id 和 label' }
      if (exec.mode === 'subprocess' && !exec.command) return { ok: false, error: 'subprocess 模式需要 command 字段' }
      const result = upsertExecutor(exec)
      return {
        ok: result.ok,
        error: result.error,
        data: result.ok ? { id: exec.id, runtimesDir: getRuntimesDir() } : undefined
      }
    }

    if (action === 'remove_executor') {
      if (!params.id) return { ok: false, error: 'remove_executor 需要 id 参数' }
      const result = removeExecutor(params.id)
      return { ok: result.ok, error: result.error }
    }

    // 默认：执行代码
    if (!params.code || params.code.trim().length === 0) {
      return { ok: false, error: 'code 不能为空' }
    }
    if (!params.language) {
      return { ok: false, error: 'language 必填' }
    }

    const result = await runCode(params.language, params.code, {
      timeoutMs: params.timeoutMs
    })

    return {
      ok: result.ok,
      data: {
        stdout: result.stdout,
        stderr: result.stderr,
        result: result.result,
        durationMs: result.durationMs,
        timedOut: result.timedOut
      },
      error: result.ok ? undefined : result.errorMessage
    }
  }
}

// ============================================================
// IPC 注册（供前端面板调用，支持流式输出）
// ============================================================

export function registerCodeSandboxIpcHandlers(ipc: IpcMain): void {
  /** 同步执行代码（一次性返回结果） */
  ipc.handle('code:run', async (_e, language: CodeLanguage, code: string, timeoutMs?: number) => {
    try {
      const result = await runCode(language, code, { timeoutMs })
      return { ok: true, data: result }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  /** 流式执行：实时推送 stdout/stderr，最后推送 done */
  ipc.handle('code:runStream', async (event, language: CodeLanguage, code: string, timeoutMs?: number) => {
    try {
      const result = await runCode(language, code, {
        timeoutMs,
        onStdout: (chunk) => {
          event.sender.send('code:stdout', chunk)
        },
        onStderr: (chunk) => {
          event.sender.send('code:stderr', chunk)
        }
      })
      event.sender.send('code:done', result)
      return { ok: true }
    } catch (err) {
      event.sender.send('code:done', {
        ok: false,
        stdout: '',
        stderr: (err as Error).message,
        durationMs: 0,
        timedOut: false,
        errorMessage: (err as Error).message
      })
      return { ok: false, error: (err as Error).message }
    }
  })

  /** 检测 Python 是否可用 */
  ipc.handle('code:detectPython', async () => {
    const pyExe = await resolvePyExe()
    return detectPythonVersion(pyExe)
  })

  /** 列出所有可用执行器 */
  ipc.handle('code:listExecutors', async () => {
    return { ok: true, executors: getExecutors() }
  })

  /** 添加/更新自定义执行器 */
  ipc.handle('code:upsertExecutor', async (_e, config: import('../services/sandbox-env').ExecutorConfig) => {
    return upsertExecutor(config)
  })

  /** 删除自定义执行器 */
  ipc.handle('code:removeExecutor', async (_e, id: string) => {
    return removeExecutor(id)
  })
}
