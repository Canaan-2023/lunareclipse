/**
 * 为什么存在：消息正文为 AI 生成的 markdown（含表格/流式光标），
 * 项目刻意不引入重级 markdown 依赖，手写轻量渲染器保证无外部依赖与可控行为。
 * 作用：渲染轻量 Markdown——标题/列表/代码块/表格/链接/行内样式与流式生成光标。
 */
import { memo, useMemo, useState, type ReactNode } from 'react'
import { openFilePreview } from '../Workshop/FileWorkshopPanel'
import { copyText } from '../../utils/clipboard'

/**
 * 轻量 Markdown 渲染器（纯手写正则方案，无外部依赖）

 * 支持：
 * - 标题 H1-H6、段落、粗体、斜体、删除线、行内代码
 * - 有序/无序列表、嵌套列表（2 或 4 空格缩进）
 * - 代码块（带复制/折叠 + 简单语法高亮，未闭合也能正确渲染）
 * - 引用块、表格、水平线
 * - file:/// 与 https:// 链接
 * - 流式输出：末尾闪烁光标
 */

interface Props {
  content: string
  streaming?: boolean
}

// ==================== 语法高亮 ====================

const KEYWORDS: Record<string, string[]> = {
  typescript: [
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'return',
    'function', 'const', 'let', 'var', 'class', 'interface', 'type', 'enum', 'extends',
    'implements', 'new', 'this', 'super', 'import', 'export', 'from', 'as', 'default',
    'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'void',
    'delete', 'yield', 'await', 'async', 'public', 'private', 'protected', 'readonly',
    'static', 'abstract', 'namespace', 'declare', 'satisfies', 'keyof', 'infer', 'is',
  ],
  javascript: [
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'return',
    'function', 'const', 'let', 'var', 'class', 'extends', 'new', 'this', 'super',
    'import', 'export', 'from', 'as', 'default', 'try', 'catch', 'finally', 'throw',
    'typeof', 'instanceof', 'in', 'of', 'void', 'delete', 'yield', 'await', 'async',
  ],
  python: [
    'def', 'class', 'if', 'elif', 'else', 'for', 'while', 'return', 'import', 'from',
    'as', 'try', 'except', 'finally', 'raise', 'with', 'lambda', 'yield', 'pass',
    'break', 'continue', 'in', 'is', 'not', 'and', 'or', 'global', 'nonlocal', 'del',
    'assert', 'async', 'await',
  ],
  bash: [
    'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac',
    'function', 'return', 'echo', 'export', 'local', 'read', 'unset', 'shift', 'source',
    'exit', 'in',
  ],
  json: [],
  markdown: [],
}

const LITERALS = ['true', 'false', 'null', 'undefined', 'None', 'True', 'False']

// 规范化语言名（处理 ts/tsx/js/py/sh 等别名）
function normalizeLang(lang?: string): string {
  if (!lang) return 'typescript'
  const l = lang.toLowerCase()
  if (l === 'ts' || l === 'tsx') return 'typescript'
  if (l === 'js' || l === 'jsx' || l === 'cjs' || l === 'mjs') return 'javascript'
  if (l === 'py' || l === 'python3') return 'python'
  if (l === 'sh' || l === 'shell' || l === 'zsh') return 'bash'
  if (l === 'md') return 'markdown'
  return l
}

