/**
 * output-verifier.ts
 * 命令/工具输出结构化解析层 + 攻击阶段级成功判定。
 * 为什么存在：自动化攻击链（workflow DAG / async delegation）需要「阶段有没有打穿」的
 * 确定性判断，不能把大模型对文本的感知当作唯一依据——本模块把常见工具输出解析成
 * 结构化字段，再按 MITRE ATT&CK 战术词表映射的阶段信号做机械判定，
 * 供 workflow 节点决策 / 子 agent 复盘使用。
 *
 * 设计原则：纯 TS、无运行时依赖；判定宁可「证据不足 → pending」，不把截断输出误判成失败。
 */

// ==================== 类型定义 ====================

/** 攻击链阶段（按 MITRE ATT&CK 战术词表映射，见各阶段注释） */
export type AttackStage =
  | 'recon' // Reconnaissance：收集目标/网络/账号信息
  | 'scan' // 端口/服务探测（Reconnaissance 的子集，项目级细分）
  | 'enum' // Discovery：收集服务版本/账号/共享等技术细节
  | 'access' // Initial Access：拿到入口/会话/初始立足点
  | 'escalate' // Privilege Escalation：权限提升成功
  | 'persist' // Persistence：植入持久化机制
  | 'exfil' // Collection + Exfiltration：敏感数据收集与外传
  | 'verify' // Command and Control：回连/标记确认（验证前序阶段真实生效）

export const ATTACK_STAGES: readonly AttackStage[] = [
  'recon',
  'scan',
  'enum',
  'access',
  'escalate',
  'persist',
  'exfil',
  'verify',
]

/** 工具输出的结构化形态 */
export interface ParsedOutput {
  tool: string
  /** 输出整体是否表现为成功（无致命错误） */
  ok: boolean
  /** 命中的明确终止信号（错误/完成），供快速判断 */
  exitHint?: string
  /** 结构化记录行（如 nmap 的开放端口、nuclei 的命中模板） */
  records: Record<string, string>[]
  /** 汇总字段（如主机数、开放端口数、HTTP 状态码） */
  summary: Record<string, string | number>
  /** 原始文本摘录（截断到 5000 字符，判定信号源） */
  raw: string
}

/** 阶段验证结果 */
export interface StageVerdict {
  stage: AttackStage
  /** passed=有明确成功证据 failed=有明确失败证据 pending=证据不足或未执行 */
  status: 'passed' | 'failed' | 'pending'
  /** 支撑判定命中的证据片段（来自输出） */
  evidence: string[]
  /** 未覆盖的说明（如输出截断、工具不可用） */
  issues: string[]
}

// ==================== 工具输出解析 ====================

const OUTPUT_RAW_LIMIT = 5000

function normText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim()
}

function trimRaw(raw: string): string {
  return raw.length > OUTPUT_RAW_LIMIT ? `${raw.slice(0, OUTPUT_RAW_LIMIT)}\n…[截断]` : raw
}

/** 按工具名分发解析；未知工具走通用文本解析 */
export function parseToolOutput(toolName: string, text: string): ParsedOutput {
  const tool = toolName.toLowerCase()
  const raw = trimRaw(normText(text))
  switch (tool) {
    case 'nmap':
      return parseNmap(raw)
    case 'nuclei':
      return parseNuclei(raw)
    case 'ping':
      return parsePing(raw)
    case 'curl':
      return parseCurl(raw)
    case 'ssh':
      return parseSsh(raw)
    default:
      return parseGeneric(tool, raw)
  }
}

function parseNmap(raw: string): ParsedOutput {
  const records: Record<string, string>[] = []
  const summary: Record<string, string | number> = {}
  for (const line of raw.split('\n')) {
    if (line.startsWith('Nmap scan report for ')) {
      records.push({ event: 'target', host: line.replace('Nmap scan report for ', '').trim() })
    } else if (/^\d+\/(tcp|udp)\s+(open|closed|filtered)\s+\S+/.test(line)) {
      const [portProto, state, service, ...rest] = line.trim().split(/\s+/)
      records.push({ event: 'port', port: portProto ?? '', state: state ?? '', service: service ?? '', version: rest.join(' ') })
    } else if (/^\d+ addresses? \(/i.test(line)) {
      summary.scanSummary = line.trim()
    }
  }
  // 扫描正常跑完即为成功（即使无开放端口目标也可能只是安全）：不把「无端口」判为失败
  const ok = /Nmap done:/.test(raw) || !/error|failed|not found/i.test(raw)
  return {
    tool: 'nmap',
    ok,
    exitHint: /Nmap done:/.test(raw) ? 'scan_completed' : undefined,
    records,
    summary,
    raw,
  }
}

function parseNuclei(raw: string): ParsedOutput {
  const records: Record<string, string>[] = []
  const severityCounts = new Map<string, number>()
  // 典型行：[critical] https://host/path [template-name]
  const lineRe = /^\[(\w+)\]\s+(\S+)\s+\[([^\]]+)\]/
  for (const line of raw.split('\n')) {
    const m = line.match(lineRe)
    if (!m) continue
    records.push({ event: 'finding', severity: m[1]!, target: m[2]!, template: m[3]! })
    const sev = m[1]!.toLowerCase()
    severityCounts.set(sev, (severityCounts.get(sev) ?? 0) + 1)
  }
  const bySeverity = Object.fromEntries(severityCounts)
  return {
    tool: 'nuclei',
    ok: records.length > 0, // 命中即结果；无命中也未必是失败（可能目标无漏洞）
    exitHint: records.length > 0 ? 'findings_detected' : undefined,
    records,
    summary: bySeverity as Record<string, string | number>,
    raw,
  }
}

