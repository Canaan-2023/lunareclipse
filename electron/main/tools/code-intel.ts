/**
 * 轻量代码智能工具：为什么存在——参考产品的 LSP 代码智能依赖外部语言服务器二进制
 * （用 config.command 启动 vscode-languageserver 等外部进程），月蚀坚持零外部二进制；
 * 本工具复用依赖内 typescript 编译器 API，为 TS/JS 系代码提供同类四大查询
 * （符号树 / 跳转定义 / 查找引用 / 悬停签名），不起外部进程、不解析 node_modules。
 * 作用：AI 对 TypeScript / JavaScript 代码库动手前，用 code_intel 摸清符号结构与定义位置，
 * 替代人肉 grep 猜结构；非 TS 系文件返回明确提示，不假装支持。
 *
 * 安全语义：纯只读（readOnly + concurrencySafe，可并发、无副作用）；路径经 resolveToolPath
 * 解析（同 Read/Edit 等文件工具口径）；单文件上限 10MB（对齐参考产品 MAX_LSP_FILE_SIZE_BYTES）。
 * 已知边界：findReferences 只覆盖当前文件；goToDefinition 支持相对/绝对 import 的跨文件跳转，
 * 不解析 node_modules 包内符号。这是"轻量替代"的刻意取舍，向 AI 明示。
 */
import ts from 'typescript'
import { readFileSync, statSync, existsSync } from 'fs'
import { extname, join, dirname } from 'path'
import type { Tool, ToolResult, ToolContext } from './base-tool'
import { resolveToolPath } from './base-tool'

/** 单文件大小上限（字节）：对齐参考产品 MAX_LSP_FILE_SIZE_BYTES，超大文件不解析 */
const MAX_FILE_BYTES = 10 * 1024 * 1024

export type CodeIntelOperation = 'documentSymbol' | 'goToDefinition' | 'findReferences' | 'hover'

export interface CodeIntelParams {
  operation?: string
  file_path?: string
  symbol?: string
  line?: number
  character?: number
}

/** 内部符号节点：node 只用于递归收集，不进入工具结果 */
interface SymNode {
  name: string
  kind: string
  line: number
  character: number
  signature: string
}

interface SymNodeWithNode extends SymNode {
  node: ts.Node
  children?: SymNodeWithNode[]
}

/** 输出用符号（剥离 AST 节点，JSON 可序列化） */
interface SerializableSym {
  name: string
  kind: string
  line: number
  character: number
  signature: string
  children?: SerializableSym[]
}

/** 位置：输出用 1-based 行列 */
interface CodePos {
  line: number
  character: number
}

/** 支持的源码扩展名 → ScriptKind */
function scriptKindOf(filePath: string): ts.ScriptKind {
  const ext = extname(filePath).toLowerCase()
  switch (ext) {
    case '.tsx':
      return ts.ScriptKind.TSX
    case '.ts':
      return ts.ScriptKind.TS
    case '.jsx':
      return ts.ScriptKind.JSX
    case '.js':
      return ts.ScriptKind.JS
    default:
      return ts.ScriptKind.Unknown
  }
}

function isSupportedSource(filePath: string): boolean {
  return scriptKindOf(filePath) !== ts.ScriptKind.Unknown
}

/** 读取并创建源码文件；错误返回 null（调用方读取 error 字段） */
function loadSourceFile(filePath: string): { sf: ts.SourceFile } | { error: string } {
  if (!existsSync(filePath)) {
    return { error: `文件不存在: ${filePath}` }
  }
  const stat = statSync(filePath)
  if (!stat.isFile()) {
    return { error: `不是文件: ${filePath}` }
  }
  if (stat.size > MAX_FILE_BYTES) {
    return {
      error: `文件超过 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB 上限（${stat.size} 字节），请用 Read / Grep 定点查看`
    }
  }
  const text = readFileSync(filePath, 'utf-8')
  const sf = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindOf(filePath)
  )
  return { sf }
}

/** 节点 1-based 位置 */
function posOf(sf: ts.SourceFile, node: ts.Node): CodePos {
  const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf))
  return { line: lc.line + 1, character: lc.character + 1 }
}

function nameOf(node: ts.Node): string | null {
  const n = (node as { name?: ts.Node }).name
  if (n && ts.isIdentifier(n)) return n.text
  return null
}

function parameterList(node: ts.SignatureDeclarationBase, sf: ts.SourceFile): string {
  return node.parameters
    .map((p) => {
      const nm = p.name.getText(sf)
      const opt = p.questionToken ? '?' : ''
      const ty = p.type ? p.type.getText(sf) : ''
      return ty ? `${nm}${opt}: ${ty}` : `${nm}${opt}`
    })
    .join(', ')
}

