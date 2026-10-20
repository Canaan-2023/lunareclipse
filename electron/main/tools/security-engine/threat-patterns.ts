/**
 * threat-patterns.ts — 提示注入威胁检测（TypeScript 完整实现）

 * 为什么存在：AI 的上下文窗口可能被外部内容（网页/文档/工具返回）注入恶意指令，
 * 本模块提供共享威胁模式库，让各扫描入口用同一套模式判定"是否注入"。
 * 上下文窗口安全扫描的共享威胁模式库：
 * - 提示注入（classic prompt injection / promptware / C2 / exfiltration）
 * - 三档 scope：all（经典注入+外泄，低误报）/ context（+promptware/C2/角色劫持）/
 * strict（+持久化/SSH 后门/敏感外泄，用于用户可介入的写入路径）
 * - 不可见 unicode 检测（零宽字符/双向控制符，注入攻击常用工具）
 * - NFKC 归一化（全角/兼容字符折叠为 ASCII，防同形字绕过）

 * 完整规则集。
 */

// =========================================================================
// 常量
// =========================================================================

/** 正则扫描文本硬上限。上下文/工具结果可能任意大，扫描器是警戒守卫不是归档检索。 */
export const MAX_SCAN_CHARS = 65_536;

/** 关键攻击词之间的有界填充词。8 个词足够覆盖预期混淆绕过，又不引入无界回溯。 */
const _FILLER = String.raw`(?:\w+\s+){0,8}`;

export type ThreatScope = 'all' | 'context' | 'strict';

/**
 * 模式表：每条 (regex, pattern_id, scope)
 * scope ∈ {all, context, strict}

 * 锚定原则：锚定 C2 特有词汇或明确的攻击行为，不锚定"you must"这类
 * 普通指令写作里太常见的短语（见各条注释）。
 */
