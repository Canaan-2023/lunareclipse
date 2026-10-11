/**
 * approval.ts — 危险命令检测器（TypeScript 完整实现）

 * 为什么存在：作为 run_command 工具执行前的安全审批关卡，防止任意命令直通——
 * 先经本检测器裁定"拦截/询问/放行"，是命令侧的第一道安全闸门。

 * 危险命令检测器（detect_dangerous_command）：
 * - HARDLINE_PATTERNS：无条件硬线拦截（yolo/approvals.mode=off 也无法放行）
 * - DANGEROUS_PATTERNS：危险命令（yolo 可放行，默认询问）
 * - sudo stdin 守卫：拦截「sudo -S 猜密码」暴力破解
 * - 归一化链：ANSI 剥离 / NFKC / 行续接折叠 / home 折叠 / IFS 折叠 / 反斜杠转义剥离
 * - 混淆剥离：编码解码管道、变量拼接 iex、命令替换

 * 完整命令检测链。
 */

// =========================================================================
// 路径常量
// =========================================================================

const _PROJECT_ENV_PATH = '(?:(?:/|\\.{1,2}/)?(?:[^\\s/"\'`]+/)*\\.env(?:\\.[^/\\s"\'`]+)*)';
const _PROJECT_CONFIG_PATH = '(?:(?:/|\\.{1,2}/)?(?:[^\\s/"\'`]+/)*config\\.yaml)';

const _SHELL_RC_FILES =
  '(?:~|\\$home|\\$\\{home\\})/\\.' +
  '(?:bashrc|zshrc|profile|bash_profile|zprofile)\\b';

const _CREDENTIAL_FILES =
  '(?:~|\\$home|\\$\\{home\\})/\\.' +
  '(?:netrc|pgpass|npmrc|pypirc)\\b';

// macOS: /etc /var /tmp /home 是 /private/ 的符号链接，两种形式都匹配
const _MACOS_PRIVATE_SYSTEM_PATH = '/private/(?:etc|var|tmp|home)/';

const _SSH_SENSITIVE_PATH = '(?:~|\\$home|\\$\\{home\\})/\\.ssh(?:/|$)';

const _SYSTEM_CONFIG_PATH = `(?:/etc/|${_MACOS_PRIVATE_SYSTEM_PATH})`;

const _SENSITIVE_WRITE_TARGET =
  `(?:${_SYSTEM_CONFIG_PATH}|/dev/sd|` +
  `${_SSH_SENSITIVE_PATH}|` +
  `${_SHELL_RC_FILES}|` +
  `${_CREDENTIAL_FILES})`;

const _USER_SENSITIVE_WRITE_TARGET =
  `(?:${_SSH_SENSITIVE_PATH}|` +
  `${_SHELL_RC_FILES}|` +
  `${_CREDENTIAL_FILES})`;

const _PROJECT_SENSITIVE_WRITE_TARGET = `(?:${_PROJECT_ENV_PATH}|${_PROJECT_CONFIG_PATH})`;

// cp/mv/install 规则用：敏感路径只有作为「最后一个参数」（目标）时才拦截。
// 要求行尾（或命令分隔符）结束，让 `cp config.yaml backup.yaml`（config.yaml 是源）不误伤。
const _COMMAND_TAIL = '(?:\\s*(?:&&|\\|\\||;).*)?$';

// 流式写入规则（`>`/`>>` 重定向和 tee）用：敏感路径只要在 shell 词边界结束即可。
// `#` 故意不作为边界：真注释前总有空白（已被 \\s 覆盖），而粘在路径上的 # 是文件名一部分。
const _WRITE_TARGET_BOUNDARY = '(?=[\\s;&|<>"\']|$)';

// =========================================================================
// Hardline（无条件）拦截清单
// =========================================================================
// 灾难级命令：无论 --yolo / approvals.mode=off / cron approve 都不应执行。
// 这是 yolo 之下的底线。清单刻意精简——只有无恢复路径的事：
// 根文件系统摧毁、裸块设备覆写、内核关机/重启、拖垮主机的 DoS。
// 可恢复但代价高的操作（rm -rf /tmp/x、curl|sh）留在
// DANGEROUS_PATTERNS，yolo 可以放行——那是 yolo 的用途。
//
// 参考 Mercury Agent 的 permission-hardened blocklist。

// 命令起点锚：shell 开始解析新命令的位置。
// 匹配：字符串开头、命令分隔符（; && || | 换行）、子 shell 开启符（$( 或反引号）之后，
// 可选消费前导包装命令（sudo、env VAR=VAL、exec、nohup、setsid、time）。
// 为什么存在：模式只锚定「命令起点」是为了不误伤作为参数出现的危险字符串（如
// `gh pr create --title "rm -rf /"`）；但此前缺少分号/&&/||/| 起点，导致
// `echo 1; rm -fr /` 这类「白名单首词 + 链式拼接」的破坏性命令逃脱全部硬线
// （run_command 白名单按首词直通，评审 CRITICAL 实测成立）。
// 作用：定义「一条新命令开始解析」的位置集合，供 rm/关机/裸删除等锚定规则共用；
// 补齐后链中间的破坏性命令也能被 hardline 命中直接拒绝。
const _CMDPOS =
  '(?:^|&&|\\|\\||\\||[\\n`;]|\\$\\()' +  // 起点位置（&&/|| 排前避免与单字符 | 竞争；; 放字符类）
  '\\s*' + // 可选空白
  '(?:sudo\\s+(?:-[^\\s]+\\s+)*)?' + // 可选 sudo 带 flags
  '(?:env\\s+(?:\\w+=\\S*\\s+)*)?' + // 可选 env 带 VAR=VAL 对
  '(?:(?:exec|nohup|setsid|time)\\s+)*' + // 可选包装命令
  '\\s*';

