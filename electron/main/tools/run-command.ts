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
import { isRedirectWriteIntent } from './security-engine/command-readonly'
import { parseSedEditCommand } from './security-engine/sed-edit-parser'
import { runHeavyExclusive } from './heavy-mutex'
import type { CommandPolicy, CommandPolicyRule } from '@shared/types/command-policy'

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
// 权限请求弹窗等待上限：用户不响应即超时返回拒绝，避免 LLM 工具循环无限挂起
const PERMISSION_REQUEST_TIMEOUT_MS = 30000
// stdout/stderr 物理累积上限：防失控命令无限输出打爆内存（对齐全局 150K 结果上限）；
// 超限丢弃后续输出并置 truncated=true，保住程序可观测性的同时约住内存
const MAX_OUTPUT_CHARS = 150_000
// timeoutMs 上限：1 小时。防御超长传入——setTimeout 超过 2^31-1ms 会立即触发，
// 传给命令的"超时"反而瞬时生效；同时限制极端值让超时语义与文档口径一致
const TIMEOUT_MS_MAX = 3_600_000

// ─── 默认黑白名单（可配置规则层的基线）──────────────────────────────────────
// 为什么分层：默认清单是「高危拦截/信任直行」的内置基线，用户通过配置 CommandPolicy
// 追加/移除（见 shared/types/command-policy.ts）。设计约束：黑名单只增不减（默认高危
// 黑名单与 security-engine 硬防线不可被配置移除）、白名单可增可减、只读自动放行默认
// 关闭、危险检测永远优先。resolveCommandPolicy 是唯一解析入口，run_command 与后台
// HOOK 门闸共用同一判定源，防止规则漂移。

// 黑名单：直接拒绝，不询问用户（高危命令）
const DEFAULT_BLACKLIST: RegExp[] = [
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
const DEFAULT_WHITELIST: string[] = [
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

// 语义只读命令清单：autoAllowReadonly 开启时这些命令免灰名单询问。
// 与白名单的关系：白名单只看「命令名在白名单 + 单条简单命令」；只读清单是「可确认
// 无副作用」的语义声明，默认不放开（autoAllowReadonly=false，行为与改造前完全一致）。
// 危险检测永远优先：命中 critical/high/exec_flag 的命令即使语义只读也必须询问/拒绝。
const DEFAULT_READONLY_COMMANDS: string[] = [
  'dir', 'ls', 'cat', 'type', 'pwd', 'echo', 'where', 'which',
  'grep', 'find', 'head', 'tail', 'wc', 'tasklist', 'systeminfo', 'ipconfig',
  'get-content', 'get-childitem', 'get-item', 'get-process',
  'get-service', 'select-string', 'test-path', 'get-command',
  'get-help', 'get-date', 'get-location', 'get-psdrive',
  'measure-object', 'where-object', 'sort-object', 'select-object'
]

/** 解析后的生效命令策略（默认基线 + 配置合并，run_command 与后台 HOOK 共用） */
export interface ResolvedCommandPolicy {
  blacklist: RegExp[]
  whitelist: Set<string>
  readonlyCommands: Set<string>
  autoAllowReadonly: boolean
  /** 管理规则层（优先级高于 userSettings 与 builtin 基线；危险检测/黑名单硬防线永远优先） */
  policyRules: CommandPolicyRule[]
}

/** 归一化配置中的命令名（小写、去扩展名，与 getCommandPrefix 的语义一致） */
function normalizeConfiguredName(name: string): string {
  return name.trim().toLowerCase().replace(/\.(exe|bat|cmd|ps1)$/i, '')
}

/** 编译用户追加的黑名单正则（非法正则降级忽略并告警，不阻塞工具） */
function compileExtraBlacklist(patterns: string[] | undefined): RegExp[] {
  if (!patterns || patterns.length === 0) return []
  const out: RegExp[] = []
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, 'i'))
    } catch {
      console.warn(`[run-command] 忽略非法黑名单正则: ${p}`)
    }
  }
  return out
}

/**
 * 从上下文配置解析生效的命令策略（默认基线 + CommandPolicy 追加/移除）。
 * ctx 缺省或未配置 commandPolicy 时返回纯默认策略（与改造前行为逐字节等价）。
 */
