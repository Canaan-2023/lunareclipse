/**
 * sed -i 内联编辑解析器。
 * 为什么存在：sed -i 把「读」升级为「原地写」——仅靠命令名只读判别无法覆盖
 * （sed 不带 -i 是只读、带 -i 是写）；且内联编辑脚本（s/old/new/、/pat/d）可能隐含
 * 危险表达式（整行删除、控制字符注入、替换为命令替换等），需要参数级解析才能精确判定。
 * 作用：解析 `sed -i 's/old/new/g' file` / `sed -e '...' -e '...' -i file` 结构，
 * 用分隔符占位方式安全拆分编辑表达式，输出结构供 run_command 的只读/危险判别使用。
 * 设计约束：只解析 sed 脚本结构（BRE/ERE 转换不做——那是语法树范畴，月蚀以参数级
 * 解析替代，见工具层改造方案 M4）；解析失败时返回空结果（不误拦）。
 */
export interface SedEditScript {
  /** 编辑表达式原文（如 s/old/new/g、/pat/d、3d） */
  expression: string
  /** 编辑命令字母（s 替换 / d 删除 / a 追加 / i 插入 / c 整行替换 / p 打印 / q 退出） */
  command: 's' | 'd' | 'a' | 'i' | 'c' | 'p' | 'q' | string
  /** 替换模式（s 命令） */
  pattern?: string
  /** 替换文本（s 命令） */
  replacement?: string
  /** 标志（s 命令的 g/i/p/w 等） */
  flags?: string
}

export interface SedEditParseResult {
  /** 解析出的编辑脚本（多为 1 个；多个 -e 合并） */
  edits: SedEditScript[]
  /** 目标文件（非选项参数） */
  files: string[]
  /** 是否 -i（原地写；含 -i.bak 备份形式） */
  inPlace: boolean
  /** 是否命中危险编辑（整行删除 / 控制字符注入 / 替换含命令替换） */
  dangerous: boolean
  /** 危险原因（dangerous=true 时） */
  reason?: string
}

/** 解析 sed 命令行（纯函数）：首词为 sed 时返回结构，否则返回空结果 */
export function parseSedEditCommand(command: string): SedEditParseResult {
  const result: SedEditParseResult = { edits: [], files: [], inPlace: false, dangerous: false }

  // 首词必须是 sed（大小写不敏感，允许带路径/exe 后缀）
  if (!/^\s*(?:[.\w/\\-]*\\)?sed(?:\.exe)?\b/i.test(command)) return result

  // 按空白切 token（引号内的空白不切——简单 lexer）
  const tokens = tokenizeShellWords(command.trim())
  const scripts: string[] = []
  let afterDoubleDash = false

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (i === 0) continue // sed 本身

    // -- 之后全部是文件
    if (tok === '--') {
      afterDoubleDash = true
      continue
    }
    if (afterDoubleDash) {
      if (tok.length > 0 && !tok.startsWith('-')) result.files.push(tok)
      continue
    }

    // 选项
    if (tok === '-i' || tok === '--in-place') {
      result.inPlace = true
      continue
    }
    // -i.bak / --in-place=.bak
    if (/^-i\.[^=]+$/.test(tok) || /^--in-place=\S+$/.test(tok)) {
      result.inPlace = true
      continue
    }
    if (tok === '-e' || tok === '--expression') {
      const next = tokens[i + 1]
      if (next !== undefined) {
        scripts.push(next)
        i++
      }
      continue
    }
    if (/^--expression=/.test(tok)) {
      scripts.push(tok.slice('--expression='.length))
      continue
    }
    if (tok.startsWith('-')) {
      // 其他选项（-n/-E/-r 等）：跳过
      continue
    }

    // 非选项参数 = 编辑脚本 或 文件
    // sed 参数顺序：脚本在前、文件在后（多个脚本需要 -e 显式区分，裸脚本只有一个）
    if (isSedScriptShape(tok)) {
      scripts.push(tok)
    } else {
      result.files.push(tok)
    }
  }

  // 解析脚本并做危险检测
  let dangerousReason: string | undefined
  for (const script of scripts) {
    const edit = parseSedScript(script)
    if (!edit) continue
    result.edits.push(edit)
    const danger = assessDanger(edit)
    if (danger) {
      result.dangerous = true
      dangerousReason = danger
    }
  }
  if (result.dangerous) result.reason = dangerousReason
  return result
}

/** 判断 token 是否是 sed 脚本形态：以地址（数字/$/正则开头）或命令字母（s/d/a/i/c/p/q）开头 */
function isSedScriptShape(tok: string): boolean {
  if (tok.length === 0) return false
  // 命令字母开头：s/ d/ a/ i/ c/ p/ q 后跟分隔符或空白
  if (/^[sdai cpq]/.test(tok)) {
    // 文件路径也可能以这些字母开头（如 delete.txt）——要求第 2 字符是脚本分隔符或数字地址
    if (/^[sdai cpq][^a-z0-9_.-]/.test(tok)) return true
  }
  // 地址开头：数字、$、/regex/、\d,\d
  if (/^(\d+|\$)(,\s*(\d+|\$))?[sdai cpq]/.test(tok)) return true
  if (/^\/.*\/[sdai cpq]/.test(tok)) return true
  return false
}