function typeAnnotation(node: { type?: ts.TypeNode }, sf: ts.SourceFile): string {
  return node.type ? node.type.getText(sf) : ''
}

/** 生成签名摘要：函数 name(params: T): Ret；类/接口/枚举直接名字；变量/属性 name: T */
function signatureOf(node: ts.Node, sf: ts.SourceFile): string {
  const name = nameOf(node)
  const nm = name ?? 'anonymous'
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
    const ret = typeAnnotation(node, sf)
    return `${nm}(${parameterList(node, sf)})${ret ? `: ${ret}` : ''}`
  }
  if (ts.isConstructorDeclaration(node)) {
    return `constructor(${parameterList(node, sf)})`
  }
  if (ts.isGetAccessorDeclaration(node)) {
    const ret = typeAnnotation(node, sf)
    return `get ${nm}()${ret ? `: ${ret}` : ''}`
  }
  if (ts.isSetAccessorDeclaration(node)) {
    return `set ${nm}(${parameterList(node, sf)})`
  }
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
    const ty = typeAnnotation(node, sf)
    return ty ? `${nm}: ${ty}` : nm
  }
  if (ts.isVariableDeclaration(node)) {
    const ty = typeAnnotation(node, sf)
    return ty ? `${nm}: ${ty}` : nm
  }
  if (ts.isTypeAliasDeclaration(node)) {
    const ty = typeAnnotation(node, sf)
    return ty ? `type ${nm} = ${ty}` : `type ${nm}`
  }
  if (ts.isClassDeclaration(node)) {
    const ext = node.heritageClauses?.map((h) => h.getText(sf)).join(' ')
    return ext ? `class ${nm} ${ext}` : `class ${nm}`
  }
  if (ts.isInterfaceDeclaration(node)) {
    const ext = node.heritageClauses?.map((h) => h.getText(sf)).join(' ')
    return ext ? `interface ${nm} ${ext}` : `interface ${nm}`
  }
  if (ts.isEnumDeclaration(node)) return `enum ${nm}`
  if (ts.isModuleDeclaration(node)) return `namespace ${nm}`
  if (ts.isEnumMember(node)) {
    const init = node.initializer ? ` = ${node.initializer.getText(sf)}` : ''
    return `${nm}${init}`
  }
  return nm
}

/** 类/接口/枚举的成员收集（children 层级） */
function childrenOf(node: ts.Node, sf: ts.SourceFile): SymNodeWithNode[] | undefined {
  const m = (node as { members?: ts.NodeArray<ts.Node> }).members
  if (m) {
    const out: SymNodeWithNode[] = []
    for (const member of m) {
      const sym = tryMakeSymbol(member, sf, false)
      if (sym) out.push(sym)
    }
    return out.length > 0 ? out : undefined
  }
  // namespace body：递归收集内部顶层声明
  const body = (node as { body?: ts.Node }).body
  if (body && ts.isModuleBlock(body)) {
    const out: SymNodeWithNode[] = []
    for (const stmt of body.statements) {
      const sym = tryMakeSymbol(stmt, sf, true)
      if (sym) out.push(sym)
    }
    return out.length > 0 ? out : undefined
  }
  return undefined
}

/**
 * 尝试把节点转成符号：只有声明类节点才收。
 * topLevel=true 时额外收"带 export 的变量声明"（避免 documentSymbol 把函数内临时变量也列出来）；
 * topLevel=false 时变量声明不收（hover/定位以函数/类/成员为主，局部变量易误匹配）。
 */
function tryMakeSymbol(node: ts.Node, sf: ts.SourceFile, topLevel: boolean): SymNodeWithNode | null {
  const name = nameOf(node)
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isEnumMember(node)
  ) {
    if (name === null) return null
    const sym: SymNodeWithNode = {
      name,
      kind: kindOf(node),
      ...posOf(sf, node),
      signature: signatureOf(node, sf),
      node
    }
    const kids = childrenOf(node, sf)
    if (kids) sym.children = kids
    return sym
  }
  if (ts.isVariableStatement(node) && topLevel && name === null) {
    // VariableStatement 不是 Declaration 类型，不能走 getCombinedModifierFlags；直接查 modifiers
    const isExported = !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    if (isExported) {
      const decls: SymNodeWithNode[] = []
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) {
          const sym: SymNodeWithNode = {
            name: d.name.text,
            kind: 'variable',
            ...posOf(sf, d),
            signature: signatureOf(d, sf),
            node: d
          }
          decls.push(sym)
        }
      }
      // 单个或多个声明变量统一取第一个声明作为代表（const a=1, b=2 只展示 a）：
      // documentSymbol 展示用，全部展开会让顶层符号列表失去聚焦，且多数项目是单声明。
      if (decls.length >= 1) return decls[0]
    }
  }
  return null
}