// 简单 token 着色：关键字/字符串/注释/数字/函数名/字面量
function highlightCode(code: string, lang?: string): ReactNode[] {
  // 性能防御：正则 token 化开销随长度增长（流式输出时 CodeBlock 每帧
  // 重新高亮，超长代码会成为渲染瓶颈）。>3000 字符直接纯文本（无高亮），
  // 常规代码不受影响。
  if (code.length > 3000) return [code]
  const normalized = normalizeLang(lang)
  const keywords = KEYWORDS[normalized] || []
  const hashComments = normalized === 'python' || normalized === 'bash'
  const kwAlt = keywords.length > 0 ? keywords.join('|') : '(?!x)x'

  const parts: string[] = [
    '\\/\\/[^\\n]*', // 行注释 //
    '\\/\\*[\\s\\S]*?\\*\\/', // 块注释 /* */
  ]
  if (hashComments) parts.push('#[^\\n]*') // hash 注释 # (python/bash)
  parts.push(
    '`(?:\\\\.|[^`\\\\])*`', // 模板字符串
    '"(?:\\\\.|[^"\\\\])*"', // 双引号字符串
    "'(?:\\\\.|[^'\\\\])*'", // 单引号字符串
    `\\b(?:${kwAlt})\\b`, // 关键字
    '\\b(?:' + LITERALS.join('|') + ')\\b', // 布尔/字面量
    '\\b\\d+\\.?\\d*(?:[eE][+-]?\\d+)?\\b', // 数字
    '[A-Za-z_$][\\w$]*(?=\\s*\\()', // 函数调用名
  )
  const pattern = new RegExp(parts.join('|'), 'g')

  const nodes: ReactNode[] = []
  let lastIdx = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = pattern.exec(code)) !== null) {
    if (m.index > lastIdx) {
      nodes.push(code.slice(lastIdx, m.index))
    }
    const tok = m[0]
    let cls = ''
    const c0 = tok[0]
    if (c0 === '/' && (tok[1] === '/' || tok[1] === '*')) {
      cls = 'italic text-fg-muted'
    } else if (hashComments && c0 === '#') {
      cls = 'italic text-fg-muted'
    } else if (c0 === '`' || c0 === '"' || c0 === "'") {
      cls = 'text-success'
    } else if (c0 >= '0' && c0 <= '9') {
      cls = 'text-amber-600'
    } else if (LITERALS.includes(tok)) {
      cls = 'text-amber-600'
    } else if (keywords.includes(tok)) {
      cls = 'text-purple-500'
    } else {
      // 函数调用名（被 lookahead 匹配到的标识符）
      cls = 'text-blue-500'
    }
    nodes.push(
      <span key={`tok-${i}`} className={cls}>
        {tok}
      </span>
    )
    lastIdx = pattern.lastIndex
    i++
  }
  if (lastIdx < code.length) {
    nodes.push(code.slice(lastIdx))
  }
  return nodes
}

// ==================== 代码块切分（含未闭合处理） ====================

type Part =
  | { type: 'text'; content: string }
  | { type: 'code'; content: string; lang?: string }

function splitCodeBlocks(content: string): Part[] {
  const parts: Part[] = []
  const regex = /```(\w*)\n?([\s\S]*?)```/g
  let lastIdx = 0
  let m: RegExpExecArray | null
  while ((m = regex.exec(content)) !== null) {
    if (m.index > lastIdx) {
      parts.push({ type: 'text', content: content.slice(lastIdx, m.index) })
    }
    parts.push({ type: 'code', lang: m[1] || undefined, content: m[2].replace(/\n$/, '') })
    lastIdx = regex.lastIndex
  }
  if (lastIdx < content.length) {
    const rest = content.slice(lastIdx)
    const fenceIdx = rest.indexOf('```')
    if (fenceIdx === -1) {
      parts.push({ type: 'text', content: rest })
    } else {
      if (fenceIdx > 0) {
        parts.push({ type: 'text', content: rest.slice(0, fenceIdx) })
      }
      const afterFence = rest.slice(fenceIdx + 3)
      const nlIdx = afterFence.indexOf('\n')
      if (nlIdx !== -1) {
        const lang = afterFence.slice(0, nlIdx).trim()
        const code = afterFence.slice(nlIdx + 1)
        parts.push({ type: 'code', lang: lang || undefined, content: code })
      } else {
        // 流式中：尚未出现换行。短标识符视为语言标签，否则视为代码内容
        if (/^\w{0,15}$/.test(afterFence)) {
          parts.push({ type: 'code', lang: afterFence || undefined, content: '' })
        } else {
          parts.push({ type: 'code', lang: undefined, content: afterFence })
        }
      }
    }
  }
  return parts
}

