import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CodeIntelTool } from '../electron/main/tools/code-intel'
import type { ToolContext } from '../electron/main/tools/base-tool'

/**
 * code_intel（轻量代码智能，⑥LSP 替代）：
 * 复用依赖内 typescript 编译器 API，零外部二进制；覆盖 documentSymbol / goToDefinition
 * （含相对 import 跨文件跳转）/ findReferences / hover，以及非 TS 提示、文件不存在/超大、
 * 位置越界、未知 operation 与路径解析安全（resolveToolPath）。
 */

const tool = new CodeIntelTool()

let root: string

/** 同文件符号测试源（行号被后续断言引用，改动需同步） */
const MAIN_TS = [
  'export interface User {',
  '  id: number',
  '  name: string',
  '}',
  '',
  'export class UserService {',
  '  users: User[] = []',
  '',
  '  addUser(user: User): void {',
  '    this.users.push(user)',
  '  }',
  '',
  '  findById(id: number): User | undefined {',
  '    return this.users.find((u) => u.id === id)',
  '  }',
  '}',
  '',
  'export function createUser(id: number, name: string): User {',
  '  return { id, name }',
  '}',
  '',
  'export type UserId = number',
  '',
  'export enum Role {',
  "  Admin = 'admin',",
  "  Member = 'member'",
  '}',
  '',
  "export const DEFAULT_USER = 'guest'",
  '',
  'const localHelper = (x: number) => x * 2',
  ''
].join('\n')

const HELPER_TS = [
  'export function helper(value: number): number {',
  '  return value * 10',
  '}',
  '',
  'export default function defaultHelper(value: number): number {',
  '  return value + 1',
  '}',
  ''
].join('\n')

const MAIN_IMPORT_TS = [
  "import { helper } from './helper'",
  "import defaultHelper from './helper'",
  '',
  'export function callHelper(v: number): number {',
  '  return helper(v) + defaultHelper(v)',
  '}',
  ''
].join('\n')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'code-intel-'))
  writeFileSync(join(root, 'main.ts'), MAIN_TS, 'utf-8')
  writeFileSync(join(root, 'helper.ts'), HELPER_TS, 'utf-8')
  writeFileSync(join(root, 'main-import.ts'), MAIN_IMPORT_TS, 'utf-8')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function ctxWithResolve(resolvePath: (p: string) => string): ToolContext {
  return { resolvePath } as ToolContext
}

describe('code_intel documentSymbol', () => {
  it('列出顶层符号树，含函数/类/接口/类型别名/枚举/导出变量', async () => {
    const r = await tool.execute({ operation: 'documentSymbol', file_path: join(root, 'main.ts') })
    expect(r.ok).toBe(true)
    const data = r.data as { count: number; symbols: Array<{ name: string; kind: string }> }
    const names = data.symbols.map((s) => s.name)
    expect(names).toContain('User')
    expect(names).toContain('UserService')
    expect(names).toContain('createUser')
    expect(names).toContain('UserId')
    expect(names).toContain('Role')
    expect(names).toContain('DEFAULT_USER')
    // 非导出的局部变量不进顶层符号树
    expect(names).not.toContain('localHelper')
  })

  it('类成员作为 children 层级收集，位置为 1-based', async () => {
    const r = await tool.execute({ operation: 'documentSymbol', file_path: join(root, 'main.ts') })
    const data = r.data as { symbols: Array<{ name: string; line: number; character: number; signature: string; children: Array<{ name: string; kind: string; signature: string }> }> }
    const svc = data.symbols.find((s) => s.name === 'UserService')
    expect(svc?.line).toBe(6)
    expect(svc?.children?.map((c) => c.name)).toEqual(['users', 'addUser', 'findById'])
    expect(svc?.children?.find((c) => c.name === 'users')?.kind).toBe('property')
    expect(svc?.children?.find((c) => c.name === 'addUser')?.signature).toBe('addUser(user: User): void')
    expect(svc?.children?.find((c) => c.name === 'findById')?.signature).toBe('findById(id: number): User | undefined')
  })

  it('顶层位置与签名摘要正确', async () => {
    const r = await tool.execute({ operation: 'documentSymbol', file_path: join(root, 'main.ts') })
    const data = r.data as { symbols: Array<{ name: string; line: number; kind: string; signature: string }> }
    const fn = data.symbols.find((s) => s.name === 'createUser')
    expect(fn?.line).toBe(18)
    expect(fn?.kind).toBe('function')
    expect(fn?.signature).toBe('createUser(id: number, name: string): User')
    expect(data.symbols.find((s) => s.name === 'Role')?.signature).toBe('enum Role')
  })
})