export function resolveCommandPolicy(ctx?: ToolContext): ResolvedCommandPolicy {
  const cfg = (ctx?.config ?? {}) as { commandPolicy?: CommandPolicy }
  const p = cfg.commandPolicy ?? {}
  const remove = new Set((p.removeWhitelist ?? []).map(normalizeConfiguredName))
  const extraWhitelist = (p.extraWhitelist ?? []).map(normalizeConfiguredName)
  const extraReadonly = (p.extraReadonly ?? []).map(normalizeConfiguredName)
  return {
    blacklist: [...DEFAULT_BLACKLIST, ...compileExtraBlacklist(p.extraBlacklist)],
    whitelist: new Set([...DEFAULT_WHITELIST.filter((w) => !remove.has(w)), ...extraWhitelist]),
    readonlyCommands: new Set([...DEFAULT_READONLY_COMMANDS, ...extraReadonly]),
    autoAllowReadonly: p.autoAllowReadonly === true,
    policyRules: p.policyRules ?? []
  }
}

// 会话级授权缓存：sessionId → Set<commandHash>
// 按会话隔离防止跨会话权限泄漏，按完整命令哈希防止前缀匹配漏洞
const sessionAllowed = new Map<string, Set<string>>()

// ─── 安全探测工具分类 ────────────────────────────────────────────────
// 为什么存在：nmap/nuclei/ssh 等不是高危命令（黑名单），不在白名单 → 天然走灰名单审批，
// 无需改 security-engine。但它们与其他灰名单命令不同：对目标网络/服务/凭据的主动探测
// 会被目标侧记录、触发告警，审批时必须显式提示「目标需已授权」，让用户做知情判断
// （配合会话级授权一次通过）。结构：匹配模式 → 分类标签（审批风险提示用）。
const SECURITY_TOOL_LABELS: Array<[RegExp, string]> = [
  [/\bnmap\b/i, '端口/服务扫描'],
  [/\bnuclei\b/i, '漏洞模板扫描'],
  [/\b(?:hydra|medusa|patator|crowbar)\b/i, '口令/凭据爆破'],
  [/\b(?:msfconsole|msfvenom|metasploit)\b/i, '漏洞利用框架'],
  [/\bsearchsploit\b/i, '漏洞库检索'],
  [/\b(?:sqlmap|sqlninja)\b/i, 'SQL 注入探测'],
  [/\b(?:netcat|nc|ncat)\b/, '网络连接工具'],
  [/\bsshpass\b/i, 'ssh 凭据自动化'],
  [/\b(?:ssh|scp|sftp)\b/i, '远程连接']
]

/** 命中安全探测工具则返回其分类标签（审批风险提示用），否则返回 null */
export function getSecurityToolLabel(command: string): string | null {
  for (const [re, label] of SECURITY_TOOL_LABELS) {
    if (re.test(command)) return label
  }
  return null
}

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

function isBlacklisted(command: string, policy: ResolvedCommandPolicy): boolean {
  return policy.blacklist.some((re) => re.test(command))
}

/**
 * 匹配命令命中的管理规则（命令前缀 + 可选参数子串）。
 * 为什么裁决取最严动作：管理员显式写 `deny npm install xxx` 时，即使更早出现
 * `allow npm` 也不允许把拒绝覆盖掉——安全优先，避免规则顺序决定安全边界。
 * 规则匹配：command 按命令首词小写匹配（'*' 匹配所有命令，大小写不敏感）；
 * argPattern 在完整命令行内做大小写不敏感子串匹配。
 */
export function matchPolicyRule(
  command: string,
  policy: ResolvedCommandPolicy
): CommandPolicyRule | null {
  if (policy.policyRules.length === 0) return null
  const prefix = getCommandPrefix(command)
  const lowerCommand = command.toLowerCase()
  let deny: CommandPolicyRule | null = null
  let ask: CommandPolicyRule | null = null
  let allow: CommandPolicyRule | null = null
  for (const rule of policy.policyRules) {
    const cmdPattern = rule.command.trim().toLowerCase()
    if (cmdPattern !== '*' && cmdPattern !== prefix) continue
    if (rule.argPattern && !lowerCommand.includes(rule.argPattern.toLowerCase())) continue
    if (rule.action === 'deny') deny ??= rule
    else if (rule.action === 'ask') ask ??= rule
    else allow ??= rule
  }
  return deny ?? ask ?? allow
}