// ==================== 行内 markdown ====================

// 渲染行内 markdown（图片、链接、行内代码、粗体、斜体、删除线）
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const regex =
    /(!\[[^\]]*\]\((?:data:|file:\/\/\/|https?:\/\/)[^)]+\)|\[[^\]]+\]\(file:\/\/\/[^)]+\)|\[[^\]]+\]\(https?:\/\/[^)]+\)|`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~|\*[^*]+\*)/g
  let lastIdx = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIdx) {
      nodes.push(text.slice(lastIdx, m.index))
    }
    const token = m[0]
    if (token.startsWith('![')) {
      const imgMatch = token.match(/^!\[([^\]]*)\]\(((?:data:|file:\/\/\/|https?:\/\/)[^)]+)\)$/)
      if (imgMatch) {
        const alt = imgMatch[1] || '图片'
        const url = imgMatch[2]
        if (url.startsWith('data:')) {
          // data: URL 被 CSP img-src 允许，直接内联渲染
          nodes.push(
            <img
              key={`${keyPrefix}-img${i}`}
              src={url}
              alt={alt}
              loading="lazy"
              className="my-1 max-h-72 max-w-full rounded"
            />
          )
        } else if (url.startsWith('file:///')) {
          // file:/// 被 CSP 拦截，降级为点击打开文件预览
          nodes.push(
            <a
              key={`${keyPrefix}-fi${i}`}
              href={url}
              onClick={(e) => {
                e.preventDefault()
                openFilePreview(url)
              }}
              className="cursor-pointer text-accent underline decoration-dotted underline-offset-2 hover:text-accent-hover"
              title={`打开图片 ${url}`}
            >
              🖼️ {alt}
            </a>
          )
        } else {
          // https:// 图片未被 CSP img-src 放行，降级为外部链接
          nodes.push(
            <a
              key={`${keyPrefix}-hi${i}`}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="cursor-pointer text-accent underline hover:text-accent-hover"
            >
              🖼️ {alt}
            </a>
          )
        }
      }
    } else if (token.startsWith('[') && token.includes('](file:///')) {
      const linkMatch = token.match(/^\[([^\]]+)\]\((file:\/\/\/[^)]+)\)$/)
      if (linkMatch) {
        nodes.push(
          <a
            key={`${keyPrefix}-f${i}`}
            href={linkMatch[2]}
            onClick={(e) => {
              e.preventDefault()
              openFilePreview(linkMatch[2])
            }}
            className="cursor-pointer text-accent underline decoration-dotted underline-offset-2 hover:text-accent-hover"
            title={`打开 ${linkMatch[2]}`}
          >
            {linkMatch[1]}
          </a>
        )
      }
    } else if (token.startsWith('[') && token.includes('](http')) {
      const linkMatch = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/)
      if (linkMatch) {
        nodes.push(
          <a
            key={`${keyPrefix}-l${i}`}
            href={linkMatch[2]}
            target="_blank"
            rel="noreferrer"
            className="cursor-pointer text-accent underline hover:text-accent-hover"
          >
            {linkMatch[1]}
          </a>
        )
      }
    } else if (token.startsWith('`')) {
      nodes.push(
        <code
          key={`${keyPrefix}-c${i}`}
          className="rounded bg-bg-muted px-1.5 py-0.5 text-[0.9em] text-fg-secondary"
        >
          {token.slice(1, -1)}
        </code>
      )
    } else if (token.startsWith('~~')) {
      nodes.push(
        <del key={`${keyPrefix}-d${i}`} className="text-fg-muted line-through">
          {token.slice(2, -2)}
        </del>
      )
    } else if (token.startsWith('**')) {
      nodes.push(
        <strong key={`${keyPrefix}-b${i}`} className="font-semibold">
          {token.slice(2, -2)}
        </strong>
      )
    } else if (token.startsWith('*')) {
      nodes.push(
        <em key={`${keyPrefix}-i${i}`} className="italic">
          {token.slice(1, -1)}
        </em>
      )
    }
    lastIdx = regex.lastIndex
    i++
  }
  if (lastIdx < text.length) {
    nodes.push(text.slice(lastIdx))
  }
  return nodes
}

