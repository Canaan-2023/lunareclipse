/**
 * 健康检查语义扫描（code-review 维度 + UI/UX 维度）
 * ------------------------------------------------------------
 * 在 typecheck/test/lint/build/files 五维机械检查之上，补充两类「静态语义审计」，
 * 让健康检查覆盖如下完整作用：
 * - code-review 维度：扫描源码中的代码质量/安全反模式（调试残留、类型绕过、
 * 动态执行、注入风险、密钥硬编码、空 catch 吞错、any 滥用、TODO 残留）
 * - uiux 维度：扫描 UI 代码中的可访问性/设计缺陷（纯图标按钮无无障碍名、
 * img 缺 alt、Tailwind 硬编码色、内联字体无回退）

 * 设计原则（避免「误报刷屏」）：
 * 1. 只报「确定性高、可定位」的模式（文件:行号），启发式条目标注「疑似，请确认」；
 * 2. 每类限制条数 + 输出首行汇总（扫描量与命中量），超限折叠告警；
 * 3. 输出经 AlertGate 指纹去重：同问题不反复唤醒 AI，修复后清单变化才重新提醒。

 * 纯函数，不依赖 HealthCheck 实例状态，可独立单测。
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import type { Dirent } from 'fs'
import { join } from 'path'

/**
 * 扫描时排除的目录。
 * 产物/依赖/第三方源码不属于「本工作区代码」：报它们只会产生无法修复的噪音。
 * - node_modules/dist/out/build/coverage/.next/.nuxt/.userdata：产物与依赖
 * - .playwright-browsers：Playwright 浏览器二进制（内置 JS 有大量 TODO/eval，纯噪音）
 * - vendor：第三方 vendored 库（上游代码，其 @ts-ignore/any/TODO 不归本项目修）
 * - test：测试代码（含构造样本字符串，如 '<img'、'<button><Icon/>'，会误命中规则，
 * 且其正确性已由 test 检查项与 typecheck 保障）
 * - data/tmp/temp：数据与临时目录
 */
const EXCLUDE_DIRS = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.userdata',
  'userdata',
  '.playwright-browsers',
  'vendor',
  'test',
  'data',
  'tmp',
  'temp'
])

/** 只扫源码扩展名（二进制/大文件/文档不扫，避免误报示例代码） */
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/i

/** 单文件读取上限（超出视为大文件跳过，避免读入压缩产物/生成文件） */
const MAX_FILE_BYTES = 1_000_000

/** 单类问题最大输出条数（防告警爆炸，汇总行保留总计） */
const MAX_ISSUES_PER_KIND = 30

/** 归一化相对路径（相对扫描根，输出可定位、指纹稳定） */
function relPath(root: string, full: string): string {
  const r = full.startsWith(root) ? full.slice(root.length) : full
  return r.replace(/\\/g, '/').replace(/^\//, '')
}

/** 计算行号（内容前缀中 \n 数量 + 1） */
function lineOf(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++
  }
  return line
}

/** 规则定义文件自身豁免：其规则模式以字符串形式写在代码里（debugger/@ts-ignore/<img 等），
 * 会被自己的正则命中造成噪音——这是 linter 自查的普遍惯例（不扫描定义规则的文件）。 */
const SELF_FILE = 'health-semantic-scan.ts'

/** 收集需扫描的文件列表（深度 ≤8，maxFiles 上限，排除产物目录） */
function collectFiles(root: string, maxFiles: number): string[] {
  const files: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || files.length >= maxFiles) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (files.length >= maxFiles) return
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.has(e.name)) continue
        walk(full, depth + 1)
      } else if (e.isFile() && CODE_EXT.test(e.name) && e.name !== SELF_FILE) {
        try {
          if (statSync(full).size <= MAX_FILE_BYTES) files.push(full)
        } catch {
          /* 权限/占用忽略 */
        }
      }
    }
  }
  walk(root, 0)
  return files
}

// ============================================================
// code-review 维度扫描
// ============================================================

interface RegexRule {
  kind: string
  label: string
  re: RegExp
  /** 命中即疑似（有歧义），提示 AI 确认而非直接定性 */
  heuristic?: boolean
}