function kindOf(node: ts.Node): string {
  if (ts.isFunctionDeclaration(node)) return 'function'
  if (ts.isClassDeclaration(node)) return 'class'
  if (ts.isInterfaceDeclaration(node)) return 'interface'
  if (ts.isTypeAliasDeclaration(node)) return 'type'
  if (ts.isEnumDeclaration(node)) return 'enum'
  if (ts.isModuleDeclaration(node)) return 'namespace'
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return 'method'
  if (ts.isConstructorDeclaration(node)) return 'constructor'
  if (ts.isGetAccessorDeclaration(node)) return 'getter'
  if (ts.isSetAccessorDeclaration(node)) return 'setter'
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return 'property'
  if (ts.isEnumMember(node)) return 'enum-member'
  return 'symbol'
}

/** 顶层符号树（documentSymbol） */
function collectTopLevel(sf: ts.SourceFile): SerializableSym[] {
  const out: SerializableSym[] = []
  for (const stmt of sf.statements) {
    const sym = tryMakeSymbol(stmt, sf, true)
    if (sym) out.push(stripNode(sym))
  }
  return out
}

/** 全量声明收集（任意深度，供定位/悬停使用） */
function collectAll(sf: ts.SourceFile): SymNodeWithNode[] {
  const out: SymNodeWithNode[] = []
  walk(sf)
  return out

  function walk(node: ts.Node): void {
    const sym = tryMakeSymbol(node, sf, false)
    if (sym) out.push(sym)
    ts.forEachChild(node, walk)
  }
}

function stripNode(sym: SymNodeWithNode): SerializableSym {
  const { node: _node, ...rest } = sym
  const out = { ...rest } as SerializableSym
  if (sym.children) out.children = sym.children.map((c) => stripNode(c))
  return out
}

/** 定位光标处标识符：line/character 为 1-based */
function identifierAt(sf: ts.SourceFile, line: number, character: number): ts.Identifier | null {
  const endLc = sf.getLineAndCharacterOfPosition(sf.getEnd())
  if (line < 1 || line > endLc.line + 1 || character < 1) return null
  let target: ts.Identifier | null = null
  walk(sf)
  return target

  function walk(node: ts.Node): void {
    if (target) return
    if (ts.isIdentifier(node)) {
      const startLc = sf.getLineAndCharacterOfPosition(node.getStart(sf))
      if (startLc.line + 1 === line) {
        const startChar = startLc.character + 1
        const endChar = sf.getLineAndCharacterOfPosition(node.getEnd()).character + 1
        if (startChar <= character && character < endChar) {
          target = node
          return
        }
      }
    }
    ts.forEachChild(node, walk)
  }
}

/** 当前文件内所有同名引用位置（findReferences） */
function collectReferences(sf: ts.SourceFile, name: string): Array<CodePos & { text: string }> {
  const out: Array<CodePos & { text: string }> = []
  walk(sf)
  return out

  function walk(node: ts.Node): void {
    if (ts.isIdentifier(node) && node.text === name) {
      const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf))
      out.push({ line: lc.line + 1, character: lc.character + 1, text: node.text })
    }
    ts.forEachChild(node, walk)
  }
}

function isRelativeSpec(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')
}

/** 模块说明符文本（去引号） */
function moduleSpecOf(node: ts.Expression, sf: ts.SourceFile): string | null {
  if (ts.isStringLiteral(node)) return node.text
  const t = node.getText(sf).replace(/^['"]|['"]$/g, '')
  return t || null
}

/** 解析相对/绝对导入目标：尝试各扩展名与 index 文件；不解析 node_modules 包 */
function resolveModulePath(base: string): string | null {
  const candidates = [base, base + '.ts', base + '.tsx', base + '.js', base + '.jsx', base + '.d.ts']
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile() && isSupportedSource(c)) return c
  }
  for (const idx of [join(base, 'index.ts'), join(base, 'index.tsx'), join(base, 'index.js'), join(base, 'index.jsx'), join(base, 'index.d.ts')]) {
    if (existsSync(idx) && statSync(idx).isFile() && isSupportedSource(idx)) return idx
  }
  return null
}