function parsePing(raw: string): ParsedOutput {
  const records: Record<string, string>[] = []
  for (const line of raw.split('\n')) {
    const reply = line.match(/Reply from ([^:]+):\s+bytes=(\d+)\s+time[=<](\d+)ms\s+TTL=(\d+)/i)
    if (reply) {
      records.push({ event: 'reply', host: reply[1]!, bytes: reply[2]!, timeMs: reply[3]!, ttl: reply[4]! })
    }
  }
  const timedOut = /Request timed out|Destination host unreachable|100% loss/i.test(raw)
  return {
    tool: 'ping',
    ok: records.length > 0,
    exitHint: timedOut ? 'unreachable' : records.length > 0 ? 'reachable' : undefined,
    records,
    summary: { replies: records.length },
    raw,
  }
}

function parseCurl(raw: string): ParsedOutput {
  const records: Record<string, string>[] = []
  const statusRe = /< HTTP\/(?:\d(?:\.\d)?)\s+(\d{3})/gi
  let m: RegExpExecArray | null
  const codes: string[] = []
  while ((m = statusRe.exec(raw)) !== null) {
    codes.push(m[1]!)
    records.push({ event: 'http', status: m[1]! })
  }
  const err = raw.match(/curl:\s+\(\d+\)\s+(.+)/)
  return {
    tool: 'curl',
    ok: codes.length > 0 && !err,
    exitHint: err ? `curl_error: ${err[1]!.trim()}` : codes.length > 0 ? `http_${codes[0]}` : undefined,
    records,
    summary: { httpStatus: codes[0] ?? '' },
    raw,
  }
}

function parseSsh(raw: string): ParsedOutput {
  const records: Record<string, string>[] = []
  const granted = /(?:Entering interactive session|Connection to \S+ closed|Last login)/i.test(raw)
  const denied = /Permission denied|Connection refused|No route to host|Could not resolve hostname/i.test(raw)
  if (granted) records.push({ event: 'session', result: 'established' })
  return {
    tool: 'ssh',
    ok: granted,
    exitHint: denied ? 'denied_or_unreachable' : granted ? 'session_established' : undefined,
    records,
    summary: { session: granted ? 'established' : denied ? 'failed' : 'unknown' },
    raw,
  }
}

function parseGeneric(tool: string, raw: string): ParsedOutput {
  const lines = raw.split('\n').filter((l) => l.trim().length > 0)
  const kv: Record<string, string>[] = []
  // 吸收形如 "key: value" 的行做成结构化字段（通用通道的弱结构化兜底）
  for (const line of lines) {
    const i = line.indexOf(':')
    const first = line.indexOf('=')
    const sep = i >= 0 && (first < 0 || i < first) ? ':' : '='
    const idx = sep === ':' ? i : first
    if (idx > 0 && idx < 60) {
      kv.push({ key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() })
    }
  }
  const errRe = /error:|failed:|exception:|timed out|command not found|access denied/i
  const ok = !errRe.test(raw)
  return {
    tool,
    ok,
    exitHint: ok ? undefined : 'generic_error',
    records: kv.slice(0, 20),
    summary: { lines: lines.length },
    raw,
  }
}

// ==================== 阶段验证器 ====================

