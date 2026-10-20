/**
 * 命令只读判别（参数级）。
 * 为什么存在：run_command 的语义只读此前是「命令名在只读清单 + 单条简单命令」的粗判，
 * 参数中的写意图（重定向、命令专用写标志）无法识别——`echo hi > config.txt`、
 * `curl -o a.url https://...` 这类命令因命令名只读会被 autoAllowReadonly 免审，
 * 等于打开一条静默写文件/写网端的通道（评审关注点）。
 * 作用：在命令名只读的基础上做参数级写意图判别，命中写重定向或命令专用写标志即判定
 * 非只读，阻止只读自动放行；未命中写意图保持只读，减少只读命令的询问骚扰。
 * 设计约束：只做判别不做决策（危险检测永远优先）；全部识别失败时默认返回 readonly=true
 * （判别器不拦截命令，真正拦截由 run_command 的黑名单/危险检测负责）。
 */
export interface ReadonlyCheckResult {
  readonly: boolean
  /** 非只读原因（审计/审批提示用） */
  reason?: string
}

// ─── 写重定向识别 ─────────────────────────────────────────────────────────
// 覆盖 POSIX 风格的 `>`/`>>`/`2>` 与 `>|` 强制覆盖写（排除 `<<` heredoc 输入与
// `<>` 读写复用）以及 PowerShell 的写管道（Out-File / Set-Content / Tee-Object / Export-Csv 等）。
// 为什么不用简单的 /[^!]>>?/：`<<` 是输入 heredoc（只读），`2>` 是 stderr 写（写）；
// `>|` 的管道符排除在分隔符集外——bash noclobber 关闭/`>|` 显式覆盖仍会创建文件，属写。
const POSIX_WRITE_REDIRECT = /(^|[^!<>])(?:>>?|2>>?)\s*[^\s&;<>]+/
const PS_WRITE_PIPE = /\|\s*(?:Out-File|Set-Content|Tee-Object|Export-Csv|Export-Clixml|Add-Content|ConvertTo-Json\s*\||Out-String\s*\|)\b/i

// ─── 命令专用写标志（白名单只读命令之外的高频命令）────────────────────────
// 结构：命令全文正则（含命令词边界）→ 写标志命中即非只读。只放「命令名可能出现在
// 只读清单/白名单且带参数后会写」的命令；其余命令交给白名单/灰名单判定。
const COMMAND_WRITE_FLAGS: Array<{ test: RegExp; reason: string }> = [
  // curl 拆为三条：短/长写文件选项、数据/表单选项（-d/-F 独立短标志，可组合 `-X POST -d ...`）、显式写方法
  // 短/长选项支持 `-o file`、`-o=file`、`--output file`、`--output=file`、`-O`（大写）等合法形态
  { test: /\bcurl\s+(?:-[^o\s]*o(?:[=\s]|$)|--output(?:-dir)?(?:[=\s]|$)|-O(?:\s|$)|--remote-name(?:\s|$)|-T(?:\s|$)|--upload-file(?:\s|$))/i, reason: 'curl 写文件（-o/-O/-T 等）' },
  { test: /\bcurl\s+(?:-d|--data(?:-binary|-raw)?|-F|--form)(?:\s|$)/i, reason: 'curl 发送数据/表单（写请求）' },
  { test: /\bcurl\s+(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)(?:\s|$)/i, reason: 'curl 显式写方法请求' },
  { test: /\bwget\s+(?:-O|--output-document|--input-file|--post-data|--post-file)(?:\s|$)/i, reason: 'wget 写文件/发起写请求' },
  { test: /\bsed\s+-i\b/i, reason: 'sed -i 原地编辑' },
  { test: /\bgit\s+(?:add|commit|push|pull|fetch|merge|rebase|reset|checkout|switch|restore|stash|rm|mv|clean|init|clone|branch|tag|config|apply|am|cherry-pick|revert)(?:$|\s)/i, reason: 'git 写操作子命令' },
  { test: /\b(?:npm|pnpm|yarn)\s+(?:install|i|ci|add|publish|pack|dedupe|rebuild|link|unlink)(?:$|\s)/i, reason: '包管理器执行写类操作' },
  { test: /\b(?:python|python3|py|node|npx)\s+(?:-c|-e|-m\s+[\w.]+)\b/i, reason: '解释器内联执行（等价任意命令）' }
]

/** 重定向/管道写意图判别（纯函数）：只识别「把任意只读命令升级为写文件」的形态——
 * `>`/`>>`/`2>`/`>|` 写重定向与 PowerShell 写管道。命令自带写标志（npm install、
 * curl -o、git add 等）由命令自身语义承担（白名单已配置信任、灰名单走询问），
 * 不属「伪装只读」的静默通道，不在此判别。供 run_command 主通道与后台 HOOK 共用，
 * 防规则漂移：白名单命令带重定向写一律降级询问/拒绝（堵 `echo hi > config.txt`）。 */
export function isRedirectWriteIntent(command: string): boolean {
  if (POSIX_WRITE_REDIRECT.test(command) && !isHereDocOnly(command)) return true
  if (PS_WRITE_PIPE.test(command)) return true
  return false
}

/** 命令级写意图判别（纯函数，不依赖策略；未知情况默认只读） */
export function isReadonlyCommand(command: string): ReadonlyCheckResult {
  // 1. 写重定向：任何命令带 `>`/`>>`/`2>` 或 PowerShell 写管道 = 非只读
  if (POSIX_WRITE_REDIRECT.test(command) && !isHereDocOnly(command)) {
    return { readonly: false, reason: '命令含写重定向（> 或 >>）' }
  }
  if (PS_WRITE_PIPE.test(command)) {
    return { readonly: false, reason: '命令含 PowerShell 写管道（Out-File/Set-Content 等）' }
  }

  // 2. git 只读子命令特化必须先于写标志遍历：`git config --list` 里的 `config`
  //    在下方 git 写操作正则（含 config）中，若先遍历会误判为非只读，
  //    后面的只读特化分支永远不会执行。只读子命令明确放行后，其余 git 写操作照常非只读。
  if (/\bgit\s+(?:status|log|diff|show|branch\s+-[lrv]|tag\s+-[ln]|ls-files|remote\s+-v|help|config\s+--get|config\s+--list)\b/i.test(command)) {
    return { readonly: true }
  }
  // 3. 命令专用写标志（只对已识别的命令生效）
  for (const rule of COMMAND_WRITE_FLAGS) {
    if (rule.test.test(command)) {
      return { readonly: false, reason: rule.reason }
    }
  }

  return { readonly: true }
}

/**
 * 判断命令是否只有 heredoc（<<）输入而无写重定向。
 * 为什么存在：`cat <<EOF` 中 `<<` 的字符序列会被 POSIX_WRITE_REDIRECT 的排除逻辑
 * 拒绝（`[^!<>]` 前导 + `>>?` 模式实际能匹配 `<<` 的一部分），需要显式排除。
 */
function isHereDocOnly(command: string): boolean {
  // 剥掉 heredoc 段（<< EOF ... EOF），剩余若还有写重定向则是写。
  // 复用 POSIX_WRITE_REDIRECT 常量，避免正则漂移（此前内联副本未同步 >| 形态）。
  const stripped = command.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\1/g, '')
  return POSIX_WRITE_REDIRECT.test(stripped) === false
}