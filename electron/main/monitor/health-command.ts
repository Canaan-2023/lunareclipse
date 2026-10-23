/**
 * 健康检查命令执行器（从 health-check.ts 拆出，0.53.10）。
 *
 * 为什么不用 `child_process.exec`：
 * - exec 的 timeout 只终止 shell 自身，Windows 下 cmd.exe 被 kill 后 node/tsc/vitest
 *   子进程仍可能存活（孤儿进程），且无法取得整棵进程树。
 * - 超时与自然退出同时发生时，exec 可能既回调 error 又已完成，结算原因容易混为一谈。
 *
 * 本模块的口径（由 health-command.test.ts 锁定）：
 * - 每种结果都有明确 outcome：pass / fail / timeout / error（`unavailable` 由
 *   health-availability.ts 在执行前判定，命令层不产出）；
 * - timeout 单独标识（timedOut=true），不冒充普通失败；
 * - 超时后按进程树终止（Windows `taskkill /T /F`；POSIX 负 PID 杀进程组）；
 * - `settled` 保证只结算一次，超时后给 close 事件 5 秒宽限，仍未退出则强制结算；
 * - 保留 stdout/stderr/退出码/信号/耗时；输出按 64MB 上限截断并标注。
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { decodeChildOutput, stripAnsi } from './health-output'

/**
 * 单路输出上限：32MB。
 * 依据：全量 vitest 失败输出通常 <1MB，worker 崩溃堆栈 <10MB；32MB 覆盖极端情况，
 * 双流合计 64MB 与旧 exec 的 maxBuffer 口径一致，避免改语义。
 */
const MAX_STREAM_BYTES = 32 * 1024 * 1024

/**
 * 超时后等待 close 的宽限：5s。
 * 依据：taskkill /T /F 本机实测 <500ms；5s 覆盖杀软/EDR 拦截或系统繁忙的慢路径，
 * 同时保证 Promise 一定在 5s 内 settle，不让整轮检查永久卡住。
 */
const KILL_GRACE_MS = 5_000

export type HealthCommandOutcome = 'pass' | 'fail' | 'timeout' | 'error'

export interface HealthCommandResult {
  outcome: HealthCommandOutcome
  /** stdout（成功）或 stdout+stderr（失败/超时/内部错误），已剥离 ANSI */
  output: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  durationMs: number
  /** 结果被截断 / 检查器自身错误的原因（无则为空） */
  note?: string
}

export interface HealthCommandOptions {
  cmd: string
  cwd: string
  timeoutMs: number
  /** 子进程创建后回调（HealthCheck.stop() 据此终止仍在运行的进程树） */
  onSpawn?: (child: ChildProcess) => void
  /** 结算后回调（从活动集合移除） */
  onSettle?: (child: ChildProcess) => void
}

/** 终止整棵进程树（Windows 用 taskkill；POSIX 用进程组）。同步版本供退出链使用。 */
export function killProcessTree(child: ChildProcess, sync = false): void {
  const pid = child.pid
  if (!pid) return
  const fallbackKill = (): void => {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 已退出 */
    }
  }
  if (process.platform === 'win32') {
    // 关键顺序：**不要先 child.kill()**。Windows 上 kill 只终止 cmd.exe 本身，
    // 子进程会被重新挂到别的父进程下，taskkill /T 就再也找不到它们（实测孤儿存活）。
    // 让 taskkill /T /F 先按进程树快照一次性终止；它不可用时才退回 child.kill。
    let ok = true
    try {
      if (sync) {
        const r = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
          // 退出链不能无限阻塞：taskkill 异常时最多等 5s，之后由调用方继续退出流程
          timeout: 5_000
        })
        ok = r.status === 0
      } else {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })
        killer.on('error', fallbackKill)
        // taskkill 正常启动但返回非 0（拒绝访问/进程树不可达）时也要回退直接杀子进程
        killer.on('close', (code) => {
          if (code !== 0) fallbackKill()
        })
      }
    } catch {
      ok = false
    }
    if (!ok) fallbackKill()
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    /* 进程组不存在时退回 child.kill */
  }
  fallbackKill()
}