/** 限制「白名单/只读自动放行」都只作用于单条简单命令：不含 shell 链式分隔符或子表达式。
 * 为什么存在：白名单按首词判定，而 PowerShell 中 `echo 1; rm -fr x` 的首词 echo 在白
 * 名单里，分号后的 rm 却是独立命令——直接放行等于把「允许 echo」升级成任意命令执行
 * （真实绕过：删库/删目录命令可完全绕过用户询问，评审 CRITICAL 实测成立）。
 * 作用：含 `;` `&&` `||` `|` `&` 或 `$(` 的命令一律降级为灰名单询问，破坏链式拼接直达。
 * 误拦代价仅是「多一次询问/多一次会话级授权」，安全收益是堵死静默执行。 */
function isSimpleCommand(command: string): boolean {
  return !/[;|&]|\$\s*\(/.test(command)
}

function isWhitelisted(command: string, policy: ResolvedCommandPolicy): boolean {
  const prefix = getCommandPrefix(command)
  if (!policy.whitelist.has(prefix)) return false
  return isSimpleCommand(command)
}

/** 语义只读判别：命令名在只读清单中且是单条简单命令（autoAllowReadonly 开启时免审） */
function isSemanticReadonly(command: string, policy: ResolvedCommandPolicy): boolean {
  const prefix = getCommandPrefix(command)
  if (!policy.readonlyCommands.has(prefix)) return false
  return isSimpleCommand(command)
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
  args: string[] = [],
  policy?: ResolvedCommandPolicy
): { allowed: boolean; reason: string } {
  // 拼回完整命令行以便复用黑名单/危险模式正则（它们匹配整串而非首词）
  const full = args.length > 0 ? `${command} ${args.join(' ')}` : command
  // 默认使用内置基线策略（ctx 缺省 = 与改造前行为一致）；装配方传入
  // resolveCommandPolicy(ctx) 的结果即可让 HOOK 通道跟随用户配置（防规则漂移）。
  const p = policy ?? resolveCommandPolicy(undefined)

  // 1. 黑名单直接拒绝（高危操作，如 del /s /q、format 等）
  if (isBlacklisted(full, p)) {
    return { allowed: false, reason: `HOOK 命令命中黑名单（高危操作已拒绝）: ${full}` }
  }

  // 1.5 管理规则层（与 run_command 共用 matchPolicyRule，防规则漂移）：
  // deny 拒绝；ask 后台无授权通道 fail-closed 拒绝；allow 放行灰名单（危险检测仍优先）。
  const policyRule = matchPolicyRule(full, p)
  if (policyRule?.action === 'deny') {
    const note = policyRule.note ? `（${policyRule.note}）` : ''
    return { allowed: false, reason: `HOOK 命令命中管理拒绝规则${note}: ${full}` }
  }
  if (policyRule?.action === 'ask') {
    return { allowed: false, reason: `HOOK 命令命中管理询问规则，后台无授权通道不能自动执行: ${full}` }
  }
  const policyAllow = policyRule?.action === 'allow'

  // 2. 复用危险命令检测：critical/high/exec_flag 全部拒绝。
  // 与 run_command 的区别：run_command 对 high/exec_flag 可降级为询问用户，
  // 而 HOOK 在后台无 requestPermission 回调，无法询问，故一律不放行。
  const dangerFindings = detect_dangerous_command(full)
  if (dangerFindings.some((f) => f.severity === 'critical' || f.severity === 'high' || f.type === 'exec_flag')) {
    const msg = dangerFindings[0].message
    return { allowed: false, reason: `HOOK 命令命中危险检测（${msg}）: ${full}` }
  }

  // 2.5 sed -i 原地编辑危险表达式：与 run_command 相同判定（参数级解析）
  const sedParse = parseSedEditCommand(full)
  if (sedParse.inPlace && sedParse.dangerous) {
    return { allowed: false, reason: `HOOK 命令命中 sed 原地编辑危险表达式（${sedParse.reason ?? '未知'}）: ${full}` }
  }

  // 2.75 重定向/管道写意图：与 run_command 主通道同一判定源（防规则漂移）——
  // `echo hi > config.txt` 这类白名单命令带写重定向，后台无授权通道不能自动执行；
  // 命令自带写标志（npm install / curl -o / git add）按命令语义处理：
  // 白名单命令照常放行、灰名单命令拒绝，与主通道行为一致。
  if (isRedirectWriteIntent(full)) {
    return { allowed: false, reason: `HOOK 命令含写重定向，后台无授权通道不能自动执行: ${full}` }
  }

  // 3. 灰名单命令（不在白名单且无管理 allow）拒绝：无授权通道的自动化场景
  // 不执行需用户确认的命令。用户如确需运行，应改用 run_command（有审批交互）
  // 或把命令放进模板的 tool 节点；管理规则 allow 可显式信任特定灰名单命令。
  if (!policyAllow && !isWhitelisted(full, p)) {
    return { allowed: false, reason: `HOOK 命令不在白名单（后台无授权通道，灰名单命令不能自动执行）: ${full}` }
  }

  return { allowed: true, reason: '' }
}

export class RunCommandTool implements Tool<RunCommandToolParams> {
  name = 'run_command'
description =
    '执行 Windows 系统命令（PowerShell），返回 stdout/stderr/exitCode。command 必填；cwd=工作目录（可选）；timeoutMs 可选（毫秒，上限 3600000），默认：网络类 1800000 / 重型 180000 / 其余 60000。危险命令直接拒绝，安全命令直接执行，其余命令需用户确认。nmap/nuclei/ssh 等安全探测工具属灰名单：审批时会提示目标需已授权，确认后本次会话内同命令不再重复询问。'
  parameters = [
    { name: 'command', type: 'string' as const, description: '要执行的命令（PowerShell 兼容）', required: true },
    { name: 'cwd', type: 'string' as const, description: '工作目录（绝对路径，可选）', required: false },
    { name: 'timeoutMs', type: 'number' as const, description: '超时毫秒（可选，最大 3600000；网络类命令默认 1800000，重型命令默认 180000，其余 60000）', required: false }
  ]

  // 行为声明：结果上限 50K——命令输出（构建日志/测试输出/大文件预览）常远超上下文承载，
  // 执行器据此先落盘再返回摘要与路径（配合 stdout/stderr 物理上限 MAX_OUTPUT_CHARS 双保险）
  behavior = {
    resultLimitChars: 50_000
  }

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
    // 显式 timeoutMs 由调用方给出（正数才认可），否则按命令类型取默认；统一 clamp 到
    // TIMEOUT_MS_MAX 上限（见常量定义：防 setTimeout 溢出/极端值瞬时触发）
    const timeoutMs = Math.min(
      params.timeoutMs && params.timeoutMs > 0
        ? params.timeoutMs
        : isHeavy
          ? HEAVY_CMD_TIMEOUT_MS
          : isNetwork
            ? NETWORK_CMD_TIMEOUT_MS
            : DEFAULT_CMD_TIMEOUT_MS,
      TIMEOUT_MS_MAX
    )
    const sessionId = ctx?.sessionId ?? undefined
    // 可配置规则层：默认基线 + config.commandPolicy 追加/移除（黑名单只增不减、只读自动放行默认关）
    const policy = resolveCommandPolicy(ctx)

    // 1. 黑名单直接拒绝（含用户配置追加的黑名单）
    if (isBlacklisted(command, policy)) {
      return { ok: false, error: `命令命中黑名单（高危操作已拒绝）: ${command}` }
    }

    // 1.25 管理规则层（policyRules，管理级 > userSettings > builtin 基线）：
    // deny 直接拒绝；ask 强制询问（即使白名单/只读自动放行面内）；
    // allow 放行灰名单命令（管理员显式信任）。危险检测/黑名单永远优先于本层，
    // 不能通过 allow 放行高危命令（下文 high/critical 检查在 policyAllow 生效前先裁决）。
    const policyRule = matchPolicyRule(command, policy)
    if (policyRule?.action === 'deny') {
      const note = policyRule.note ? `（${policyRule.note}）` : ''
      return { ok: false, error: `命令命中管理拒绝规则${note}: ${command}` }
    }
    const policyAsk = policyRule?.action === 'ask'
    const policyAllow = policyRule?.action === 'allow'

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

    // 1.75 sed -i 原地编辑参数级解析：命中危险编辑（行删除/插入/控制字符注入/命令替换）
    // 直接拒绝。为什么需要参数级解析：sed 不带 -i 是只读、带 -i 是原地写，命令名级
    // 黑名单/白名单无法区分；内联脚本（s/old/new/、/pat/d）还可能隐含破坏性表达式，
    // 命中即等同 hardline 拦截（对应工具层改造方案 M4 的 sedEditParser 接入）。
    const sedParse = parseSedEditCommand(command)
    if (sedParse.inPlace && sedParse.dangerous) {
      return {
        ok: false,
        error: `sed 原地编辑命中危险表达式（${sedParse.reason ?? '未知'}）: ${command}`
      }
    }

    // 2. 白名单/语义只读 + 无高危模式 → 直接执行；灰名单/命中高危模式/解释器内联代码 → 需用户授权。
    // 只读自动放行（autoAllowReadonly）只豁免「语义只读 + 单条简单命令」的灰名单询问；
    // 危险检测永远优先——命中 high/exec_flag 的命令不受只读豁免（阻止把只读名当外壳
    // 拼接破坏操作）；白名单只读 cmdlet 的直行不受此开关影响（现有行为保留）。
    // 只读自动放行还需通过参数级写意图判别（isReadonlyCommand）：
    // `echo hi > config.txt`、`curl -o a.url ...` 命令名虽只读，参数含写重定向/写标志，
    // 不能享受 autoAllowReadonly 免审（对应工具层改造方案 M4 的 readOnlyValidation 接入）。
    // 参数级写意图判别：命令名只读/白名单不代表参数无写意图——
    // `echo hi > config.txt`（写重定向）等必须降级询问，不能因白名单/只读自动放行
    // 而静默直行（对应工具层改造方案 M4 的 readOnlyValidation 接入）。
    // 范围界定：只判别「重定向/管道写」这类把任意白名单命令升级为写文件的形态；
    // 命令自带写标志（npm install / curl -o / git add）由命令语义承担——白名单命令
    // 保持基线直行（M4「默认行为不变」），灰名单命令走询问，两者均不额外升级。
    const writableIntent = isRedirectWriteIntent(command)
    const readonlyAutoAllow =
      policy.autoAllowReadonly &&
      highFindings.length === 0 &&
      execFlagFindings.length === 0 &&
      isSemanticReadonly(command, policy) &&
      !writableIntent
    // 3. 会话级授权缓存（完整命令哈希匹配）
    // policyAsk 强制询问（即使白名单/只读自动放行面内）；policyAllow 只放行灰名单普通命令，
    // 写意图与高危/内联代码强制执行——不能通过 allow 放行 `find -exec rm`（危险检测硬防线优先）；
    // 白名单命令命中写意图同样降级询问（堵 `echo hi > config.txt` 静默写文件通道）。
    const needsApproval =
      policyAsk ||
      highFindings.length > 0 ||
      execFlagFindings.length > 0 ||
      writableIntent ||
      (!policyAllow && !readonlyAutoAllow && !isWhitelisted(command, policy))
    if (needsApproval && !isSessionAllowed(sessionId, command)) {
      if (!ctx?.requestPermission) {
        // 自动化通道（子 agent / 批量 / 工作流）：主对话前端才有 requestPermission 回调。
        // ① 命中 high 危险模式的命令：保持强约束一律拒绝（不因走策略裁决而放宽安全边界）；
        // ② 其余灰名单命令：若装配了子 agent 审批裁决器，按工具策略裁决——
        //    allow 放行并授予会话授权；ask 无父级可问 → fail-closed 拒绝；
        // ③ 未装配裁决器 → 维持原有拒绝，不静默放行。
        if (highFindings.length > 0) {
          return {
            ok: false,
            error: `命令命中危险模式，自动化通道拒绝执行: ${command}`
          }
        }
        // 管理规则 ask：自动化通道无父级用户可询问 → fail-closed 拒绝
        if (policyAsk) {
          const note = policyRule?.note ? `（${policyRule.note}）` : ''
          return {
            ok: false,
            error: `命令命中管理询问规则${note}，自动化通道不能代为确认: ${command}`
          }
        }
        const approval = ctx?.getSubAgentApproval?.()
        if (approval) {
          const securityLabel = getSecurityToolLabel(command)
          const verdict = approval.resolveByPolicy('automation', 'automation', 'run_command', {
            command,
            risk: execFlagFindings.length > 0 ? 'medium' : this.assessRisk(command),
            ...(securityLabel ? { securityTool: securityLabel } : {})
          })
          if (verdict.status === 'approved') {
            grantSessionAllowed(sessionId, command)
          } else {
            const why = verdict.reason ? `（${verdict.reason}）` : ''
            return {
              ok: false,
              error: `自动化通道未获授权执行命令${why}: ${command}`
            }
          }
        } else {
          return { ok: false, error: '灰名单命令需要用户授权，但 requestPermission 未初始化' }
        }
      } else {
        const riskDepth = highFindings.length > 0 ? 'high' : execFlagFindings.length > 0 ? 'medium' : this.assessRisk(command)
        const riskNote = highFindings.length > 0
          ? `命中危险模式: ${highFindings[0].message}`
          : execFlagFindings.length > 0
            ? `解释器内联代码执行（${execFlagFindings[0].interpreter || '?'} ${execFlagFindings[0].flag}）`
            : ''
        // 安全探测工具（nmap/nuclei/ssh 等）：审批时显式提示目标需已授权，
        // 与普通灰名单命令区分——主动扫描会被目标侧记录，用户需知情确认
        const securityLabel = getSecurityToolLabel(command)
        const securityNote = securityLabel
          ? `（${securityLabel}，请确认目标已授权）`
          : ''
        // 管理规则 ask：询问描述附带管理员备注，提示用户这是管理策略要求的确认
        const policyAskNote = policyAsk && policyRule?.note ? `；管理规则：${policyRule.note}` : ''
        const req = {
          type: 'command' as const,
          description: riskNote
            ? `执行命令（${riskNote}${securityNote}${policyAskNote}）: ${command}`
            : `执行命令${securityNote}${policyAskNote}: ${command}`,
          content: command,
          risk: riskDepth,
          timeoutMs: PERMISSION_REQUEST_TIMEOUT_MS
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
    }

    // 4. 执行命令（PowerShell，子进程降为 BelowNormal 优先级）
// 防止 CPU 密集命令（tsc/npm build 等）饿死 Electron 主进程事件循环
    // ——真实案例：tsc 全量编译把 UI 卡死 24.6s（事件循环延迟）
    const run: () => Promise<ToolResult> = () => new Promise((resolve) => {
      // 外层取消信号：执行器（如 llm.ts 对话保护墙）超时 abort 时终止子进程，
      // 而不是把它留成无人回收的孤儿。非前端路径（记忆工作流/workflow）可能不注入 signal，由内部计时器兜底。
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
      let stdoutTruncated = false
      let stderrTruncated = false
      let timedOut = false
      let cancelled = false
      let settled = false
      const finish = (r: ToolResult): void => {
        if (settled) return
        settled = true
        resolve(r)
      }
      // 输出物理上限：stdout/stderr 各最多保留 MAX_OUTPUT_CHARS 字符，超出丢弃并置截断标记。
      // 为什么必须硬截断：失控命令（构建日志/测试输出）可无限增长，全量累积会拖垮内存；
      // 成功路径由 behavior.resultLimitChars（50K 落盘摘要）兜底，这里约住常驻内存双保险。
      const appendLimited = (current: string, chunk: string, markTruncated: () => void): string => {
        if (current.length >= MAX_OUTPUT_CHARS) {
          markTruncated()
          return current
        }
        const next = current + chunk
        if (next.length > MAX_OUTPUT_CHARS) {
          markTruncated()
          return next.slice(0, MAX_OUTPUT_CHARS)
        }
        return next
      }
      // 截断标注：超时/取消错误信息里如实说明哪路输出被截断，避免调用方误以为拿到了完整输出
      const truncNote = (): string => {
        const notes: string[] = []
        if (stdoutTruncated) notes.push(`stdout 已截断（超过 ${MAX_OUTPUT_CHARS} 字符）`)
        if (stderrTruncated) notes.push(`stderr 已截断（超过 ${MAX_OUTPUT_CHARS} 字符）`)
        return notes.length > 0 ? `\n${notes.join('；')}` : ''
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
        finish({ ok: false, error: `命令被取消（外层超时）已终止。部分输出：\nstdout: ${stdout}\nstderr: ${stderr}${truncNote()}` })
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      child.stdout.on('data', (d) => { stdout = appendLimited(stdout, d.toString('utf-8'), () => { stdoutTruncated = true }) })
      child.stderr.on('data', (d) => { stderr = appendLimited(stderr, d.toString('utf-8'), () => { stderrTruncated = true }) })

      child.on('close', (code) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (cancelled) {
          finish({ ok: false, error: `命令被取消（外层超时）已终止。部分输出：\nstdout: ${stdout}\nstderr: ${stderr}${truncNote()}` })
          return
        }
        if (timedOut) {
          finish({ ok: false, error: `命令超时（${timeoutMs}ms）被终止。部分输出：\nstdout: ${stdout}\nstderr: ${stderr}${truncNote()}` })
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
    // 安全探测工具（nmap/nuclei/ssh 等主动探测目标网络/服务/凭据）：需目标已授权 → medium
    if (getSecurityToolLabel(command)) {
      return 'medium'
    }
    return 'low'
  }
}