const CODE_REVIEW_RULES: RegexRule[] = [
  {
    kind: 'debugger',
    label: 'debugger 语句残留（调试断点泄漏到源码）',
    re: /\bdebugger\s*;?/g
  },
  {
    kind: 'eval',
    label: 'eval/动态代码执行（安全与性能风险，若必须请白名单校验输入）',
    re: /\beval\s*\(|\bnew\s+Function\s*\(/g,
    heuristic: true
  },
  {
    kind: 'ts-ignore',
    label: '@ts-ignore 绕过类型检查（类型债，建议修复类型而非压制）',
    // 只在「注释行首」算压制指令：真正的 @ts-ignore 必须是注释且独占行首
    // （`// @ts-ignore` / `/* @ts-nocheck */` / JSDoc 的 `* @ts-ignore`）。
    // 为什么必须收窄（原文案是 /@ts-ignore\b|@ts-nocheck\b/g 全文匹配）：正文里一旦
    // 提到这两个词就会被报成「绕过类型检查」——实测 cordis-mounter.ts 的 JSDoc 解释
    // 文字（说明 vendor 目录整体关闭了类型检查）被误报，属规则自身的误报，
    // 而本模块的设计原则第一条就是「避免误报刷屏」。
    // 不删理由：注释行首锚定是这条规则唯一能同时「抓住真压制」与「放过提及」的写法；
    // 删除（退回全文匹配）会让解释性注释持续产生无法修复的假问题、白耗 AI 修复额度。
    re: /^[ \t]*(?:\/\/+|\/\*+|\*)[ \t]*@ts-(?:ignore|nocheck)\b/gm
  },
  {
    kind: 'dangerouslySetInnerHTML',
    label: 'dangerouslySetInnerHTML 直接注入 HTML（XSS 风险，确认内容非用户输入）',
    re: /dangerouslySetInnerHTML/g,
    heuristic: true
  },
  {
    kind: 'innerHTML-write',
    label: '.innerHTML = 写 DOM（XSS 风险，推荐 textContent/createElement）',
    re: /\.innerHTML\s*=/g,
    heuristic: true
  },
  {
    kind: 'secret',
    label: '疑似密钥/令牌硬编码（API Key/Token/密码字面量，应移入 .env）',
    re: /\bsk-[A-Za-z0-9_-]{16,}\b|(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*['"][^'"]{12,}['"]/gi,
    heuristic: true
  },
  {
    kind: 'todo',
    label: 'TODO/FIXME/HACK 待办残留（未完成工作标记）',
    re: /\/\/\s*(?:TODO|FIXME|HACK|XXX)\b/g
  }
]

/**
 * 空 catch 吞错专项扫描。

 * 为什么不能走通用掩码正则：掩码会把 catch 块内代码抹成空白，导致
 * `catch (e) { log(err) }` 这类「非空但单行」的真实代码被误判为空 catch；
 * 而直接扫原始文本又会让字符串内的 `'catch(e){}'` 误报。

 * 因此采用「候选 + 校验」两步：
 * 1. 原始文本用「空块正则」找候选 —— 块内仅空白（含跨行），无代码/注释（非空不匹配）；
 * 2. 掩码文本同位置再校验 —— 字符串/模板/正则字面量内的 catch 字样已被抹平，校验不过即跳过。
 */
function scanEmptyCatches(
  content: string,
  masked: string,
  file: string,
  totals: Record<string, number>,
  push: (text: string) => void
): void {
  const kind = 'empty-catch'
  const label = '空 catch 吞错（异常被静默丢弃，调试困难，至少 log 一行）'
  // 空块形态（跨行生效）：catch(...) 后跟 { }，块内仅空白 —— 注释/换行说明（如
  // `catch(e) {\n // 有意忽略\n }`）会被注释字符挡住不匹配，避免误报有说明的合理忽略。
  const re = /catch[^\S\n]*(?:\([^)\n]*\))?[^\S\n]*\{\s*\}/g
  const verifyRe = /catch[^\S\n]*(?:\([^)\n]*\))?[^\S\n]*\{\s*\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    // 掩码校验：同位置在掩码文本上必须仍构成同样的空块形态
    verifyRe.lastIndex = m.index
    const v = verifyRe.exec(masked)
    if (!v || v[0] !== m[0]) continue
    totals[kind] = (totals[kind] ?? 0) + 1
    const line = lineOf(content, m.index)
    push(`（疑似）${file}:${line} ${label}，请确认`)
  }
}

/**
 * 非代码内容掩码：把字符串字面量、模板字符串（保留 ${} 插值代码）、正则字面量、
 * 以及（可选）注释的内容替换为等长空白（保留换行与列号），使模式规则只命中「目标文本」。

 * 不同规则需要不同的掩码策略：
 * - @ts-ignore / TODO 本身就是注释内信号 → 必须保留注释（maskComments=false）
 * - secret 检测要求看字符串原始内容 → 必须保留字符串（maskStrings=false）
 * - 其余规则面向「真实代码」→ 字符串/模板/正则/注释全掩码

 * 用途：避免把字符串/模板/正则/注释里的模式字样（如 catch(e){}、eval(、.innerHTML=）
 * 误判为缺陷，同时保留每类规则真实需要的语义输入。
 */
function maskNonCode(
  content: string,
  opts: { maskStrings?: boolean; maskComments?: boolean } = {}
): string {
  const { maskStrings = true, maskComments = true } = opts
  const n = content.length
  const out = content.split('')
  const blank = (from: number, to: number): void => {
    for (let k = Math.max(0, from); k < Math.min(to, n); k++) {
      if (content[k] !== '\n') out[k] = ' '
    }
  }
  // 判断 / 是正则字面量起始（而非除法）：前一个非空白字符不是标识符/数字/闭括号
  const isRegExpStart = (idx: number): boolean => {
    let p = idx - 1
    while (p >= 0 && /\s/.test(content[p])) p--
    if (p < 0) return true
    return !/[A-Za-z0-9_)\]$]/.test(content[p])
  }

  let i = 0
  while (i < n) {
    const c = content[i]
    const nx = content[i + 1]
    // 行注释 / 块注释：maskComments=false 时不掩码（@ts-ignore / TODO 依赖注释内容）
    if (c === '/' && nx === '/') {
      if (maskComments) {
        const end = content.indexOf('\n', i)
        blank(i, end === -1 ? n : end)
        i = end === -1 ? n : end
      } else {
        i += 2
      }
      continue
    }
    if (c === '/' && nx === '*') {
      if (maskComments) {
        let end = content.indexOf('*/', i + 2)
        end = end === -1 ? n : end + 2
        blank(i, end)
        i = end
      } else {
        i += 2
        while (i < n && !(content[i] === '*' && content[i + 1] === '/')) i++
        i = Math.min(i + 2, n)
      }
      continue
    }
    // 字符串字面量
    if (c === "'" || c === '"') {
      if (!maskStrings) {
        i += 2
        continue
      }
      let j = i + 1
      while (j < n) {
        if (content[j] === '\\') { j += 2; continue }
        if (content[j] === c) break
        j++
      }
      blank(i, j + 1)
      i = j + 1
      continue
    }
    // 模板字符串：普通文本掩码，${...} 插值内代码保留
    if (c === '`') {
      if (!maskStrings) {
        i += 2
        continue
      }
      const keep: Array<[number, number]> = []
      let j = i + 1
      while (j < n) {
        if (content[j] === '\\') { j += 2; continue }
        if (content[j] === '`') break
        if (content[j] === '$' && content[j + 1] === '{') {
          const st = j + 2
          let depth = 1
          let k = st
          while (k < n && depth > 0) {
            if (content[k] === '{') depth++
            else if (content[k] === '}') depth--
            else if (content[k] === "'" || content[k] === '"') {
              const q = content[k]
              k++
              while (k < n && content[k] !== q) {
                if (content[k] === '\\') k++
                k++
              }
            }
            k++
          }
          if (st <= k - 2) keep.push([st, k - 2])
          j = k
          continue
        }
        j++
      }
      const end = Math.min(j, n)
      for (let k = i; k < end; k++) {
        if (content[k] === '\n') continue
        let inKeep = false
        for (const [s, e] of keep) {
          if (k >= s && k <= e) { inKeep = true; break }
        }
        if (!inKeep) out[k] = ' '
      }
      i = end
      continue
    }
    // 正则字面量
    if (c === '/' && isRegExpStart(i)) {
      let j = i + 1
      let inClass = false
      while (j < n) {
        if (content[j] === '\\') { j += 2; continue }
        if (content[j] === '[') inClass = true
        else if (content[j] === ']') inClass = false
        else if (content[j] === '/' && !inClass) break
        j++
      }
      blank(i, j + 1)
      i = j + 1
      continue
    }
    i++
  }
  return out.join('')
}