/** 跨文件跳转：符号是否以 import 形式来自相对/绝对模块；命中返回目标文件与目标符号名 */
function resolveImportTarget(
  sf: ts.SourceFile,
  symbol: string,
  baseDir: string
): { filePath: string; targetName: string } | null {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    const clause = stmt.importClause
    if (!clause) continue
    const spec = moduleSpecOf(stmt.moduleSpecifier, sf)
    if (!spec || !isRelativeSpec(spec)) continue
    const targetFile = resolveModulePath(join(baseDir, spec))
    if (!targetFile) continue
    // 命名导入：import { foo as bar } from './x' -> 本文件符号名 bar，目标符号名 foo
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        const localName = el.name.text
        const importedName = el.propertyName ? el.propertyName.text : el.name.text
        if (localName === symbol) return { filePath: targetFile, targetName: importedName }
      }
    }
    // 默认导入：import foo from './x'
    if (clause.name && clause.name.text === symbol) {
      return { filePath: targetFile, targetName: 'default' }
    }
  }
  return null
}

/** 在源码文件里按名字查声明（收集到的全量声明，含类成员） */
function findDeclaration(sf: ts.SourceFile, name: string): SymNodeWithNode | null {
  for (const sym of collectAll(sf)) {
    if (sym.name === name) return sym
  }
  return null
}

/** 打开目标文件并按其导出名查找（跨文件跳转用；targetName 'default' 表示默认导出，取带 default 修饰的声明） */
function findInTargetFile(targetPath: string, targetName: string): SymNodeWithNode | null {
  const loaded = loadSourceFile(targetPath)
  if ('error' in loaded) return null
  const all = collectAll(loaded.sf)
  if (targetName === 'default') {
    for (const sym of all) {
      const mods = ts.canHaveModifiers(sym.node) ? ts.getModifiers(sym.node) : undefined
      const isDefault = !!mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
      if (isDefault) return sym
    }
    return null
  }
  for (const sym of all) {
    if (sym.name === targetName) return sym
  }
  return null
}

/** 从输入中解析符号名：优先显式 symbol，其次光标处标识符 */
function resolveSymbol(
  params: CodeIntelParams,
  sf: ts.SourceFile
): { symbol: string } | { error: string } {
  if (params.symbol && String(params.symbol).trim() !== '') return { symbol: String(params.symbol).trim() }
  if (params.line !== undefined && params.character !== undefined) {
    const id = identifierAt(sf, Number(params.line), Number(params.character))
    if (id) return { symbol: id.text }
    return { error: `在 ${Number(params.line)}:${Number(params.character)} 未找到标识符（请把 line/character 指向符号名上）` }
  }
  return { error: '需要提供 symbol（符号名）或 line+character（光标位置）' }
}

/**
 * code_intel：
 * 轻量代码智能（零外部二进制）——复用依赖内 typescript 编译器 API，对 TS/JS 系代码提供
 * 符号树 / 跳转定义 / 查找引用 / 悬停签名。覆盖 .ts/.tsx/.js/.jsx，其他语言明确提示不支持。
 *
 * 用法：
 * - documentSymbol(file_path) → 文件顶层符号树（含成员层级/行列/签名）
 * - goToDefinition(file_path, symbol 或 line+character) → 定义位置（支持相对 import 跨文件跳转）
 * - findReferences(file_path, symbol 或 line+character) → 当前文件内引用位置列表
 * - hover(file_path, symbol 或 line+character) → 符号签名摘要
 *
 * 位置参数 line/character 为 1-based。纯只读，单文件上限 10MB。跨文件仅解析相对/绝对
 * import（不解析 node_modules）；findReferences 仅当前文件——轻量替代的刻意边界。
 */
