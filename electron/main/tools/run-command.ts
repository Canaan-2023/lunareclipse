/**
 * 命令执行工具：为什么存在——AI 需要运行 shell 命令（构建/测试/脚本），但任意命令直通是
 * 灾难，必须先经 security-engine 危险检测再做权限决断。
 * 作用：run_command 检测危险命令（硬线拦截/询问/yolo 放行），经全局互斥队列与超时控制后 spawn；
 * 超时有两个来源——本工具内部计时器（timeoutMs）与执行器经 ctx.signal 发来的取消——共用同一
 * killTree 终止子进程树，避免命令在后台残留成孤儿。
 */
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import type { Tool, ToolResult, ToolContext, PermissionResponse } from './base-tool'
import { detect_dangerous_command } from './security-engine/approval'
import { runHeavyExclusive } from './heavy-mutex'

export interface RunCommandToolParams {
  command: string
  cwd?: string
  timeoutMs?: number
}

// 超时默认值（毫秒）
const HEAVY_CMD_TIMEOUT_MS = 180000  // 重型命令（tsc/构建等）
const DEFAULT_CMD_TIMEOUT_MS = 60000 // 普通命令
// 网络类命令：下载时长不可预估，默认给宽松上限而非「不设超时」。
// 此前用 0 表示不启动计时器，子进程一旦挂死（句柄被孙进程持有、close 永不触发）
// 工具调用就永不返回，LLM 工具循环被永久卡住；30 分钟对任何正常下载都足够宽裕。
const NETWORK_CMD_TIMEOUT_MS = 30 * 60_000

// 黑名单：直接拒绝，不询问用户（高危命令）
const BLACKLIST = [
  /\brm\s+-rf\b/i,
  /\bdel\s+\/[fs]/i,
  /\brmdir\s+\/s\b/i,
  /\bformat\s+[a-zA-Z]:/i,
  /\bdiskpart\b/i,
  /\bshutdown\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\breg\s+delete\b/i,
  /\btakeown\s+\/f\b/i,
  /\btaskkill\s+\/(f|pid)/i,
  /\bnet\s+user\b/i,
  /\bnet\s+localgroup\b/i
]

// 白名单：直接执行，不询问用户（安全命令）
// 只读 PowerShell cmdlet 也放行（Get-Content/Select-String 等），
// 避免 AI 自主修复时看日志/搜文件触发权限弹窗轰炸用户
const WHITELIST = [
  'npm', 'node', 'pnpm', 'yarn', 'npx', 'tsc', 'vite',
  'dir', 'ls', 'cat', 'type', 'echo', 'pwd', 'cd', 'mkdir', 'md',
  'where', 'which', 'grep', 'find', 'tasklist', 'systeminfo',
  'ipconfig', 'ping', 'head', 'tail', 'wc',
  'python', 'python3', 'java', 'go', 'rustc', 'cargo',
  // docker/docker-compose 已移出白名单：docker -v 可挂载宿主文件系统绕过路径校验
  // 只读 PowerShell cmdlet（安全：不修改系统状态）
  'get-content', 'get-childitem', 'get-item', 'get-process',
  'get-service', 'select-string', 'test-path', 'get-command',
  'get-help', 'get-date', 'get-location', 'get-psdrive',
  'measure-object', 'where-object', 'sort-object', 'select-object'
]

// 会话级授权缓存：sessionId → Set<commandHash>
// 按会话隔离防止跨会话权限泄漏，按完整命令哈希防止前缀匹配漏洞
const sessionAllowed = new Map<string, Set<string>>()

function getCommandPrefix(command: string): string {
  // 提取命令首词：先去开头 .;/反斜杠（如 .\script.ps1），按空白/管道/&/分号切出首词，
  // 再去路径前缀。顺序关键：必须先 split 再取 basename，否则 Windows 参数里的
  // 反斜杠（Get-Content C:\x.txt 的 C:\）会被 ^.*\\ 贪婪吃掉，首词被截断成 x.txt，
  // 白名单/黑名单全部匹配失败（T6E 测试暴露的现存 bug）。
  const trimmed = command.trim().replace(/^[.;]*\\?/, '')
  const firstWord = trimmed.split(/[\s|&;]+/)[0]
  const basename = firstWord.replace(/^.*[\\/]/, '')
  return basename.replace(/\.(exe|bat|cmd|ps1)$/i, '').toLowerCase()
}