describe('code_intel goToDefinition', () => {
  it('同文件按 symbol 定位函数定义', async () => {
    const r = await tool.execute({ operation: 'goToDefinition', file_path: join(root, 'main.ts'), symbol: 'createUser' })
    expect(r.ok).toBe(true)
    const data = r.data as { found: boolean; location: { file: string; line: number; character: number }; kind: string; position: string }
    expect(data.found).toBe(true)
    expect(data.location.line).toBe(18)
    expect(data.location.character).toBe(1)
    expect(data.kind).toBe('function')
    expect(data.position).toBe(`${join(root, 'main.ts')}:18:1`)
  })

  it('同文件定位类方法', async () => {
    const r = await tool.execute({ operation: 'goToDefinition', file_path: join(root, 'main.ts'), symbol: 'findById' })
    const data = r.data as { found: boolean; location: { line: number } }
    expect(data.found).toBe(true)
    expect(data.location.line).toBe(13)
  })

  it('跨文件：相对 import 的命名导入跳到目标文件定义', async () => {
    const r = await tool.execute({ operation: 'goToDefinition', file_path: join(root, 'main-import.ts'), symbol: 'helper' })
    expect(r.ok).toBe(true)
    const data = r.data as { found: boolean; location: { file: string; line: number; character: number }; signature: string }
    expect(data.found).toBe(true)
    expect(data.location.file).toBe(join(root, 'helper.ts'))
    expect(data.location.line).toBe(1)
    expect(data.location.character).toBe(1)
    expect(data.signature).toBe('helper(value: number): number')
  })

  it('跨文件：默认导入跳到目标文件的默认导出声明', async () => {
    const r = await tool.execute({ operation: 'goToDefinition', file_path: join(root, 'main-import.ts'), symbol: 'defaultHelper' })
    const data = r.data as { found: boolean; location: { file: string; line: number }; signature: string }
    expect(data.found).toBe(true)
    expect(data.location.file).toBe(join(root, 'helper.ts'))
    expect(data.location.line).toBe(5)
    expect(data.signature).toBe('defaultHelper(value: number): number')
  })

  it('光标定位（line/character）识别导入符号并跳转', async () => {
    // main-import.ts 第 5 行 "  return helper(v) + defaultHelper(v)"，helper 从第 10 列开始
    const r = await tool.execute({ operation: 'goToDefinition', file_path: join(root, 'main-import.ts'), line: 5, character: 10 })
    const data = r.data as { found: boolean; location: { file: string; line: number } }
    expect(data.found).toBe(true)
    expect(data.location.file).toBe(join(root, 'helper.ts'))
    expect(data.location.line).toBe(1)
  })

  it('光标定位指向默认导入符号', async () => {
    // defaultHelper 起始列 22，第 23 列落在其内
    const r = await tool.execute({ operation: 'goToDefinition', file_path: join(root, 'main-import.ts'), line: 5, character: 23 })
    const data = r.data as { found: boolean; location: { file: string; line: number }; signature: string }
    expect(data.found).toBe(true)
    expect(data.location.file).toBe(join(root, 'helper.ts'))
    expect(data.location.line).toBe(5)
  })

  it('找不到定义时返回 found=false（不视为工具失败）', async () => {
    const r = await tool.execute({ operation: 'goToDefinition', file_path: join(root, 'main.ts'), symbol: 'noSuchSymbol' })
    expect(r.ok).toBe(true)
    expect((r.data as { found: boolean }).found).toBe(false)
  })
})