/**
 * 行豁免：命中行及其相邻行（上/下一行）含 `health-scan: ignore` 时返回豁免的 kind 集合
 * （-kind 限定只豁免该规则；无后缀 = 豁免全部规则）。
 * 上一行覆盖「注释置于命中代码上方」的写法；下一行覆盖跨行块（如 catch(e) {\n // 注释\n }）
 * 中块内首行注释的写法。用于「形态匹配规则但人工/AI 审查已确认安全」的条目，留下显式审计痕迹。
 */
function exemptKindsOfLine(lines: string[], line: number): Set<string> | null {
  const candidates = [
    lines[line - 1] ?? '',
    ...(line >= 2 ? [lines[line - 2] ?? ''] : []),
    ...(line < lines.length ? [lines[line] ?? ''] : [])
  ]
  const kinds = new Set<string>()
  let any = false
  for (const seg of candidates) {
    const m = /health-scan:\s*ignore(?:-([a-z0-9-]+))?/i.exec(seg)
    if (m) {
      any = true
      if (m[1]) kinds.add(m[1].toLowerCase())
    }
  }
  return any ? kinds : null
}

/**
 * 统计 any 滥用（: any / as any），按文件聚合输出 Top 文件
 */
function scanAnyAbuse(root: string, files: string[]): string[] {
  const perFile: Array<{ file: string; count: number; firstLine: number }> = []
  for (const full of files) {
    try {
      const content = readFileSync(full, 'utf-8')
      const masked = maskNonCode(content)
      let count = 0
      let firstLine = 0
      const re = /\bas\s+any\b|:\s*any\b/g
      let m: RegExpExecArray | null
      while ((m = re.exec(masked)) !== null) {
        if (count === 0) firstLine = lineOf(masked, m.index)
        count++
      }
      if (count > 0) perFile.push({ file: relPath(root, full), count, firstLine })
    } catch {
      /* ignore */
    }
  }
  perFile.sort((a, b) => b.count - a.count)
  return perFile
    .slice(0, 5)
    .map((p) => `any 滥用 ${p.file}:${p.firstLine}（本文件共 ${p.count} 处）`)
}

