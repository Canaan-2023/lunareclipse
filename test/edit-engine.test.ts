/**
 * edit-engine.test.ts
 * fuzzy-match.ts + file-operations.ts 的单元测试。
 * 覆盖：CRLF 匹配（核心痛点）、BOM 处理、九层模糊策略、已应用检测、原子写、行尾保持、写后验证。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  fuzzyMatch,
  applyEdit,
  detectLineEnding,
  normalizeLineEndings,
  stripBom,
  isAlreadyApplied,
  findClosestLines,
  buildDidYouMean
} from '../app/electron/main/tools/edit-engine/fuzzy-match'
import {
  readFileSafe,
  writeFileSafe,
  applyEditToFile,
  atomicWrite
} from '../app/electron/main/tools/edit-engine/file-operations'

// ==================== 工具 ====================

let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-engine-test-'))
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function tmpFile(name: string, content: string): string {
  const p = path.join(tmpDir, name)
  fs.writeFileSync(p, content, 'utf-8')
  return p
}

// ==================== 换行与 BOM ====================

describe('换行与 BOM', () => {
  it('detectLineEnding: 识别 CRLF / LF / CR', () => {
    expect(detectLineEnding('a\r\nb\r\nc')).toBe('\r\n')
    expect(detectLineEnding('a\nb\nc')).toBe('\n')
    expect(detectLineEnding('a\rb\rc')).toBe('\r')
    expect(detectLineEnding('abc')).toBe('\n')
  })

  it('normalizeLineEndings: 统一换行', () => {
    expect(normalizeLineEndings('a\r\nb\rc\n')).toBe('a\nb\nc\n')
    expect(normalizeLineEndings('a\nb', '\r\n')).toBe('a\r\nb')
  })

  it('stripBom: 剥离 BOM 保留内容', () => {
    expect(stripBom('\uFEFFhello')).toBe('hello')
    expect(stripBom('hello')).toBe('hello')
  })
})

// ==================== 核心痛点：CRLF 匹配 ====================

describe('CRLF 文件编辑（核心痛点）', () => {
  const crlfContent = 'line1\r\nline2\r\nline3\r\ntarget line\r\nline5\r\n'

  it('fuzzyMatch: 多行 old_string（LF）匹配 CRLF 内容', () => {
    const result = fuzzyMatch(crlfContent, 'line2\nline3\ntarget line', 'X\nY\nZ')
    expect(result.matched).toBe(true)
    expect(result.strategy).toBe('exact') // 归一化后精确命中
  })

  it('applyEdit: 替换后保持 CRLF 行尾', () => {
    const { content, result } = applyEdit(crlfContent, 'target line', 'REPLACED')
    expect(result.matched).toBe(true)
    expect(content).toBe('line1\r\nline2\r\nline3\r\nREPLACED\r\nline5\r\n')
    expect(detectLineEnding(content)).toBe('\r\n')
  })

  it('applyEdit: 单行 old 带行尾差异也能命中', () => {
    const { result } = applyEdit(crlfContent, 'line3\r\n', 'L3\n')
    expect(result.matched).toBe(true)
  })

  it('applyEditToFile: CRLF 文件整体编辑并保持行尾', () => {
    const p = tmpFile('crlf.txt', crlfContent)
    const res = applyEditToFile(p, 'line2\nline3\ntarget line', 'A\nB\nC')
    expect(res.ok).toBe(true)
    expect(res.matched).toBe(true)
    const after = fs.readFileSync(p, 'utf-8')
    expect(after).toBe('line1\r\nA\r\nB\r\nC\r\nline5\r\n')
    expect(res.verified).toBe(true)
  })
})

// ==================== BOM 处理 ====================

describe('BOM 处理', () => {
  it('readFileSafe: 剥离 BOM 并记录', () => {
    const p = tmpFile('bom.txt', '\uFEFFhello\nworld')
    const r = readFileSafe(p)
    expect(r.hadBom).toBe(true)
    expect(r.content).toBe('hello\nworld')
  })

  it('writeFileSafe: 覆盖 BOM 文件时保持 BOM', () => {
    const p = tmpFile('bom2.txt', '\uFEFFold\ncontent')
    writeFileSafe(p, 'new\ncontent')
    const buf = fs.readFileSync(p)
    expect(buf[0]).toBe(0xef)
    expect(buf[1]).toBe(0xbb)
    expect(buf[2]).toBe(0xbf)
    expect(buf.toString('utf-8')).toBe('\uFEFFnew\ncontent')
  })

  it('applyEditToFile: BOM + CRLF 文件编辑后两者都保持', () => {
    const p = tmpFile('bom-crlf.txt', '\uFEFFa\r\nb\r\nc\r\n')
    const res = applyEditToFile(p, 'b', 'B2')
    expect(res.ok).toBe(true)
    const buf = fs.readFileSync(p)
    expect(buf.toString('utf-8')).toBe('\uFEFFa\r\nB2\r\nc\r\n')
  })
})

// ==================== 九层模糊策略 ====================

describe('模糊匹配策略链', () => {
  it('字面 \\n 的 old_string（模型参数转义形态）匹配真实换行内容', () => {
    const content = 'const a = 1;\nif (msg.type === \'token\' && msg.messages) {\n  handleToken(msg);\n}\n'
    const oldLiteral = 'if (msg.type === \'token\' && msg.messages) {\\n  handleToken(msg);\\n}'
    const r = fuzzyMatch(content, oldLiteral, 'REPLACED')
    expect(r.matched).toBe(true)
    expect(r.strategy).toBe('exact')
  })

  it('exact: 精确命中', () => {
    const r = fuzzyMatch('hello world', 'world', 'there')
    expect(r.matched).toBe(true)
    expect(r.strategy).toBe('exact')
    expect(r.startOffset).toBe(6)
  })

  it('trimmed: 行首尾空白差异', () => {
    const r = fuzzyMatch('const a = 1;\n  const b = 2;  \nconst c = 3;', 'const b = 2;', 'const b = 22;')
    expect(r.matched).toBe(true)
    // 应该通过 trimmed 或 whitespace 命中
    expect(r.strategy).not.toBeNull()
  })

  it('whitespace: 行内连续空白差异', () => {
    const r = fuzzyMatch('function  foo(a, b) {', 'function foo(a, b) {', 'function foo(x) {')
    expect(r.matched).toBe(true)
  })

  it('indentation: 缩进差异', () => {
    const content = 'if (x) {\n        console.log(1);\n    console.log(2);\n}'
    const r = fuzzyMatch(content, '    console.log(1);\n    console.log(2);', '    doThing();')
    expect(r.matched).toBe(true)
  })

  it('escapes: 字面 \\n 转义差异', () => {
    const r = fuzzyMatch('const s = "a\\nb";', 'a\\nb', 'a\nb')
    expect(r.matched).toBe(true)
  })

  it('unicode: NFKC 差异（全角/半角）', () => {
    const r = fuzzyMatch('ＡＢＣ（全角）', 'ABC(全角)', 'XYZ')
    expect(r.matched).toBe(true)
    expect(r.strategy).toBe('unicode')
  })

  it('block-anchor: 块内行漂移容忍', () => {
    const content = 'start\nalpha\nbeta\nchanged-line\ngamma\nend\n'
    const r = fuzzyMatch(content, 'start\nalpha\nbeta\noriginal-line\ngamma\nend', 'REPLACED')
    expect(r.matched).toBe(true)
    expect(r.strategy).toBe('block-anchor')
  })

  it('context-aware: 内容归一化后命中', () => {
    const content = 'const  x  =  1;\nconst y = 2;'
    const r = fuzzyMatch(content, 'const x = 1;', 'const x = 10;')
    expect(r.matched).toBe(true)
  })
})

// ==================== 已应用检测 ====================

describe('isAlreadyApplied', () => {
  it('old 已被 new 替换 → 已应用', () => {
    expect(isAlreadyApplied('hello there world', 'foo', 'there')).toBe(true)
  })

  it('old == new → 已应用', () => {
    expect(isAlreadyApplied('abc', 'x', 'x')).toBe(true)
  })

  it('old 在内容中 → 未应用', () => {
    expect(isAlreadyApplied('hello foo world', 'foo', 'bar')).toBe(false)
  })

  it('applyEdit: alreadyApplied 返回正确', () => {
    const { result } = applyEdit('already done', 'old', 'done')
    expect(result.alreadyApplied).toBe(true)
    expect(result.matched).toBe(false)
  })
})

// ==================== 原子写与写后验证 ====================

describe('原子写', () => {
  it('atomicWrite: 落盘内容正确', () => {
    const p = path.join(tmpDir, 'atomic.txt')
    atomicWrite(p, 'atomic content')
    expect(fs.readFileSync(p, 'utf-8')).toBe('atomic content')
  })

  it('atomicWrite: 同目录无残留临时文件', () => {
    const p = path.join(tmpDir, 'atomic2.txt')
    atomicWrite(p, 'x')
    const leftovers = fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp'))
    expect(leftovers).toHaveLength(0)
  })

  it('writeFileSafe: 返回 verified=true 且字节数正确', () => {
    const p = path.join(tmpDir, 'verify.txt')
    const res = writeFileSafe(p, 'hello\nworld')
    expect(res.ok).toBe(true)
    expect(res.verified).toBe(true)
    expect(res.bytes).toBe(11)
  })

  it('writeFileSafe: 覆盖已有文件时行尾保持（只转换已有换行，不补结尾）', () => {
    const p = tmpFile('eol-keep.txt', 'a\r\nb\r\nc\r\n')
    writeFileSafe(p, 'x\ny\nz')
    const after = fs.readFileSync(p, 'utf-8')
    expect(after).toBe('x\r\ny\r\nz')
  })
})

// ==================== 相近行提示 ====================

describe('相近行提示（Did you mean?）', () => {
  it('findClosestLines: 返回相似行并按相似度排序', () => {
    const content = 'const alpha = 1;\nconst beta = 2;\nfunction gamma() {}'
    const closest = findClosestLines(content, 'const alfa = 1;')
    expect(closest.length).toBeGreaterThan(0)
    expect(closest[0].line).toBe('const alpha = 1;')
  })

  it('buildDidYouMean: 无相近行时返回空串', () => {
    expect(buildDidYouMean('hello', 'zzz')).toBe('')
  })
})