/** 各阶段判定信号：命中任一即认为该阶段有成功证据（模式源：MITRE ATT&CK 战术描述词表） */
const STAGE_SIGNALS: Record<AttackStage, RegExp[]> = {
  recon: [
    /\b(?:domain|hostname|ip address|subdomain|whois)\s*[:=]/i,
    /\b(?:os ?detect|os guess|open ports on)/i,
    /\b(?:user|account|credential)\s+enumerat/i,
  ],
  scan: [
    /\b\d+\/(?:tcp|udp)\s+open\s+/i,
    /\bHost is up\b/i,
    /\bNmap done: \d+ IP addresses? \(\d+ hosts? up\)/i,
    /\bPortscan (?:finished|completed)/i,
  ],
  enum: [
    /\b(?:product|service|version|running version)/i,
    /\b(?:samba|smb|netbios|snmp|ldap|rpc)\b/i,
    /\b(?:anonymous|guest|share|mount point)/i,
    /\bmachine account quota|password policy/i,
  ],
  access: [
    /\bEntering interactive session\b/i,
    /\b(?:session established|connection established|login success|welcome!?)\b/i,
    /\b(?:privileged shell|got shell|meterpreter|reverse shell)\b/i,
    /\bHTTP\/(?:\d\.\d)?\s+2\d{2}\b/i,
    /\b(?:vuln|exploit|payload)\s+(?:succeeded|executed|delivered)/i,
  ],
  escalate: [
    /\b(?:uid|gid)=0\b/i,
    /\b(?:root|system|administrator|admin)\s*(?:shell|session|prompt)\b/i,
    /\b(?:privilege escalation|privesc|elevat(?:ion|ed)|impersonat(?:ion|ed))\s+(?:succeed|done|obtained)/i,
    /\b(?:SeDebugPrivilege|SeImpersonatePrivilege|SYSTEM\s+account)\b/i,
  ],
  persist: [
    /\b(?:scheduled task|schtasks|at \d|taskmgr)\s*(?:created|registered|install)/i,
    /\b(?:startup|autorun|run key|runonce|registry run)\s*(?:added|set|created)/i,
    /\b(?:service|daemon|systemd unit)\s*(?:created|enabled|installed)/i,
    /\b(?:web shell|webshell|backdoor|persist(?:ent)?)\b/i,
  ],
  exfil: [
    /\b(?:exfiltrat|data collected|harvest(?:ed|ing))\b/i,
    /\b(?:upload|put|post)\s+\S+\s+(?:to|http)/i,
    /\b(?:\d+\s+(?:bytes|KB|MB)\s+(?:sent|uploaded)|sent\s+\d+)/i,
    /\b(?:sftp|scp|rsync)\s+.*(?:put|send)/i,
  ],
  verify: [
    /\b(?:connect back|connect-back|callback|call back)\s+(?:received|success|ok)/i,
    /\b(?:beacon|check-in|checkin|heartbeat)\s+(?:detected|received|ok)/i,
    /\b(?:marker|flag|token)\s*(?:read|retrieved|matched|found)\b/i,
    /\bwebhook\s+(?:received|hit|200)/i,
  ],
}

/** 明确失败信号（任一即 failed，优先级高于成功信号） */
const FAIL_SIGNALS: RegExp[] = [
  /\b(?:permission denied|access denied)\b/i,
  /\bconnection (?:refused|timed out|reset)\b/i,
  /\b(?:no route to host|could not resolve hostname)\b/i,
  /\b(?:authentication|login) failed\b/i,
  /\b(?:error|exception|traceback):/i,
  /\b100% loss\b/i,
]

function textOf(output: ParsedOutput): string {
  const recordText = output.records.map((r) => Object.values(r).join(' ')).join('\n')
  return `${output.raw}\n${recordText}`
}

/** 汇总多个工具输出，给出某攻击阶段的成功判定 */
export function verifyStage(stage: AttackStage, outputs: ParsedOutput[]): StageVerdict {
  const evidence: string[] = []
  const issues: string[] = []
  if (outputs.length === 0) {
    return { stage, status: 'pending', evidence, issues: ['无任何输出证据，阶段未执行'] }
  }
  const signals = STAGE_SIGNALS[stage]
  for (const out of outputs) {
    const text = textOf(out)
    // 1) 明确失败信号先分组（避免把报错文本里的关键词误判为成功证据）
    if (!out.ok || FAIL_SIGNALS.some((re) => re.test(text))) {
      issues.push(`${out.tool} 输出含失败信号`)
      continue
    }
    // 2) 成功信号命中即收集凭证
    for (const re of signals) {
      const m = text.match(re)
      if (m) {
        const snippet = m[0].trim().slice(0, 120)
        evidence.push(`[${out.tool}] ${snippet}`)
        break
      }
    }
  }
  // 3) 判定：有成功证据 → passed（失败输出作为冲突问题随附，上层可感知）；
  //    无成功证据但存在失败输出 → failed；两者皆无 → pending（证据不足，不误判）
  if (evidence.length > 0) {
    return { stage, status: 'passed', evidence, issues }
  }
  if (issues.length > 0) {
    return { stage, status: 'failed', evidence, issues }
  }
  return { stage, status: 'pending', evidence, issues: ['输出未命中阶段特征信号，证据不足'] }
}