/**
 * semantic 扫描结果：
 * - summary = 首行汇总（「扫描 N 个源码文件，发现 X 处」，用于通知消息头部）
 * - issues = 问题条目（文件:行号 描述，空数组 = 通过）
 */
export interface SemanticScanResult {
  summary: string
  issues: string[]
}

/**
 * code-review 维度扫描：返回问题清单（每项一行，首行为汇总）。
 * 定位格式：`文件:行号`，启发式条目带「（疑似）」前缀。
 */
export function scanCodeReviewIssues(root: string, opts: { maxFiles?: number } = {}): SemanticScanResult {
  const maxFiles = opts.maxFiles ?? 2000
  const files = collectFiles(root, maxFiles)
  const issues: string[] = []
  const totals: Record<string, number> = {}

  const push = (text: string): void => {
    if (issues.length < MAX_ISSUES_PER_KIND) issues.push(text)
  }

for (const full of files) {
    let content: string
    try {
      content = readFileSync(full, 'utf-8')
    } catch {
      continue
    }
    const file = relPath(root, full)
    // 掩码策略按规则语义分层：
    // - ts-ignore / todo 依赖注释内容 → maskComments=false 保留注释
    // - secret 依赖字符串原始内容 → maskStrings=false 保留字符串
    // - 其余规则面向真实代码 → 全掩码
    const maskedKeepComments = maskNonCode(content, { maskStrings: true, maskComments: false })
    const maskedKeepStrings = maskNonCode(content, { maskStrings: false, maskComments: true })
    const maskedAll = maskNonCode(content)
    const lines = content.split('\n')
    for (const rule of CODE_REVIEW_RULES) {
      const haystack =
        rule.kind === 'ts-ignore' || rule.kind === 'todo'
          ? maskedKeepComments
          : rule.kind === 'secret'
            ? maskedKeepStrings
            : maskedAll
      let m: RegExpExecArray | null
      rule.re.lastIndex = 0
      while ((m = rule.re.exec(haystack)) !== null) {
        const line = lineOf(haystack, m.index)
        // 显式豁免：命中行或上一行带 health-scan: ignore[-kind] 注释 → 跳过（审计确认过安全）
        const exempt = exemptKindsOfLine(lines, line)
        if (exempt !== null && (exempt.size === 0 || exempt.has(rule.kind))) continue
        // 总量全量统计（摘要展示真实问题数），输出条目限量防刷屏
        totals[rule.kind] = (totals[rule.kind] ?? 0) + 1
        push(
          `${rule.heuristic ? '（疑似）' : ''}${file}:${line} ${rule.label}${rule.heuristic ? '，请确认' : ''}`
        )
      }
    }
    // 空 catch 吞错：原始文本找候选 + 掩码校验（见 scanEmptyCatches）
    scanEmptyCatches(content, maskedAll, file, totals, (text) => {
      const line = parseInt(text.match(/:(\d+)/)?.[1] ?? '0', 10)
      const exempt = exemptKindsOfLine(lines, line)
      if (exempt === null || !(exempt.size === 0 || exempt.has('empty-catch'))) push(text)
    })
  }

  // any 滥用（独立聚合规则，不占用单条上限）
  const anyIssues = scanAnyAbuse(root, files)
  const totalHit =
    Object.values(totals).reduce((a, b) => a + b, 0) +
    anyIssues.reduce((a, l) => a + parseInt(l.match(/共 (\d+) 处/)?.[1] ?? '0', 10), 0)
  return {
    summary: `扫描 ${files.length} 个源码文件，发现 code-review 问题 ${totalHit} 处`,
    issues: [...issues, ...anyIssues]
  }
}