function getCommandHash(command: string): string {
  return createHash('sha256').update(command).digest('hex')
}

function isBlacklisted(command: string): boolean {
  return BLACKLIST.some((re) => re.test(command))
}

function isWhitelisted(command: string): boolean {
  const prefix = getCommandPrefix(command)
  if (!WHITELIST.includes(prefix)) return false
  // 白名单直通只允许「单条简单命令」：不含 shell 链式分隔符或子表达式。
  // 为什么存在：白名单按首词判定，而 PowerShell 中 `echo 1; rm -fr x` 的首词 echo 在白
  // 名单里，分号后的 rm 却是独立命令——直接放行等于把「允许 echo」升级成任意命令执行
  // （真实绕过：删库/删目录命令可完全绕过用户询问，评审 CRITICAL 实测成立）。
  // 作用：含 `;` `&&` `||` `|` `&` 或 `$(` 的命令一律降级为灰名单询问，破坏链式拼接直达。
  // 误拦代价仅是「多一次询问/多一次会话级授权」，安全收益是堵死静默执行。
  return !/[;|&]|\$\s*\(/.test(command)
}

/** 检查命令是否已被该会话授权（完整命令哈希匹配） */
function isSessionAllowed(sessionId: string | undefined, command: string): boolean {
  if (!sessionId) return false
  const set = sessionAllowed.get(sessionId)
  if (!set) return false
  return set.has(getCommandHash(command))
}

/** 记录会话级授权（完整命令哈希） */
function grantSessionAllowed(sessionId: string | undefined, command: string): void {
  if (!sessionId) return
  let set = sessionAllowed.get(sessionId)
  if (!set) {
    set = new Set()
    sessionAllowed.set(sessionId, set)
  }
  set.add(getCommandHash(command))
}

/** 清理指定会话的授权缓存（会话结束时调用） */
export function clearSessionAllowed(sessionId: string): void {
  sessionAllowed.delete(sessionId)
}

// ─── 重型任务识别 + 全局互斥队列 ────────────────────────────────────────────
// 背景：CPU 密集命令（tsc 全量编译、vitest、npm build 等）即使降了优先级，
// 多个并行仍可能把多核打满、饿死主进程事件循环（真实案例：
// 24.6s、12:38 58.5s）。对策：重型命令之间全局串行——同一时刻只允许一个
// 重活执行，其余排队；轻量命令（Read/Grep/echo 等）不排队直接跑。

/** 重型命令模式：匹配 CPU/IO 密集、会长时间占满资源的命令 */
const HEAVY_PATTERNS = [
  /(^|\s)(tsc|tsc\.exe)(\s|$)/,                                    // tsc 直接跑
  /\bnpm\s+run\s+(typecheck|typecheck:node|typecheck:web|build|test|dist)/i,
  /\bnpm\s+(test|run\s+test)\b/i,
  /\b(?:npx\s+)?(vitest|jest)(\s|$)/i,                             // vitest/jest
  /\belectron-vite\s+(build|preview)\b/i,                          // electron-vite build
  /\b(vite|webpack|rollup|esbuild)\s+build\b/i,                    // 前端构建
  /\brun-eval\b/i,                                                 // eval 套件
  /\bpnpm\s+(run\s+)?(build|test)\b/i,
  /\byarn\s+(build|test)\b/i,
  // node/python 脚本执行：AI 批量脚本（清字段/touch/归位）走互斥队列防 CPU 打满
  // （真实案例：node 批量脚本 + 同步回填 IO 风暴 → eventloop 阻塞 19.3s）
  // 注意：--version/-v/--help 等轻量探测不匹配以下模式，不排队
  /\bnode\s+[\w./\\-]*(?:\.(?:js|mjs|cjs|ts))\b/i, // node script.js / node ./tools/x.ts
  /\bnode\s+-[ec]\b/i,                                             // node -e "code" 内联执行
  /\b(?:python|python3|py)\s+[\w./\\-]*\.py\b/i, // python script.py
  /\b(?:python|python3|py)\s+-c\b/i                                // python -c "code" 内联执行
]

/** 判断命令是否为重型任务（需要全局互斥串行） */
export function isHeavyCommand(command: string): boolean {
  return HEAVY_PATTERNS.some((re) => re.test(command))
}

// ─── 网络类命令识别（长超时） ─────────────────────────────────────────────
// 背景：curl/wget/npm install 等网络 IO 命令受网速影响，慢时远超默认 60s，
// 会被超时 SIGKILL 误杀（真实案例：下载 jsdelivr 资源反复超时）。
// 网络命令不占 CPU（不进互斥队列），但需要更长超时。
const NETWORK_PATTERNS = [
  /^curl\b/i,
  /^wget\b/i,
  /\bInvoke-WebRequest\b/i,
  /\bInvoke-RestMethod\b/i,
  /\bnpm\s+(install|i|ci|pack)\b/i,
  /\bpnpm\s+(install|i|add|fetch)\b/i,
  /\byarn\s+(add|install)\b/i,
  /\bpip\s+install\b/i,
  /\bnpx\s+\S*download/i
]

/** 判断命令是否为网络类命令（需要长超时，不排队） */
export function isNetworkCommand(command: string): boolean {
  return NETWORK_PATTERNS.some((re) => re.test(command))
}

/**
 * 后台无交互场景的命令安全判定（workflow HOOK 等复用）
 * 为什么存在：workflow 模板可由 AI 通过 workflow_define 全自动创建、workflow_run 触发执行，
 * HOOK 的 command 类型此前直接 execFile 任意命令，绕过了 run_command 的黑名单/白名单/灰名单
 * 审批语义——等于给 AI 一条无询问的任意命令执行通道（威胁等级：CRITICAL，实测可注入
 * `del /s /q`、任意脚本等）。作用：把 HOOK 命令纳入与 run_command 相同的判定规则，
 * 灰名单命令因后台通道无用户授权回调、一律拒绝；仅白名单简单命令可执行。
 * 不删掉的理由：workflow HOOK 有合法诉求（如只读钩子、节点前后跑轻量校验），
 * 一刀切禁掉会破坏模板能力；固化两处共用同一判定源可防止规则漂移。
 */
export function assessCommandForBackgroundExec(
  command: string,
  args: string[] = []
): { allowed: boolean; reason: string } {
  // 拼回完整命令行以便复用黑名单/危险模式正则（它们匹配整串而非首词）
  const full = args.length > 0 ? `${command} ${args.join(' ')}` : command

  // 1. 黑名单直接拒绝（高危操作，如 del /s /q、format 等）
  if (isBlacklisted(full)) {
    return { allowed: false, reason: `HOOK 命令命中黑名单（高危操作已拒绝）: ${full}` }
  }

  // 2. 复用危险命令检测：critical/high/exec_flag 全部拒绝。
  // 与 run_command 的区别：run_command 对 high/exec_flag 可降级为询问用户，
  // 而 HOOK 在后台无 requestPermission 回调，无法询问，故一律不放行。
  const dangerFindings = detect_dangerous_command(full)
  if (dangerFindings.some((f) => f.severity === 'critical' || f.severity === 'high' || f.type === 'exec_flag')) {
    const msg = dangerFindings[0].message
    return { allowed: false, reason: `HOOK 命令命中危险检测（${msg}）: ${full}` }
  }

  // 3. 灰名单命令（不在白名单）拒绝：无授权通道的自动化场景不执行需用户确认的命令。
  // 用户如确需运行，应改用 run_command（有审批交互）或把命令放进模板的 tool 节点。
  if (!isWhitelisted(full)) {
    return { allowed: false, reason: `HOOK 命令不在白名单（后台无授权通道，灰名单命令不能自动执行）: ${full}` }
  }

  return { allowed: true, reason: '' }
}

export class RunCommandTool implements Tool<RunCommandToolParams> {
  name = 'run_command'
description =
    '执行 Windows 系统命令（PowerShell），返回 stdout/stderr/exitCode。command 必填；cwd=工作目录（可选）；timeoutMs 可选，默认：网络类 1800000 / 重型 180000 / 其余 60000。危险命令直接拒绝，安全命令直接执行，其余命令需用户确认。'
  parameters = [
    { name: 'command', type: 'string' as const, description: '要执行的命令（PowerShell 兼容）', required: true },
    { name: 'cwd', type: 'string' as const, description: '工作目录（绝对路径，可选）', required: false },
    { name: 'timeoutMs', type: 'number' as const, description: '超时毫秒（可选；网络类命令默认 1800000，重型命令默认 180000，其余 60000）', required: false }
  ]

  async execute(params: RunCommandToolParams, ctx?: ToolContext): Promise<ToolResult> {
    if (!params.command || params.command.trim().length === 0) {
      return { ok: false, error: 'command 不能为空' }
    }

    const command = params.command.trim()
    const isHeavy = isHeavyCommand(command)
    const isNetwork = isNetworkCommand(command)
    // 重型命令默认给更长超时（tsc 全量编译可能超 60s），防止被默认 60s 误杀
    // 网络类命令给宽松上限（下载时长不可预估，jsdelivr/npm 慢时远超 60s），
    // 需要限制时由调用方显式传 timeoutMs 覆盖
    const timeoutMs =
      params.timeoutMs && params.timeoutMs > 0
        ? params.timeoutMs
        : isHeavy
          ? HEAVY_CMD_TIMEOUT_MS
          : isNetwork
            ? NETWORK_CMD_TIMEOUT_MS
            : DEFAULT_CMD_TIMEOUT_MS
    const sessionId = ctx?.sessionId ?? undefined

    // 1. 黑名单直接拒绝
    if (isBlacklisted(command)) {
      return { ok: false, error: `命令命中黑名单（高危操作已拒绝）: ${command}` }
    }

    // 1.5 危险命令检测（detect_dangerous_command）：
    // critical（hardline：删根/删系统目录/sudo stdin/自我终止等）→ 直接拒绝，等同黑名单；
    // high（危险模式：破坏性删除/管道执行远程内容等）→ 强制询问，
    // 即使是白名单命令也降级询问（堵 M3 绕过面：PowerShell 原生命令、白名单首词拼接）
    const dangerFindings = detect_dangerous_command(command)
    const hardline = dangerFindings.find((f) => f.severity === 'critical')
    if (hardline) {
      return { ok: false, error: `命令命中危险检测（${hardline.message}）: ${command}` }
    }
    const highFindings = dangerFindings.filter((f) => f.severity === 'high')
    // exec_flag（warning 级：bash -c / python -c / perl -e 等解释器内联代码）不直接拒绝，
    // 但必须降级为询问——白名单首词（python/node）加 -c 内联代码等于是任意命令执行，
    // 静默直通与「白名单只能单条简单命令」的约束矛盾（评审确认：`python -c "os.remove(...)"`
    // 可直接绕过询问）。改用询问 + 会话级授权，既不打断正常用法又堵住静默执行。
    const execFlagFindings = dangerFindings.filter((f) => f.type === 'exec_flag')

    // 2. 白名单 + 无高危模式 → 直接执行；灰名单/命中高危模式/解释器内联代码 → 需用户授权
    // 3. 会话级授权缓存（完整命令哈希匹配）
    const needsApproval =
      !isWhitelisted(command) || highFindings.length > 0 || execFlagFindings.length > 0
    if (needsApproval && !isSessionAllowed(sessionId, command)) {
      if (!ctx?.requestPermission) {
        return { ok: false, error: '灰名单命令需要用户授权，但 requestPermission 未初始化' }
      }
      const riskDepth = highFindings.length > 0 ? 'high' : execFlagFindings.length > 0 ? 'medium' : this.assessRisk(command)
      const riskNote = highFindings.length > 0
        ? `命中危险模式: ${highFindings[0].message}`
        : execFlagFindings.length > 0
          ? `解释器内联代码执行（${execFlagFindings[0].interpreter || '?'} ${execFlagFindings[0].flag}）`
          : ''
      const req = {
        type: 'command' as const,
        description: riskNote ? `执行命令（${riskNote}）: ${command}` : `执行命令: ${command}`,
        content: command,
        risk: riskDepth,
        timeoutMs: 30000
      }
      const resp: PermissionResponse = await ctx.requestPermission(req)
      if (!resp.allowed) {
        return { ok: false, error: `用户拒绝执行命令: ${resp.reason ?? '无原因'}` }
      }
      // 会话级授权：记录完整命令哈希，本次会话内相同命令不再询问
      if (resp.scope === 'session') {
        grantSessionAllowed(sessionId, command)
      }
    }

    // 4. 执行命令（PowerShell，子进程降为 BelowNormal 优先级）
// 防止 CPU 密集命令（tsc/npm build 等）饿死 Electron 主进程事件循环
    // ——真实案例：tsc 全量编译把 UI 卡死 24.6s（事件循环延迟）
    const run: () => Promise<ToolResult> = () => new Promise((resolve) => {
      // 外层取消信号：执行器（如 llm.ts 对话保护墙）超时 abort 时终止子进程，
      // 而不是把它留成无人回收的孤儿。非前端路径（DMN/workflow）可能不注入 signal，由内部计时器兜底。
      const signal = ctx?.signal
      if (signal?.aborted) {
        resolve({ ok: false, error: '命令被取消（执行前信号已中止）' })
        return
      }
      const prioPrefix = "[System.Diagnostics.Process]::GetCurrentProcess().PriorityClass='BelowNormal';"
      // 命令首字符为 # 时是 PowerShell 注释，不拼接 prioPrefix 避免被注释吞掉
      const isComment = command.startsWith('#')
      const args = ['-NoProfile', '-Command', isComment ? command : `${prioPrefix} ${command}`]
      const child = spawn('powershell.exe', args, {
        cwd: params.cwd || undefined,
        windowsHide: true,
        env: { ...process.env, LANG: 'zh-CN.UTF-8' }
      })

      let stdout = ''
      let stderr = ''
      let timedOut = false
      let cancelled = false
      let settled = false
      const finish = (r: ToolResult): void => {
        if (settled) return
        settled = true
        resolve(r)
      }
      // 杀整个进程树（powershell 壳 + 其子进程），两个触发源共用同一动作：
      // ① 本工具内部计时器到 timeoutMs；② 执行器经 ctx.signal 发来的取消。
      // 为什么杀树（/T /F）：curl/npm 的子进程会持有句柄，只杀壳会让真正的重活在后台残留成孤儿。
      const killTree = (): void => {
        try {
          spawn('taskkill.exe', ['/pid', String(child.pid ?? ''), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore'
          })
        } catch { /* ignore */ }
        try { child.kill('SIGKILL') } catch { /* ignore */ }
      }
      // timeoutMs 恒 > 0（网络类命令也有 30 分钟上限），始终启动计时器
      const timer = setTimeout(() => {
        timedOut = true
        killTree()
      }, timeoutMs)

      const onAbort = (): void => {
        cancelled = true
        clearTimeout(timer)
        killTree()
        // 取消是外层超时的结果，尽快返回，不等子进程 close（避免取消路径再被拖住）
        finish({ ok: false, error: `命令被取消（外层超时）已终止。部分输出：\nstdout: ${stdout}\nstderr: ${stderr}` })
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      child.stdout.on('data', (d) => { stdout += d.toString('utf-8') })
      child.stderr.on('data', (d) => { stderr += d.toString('utf-8') })

      child.on('close', (code) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (cancelled) {
          finish({ ok: false, error: `命令被取消（外层超时）已终止。部分输出：\nstdout: ${stdout}\nstderr: ${stderr}` })
          return
        }
        if (timedOut) {
          finish({ ok: false, error: `命令超时（${timeoutMs}ms）被终止。部分输出：\nstdout: ${stdout}\nstderr: ${stderr}` })
          return
        }
        finish({
          ok: true,
          data: {
            command,
            exitCode: code ?? 0,
            stdout,
            stderr
          }
        })
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        finish({ ok: false, error: `启动命令失败: ${err.message}` })
      })
    })

    // 重型命令走全局互斥队列：同一时刻只允许一个重活，其余排队（削 CPU 峰值）
    // 真实案例：并行跑 tsc + 全量测试把 UI 卡死 58.5s（事件循环延迟）
    if (isHeavy) {
      return runHeavyExclusive(run)
    }
    return run()
  }

  private assessRisk(command: string): 'low' | 'medium' | 'high' {
    const prefix = getCommandPrefix(command)
    // 高风险：注册表、用户管理、服务、网络配置
    if (/reg\s+(add|delete|import)/i.test(command) || /\bnet\s+(user|localgroup|start)/i.test(command)) {
      return 'high'
    }
    // 中风险：文件删除、移动、覆盖、安装包
    if (/(\bdel\b|\berase\b|\bmove\b|\bcopy\b|\bxcopy\b|\brobocopy\b)/i.test(command) || /\b(install|iex|invoke)/i.test(prefix)) {
      return 'medium'
    }
    return 'low'
  }
}