describe('code_intel findReferences', () => {
  it('列出当前文件内同名引用（含 import 与调用）', async () => {
    const r = await tool.execute({ operation: 'findReferences', file_path: join(root, 'main-import.ts'), symbol: 'helper' })
    expect(r.ok).toBe(true)
    const data = r.data as { count: number; references: Array<{ line: number; text: string }> }
    expect(data.count).toBeGreaterThanOrEqual(2)
    expect(data.references.some((ref) => ref.line === 1)).toBe(true) // import { helper }
    expect(data.references.some((ref) => ref.line === 5)).toBe(true) // 调用处
    expect(data.references.every((ref) => ref.text === 'helper')).toBe(true)
  })

  it('光标定位取符号名再统计引用', async () => {
    const r = await tool.execute({ operation: 'findReferences', file_path: join(root, 'main-import.ts'), line: 5, character: 10 })
    const data = r.data as { symbol: string; count: number }
    expect(data.symbol).toBe('helper')
    expect(data.count).toBeGreaterThanOrEqual(2)
  })
})

describe('code_intel hover', () => {
  it('返回符号签名摘要（函数）', async () => {
    const r = await tool.execute({ operation: 'hover', file_path: join(root, 'main.ts'), symbol: 'createUser' })
    const data = r.data as { found: boolean; kind: string; signature: string }
    expect(data.found).toBe(true)
    expect(data.kind).toBe('function')
    expect(data.signature).toBe('createUser(id: number, name: string): User')
  })

  it('返回成员签名摘要（类方法）', async () => {
    const r = await tool.execute({ operation: 'hover', file_path: join(root, 'main.ts'), symbol: 'findById' })
    const data = r.data as { found: boolean; signature: string }
    expect(data.found).toBe(true)
    expect(data.signature).toBe('findById(id: number): User | undefined')
  })

  it('未找到符号返回 found=false', async () => {
    const r = await tool.execute({ operation: 'hover', file_path: join(root, 'main.ts'), symbol: 'missing' })
    expect((r.data as { found: boolean }).found).toBe(false)
  })
})

describe('code_intel 边界与安全', () => {
  it('非 TS/JS 文件返回明确提示而非装作支持', async () => {
    const py = join(root, 'main.py')
    writeFileSync(py, 'def hello():\n    pass\n', 'utf-8')
    const r = await tool.execute({ operation: 'documentSymbol', file_path: py })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('只支持 TypeScript/JavaScript')
  })

  it('文件不存在返回明确错误', async () => {
    const r = await tool.execute({ operation: 'documentSymbol', file_path: join(root, 'missing.ts') })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('文件不存在')
  })

  it('文件超过 10MB 上限不解析', async () => {
    const big = join(root, 'big.ts')
    writeFileSync(big, "export const big = '" + 'x'.repeat(10 * 1024 * 1024 + 1) + "'\n", 'utf-8')
    const r = await tool.execute({ operation: 'documentSymbol', file_path: big })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('上限')
  })

  it('位置越界返回明确错误', async () => {
    const r = await tool.execute({ operation: 'findReferences', file_path: join(root, 'main.ts'), line: 99999, character: 1 })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('未找到标识符')
  })

  it('缺少定位方式时返回明确错误', async () => {
    const r = await tool.execute({ operation: 'goToDefinition', file_path: join(root, 'main.ts') })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('symbol')
  })

  it('未知 operation 被拒绝（fail-closed）', async () => {
    const r = await tool.execute({ operation: 'explode', file_path: join(root, 'main.ts') })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('未知 operation')
  })

  it('缺少 file_path 被拒绝', async () => {
    const r = await tool.execute({ operation: 'documentSymbol' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('file_path')
  })

  it('路径经 ctx.resolvePath 解析（与文件工具同一口径）', async () => {
    const resolved = join(root, 'main.ts')
    const seen: string[] = []
    const ctx = ctxWithResolve((p) => {
      seen.push(p)
      return resolved
    })
    const r = await tool.execute({ operation: 'documentSymbol', file_path: 'main.ts' }, ctx)
    expect(r.ok).toBe(true)
    expect(seen).toEqual(['main.ts'])
    expect((r.data as { file: string }).file).toBe(resolved)
  })

  it('读操作无副作用：执行后源文件内容不变', async () => {
    const before = await import('fs').then((fs) => fs.readFileSync(join(root, 'main.ts'), 'utf-8'))
    await tool.execute({ operation: 'documentSymbol', file_path: join(root, 'main.ts') })
    await tool.execute({ operation: 'goToDefinition', file_path: join(root, 'main.ts'), symbol: 'createUser' })
    const after = await import('fs').then((fs) => fs.readFileSync(join(root, 'main.ts'), 'utf-8'))
    expect(after).toBe(before)
  })
})