// ============================================================
// UI/UX 维度扫描
// ============================================================

/**
 * 在源码中按模式提取命中行（返回 {file, line, text} 列表，含上限）。
 * 处理逻辑各扫描器不同，分别实现。
 */

/** img 缺 alt：提 <img 标签到 >，检查是否有 alt= */
function scanImgAlt(root: string, files: string[]): string[] {
  const out: string[] = []
  for (const full of files) {
    if (out.length >= MAX_ISSUES_PER_KIND) break
    let content: string
    try {
      content = readFileSync(full, 'utf-8')
    } catch {
      continue
    }
    let idx = content.indexOf('<img')
    while (idx !== -1 && out.length < MAX_ISSUES_PER_KIND) {
      // 跳过注释行中的 <img>（JSDoc/说明文档里常见 "<img> 标签"字样，不是真实 JSX 节点）
      const lineStart = content.lastIndexOf('\n', idx) + 1
      const lineHead = content.slice(lineStart, idx).trimStart()
      if (lineHead.startsWith('//') || lineHead.startsWith('*') || lineHead.startsWith('/*')) {
        idx = content.indexOf('<img', idx + 4)
        continue
      }
      const tagEnd = content.indexOf('>', idx)
      if (tagEnd === -1) break
      const tag = content.slice(idx, tagEnd + 1)
      if (!/alt\s*=/.test(tag) && !/aria-hidden\s*=\s*["']?true/i.test(tag)) {
        out.push(`${relPath(root, full)}:${lineOf(content, idx)} <img> 缺少 alt 无障碍文本（装饰图应加 alt="" 或 aria-hidden）`)
      }
      idx = content.indexOf('<img', tagEnd)
    }
  }
  return out
}

/** 纯图标按钮无 title/aria-label：提取 <button>...</button> 标签对，属性无无障碍名且内容以 < 开头（图标组件） */
function scanIconButtons(root: string, files: string[]): string[] {
  const out: string[] = []
  for (const full of files) {
    if (out.length >= MAX_ISSUES_PER_KIND) break
    let content: string
    try {
      content = readFileSync(full, 'utf-8')
    } catch {
      continue
    }
    let idx = content.indexOf('<button')
    while (idx !== -1 && out.length < MAX_ISSUES_PER_KIND) {
      const tagEnd = content.indexOf('>', idx)
      if (tagEnd === -1) break
      const openTag = content.slice(idx, tagEnd + 1)
      const hasA11yName =
        /title\s*=/.test(openTag) ||
        /aria-label\s*=/.test(openTag) ||
        /aria-labelledby\s*=/.test(openTag)
      if (!hasA11yName) {
        const closeIdx = content.indexOf('</button>', tagEnd)
        const inner = content.slice(tagEnd + 1, closeIdx === -1 ? tagEnd + 1 : closeIdx)
        // 内容以 < 开头（图标/组件子节点）且无可读文本 → 纯图标按钮
        const readText = inner.replace(/<[^>]*>/g, '').trim()
        if (inner.trimStart().startsWith('<') && readText.length === 0) {
          out.push(
            `${relPath(root, full)}:${lineOf(content, idx)} <button> 纯图标按钮缺少 title/aria-label（辅助技术无法读出用途）`
          )
        }
      }
      idx = content.indexOf('<button', tagEnd)
    }
  }
  return out
}

/** Tailwind 硬编码颜色（text-[#..]/bg-[#..] 等任意值，应走主题语义 token） */
function scanHardcodedColors(root: string, files: string[]): string[] {
  const out: string[] = []
  const re = /(?:text|bg|border|ring|fill|stroke)-\[(?:#[0-9a-fA-F]{3,8}|(?:rgb|hsl)a?\([^)]*\))/g
  for (const full of files) {
    if (out.length >= MAX_ISSUES_PER_KIND) break
    let content: string
    try {
      content = readFileSync(full, 'utf-8')
    } catch {
      continue
    }
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null && out.length < MAX_ISSUES_PER_KIND) {
      out.push(
        `${relPath(root, full)}:${lineOf(content, m.index)} 硬编码颜色 ${m[0]}（建议使用主题 token，深色主题/换肤时不随主题）`
      )
    }
  }
  return out
}

/** 内联 fontFamily 无回退（单字体值，缺字体时无兜底） */
function scanFontFallback(root: string, files: string[]): string[] {
  const out: string[] = []
  const re = /fontFamily:\s*['"][^'",;{}]+?['"]/g
  for (const full of files) {
    if (out.length >= MAX_ISSUES_PER_KIND) break
    let content: string
    try {
      content = readFileSync(full, 'utf-8')
    } catch {
      continue
    }
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null && out.length < MAX_ISSUES_PER_KIND) {
      out.push(
        `${relPath(root, full)}:${lineOf(content, m.index)} 内联 fontFamily 无回退字体（建议补 sans-serif 等通用回退）`
      )
    }
  }
  return out
}

/**
 * UI/UX 维度扫描：返回问题清单（每项一行，首行为汇总）。
 * 覆盖可访问性（图标按钮无障碍名 / img alt）与设计一致性（硬编码色 / 字体回退）。
 */
export function scanUiUxIssues(root: string, opts: { maxFiles?: number } = {}): SemanticScanResult {
  const maxFiles = opts.maxFiles ?? 2000
  const files = collectFiles(root, maxFiles)
  const issues: string[] = []
  issues.push(...scanImgAlt(root, files))
  issues.push(...scanIconButtons(root, files))
  issues.push(...scanHardcodedColors(root, files))
  issues.push(...scanFontFallback(root, files))
  return {
    summary: `扫描 ${files.length} 个源码文件，发现 UI/UX 问题 ${issues.length} 处`,
    issues: issues.slice(0, MAX_ISSUES_PER_KIND)
  }
}