/** 执行一条检查命令（永不 reject；所有失败都以 outcome 表达） */
export function runHealthCommand(opts: HealthCommandOptions): Promise<HealthCommandResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let settled = false
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let graceTimer: ReturnType<typeof setTimeout> | null = null
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false
    let child: ChildProcess

    try {
      child = spawn(opts.cmd, {
        cwd: opts.cwd,
        shell: true,
        windowsHide: true,
        // POSIX 下 detached 让进程自成一个组，超时可整组 SIGKILL；Windows 不需要。
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      resolve({
        outcome: 'error',
        output: `无法启动检查命令：${(err as Error).message}`,
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        note: (err as Error).message
      })
      return
    }

    opts.onSpawn?.(child)

    // 记录真实退出（close 可能因孙进程持有 stdout 管道而迟到）
    let exited = false
    let exitCode: number | null = null
    let exitSignal: NodeJS.Signals | null = null
    child.once('exit', (code, signal) => {
      exited = true
      exitCode = code
      exitSignal = signal
      // 进程已退出即可从 activeChildren 移除；宽限强制结算时仍保留登记（见 finish 的 keepTracked）
      opts.onSettle?.(child)
    })

    const collect = (target: Buffer[], chunk: Buffer, currentBytes: number): number => {
      if (currentBytes >= MAX_STREAM_BYTES) {
        truncated = true
        return currentBytes
      }
      const remaining = MAX_STREAM_BYTES - currentBytes
      if (chunk.length > remaining) {
        target.push(chunk.subarray(0, remaining))
        truncated = true
        return MAX_STREAM_BYTES
      }
      target.push(chunk)
      return currentBytes + chunk.length
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes = collect(stdout, chunk, stdoutBytes)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes = collect(stderr, chunk, stderrBytes)
    })

    const finish = (
      outcome: HealthCommandOutcome,
      code: number | null,
      signal: NodeJS.Signals | null,
      note?: string,
      keepTracked = false
    ): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      // keepTracked：宽限强制结算时进程可能仍活着，保留在 HealthCheck.activeChildren，
      // 让 stop()/退出链还能再杀一次（不能因为 Promise 结算了就声明「已清理」）。
      if (!keepTracked) opts.onSettle?.(child)

      const out = stripAnsi(decodeChildOutput(Buffer.concat(stdout))).trim()
      const errOut = stripAnsi(decodeChildOutput(Buffer.concat(stderr))).trim()
      const merged = errOut ? (out ? `${out}\n${errOut}` : errOut) : out
      const notes: string[] = []
      if (note) notes.push(note)
      if (truncated) notes.push(`输出超过 ${MAX_STREAM_BYTES / 1024 / 1024}MB，已截断`)
      if (signal) notes.push(`退出信号 ${signal}`)
      if (code != null && code !== 0) notes.push(`退出码 ${code}`)

      resolve({
        outcome,
        output: notes.length > 0 ? `${merged}${merged ? '\n\n' : ''}${notes.join('\n')}` : merged,
        exitCode: code,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        ...(note ? { note } : {})
      })
    }

    timer = setTimeout(() => {
      // 竞态：进程已退出，但 close 被孙进程持有的 stdout 管道拖住。
      // 这种情况按真实退出码结算，不把一次正常完成误报成 timeout。
      if (exited) {
        finish(
          exitCode === 0 ? 'pass' : 'fail',
          exitCode,
          exitSignal,
          '进程已退出；输出管道仍被占用，已提前结算（可能存在脱离的子进程）'
        )
        return
      }
      timedOut = true
      killProcessTree(child)
      // close 事件可能因 taskkill 竞态/子进程忽略信号而迟到：宽限后强制结算，
      // 保证 Promise 一定 settle（不让整轮检查卡死）。keepTracked=true 保留进程登记，
      // 让 stop() 还能再杀一次。
      graceTimer = setTimeout(() => {
        finish(
          'timeout',
          child.exitCode ?? null,
          (child.signalCode ?? null) as NodeJS.Signals | null,
          `命令超时（${opts.timeoutMs / 1000}s）被终止（已请求终止整棵进程树）`,
          true
        )
      }, KILL_GRACE_MS)
    }, opts.timeoutMs)

    child.on('error', (err) => {
      finish('error', null, null, `检查命令启动/运行失败：${err.message}`)
    })

    child.on('close', (code, signal) => {
      if (timedOut) {
        finish('timeout', code, signal, `命令超时（${opts.timeoutMs / 1000}s）被终止（已请求终止整棵进程树）`)
      } else if (code === 0) {
        finish('pass', code, signal)
      } else {
        finish('fail', code, signal)
      }
    })
  })
}