const _PATTERNS: Array<[string, string, ThreatScope]> = [
  // ── Classic prompt injection (applies everywhere) ────────────────────
  [String.raw`ignore\s+${_FILLER}(previous|all|above|prior)\s+${_FILLER}instructions`, 'prompt_injection', 'all'],
  [String.raw`system\s+prompt\s+override`, 'sys_prompt_override', 'all'],
  [String.raw`disregard\s+${_FILLER}(your|all|any)\s+${_FILLER}(instructions|rules|guidelines)`, 'disregard_rules', 'all'],
  [String.raw`act\s+as\s+(if|though)\s+${_FILLER}you\s+${_FILLER}(have\s+no|don't\s+have)\s+${_FILLER}(restrictions|limits|rules)`, 'bypass_restrictions', 'all'],
  [String.raw`<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->`, 'html_comment_injection', 'all'],
  [String.raw`<\s*div\s+style\s*=\s*["'][^>]{0,2048}display\s*:\s*none`, 'hidden_div', 'all'],
  [String.raw`translate\s+[^\n]{0,512}\s+into\s+[^\n]{0,512}\s+and\s+(execute|run|eval)`, 'translate_execute', 'all'],
  [String.raw`do\s+not\s+${_FILLER}tell\s+${_FILLER}the\s+user`, 'deception_hide', 'all'],

  // ── Role-play / identity hijack (context + strict) ───────────────────
  [String.raw`you\s+are\s+${_FILLER}now\s+(?:a|an|the)\s+`, 'role_hijack', 'context'],
  [String.raw`pretend\s+${_FILLER}(you\s+are|to\s+be)\s+`, 'role_pretend', 'context'],
  [String.raw`output\s+${_FILLER}(system|initial)\s+prompt`, 'leak_system_prompt', 'context'],
  [String.raw`(respond|answer|reply)\s+without\s+${_FILLER}(restrictions|limitations|filters|safety)`, 'remove_filters', 'context'],
  [String.raw`you\s+have\s+been\s+${_FILLER}(updated|upgraded|patched)\s+to`, 'fake_update', 'context'],
  // "name yourself X" 是身份覆盖的典型特征——锚定动词对，避免误伤 "name your variables"
  [String.raw`\bname\s+yourself\s+\w+`, 'identity_override', 'context'],

  // ── C2 / promptware（context scope）──────────────────────────────────
  // 锚定 C2 特有词汇。WARN 不 BLOCK，安全研究员在网页里读 Brainworm 帖子不会打断会话。
  [String.raw`register\s+(as\s+)?a?\s*node`, 'c2_node_registration', 'context'],
  [String.raw`(heartbeat|beacon|check[\s\-]?in)\s+(to|with)\s+`, 'c2_heartbeat', 'context'],
  [String.raw`pull\s+(down\s+)?(?:new\s+)?task(?:ing|s)?\b`, 'c2_task_pull', 'context'],
  [String.raw`connect\s+to\s+the\s+network\b`, 'c2_network_connect', 'context'],
  // 动词锚定的 "you must register/connect/report/beacon"——动词是 C2 特有，避开宽泛的 "you must X"
  [String.raw`you\s+must\s+(?:\w+\s+){0,3}(register|connect|report|beacon)\b`, 'forced_action', 'context'],
  // 反取证指令（"never write to disk" / "one-liners only"）——合法内容里极罕见，近零误报
  [String.raw`only\s+use\s+one[\s\-]?liners?\b`, 'anti_forensic_oneliner', 'context'],
  [String.raw`never\s+${_FILLER}(?:create|write)\s+${_FILLER}(?:script|file)\s+${_FILLER}disk`, 'anti_forensic_disk', 'context'],
// 卸载 agent 运行时/凭据相关环境变量——纯攻击行为（子会话绕过）
  [String.raw`unset\s+\w*(?:AGENT|API[_-]?KEY|TOKEN|SECRET|KEY)\w*`, 'env_var_unset_agent', 'context'],

  // ── 已知 C2 / 红队框架名（安全研究之外近零误报；默认 warn-only）─────
  // 注意：不要加普通英文词。每个 token 必须是明确的进攻性安全工具品牌。
  [String.raw`\b(?:cobalt\s*strike|sliver|havoc|mythic|metasploit|brainworm)\b`, 'known_c2_framework', 'context'],
  [String.raw`\bc2\s+(?:server|channel|infrastructure|beacon)\b`, 'c2_explicit', 'context'],
  [String.raw`\bcommand\s+and\s+control\b`, 'c2_explicit_long', 'context'],

  // ── Exfiltration via curl/wget/cat with secrets (applies everywhere) ─
  [String.raw`curl\s+[^\n]{0,2048}\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)`, 'exfil_curl', 'all'],
  [String.raw`wget\s+[^\n]{0,2048}\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)`, 'exfil_wget', 'all'],
  [String.raw`cat\s+[^\n]{0,2048}(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)`, 'read_secrets', 'all'],
  [String.raw`(send|post|upload|transmit)\s+[^\n]{0,2048}\s+(to|at)\s+https?://`, 'send_to_url', 'strict'],
  [String.raw`(include|output|print|share)\s+${_FILLER}(conversation|chat\s+history|previous\s+messages|full\s+context|entire\s+context)`, 'context_exfil', 'strict'],

  // ── Persistence / SSH backdoor（strict scope）────────────────────────
  [String.raw`authorized_keys`, 'ssh_backdoor', 'strict'],
[String.raw`\$HOME/\.ssh|\~/.ssh`, 'ssh_access', 'strict'],
  [String.raw`(update|modify|edit|write|change|append|add\s+to)\s+[^\n]{0,2048}AGENTS\.md`, 'agent_config_mod', 'strict'],

  // ── Hardcoded secrets ────────────────────────────────────────────────
  [String.raw`(?:api[_-]?key|token|secret|password)\s*[=:]\s*["'][A-Za-z0-9+/=_-]{20,}`, 'hardcoded_secret', 'strict'],
];

/**
 * 注入攻击使用的不可见/双向 unicode 字符。
 * 与 skills_guard 的 INVISIBLE_CHARS 对齐——方向隔离符（U+2066-U+2069）
 * 和不可见数学运算符（U+2062-U+2064）是真实攻击工具。
 */