// ==================== 列表树（支持嵌套） ====================

type ListNode = { content: string; ordered: boolean; children: ListNode[] }
type RawItem = { indent: number; ordered: boolean; content: string }

function buildListTree(items: RawItem[]): ListNode[] {
  const root: ListNode[] = []
  const stack: Array<{ node: ListNode; indent: number }> = []
  for (const item of items) {
    const node: ListNode = { content: item.content, ordered: item.ordered, children: [] }
    while (stack.length > 0 && stack[stack.length - 1].indent >= item.indent) {
      stack.pop()
    }
    if (stack.length === 0) {
      root.push(node)
    } else {
      stack[stack.length - 1].node.children.push(node)
    }
    stack.push({ node, indent: item.indent })
  }
  return root
}

function renderListTree(nodes: ListNode[], keyPrefix: string, ordered: boolean): ReactNode {
  const Tag = ordered ? 'ol' : 'ul'
  const cls = ordered ? 'list-decimal' : 'list-disc'
  return (
    <Tag key={keyPrefix} className={`my-3 ml-5 ${cls} space-y-1.5`}>
      {nodes.map((node, i) => (
        <li key={i} className="text-body leading-relaxed">
          {renderInline(node.content, `${keyPrefix}-i${i}`)}
          {node.children.length > 0 &&
            renderListTree(node.children, `${keyPrefix}-c${i}`, node.children[0].ordered)}
        </li>
      ))}
    </Tag>
  )
}

// ==================== 表格 ====================

function isTableRow(line: string): boolean {
  const t = line.trim()
  return /\|/.test(t) && /^\|?[^|]*(\|[^|]*)+\|?$/.test(t)
}

function isTableSeparator(line: string): boolean {
  const t = line.trim()
  return /^[\s|:-]+$/.test(t) && /-/.test(t) && /\|/.test(t)
}

function parseTableRow(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|')) t = t.slice(0, -1)
  return t.split('|').map((c) => c.trim())
}

type Align = 'left' | 'center' | 'right' | null

function parseTableAlignment(line: string): Align[] {
  return parseTableRow(line).map((cell) => {
    const t = cell.trim()
    if (t.startsWith(':') && t.endsWith(':')) return 'center'
    if (t.endsWith(':')) return 'right'
    if (t.startsWith(':')) return 'left'
    return null
  })
}

function alignClass(align: Align): string {
  if (align === 'center') return 'text-center'
  if (align === 'right') return 'text-right'
  return 'text-left'
}