export class CodeIntelTool implements Tool<CodeIntelParams> {
  name = 'code_intel'
  description = `轻量代码智能（零外部二进制，基于 typescript 编译器 API）：对 TypeScript/JavaScript 代码提供 LSP 式查询。
四种操作（operation 必填）：
1. documentSymbol：列出文件顶层符号树（函数/类/接口/类型别名/枚举/命名空间/导出变量，含成员层级与 1-based 行列）；
2. goToDefinition：跳到符号定义位置（symbol 或 line+character 定位；支持相对/绝对 import 的跨文件跳转，不解析 node_modules）；
3. findReferences：列出当前文件内符号的全部引用位置（符号名或光标位置定位）；
4. hover：返回符号签名摘要（如 "fetchUser(id: number): Promise<User>"）。
参数：operation（必填）/ file_path（必填，绝对路径）/ symbol（符号名）/ line / character（1-based 光标位置）。
覆盖 .ts/.tsx/.js/.jsx；其他文件类型返回明确提示。纯只读、单文件上限 10MB。`
  parameters = [
    {
      name: 'operation',
      type: 'string' as const,
      description: '查询操作：documentSymbol / goToDefinition / findReferences / hover',
      required: true
    },
    {
      name: 'file_path',
      type: 'string' as const,
      description: '要分析的源码文件绝对路径（.ts/.tsx/.js/.jsx）',
      required: true
    },
    {
      name: 'symbol',
      type: 'string' as const,
      description: '符号名（goToDefinition / findReferences / hover；与 line+character 二选一）',
      required: false
    },
    {
      name: 'line',
      type: 'number' as const,
      description: '光标所在行（1-based，与 symbol 二选一）',
      required: false
    },
    {
      name: 'character',
      type: 'number' as const,
      description: '光标所在列（1-based，与 symbol 配合）',
      required: false
    }
  ]
  behavior = { readOnly: true, concurrencySafe: true, destructive: false }

  async execute(params: CodeIntelParams, ctx?: ToolContext): Promise<ToolResult> {
    const operation = String(params.operation ?? '').trim()
    if (operation !== 'documentSymbol' && operation !== 'goToDefinition' && operation !== 'findReferences' && operation !== 'hover') {
      return { ok: false, error: `未知 operation "${operation}"（支持 documentSymbol / goToDefinition / findReferences / hover）` }
    }
    if (!params.file_path || String(params.file_path).trim() === '') {
      return { ok: false, error: '缺少 file_path（要分析的 TS/JS 文件绝对路径）' }
    }
    const filePath = resolveToolPath(String(params.file_path), ctx)
    if (!isSupportedSource(filePath)) {
      return { ok: false, error: `code_intel 只支持 TypeScript/JavaScript 文件（.ts/.tsx/.js/.jsx），当前扩展名 "${extname(filePath) || '(无)'}" 不在支持范围；其他语言请用 Read / Grep 等通用工具` }
    }
    const loaded = loadSourceFile(filePath)
    if ('error' in loaded) return { ok: false, error: loaded.error }
    const { sf } = loaded

    if (operation === 'documentSymbol') {
      const symbols = collectTopLevel(sf)
      return {
        ok: true,
        data: {
          file: filePath,
          operation,
          count: symbols.length,
          message: symbols.length > 0 ? '顶层符号树如下（line/character 为 1-based）' : '文件内未发现顶层符号声明',
          symbols
        }
      }
    }

    // 其余三种操作都需要符号名（显式或光标定位）
    const resolved = resolveSymbol(params, sf)
    if ('error' in resolved) return { ok: false, error: resolved.error }
    const symbol = resolved.symbol

    if (operation === 'findReferences') {
      const references = collectReferences(sf, symbol)
      return {
        ok: true,
        data: {
          file: filePath,
          operation,
          symbol,
          count: references.length,
          message: references.length > 0 ? `当前文件内 "${symbol}" 的引用（含声明处）如下` : `当前文件内未找到 "${symbol}" 的引用`,
          references
        }
      }
    }

    // goToDefinition / hover：先查本文件，再尝试跨文件 import 目标
    const local = findDeclaration(sf, symbol)
    if (local) {
      return finish(local, filePath)
    }
    const importTarget = resolveImportTarget(sf, symbol, dirname(filePath))
    if (importTarget) {
      const target = findInTargetFile(importTarget.filePath, importTarget.targetName)
      if (target) {
        return finish(target, importTarget.filePath)
      }
    }
    return {
      ok: true,
      data: {
        file: filePath,
        operation,
        symbol,
        found: false,
        message: `在当前文件与相对/绝对 import 的目标文件中均未找到 "${symbol}" 的声明（跨文件仅解析相对路径，node_modules 包内符号不解析）`
      }
    }

    function finish(sym: SymNodeWithNode, ownerFile: string): ToolResult {
      // 用符号自身所属的 sourceFile 计算位置：跨文件跳转时目标 AST 属于目标文件，不能拿源文件 sf 算
      const ownerSf = sym.node.getSourceFile()
      const loc = posOf(ownerSf, sym.node)
      const base = {
        symbol,
        found: true,
        location: { file: ownerFile, line: loc.line, character: loc.character },
        kind: sym.kind,
        signature: sym.signature
      }
      if (operation === 'goToDefinition') {
        return { ok: true, data: { ...base, operation, position: `${ownerFile}:${loc.line}:${loc.character}` } }
      }
      return { ok: true, data: { ...base, operation } }
    }
  }
}