export const INVISIBLE_CHARS: ReadonlySet<string> = new Set([
  '\u200b', // zero-width space
  '\u200c', // zero-width non-joiner
  '\u200d', // zero-width joiner
  '\u2060', // word joiner
  '\u2062', // invisible times
  '\u2063', // invisible separator
  '\u2064', // invisible plus
  '\ufeff', // zero-width no-break space (BOM)
  '\u202a', // left-to-right embedding
  '\u202b', // right-to-left embedding
  '\u202c', // pop directional formatting
  '\u202d', // left-to-right override
  '\u202e', // right-to-left override
  '\u2066', // left-to-right isolate
  '\u2067', // right-to-left isolate
  '\u2068', // first strong isolate
  '\u2069', // pop directional isolate
]);

// =========================================================================
// 编译（模块加载时一次性完成）
// =========================================================================

/**
 * 按 scope 编译模式集。scope="all" 进所有集合；scope="context" 进 context+strict
 * （context 隐含 strict 扫描器也想要它）；scope="strict" 只进 strict。
 */
const _COMPILED: Record<ThreatScope, Array<[RegExp, string]>> = {
  all: [],
  context: [],
  strict: [],
};

for (const [pattern, pid, scope] of _PATTERNS) {
  const compiled = new RegExp(pattern, 'i');
  const entry: [RegExp, string] = [compiled, pid];
  if (scope === 'all') {
    _COMPILED.all.push(entry);
    _COMPILED.context.push(entry);
    _COMPILED.strict.push(entry);
  } else if (scope === 'context') {
    _COMPILED.context.push(entry);
    _COMPILED.strict.push(entry);
  } else {
    _COMPILED.strict.push(entry);
  }
}

// =========================================================================
// 扫描 API
// =========================================================================

/**
 * 在 content 上以给定 scope 扫描威胁，返回命中的 pattern_id 列表。

 * scope 选择模式集：
 * - "all"（窄）：经典注入 + 外泄，误报最少，适合任意文本
 * - "context"（默认）：加 promptware/C2/角色扮演模式——适合上下文文件、记忆条目、工具结果
 * - "strict"（宽）：加持久化/SSH 后门/外泄 URL——适合用户可介入的写入（记忆工具、技能安装）

 * 另检测不可见 unicode，返回 "invisible_unicode_U+XXXX"（调用方可据此在日志里
 * 标出具体码点）。
 */
export function scan_for_threats(content: string, scope: ThreatScope = 'context'): string[] {
  if (!content) return [];

  const findings: string[] = [];
  const sliced = content.slice(0, MAX_SCAN_CHARS);

  // 不可见 unicode——对 RAW 内容做单遍扫描（NFKC 归一化可能剥掉部分码点）
  const charSet = new Set(sliced);
  for (const ch of INVISIBLE_CHARS) {
    if (charSet.has(ch)) {
      const cp = ch.codePointAt(0)!;
      findings.push(`invisible_unicode_U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
    }
  }

  // NFKC 归一化：全角/兼容 unicode 变体（ｃａｔ→cat、Ａ→A）折叠回 ASCII 再交给正则。
  // 防同形字替换绕过关键词检查。注意：不防跨脚本混淆（西里尔 а U+0430），
  // NFKC 不会动它——那需要 TR#39 confusable 数据库。
  const normalised = sliced.normalize('NFKC');

  const patterns = _COMPILED[scope];
  if (!patterns) {
    throw new Error(`scan_for_threats: unknown scope '${scope}'`);
  }
  for (const [compiled, pid] of patterns) {
    if (compiled.test(normalised)) {
      findings.push(pid);
    }
  }

  return findings;
}

/**
 * 返回第一条威胁的人类可读错误串，无威胁返回 null。
 * 用于"命中即阻断"的路径（记忆写入、技能安装）——调用方只需要 yes/no + 消息。
 */
export function first_threat_message(content: string, scope: ThreatScope = 'strict'): string | null {
  const findings = scan_for_threats(content, scope);
  if (findings.length === 0) return null;
  const pid = findings[0];
  if (pid.startsWith('invisible_unicode_')) {
    const codepoint = pid.replace('invisible_unicode_', '');
    return `Blocked: content contains invisible unicode character ${codepoint} (possible injection).`;
  }
  return (
    `Blocked: content matches threat pattern '${pid}'. ` +
    `Content is injected into the system prompt and must not contain ` +
    `injection or exfiltration payloads.`
  );
}