function renderTable(
  header: string[],
  rows: string[][],
  alignments: Align[],
  keyPrefix: string,
): ReactNode {
  return (
    <div key={`${keyPrefix}-wrap`} className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-body">
        <thead>
          <tr>
            {header.map((cell, i) => (
              <th
                key={i}
                className={`border border-border-subtle bg-bg-muted px-3 py-1.5 font-semibold ${alignClass(
                  alignments[i],
                )}`}
              >
                {renderInline(cell, `${keyPrefix}-th${i}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className={`border border-border-subtle px-3 py-1.5 ${alignClass(alignments[ci])}`}
                >
                  {renderInline(cell, `${keyPrefix}-td${ri}-${ci}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ==================== 块级渲染 ====================

const headingClasses: Record<number, string> = {
  1: 'text-heading',
  2: 'text-lg font-semibold',
  3: 'text-body font-semibold',
  4: 'text-body font-semibold',
  5: 'text-[13px] font-semibold text-fg-secondary',
  6: 'text-[12px] font-semibold text-fg-muted',
}

// 渲染文本块（标题 H1-H6、列表、引用、表格、水平线、段落）
function renderTextBlock(text: string, keyPrefix: string): ReactNode[] {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let key = 0

  let listBuffer: RawItem[] = []

  const flushList = () => {
    if (listBuffer.length === 0) return
    // 连续相同 ordered 标志的项分为一组，混合列表拆为多个 <ul>/<ol>
    let currentGroup: RawItem[] = []
    const groups: RawItem[][] = []
    for (const item of listBuffer) {
      if (currentGroup.length === 0 || currentGroup[0].ordered === item.ordered) {
        currentGroup.push(item)
      } else {
        groups.push(currentGroup)
        currentGroup = [item]
      }
    }
    if (currentGroup.length > 0) groups.push(currentGroup)
    for (const group of groups) {
      const tree = buildListTree(group)
      blocks.push(renderListTree(tree, `${keyPrefix}-lst${key++}`, group[0].ordered))
    }
    listBuffer = []
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // 空行：刷新缓冲
    if (trimmed === '') {
      flushList()
      i++
      continue
    }

    // 标题 H1-H6
    const hMatch = trimmed.match(/^(#{1,6})\s+(.+)$/)
    if (hMatch) {
      flushList()
      const level = hMatch[1].length
      const cls = headingClasses[level] || headingClasses[6]
      blocks.push(
        <div key={`${keyPrefix}-h${key++}`} className={`my-3 ${cls}`}>
          {renderInline(hMatch[2], `${keyPrefix}-h${key}`)}
        </div>,
      )
      i++
      continue
    }

    // 水平线：--- *** ___（3+ 同字符）
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushList()
      blocks.push(
        <hr key={`${keyPrefix}-hr${key++}`} className="my-3 border-0 border-t border-border-subtle" />,
      )
      i++
      continue
    }

    // 引用块 > ...
    if (/^>/.test(trimmed)) {
      flushList()
      const quoteLines: string[] = []
      while (i < lines.length && /^>/.test(lines[i].trim())) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''))
        i++
      }
      const quoteContent = quoteLines.join('\n')
      blocks.push(
        <blockquote
          key={`${keyPrefix}-bq${key++}`}
          className="my-3 border-l-[3px] border-border-subtle pl-3 py-1 text-fg-secondary"
        >
          {renderTextBlock(quoteContent, `${keyPrefix}-bq${key}`)}
        </blockquote>,
      )
      continue
    }

    // 表格：表头行 + 分隔行
    if (isTableRow(trimmed) && i + 1 < lines.length && isTableSeparator(lines[i + 1].trim())) {
      flushList()
      const headerCells = parseTableRow(trimmed)
      const alignments = parseTableAlignment(lines[i + 1].trim())
      i += 2
      const dataRows: string[][] = []
      while (i < lines.length && isTableRow(lines[i].trim())) {
        dataRows.push(parseTableRow(lines[i].trim()))
        i++
      }
      blocks.push(renderTable(headerCells, dataRows, alignments, `${keyPrefix}-tbl${key++}`))
      continue
    }

    // 无序列表项：- * +
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/)
    if (ulMatch) {
      listBuffer.push({
        indent: Math.floor(ulMatch[1].length / 2),
        ordered: false,
        content: ulMatch[2],
      })
      i++
      continue
    }

    // 有序列表项：1.
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)$/)
    if (olMatch) {
      listBuffer.push({
        indent: Math.floor(olMatch[1].length / 2),
        ordered: true,
        content: olMatch[3],
      })
      i++
      continue
    }

    // 普通段落
    flushList()
    blocks.push(
      <p key={`${keyPrefix}-p${key++}`} className="my-3 text-body leading-relaxed">
        {renderInline(trimmed, `${keyPrefix}-p${key}`)}
      </p>,
    )
    i++
  }
  flushList()
  return blocks
}

// ==================== 组件 ====================

// 代码块组件：memo 化，code/lang 不变时不重渲染（内部 copied/collapsed 状态变化仍正常）
const CodeBlock = memo(function CodeBlock({ code, lang, streaming }: { code: string; lang?: string; streaming?: boolean }) {
  const [copied, setCopied] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  // 性能优化：流式中代码块每帧都在变（token 追加），每次全量正则高亮
  // 是编程模式"输出卡一下"的重活（O(代码长度) × 帧数）。流式期间跳过语法高亮
  // （纯文本），输出完成后（streaming=false）才高亮一次。
  const highlighted = useMemo(
    () => (streaming ? null : highlightCode(code, lang)),
    [code, lang, streaming]
  )

  const onCopy = async () => {
      const ok = await copyText(code)
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }
    }

  return (
    <div className="my-3 overflow-hidden rounded-card border border-border-subtle bg-bg-muted">
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-1.5">
        <span className="text-xs uppercase tracking-wider text-fg-muted">{lang || 'code'}</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="text-xs text-fg-muted hover:text-fg-primary"
          >
            {collapsed ? '展开' : '折叠'}
          </button>
          <button
            onClick={onCopy}
            className="text-xs text-fg-muted hover:text-fg-primary"
          >
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      </div>
      {!collapsed && (
        <pre className="overflow-x-auto px-3 py-2 font-mono text-[13px] leading-relaxed">
          <code className="text-fg-primary">{highlighted ?? code}</code>
        </pre>
      )}
    </div>
  )
})

// 文本块组件：memo + useMemo，content 不变时不重新解析（避免流式输出 O(n²) 重解析）
const TextBlock = memo(function TextBlock({ content, index }: { content: string; index: number }) {
  const nodes = useMemo(() => renderTextBlock(content, `t${index}`), [content, index])
  return <div>{nodes}</div>
})

// 文本片段 → 内部再拆代码块：memo + useMemo，content 不变时不重解析
const MarkdownTextPart = memo(function MarkdownTextPart({
  content,
  index,
  streaming
}: {
  content: string
  index: number
  streaming?: boolean
}) {
  // 性能修复（"AI 输出一多就卡"根因）：
  // 原实现整块 content 直接走 splitCodeBlocks + renderTextBlock，流式时 content 每帧
  // 追加 → 全文每帧重解析（O(全文) × 帧数，长输出拖垮帧率）。改为按空行拆段：
  // 前面完整段 content 不变 → SegmentBlock/TextBlock memo 挡住不重渲染，
  // 只有尾部不完整段每帧重解析（O(尾部段)）。段边界 = \n{2,}（空行），与
  // renderTextBlock 的空行 flush 语义一致（标题/列表组/表格/引用都不跨空行）。
  // 非流式路径同样拆段（总成本不变：split 一次 + 各段解析一次）。
  const segments = useMemo(() => content.split(/\n{2,}/), [content])
  return (
    <>
      {segments.map((seg, i) => (
        <SegmentBlock key={i} content={seg} index={index * 100 + i} streaming={streaming} />
      ))}
    </>
  )
})

// 段级块：段内拆代码块 → 代码块 / 文本块。memo：段 content 不变时不重解析
const SegmentBlock = memo(function SegmentBlock({
  content,
  index,
  streaming
}: {
  content: string
  index: number
  streaming?: boolean
}) {
  const parts = useMemo(() => splitCodeBlocks(content), [content])
  return (
    <>
      {parts.map((part, i) =>
        part.type === 'code' ? (
          <CodeBlock key={i} code={part.content} lang={part.lang} streaming={streaming} />
        ) : (
          <TextBlock key={i} content={part.content} index={index * 100 + i} />
        ),
      )}
    </>
  )
})

// 主渲染器：memo + useMemo 消除流式输出时 O(n²) 的全文重解析
export const MarkdownRenderer = memo(function MarkdownRenderer({ content, streaming }: Props) {
  return (
    <div className="markdown-body">
      <MarkdownTextPart content={content} index={0} streaming={streaming} />
      {streaming && (
        <span
          className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.15em] animate-pulse bg-accent align-middle"
          aria-hidden="true"
        />
      )}
    </div>
  )
})