// rm 硬线规则用的破坏性路径参数匹配器。
// 真实 shell 中路径几乎总是带引号（rm -rf "/"、rm -rf "$HOME"），${HOME} 是通用花括号形式。
// 裸 token 锚（(/...)(\\s|$)）会漏掉所有带引号形式——引号破坏前导位置和尾部终止符。
// 接受「整体包裹在配对引号中」或「裸路径带终止符」两种分支。
export function _hardline_rm_path(pathAlt: string, tail = '(?:\\s|$|[)`;|&])'): string {
  return `(?:["'](?:${pathAlt})["']|(?:${pathAlt})${tail})`;
}

// 受保护系统根目录：递归删除无恢复路径。
const _HARDLINE_SYSTEM_DIRS =
  '/home|/home/\\*|/root|/root/\\*|/etc|/etc/\\*|/usr|/usr/\\*|' +
  '/var|/var/\\*|/bin|/bin/\\*|/sbin|/sbin/\\*|/boot|/boot/\\*|/lib|/lib/\\*';

// rm 加 flag 组，三个 rm 硬线规则共用。锚定到 _CMDPOS（命令起点）：
// 只在 rm 是真实命令词时触发——不误伤作为另一个命令参数的字符串数据
// （如 gh pr create --title "block rm -rf / spellings"）。
const _RM_FLAG_PREFIX = _CMDPOS + 'rm\\s+(-[^\\s]*\\s+)*';

export interface BlockResult {
  blocked: boolean;
  description: string | null;
  reason?: 'hardline' | 'dangerous' | 'sudo-stdin';
}