/** sed 动作命令字母（s 替换 / d 删除 / a 追加 / i 插入 / c 整行替换 / p 打印 / q 退出） */
const SED_ACTION_RE = /[sdai cpq]/

/** 剥离 sed 地址前缀（数字 / $ / 正则，含 地址1,地址2 与 ! 取反），返回命令主体。
 * 为什么必须剥离：`/pat/q` 若从开头扫首个字符，会把地址正则里的 p/d 误当成命令
 * 字母（`/pat/d` 误判为 p、`/debug/q` 误判为 d）——漏拦删除或误拦退出，都是错误
 * 裁决。解析失败/非地址开头时原样返回，由上层按剩余首字符判断动作字母。 */
function stripSedAddress(script: string): string {
  // 地址：数字（含 0-addr）、$、/regex/（允许转义 \/）；组合 1,2 / 1,$ / $,N / /re/,N；尾随 ! 取反
  const addr = /^(?:\d+|\$|\/(?:[^/\\]|\\.)*\/)(?:\s*,\s*(?:\d+|\$|\/(?:[^/\\]|\\.)*\/))?!?/
  const m = script.match(addr)
  return m ? script.slice(m[0].length) : script
}

/** 解析单个 sed 脚本：s 命令拆 pattern/replacement/flags；其余命令只取命令字母 */
function parseSedScript(script: string): SedEditScript | undefined {
  if (script.length === 0) return undefined
  // 允许地址前缀（如 3d、/pat/d、1,5s/.../.../）——先剥离地址，剩余首字符即动作字母
  const body = stripSedAddress(script)
  if (body.length === 0) return undefined
  const commandChar = body[0]
  if (!SED_ACTION_RE.test(commandChar)) return undefined
  const command = commandChar as SedEditScript['command']
  const rest = body.slice(1)

  // s 命令：s{delim}pattern{delim}replacement{delim}flags
  if (command === 's') {
    if (rest.length === 0) return { expression: script, command }
    const delim = rest[0]
    // 分隔符后的 pattern/replacement/flags（最后一个未转义分隔符之前）
    const parts = splitByDelim(rest.slice(1), delim)
    if (parts.length < 1) return { expression: script, command }
    const edit: SedEditScript = { expression: script, command, pattern: parts[0] }
    if (parts.length >= 2) {
      edit.replacement = parts[1]
      if (parts.length >= 3) edit.flags = parts.slice(2).join(delim)
    }
    return edit
  }

  return { expression: script, command }
}

/**
 * 用分隔符拆分（处理转义分隔符 \/ 与 \d）：返回分隔后的段。
 * 为什么实现：sed 的分隔符可以是任意字符（s|a|b|、s#a#b#），必须有占位式拆分，
 * 不能简单 split(delim)——那会把转义分隔符错切（占位式拆分：转义分隔符不参与切分）。
 * 转义只保留原样（不还原），供危险检测在原文上工作。
 */
function splitByDelim(input: string, delim: string): string[] {
  const parts: string[] = []
  let current = ''
  let escaped = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (escaped) {
      current += '\\' + ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === delim) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (escaped) current += '\\'
  parts.push(current)
  return parts
}

/** 危险编辑评估：整行删除 / 控制字符注入 / 替换含命令替换 */
function assessDanger(edit: SedEditScript): string | undefined {
  // d 命令（含地址前缀的 /pat/d、3d）→ 整行删除，原地编辑时破坏性
  if (edit.command === 'd') {
    return `sed 脚本执行行删除（${edit.expression}）`
  }
  // a/i/c 命令 → 插入/整行替换写行为
  if (edit.command === 'a' || edit.command === 'i' || edit.command === 'c') {
    return `sed 脚本执行插入/整行替换（${edit.expression}）`
  }
  // 替换文本含控制字符（换行注入）。
  // 两种形态都要识别：真实换行符（[\r\n]）与 sed 字面量转义（\\n / \\r = 反斜杠+n，
  // 测试与真实攻击面多以字面量形式注入，[\r\n] 一个字节都匹配不到）。
  if (edit.replacement && /(?:[\r\n]|\\[rn])/.test(edit.replacement)) {
    return `sed 替换文本含换行控制字符（${edit.expression}）`
  }
  // pattern/replacement 含命令替换（反引号 或 $(...)）——shell 先展开等价任意命令执行
  if (edit.pattern && /\$\(|`/.test(edit.pattern)) {
    return `sed 模式含命令替换（${edit.expression}）`
  }
  if (edit.replacement && /\$\(|`/.test(edit.replacement)) {
    return `sed 替换文本含命令替换（${edit.expression}）`
  }
  // /d 删除形式（地址 + d）已在 command='d' 覆盖
  return undefined
}

/** 简单 shell 词切分：正确处理单引号（sed 脚本通常单引号包裹），双引号内按普通词。
 * 引号去掉边界只保留内容：`'s/a/b/'` → `s/a/b/`，`--expression='s/a/b/'` → `--expression=s/a/b/`，
 * 后续脚本形态判断与 --expression= 前缀提取都按无引号 token 工作。 */
function tokenizeShellWords(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote) {
      if (ch === quote) {
        quote = null
        continue
      }
      current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}