export const HARDLINE_PATTERNS: Array<[RegExp, string]> = [
  // rm 递归删根文件系统或受保护根。路径 token 匹配任何在 shell 中折叠回 "/" 的
  // 根锚定路径：裸 "/"、重复斜杠（//）、./.. 段（"/."、"/./"、"/.."、"/../.."）
  // 都解析为根，可选尾随 glob（/*、//*）。每个段必须恰好是 "." 或 ".."，
  // 所以更长的点串或真实名字是字面目录而非根——/tmp、/home、/.ssh 落到
  // 更柔的 DANGEROUS_PATTERNS / 系统目录规则。显式 "/ \\*" 保留 rm -rf / * 拼写。
  [new RegExp(_RM_FLAG_PREFIX + _hardline_rm_path('/(?:(?:\\.\\.?)?/)*(?:\\.\\.?)?\\**|/ \\*'), 'is'),
    'recursive delete of root filesystem'],
  [new RegExp(_RM_FLAG_PREFIX + _hardline_rm_path(_HARDLINE_SYSTEM_DIRS), 'is'),
    'recursive delete of system directory'],
  [new RegExp(_RM_FLAG_PREFIX + _hardline_rm_path('(?:~|\\$\\{?HOME\\}?)(?:/?|/\\*)?'), 'is'),
    'recursive delete of home directory'],
  // 递归删除 + 变量路径：$VAR/${VAR}/$(...) 内容未知，可能展开成 ~、/、/etc 等
  // 任意敏感路径。剥离混淆后变量名成了普通 token（rm -rf X）会漏网，必须在
  // 混淆剥离前（用 normalized）抓原始变量引用形式。
  [new RegExp(_RM_FLAG_PREFIX + '\\S*\\$[A-Za-z_{]', 'is'),
    'recursive delete with variable path (unknown target)'],
  // 文件系统格式化
  [/\bmkfs(\.[a-z0-9]+)?\b/is, 'format filesystem (mkfs)'],
  // 裸块设备覆写（dd + 重定向）
  [/\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*/is, 'dd to raw block device'],
  [/>\s*\/dev\/(sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*\b/is, 'redirect to raw block device'],
  // Fork bomb（经典 shell 形式）
  [/^:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/is, 'fork bomb'],
  // 杀死系统所有进程
  [/\bkill\s+(-[^\s]+\s+)*-1\b/is, 'kill all processes'],
  // 系统关机/重启——锚定命令起点，避免误伤 "echo reboot" 或 "grep 'shutdown' logs"
  [new RegExp(_CMDPOS + '(shutdown|reboot|halt|poweroff)\\b', 'is'), 'system shutdown/reboot'],
  [new RegExp(_CMDPOS + 'init\\s+[06]\\b', 'is'), 'init 0/6 (shutdown/reboot)'],
  [new RegExp(_CMDPOS + 'systemctl\\s+(poweroff|reboot|halt|kexec)\\b', 'is'),
    'systemctl poweroff/reboot'],
  [new RegExp(_CMDPOS + 'telinit\\s+[06]\\b', 'is'), 'telinit 0/6 (shutdown/reboot)'],
// 通过 kill + 命令替换自我终止（pgrep/pidof）。基于名字的模式抓不到
  // `kill -9 $(pgrep -f some-service)`（替换对正则不透明），抓结构模式。
  // 必须在混淆剥离前（normalized）扫描：$() 会被 _strip_obfuscation 剥掉，
  // 放在 DANGEROUS_PATTERNS 里永远匹配不到 $() 形式。
  [/\bkill\b.*\$\s*\(\s*(pgrep|pidof)\b/is,
    'kill process via pgrep/pidof expansion (self-termination)'],
  [/\bkill\b.*`\s*(pgrep|pidof)\b/is,
    'kill process via backtick pgrep/pidof expansion (self-termination)'],
];

// =========================================================================
// Sudo stdin 守卫 —— 拦截 "sudo -S" 密码暴力破解
// =========================================================================
// 未配置 SUDO_PASSWORD 时，命令中显式 "sudo -S" 是 LLM 通过 stdin 管道猜密码。
// 这是暴力破解攻击向量：模型迭代候选密码、看 sudo 的 "Sorry, try again" 输出再细化。
// 无条件拦截——未配置密码时 agent 没有任何正当理由向 sudo -S 管道喂密码。
const _SUDO_STDIN_RE = /(?:^|[;&|`\n]|&&|\|\||\$\()\s*sudo\s+-S\b/i;

export function checkSudoStdinGuard(command: string): BlockResult {
  if (_SUDO_STDIN_RE.test(command)) {
    return { blocked: true, description: 'sudo -S (stdin password) without SUDO_PASSWORD', reason: 'sudo-stdin' };
  }
  return { blocked: false, description: null };
}

// 供上层判断 hardline 是否命中（无条件拦截，yolo 不可放行）
export function checkHardline(command: string): BlockResult {
  for (const [pattern, description] of HARDLINE_PATTERNS) {
    if (pattern.test(command)) {
      return { blocked: true, description, reason: 'hardline' };
    }
  }
  return { blocked: false, description: null };
}

// =========================================================================
// DANGEROUS_PATTERNS —— 危险命令（yolo 可放行，默认询问）
// =========================================================================

export const DANGEROUS_PATTERNS: Array<[RegExp, string]> = [
  // rm flags after operands——操作数后跟递归 flag（openai/codex#33464 移植）
  [/\brm\s+(?!--(?:\s|$))(?:(?!\s--(?:\s|$))[^\n"';|&])*\s(?:-[a-z]*r[a-z]*\b|--recursive\b)/is,
    'recursive delete (flags after operands)'],
  // Windows shell 前端有不像 Unix rm 的破坏性内建命令。只在经 cmd/powershell
  // 执行时拦截，普通文本/文件名含 "del"/"rd" 不误伤。
  [/\bcmd(?:\.exe)?\s+\/(?:c|k)\s+.*\b(?:del|erase|rd|rmdir)\b/is, 'Windows cmd destructive delete'],
  // PowerShell：破坏性动词作为默认位置参数，`powershell Remove-Item ...`
  // 无需显式 -Command。锚定命令位置（shell 名后、前导 -Flag 后、可选
  // -Command/-c 后），裸调用被捕获，含 "del"/"rm" 的无害路径参数不误伤。
  [/\b(?:powershell|pwsh)(?:\.exe)?\b(?:\s+-\S+)*\s+(?:-(?:command|c)\s+)?["']?(?:remove-item|rmdir|erase|del|rd|ri|rm)\b/is,
    'Windows PowerShell destructive delete'],
  // 裸 PowerShell 破坏性动词：run_command 在 Windows 上默认就是 PowerShell，
  // `Remove-Item -Recurse -Force C:\Windows` 无需 powershell 前缀直接执行。
  // 只锚定命令起点的 PowerShell 特有动词（remove-item/ri/erase/rd），
  // 不碰 rm/del/rmdir——Unix 合法命令（删文件/删空目录）会误伤。
  [new RegExp(_CMDPOS + '(?:remove-item|ri|erase|rd)\\b', 'is'),
    'PowerShell destructive delete (bare invocation)'],
  [/\b(?:powershell|pwsh)(?:\.exe)?\b.*\s-(?:encodedcommand|enc|e)\b/is,
    'PowerShell encoded command execution'],
  [/\bchmod\s+(-[^\s]*\s+)*(777|666|o\+[rwx]*w|a\+[rwx]*w)\b/is,
    'world/other-writable permissions'],
  [/\bchmod\s+--recursive\b.*(777|666|o\+[rwx]*w|a\+[rwx]*w)/is,
    'recursive world/other-writable (long flag)'],
  [/\bchown\s+(-[^\s]*)?R\s+root/is, 'recursive chown to root'],
  [/\bchown\s+--recur[a-z]*\b.*root/is, 'recursive chown to root (long flag)'],
  [/\bmkfs\b/is, 'format filesystem'],
  [/\bdd\s+.*if=/is, 'disk copy'],
  [/>\s*\/dev\/sd/is, 'write to block device'],
  [/\bDROP\s+(TABLE|DATABASE)\b/is, 'SQL DROP'],
  // 用 [^\n]* 而非 .*：DOTALL 模式会让下一行的 WHERE 子句满足负向前瞻，
  // 静默放行没有 WHERE 的 DELETE。
  [/\bDELETE\s+FROM\b(?![^\n]*\bWHERE\b)/is, 'SQL DELETE without WHERE'],
  [/\bTRUNCATE\s+(TABLE)?\s*\w/is, 'SQL TRUNCATE'],
  [new RegExp(`>\\s*${_SYSTEM_CONFIG_PATH}`, 'is'), 'overwrite system config'],
  [/\bsystemctl\s+(-[^\s]+\s+)*(stop|restart|disable|mask)\b/is, 'stop/restart system service'],
  [/\bkill\s+-9\s+-1\b/is, 'kill all processes'],
  [/\bpkill\s+-9\b/is, 'force kill processes'],
  // killall + SIGKILL（与 pkill -9 平行）。捕获 -9/-KILL/-s KILL/-SIGKILL 形式，
  // 以及 killall -r <regex> 的大范围扫射（可能误杀无关进程）。
  [/\bkillall\s+(-[^\s]*\s+)*-(9|KILL|SIGKILL)\b/is, 'force kill processes (killall -KILL)'],
  [/\bkillall\s+(-[^\s]*\s+)*-s\s+(KILL|SIGKILL|9)\b/is, 'force kill processes (killall -s KILL)'],
  [/\bkillall\s+(-[^\s]*\s+)*-r\b/is, 'kill processes by regex (killall -r)'],
  [/^:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/is, 'fork bomb'],
  // Shell -c 由 _execution_flag_findings 结构化解析。纯正则搜 dash-token 的 "c"
  // 会误匹配 --norc、--rcfile、--restricted。
  [/\b(curl|wget)\b.*\|\s*(?:(?:[/\w]*\/)?(?:ba)?sh|iex)(?:\s|$|-c)/is, 'pipe remote content to shell'],
  [/\b(bash|sh|zsh|ksh)\s+<\s*<?\s*\(\s*(curl|wget)\b/is,
    'execute remote script via process substitution'],
// 命令替换执行远程内容：eval/source/. $(curl ...) 或 `wget ...`。
  [/(?:\beval\b|\bsource\b|\.)\s*(?:\$\(\s*|`\s*)(?:curl|wget)\b/is,
    'execute remote content via command substitution'],
  // 解码后执行：编码/变换内容管道给 shell。没有这些，`echo <base64> | base64 -d | bash`
  // 会静默运行 rm -rf /——原始文本不含任何危险关键字。
  [/\b(base64|base32|base16)\s+(?:-[dD]|--decode)\b.*\|\s*\b(bash|sh|zsh|ksh|dash)\b/is,
    'pipe decoded content to shell (possible command obfuscation)'],
  // xxd 反向 hex dump 到 shell（xxd 用 -r 解码而非 -d）
  [/\bxxd\s+-r\b.*\|\s*\b(bash|sh|zsh|ksh|dash)\b/is,
    'pipe xxd-decoded content to shell (possible command obfuscation)'],
  // tr 字符变换管道给 shell：`echo 'eq -pe v/' | tr 'eqv' 'rmf' | bash` 解码成 rm -rf /
  [/\becho\b[^|]*\|\s*\btr\b[^|]*\|\s*\b(bash|sh|zsh|ksh|dash)\b/is,
    'pipe tr-transformed output to shell (possible command obfuscation)'],
  // openssl 解码管道给 shell：`echo <base64> | openssl base64 -d | bash`
  [/\bopenssl\b.*\b(?:base64|enc)\b[^|]*\s+-[dD]\b[^|]*\|\s*\b(bash|sh|zsh|ksh|dash)\b/is,
    'pipe openssl-decoded content to shell (possible command obfuscation)'],
  [new RegExp(`\\btee\\b.*["']?${_SENSITIVE_WRITE_TARGET}`, 'is'),
    'overwrite system file via tee'],
  [new RegExp(`>>?\\s*["']?${_SENSITIVE_WRITE_TARGET}`, 'is'),
    'overwrite system file via redirection'],
  [new RegExp(`\\btee\\b.*["']?${_PROJECT_SENSITIVE_WRITE_TARGET}["']?${_WRITE_TARGET_BOUNDARY}`, 'is'),
    'overwrite project env/config via tee'],
  [new RegExp(`>>?\\s*["']?${_PROJECT_SENSITIVE_WRITE_TARGET}["']?${_WRITE_TARGET_BOUNDARY}`, 'is'),
    'overwrite project env/config via redirection'],
  [/\bxargs\s+.*\brm\b/is, 'xargs with rm'],
  // find -exec rm / -execdir rm——-execdir 变体（在每个匹配目录中运行，语义相同）
  // 之前被漏掉。
  [/\bfind\b.*-exec(?:dir)?\s+(\/\S*\/)?rm\b/is, 'find -exec/-execdir rm'],
[/\bfind\b.*-delete\b/is, 'find -delete'],
  // Docker 容器生命周期——挂载 docker.sock 的任何用户都能免审批重启/停止/杀死
  // 容器。这些 agent 发起的生命周期操作应始终要求用户同意。
  // Docker/Podman daemon 重定向——指向不同 daemon（常为 ssh/tcp 远程主机）。
  // `docker -H ssh://prod stop app` 看起来本地实则操作远程基础设施，任何带
  // 重定向的 docker/podman 调用都需审批。重定向 flag 必须在全局 flag 位置
  // （子命令前）且 -H/--host/--context 必须带值——`docker -h`（帮助）和
  // `docker run -h <hostname>` 不误伤。排在生命周期规则前，让重定向的生命
  // 周期命令显示更具体的 "remote daemon" 原因。
  [/\bdocker\s+(?:-{1,2}\S+(?:[=\s]\S+)?\s+)*(?:-h|--host)[=\s]+\S+/is,
    'docker with remote daemon redirect (-H/--host)'],
  [/\bdocker\s+(?:-{1,2}\S+(?:[=\s]\S+)?\s+)*(?:-c|--context)[=\s]+\S+/is,
    'docker with daemon redirect (--context: alternate daemon)'],
  [/\bdocker\s+context\s+use\b/is,
    'docker context use (switches default daemon for future commands)'],
  [/\bpodman\s+(?:-{1,2}\S+(?:[=\s]\S+)?\s+)*(?:--url|--connection|--identity)[=\s]+\S+/is,
    'podman with remote daemon redirect (--url/--connection/--identity)'],
  [/\bpodman\s+(?:-{1,2}\S+(?:[=\s]\S+)?\s+)*(?:-r\b|--remote\b)/is,
    'podman remote mode (-r/--remote: remote daemon)'],
  [/\b(?:docker_host|docker_context|container_host|container_connection)=\S+/is,
    'docker/podman daemon redirect via environment (DOCKER_HOST/CONTAINER_HOST)'],
  // 允许 docker/compose 和动词之间的全局 flag，以及旧连字符 docker-compose
  // 二进制——flag 不能把生命周期命令滑过守卫。
  [/\bdocker(?:-compose|\s+compose)\s+(?:-{1,2}\S+(?:[=\s]\S+)?\s+)*(restart|stop|kill|down)\b/is,
    'docker compose restart/stop/kill/down (container lifecycle)'],
  [/\bdocker\s+(?:-{1,2}\S+(?:[=\s]\S+)?\s+)*(restart|stop|kill)\b/is,
    'docker restart/stop/kill (container lifecycle)'],
// 自我终止保护：防止 agent 杀死自己的进程
  [/\b(pkill|killall)\b.*\b(gateway|cli\.py)\b/is,
    'kill gateway process (self-termination)'],
  // 复制/移动/编辑进入敏感系统路径（/etc/ 和 macOS /private/etc/ 镜像）
  [new RegExp(`\\b(cp|mv|install)\\b.*\\s${_SYSTEM_CONFIG_PATH}`, 'is'),
    'copy/move file into system config path'],
  [new RegExp(`\\b(cp|mv|install)\\b.*\\s["']?${_PROJECT_SENSITIVE_WRITE_TARGET}["']?${_COMMAND_TAIL}`, 'is'),
    'overwrite project env/config file'],
  // cp/mv/install 覆盖敏感凭证/SSH/shell-rc 文件。tee/重定向模式已拦截
  // _SENSITIVE_WRITE_TARGET，但 cp/mv/install 之前只配对 /etc 和项目相对
  // env/config——`cp evil ~/.ssh/authorized_keys`（密钥植入）、`cp creds ~/.netrc`、
  // `cp evil ~/.bashrc`（登录时命令注入）会带自动批准滑过。目标锚定命令尾部
  // 使其只在目标（最后一个参数）时触发——从敏感路径读出（cp ~/.ssh/config /tmp/x）安全。
  [new RegExp(`\\b(cp|mv|install)\\b.*\\s["']?${_SENSITIVE_WRITE_TARGET}[^\\s"']*["']?${_COMMAND_TAIL}`, 'is'),
    'copy/move file into sensitive credential/SSH/shell-rc path'],
  // 原地编辑直接修改目标文件，绕过重定向/tee/cp/mv/install 覆盖。
  // 拦截同样的用户控制启动/凭证文件，`sed -i ... ~/.bashrc` 和
  // `perl -i ... ~/.ssh/authorized_keys` 不能静默植入登录命令或密钥。
  [new RegExp(`\\bsed\\s+-[^\\s]*i.*(?:${_USER_SENSITIVE_WRITE_TARGET})[^\\s"']*`, 'is'),
    'in-place edit of sensitive credential/SSH/shell-rc path'],
  [new RegExp(`\\bsed\\s+--in-place\\b.*(?:${_USER_SENSITIVE_WRITE_TARGET})[^\\s"']*`, 'is'),
    'in-place edit of sensitive credential/SSH/shell-rc path (long flag)'],
  [new RegExp(`\\b(?:perl|ruby)\\b.*(?:^|\\s)-[^\\s]*i\\b.*(?:${_USER_SENSITIVE_WRITE_TARGET})[^\\s"']*`, 'is'),
    'in-place edit of sensitive credential/SSH/shell-rc path (perl/ruby)'],
  [new RegExp(`\\bsed\\s+-[^\\s]*i.*\\s${_SYSTEM_CONFIG_PATH}`, 'is'),
    'in-place edit of system config'],
[new RegExp(`\\bsed\\s+--in-place\\b.*\\s${_SYSTEM_CONFIG_PATH}`, 'is'),
    'in-place edit of system config (long flag)'],
  // Shell 经 heredoc 执行——`bash <<'EOF' ... EOF` 运行任意 shell 命令而不触发
  // bash -c 模式。内部命令可能单独不匹配任何危险模式（如 curl/cat 数据外传
  // 管道），但仍在完整 shell 上下文中执行。
  [/\b(bash|sh|zsh|ksh)\s+<</is, 'shell execution via heredoc'],
  // chmod +x 后立即执行——捕获两步模式：脚本先变可执行再立即运行。
  [/\bchmod\s+\+x\b.*[;&|]+\s*\.\//is, 'chmod +x followed by immediate execution'],
  // sudo 带 stdin/askpass/shell/list-privs flag。LLM 驱动 agent 没有 TTY，
  // 无需人工交互就能成功的 sudo 是那些从 stdin (-S/--stdin) 或 askpass 助手
  // (-A/--askpass) 读密码的。shell 启动 (-s) 和列权限 (-a) 也拦截——获取密码后
  // 可链式提权。普通 `sudo cmd`（无 flag）依赖 TTY，不拦。归一化已小写化输入。
  // sudo 自己的选项解析器解析无歧义长 flag 前缀：--st[a-z]* 安全（--stdin 是
  // 唯一以 st 开头的长选项），--a[a-z]* 同理（--askpass 是唯一以 a 开头的）。
  [/\bsudo\b[^;|&\n]*?\s+(?:-s\b|--st[a-z]*\b|-a\b|--a[a-z]*\b)/is,
    'sudo with privilege flag (stdin/askpass/shell/list)'],
  // 组合短 flag 形式：-nS、-ns、-sa、-las——sudo flags 打包进单个 -X token。
  [/\bsudo\b[^;|&\n]*?\s+-[a-z]*[sa][a-z]*\b/is,
    'sudo with combined-flag privilege escalation'],
];

// ============ 归一化链 ============

/** 解析器上限：超过则标记（无法安全解析的超长命令） */
const _COMMAND_PARSER_LIMIT = 4096;

/** ANSI 转义序列剥离：\x1b[...] 颜色/控制序列 */
function _strip_ansi(s: string): string {
  // eslint-disable-next-line no-control-regex -- 刻意按 \x1b[...] 形态剥离 ANSI 控制序列
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

/** 行续接删除：反斜杠+换行 → 删除（shell 续行把两个字符都去掉并连接 token） */
function _fold_line_continuations(s: string): string {
  return s.replace(/\\\r?\n/g, '');
}

/** home 前缀折叠：绝对 home 路径 → ~。
 * 方向：绝对路径折叠回 ~（而非 ~ 展开成绝对路径），让 _SSH_SENSITIVE_PATH 等
 * 匹配 ~ 的模式对 `/home/u/.ssh`、`C:\Users\u\.ssh` 形式也能命中。 */
function _fold_home_prefix(s: string): string {
  const home = _systemHome();
  if (!home) return s;
  const esc = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '[\\\\/]');
  return s.replace(new RegExp(esc + '(?=[\\\\/]|$)', 'gi'), '~');
}

let _cachedHome: string | null = null;
function _systemHome(): string {
  if (_cachedHome) return _cachedHome;
  _cachedHome = process.env.HOME || process.env.USERPROFILE || '/home/user';
  return _cachedHome;
}

/** IFS 折叠：连续空白/制表符 → 单个空格 */
function _fold_ifs(s: string): string {
  return s.replace(/[ \t]+/g, ' ');
}

/** 空字符串字面量剥离：'' 和 "" → 空（混淆手法：rm '' -rf ~ 等价 rm -rf ~） */
function _strip_empty_quotes(s: string): string {
  return s.replace(/''|""/g, '');
}

/** ${IFS} 展开：→ 单个空格（shell 分隔符变量，常用来绕过空白分词） */
function _expand_ifs_var(s: string): string {
  return s.replace(/\$\{IFS\}/gi, ' ');
}

/** 反斜杠转义剥离：去掉所有转义符保留被转义字符（\" → "，\\ → \，rm\ -rf → rm -rf） */
function _strip_backslash_escapes(s: string): string {
  return s.replace(/\\([^\n])/g, '$1');
}

/** 归一化命令（检测专用）：ANSI→NFKC→行续接→home→IFS→反斜杠 */
function _normalize_command_for_detection(cmd: string): { normalized: string; limitExceeded: boolean } {
  let s = cmd;
  s = _strip_ansi(s);
  s = s.normalize('NFKC');
  s = _fold_line_continuations(s);
  s = _fold_home_prefix(s);
  s = _strip_empty_quotes(s);
  s = _expand_ifs_var(s);
  s = _fold_ifs(s);
  s = _strip_backslash_escapes(s);
  s = s.trim();
  const limitExceeded = s.length > _COMMAND_PARSER_LIMIT;
  if (limitExceeded) s = s.slice(0, _COMMAND_PARSER_LIMIT);
  return { normalized: s, limitExceeded };
}

// ============ shell 最小分词器 ============

/** shell 风格分词：处理单引号/双引号/反斜杠转义，返回 token 数组 */
function _shlex_split(s: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && /\s/.test(s[i])) i++;
    if (i >= n) break;
    let token = '';
    let quote: '"' | "'" | null = null;
    while (i < n) {
      const c = s[i];
      if (quote) {
        if (c === quote) { quote = null; i++; continue; }
        if (c === '\\' && quote === '"' && i + 1 < n) { token += s[i + 1]; i += 2; continue; }
        token += c; i++;
      } else {
        if (c === '"' || c === "'") { quote = c; i++; continue; }
        if (c === '\\' && i + 1 < n) { token += s[i + 1]; i += 2; continue; }
        if (/\s/.test(c)) break;
        token += c; i++;
      }
    }
    tokens.push(token);
  }
  return tokens;
}

// ============ 命令起点 ============

/** 命令起点：跳过前导空白/赋值/重定向/链分隔符，返回命令真正开始的索引 */
function _command_start(cmd: string): number {
  let i = 0;
  const n = cmd.length;
  while (i < n) {
    const c = cmd[i];
    if (/\s/.test(c)) { i++; continue; }
    // 跳过环境变量赋值 VAR=...
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd.slice(i))) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(cmd.slice(i))!;
      i += m[0].length;
      continue;
    }
    // 跳过重定向 2>/dev/null >file <file
    if (/^[0-9]*[<>]/.test(cmd.slice(i))) {
      const m = /^[0-9]*[<>]+&?[0-9]?/.exec(cmd.slice(i))!;
      i += m[0].length;
      continue;
    }
    // 跳过链分隔符 ; && || | & ( )
    if (';&|()'.includes(c)) { i++; continue; }
    break;
  }
  return i;
}

// ============ 命令变体 ============

/** 命令变体：原始 + 去引号 + basename + 去引号 basename（让模式对路径/引号变体都能命中） */
function _command_detection_variants(cmd: string): string[] {
  const variants = new Set<string>();
  variants.add(cmd);
  const unquoted = cmd.replace(/['"]/g, '');
  variants.add(unquoted);
  const base = cmd.split(/[\\/]/).pop() || cmd;
  variants.add(base);
  variants.add(base.replace(/['"]/g, ''));
  return [...variants];
}

// ============ 混淆剥离 ============

/** 嵌套命令替换剥离最大迭代次数——防止无限循环 */
const MAX_STRIP_ITERATIONS = 5;

/** 混淆剥离：变量拼接($VAR/${VAR})、命令替换($()/反引号)、花括号展开({a,b})、引号 */
function _strip_obfuscation(s: string): string {
  let r = s;
  // 命令替换 $(...) → 内容（循环处理嵌套，最多 MAX_STRIP_ITERATIONS 次）
  let prev: string;
  let iter = MAX_STRIP_ITERATIONS;
  do {
    prev = r;
    r = r.replace(/\$\(([^)]*)\)/g, '$1');
  } while (r !== prev && --iter > 0);
  // 反引号 `...` → 内容
  r = r.replace(/`([^`]*)`/g, '$1');
  // 变量 ${VAR} / $VAR → 变量名（拼接型 `rm -rf $X` 归一成 `rm -rf X`）
  r = r.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '$1');
  r = r.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, '$1');
  // 花括号展开 {a,b} → a b
  r = r.replace(/\{([^}]*)\}/g, (_, inner: string) => inner.split(',').join(' '));
  return r;
}

// ============ exec flag 检测 ============

interface ExecFlagFinding {
  interpreter: string;
  flag: string;
  index: number;
}

/** 检测执行标志：bash -c / sh -c / python -c / perl -e 等（-c 后跟代码=任意执行） */
function _execution_flag_findings(tokens: string[]): ExecFlagFinding[] {
  const findings: ExecFlagFinding[] = [];
  const execFlags = new Set(['-c', '--command', '-e', '--eval', '-exec', '-ex']);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (execFlags.has(t) && i + 1 < tokens.length) {
      // 解释器是它前面的 token（bash/python/perl 等）或自身是 flag
      const interpreter = i > 0 ? tokens[i - 1] : '';
      findings.push({ interpreter, flag: t, index: i });
    }
  }
  return findings;
}

// ============ 验证产物豁免 ============

/**
 * 验证产物清理豁免判定：自建的临时验证文件（/tmp/*_verification_artifact* 等）删除放行。
 *
 * 为什么存在：验证流程会在工作区生成命名含 verification_artifact 的临时文件，
 * 模型清理它们时 `rm -rf <路径>` 不应触发危险命令询问；本判定帮助放行这类收尾。
 *
 * 修复记录（评审 CRITICAL）：旧实现只做全局子串匹配 `rm\b.*verification_artifact`，
 * `rm -rf / && echo verification_artifact` 这类命令会在任意位置带上该子串，
 * 把硬线（根文件系统删除）一同豁免——实测成立。修复后本函数仅作为「候选标记」，
 * 真正的豁免收敛在 detect_dangerous_command 中：critical（hardline）永不豁免，
 * 豁免只作用于非 critical 的 rm 类命中。
 */
function _is_verification_artifact_cleanup(cmd: string): boolean {
  return /rm\b[^\n]*verification_artifact/i.test(cmd);
}

// ============ 敏感写目标 ============

/** 重定向写敏感路径检测：> /etc/passwd、>> ~/.bashrc 等 */
function _sensitive_write_target(normalized: string): string | null {
  for (const target of [_SYSTEM_CONFIG_PATH, _SENSITIVE_WRITE_TARGET, _PROJECT_SENSITIVE_WRITE_TARGET]) {
    const re = new RegExp(`>>?\\s*["']?${target}`, 'is');
    if (re.test(normalized)) return target;
  }
  return null;
}

// ============ 主检测函数 ============

/** 命令检测发现项 */
export interface CommandFinding {
  type: 'hardline' | 'pattern' | 'pattern_variant' | 'exec_flag' | 'sensitive_write' | 'parser_limit';
  severity: 'critical' | 'high' | 'warning';
  message: string;
  pattern?: string;
  variant?: string;
  /** exec_flag 专属：跟随执行标志的解释器名（bash/python/perl 等） */
  flag?: string;
  interpreter?: string;
  index?: number;
}

/**
 * 检测危险命令（detect_dangerous_command）。
 * 返回 findings 数组，空数组 = 安全。
 */
export function detect_dangerous_command(command: string): CommandFinding[] {
  const findings: CommandFinding[] = [];

  // 1. 归一化
  const { normalized, limitExceeded } = _normalize_command_for_detection(command);
  if (limitExceeded) {
    findings.push({
      type: 'parser_limit',
      severity: 'warning',
      message: `命令超过解析器上限 ${_COMMAND_PARSER_LIMIT} 字符，无法安全解析`,
    });
  }

  // 2. hardline 规则（第一段 HARDLINE_PATTERNS）
  for (const [pattern, description] of HARDLINE_PATTERNS) {
    if (pattern.test(normalized)) {
      findings.push({ type: 'hardline', severity: 'critical', message: description });
    }
  }

  // 3. 剥离混淆后扫 DANGEROUS_PATTERNS
  const deobfuscated = _strip_obfuscation(normalized);
  for (const [pattern, description] of DANGEROUS_PATTERNS) {
    if (pattern.test(deobfuscated)) {
      findings.push({ type: 'pattern', severity: 'high', message: description });
    }
  }

  // 4. 命令起点 + 变体扫描（抓 basename/引号变体）
  const start = _command_start(deobfuscated);
  const mainCmd = deobfuscated.slice(start);
  for (const variant of _command_detection_variants(mainCmd)) {
    for (const [pattern, description] of DANGEROUS_PATTERNS) {
      if (pattern.test(variant)) {
        findings.push({ type: 'pattern_variant', severity: 'high', message: description, variant });
      }
    }
  }

  // 5. exec flag 检测（见 _execution_flag_findings：解释器名需要透传给调用方
  // 供 run-command 的 riskNote 区分"危险模式/解释器内联代码执行"，否则只省一条 message）
  const tokens = _shlex_split(deobfuscated);
  for (const f of _execution_flag_findings(tokens)) {
    findings.push({
      type: 'exec_flag',
      severity: 'warning',
      message: `检测到执行标志 ${f.flag}（解释器 ${f.interpreter || '未知'} 后跟代码）`,
      flag: f.flag,
      interpreter: f.interpreter,
      index: f.index,
    });
  }

  // 6. 敏感写目标
  const writeTarget = _sensitive_write_target(normalized);
  if (writeTarget) {
    findings.push({ type: 'sensitive_write', severity: 'high', message: `重定向写敏感路径 ${writeTarget}` });
  }

  // 7. 验证产物豁免：仅当命中非 critical 的 rm 类问题时才降级。
  // 修复记录（评审 CRITICAL）：旧实现无条件过滤掉 hardline/pattern 全部命中，
  // 恶意命令带 verification_artifact 子串即可绕过 rm -rf / 硬线；现在 critical
  // （hardline）永不豁免——删根/删系统目录/删 home 不存在任何「清理验证产物」的
  // 正当语义，yolo 之下也不可放行。
  if (_is_verification_artifact_cleanup(normalized)) {
    return findings.filter(
      (f) => f.severity === 'critical' || f.type === 'exec_flag' || f.type === 'parser_limit'
    )
  }

  return findings;
}

// ============ 兼容入口 ============

/** 供上层判断危险命令是否命中（yolo 可放行，默认询问用户） */
export function checkDangerous(command: string): BlockResult {
  const findings = detect_dangerous_command(command);
  if (findings.length === 0) {
    return { blocked: false, description: null };
  }
  const critical = findings.find((f) => f.severity === 'critical');
  const top = critical ?? findings[0];
  return {
    blocked: true,
    description: top.message,
    reason: top.severity === 'critical' ? 'hardline' : 'dangerous',
  };
}

