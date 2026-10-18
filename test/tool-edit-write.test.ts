/**
 * tool-edit-write.test.ts
 * 真实工具链集成测试：实例化 EditTool / WriteTool 走完整 execute 流程，
 * 验证 CRLF/BOM 文件在新引擎下编辑后行尾保持、返回结构完整（addedLines/removedLines）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { EditTool } from '../electron/main/tools/edit'
import { WriteTool } from '../electron/main/tools/write'
import { clearFileHistory, getFileHistory } from '../electron/main/tools/file-history'

let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-edit-write-'))
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function tmpFile(name: string, content: string): string {
  const p = path.join(tmpDir, name)
  fs.writeFileSync(p, content, 'utf-8')
  return p
}

describe('EditTool 真实工具链（CRLF）', () => {
  it('多行 old_string 编辑 CRLF 文件：匹配成功 + 行尾保持 + 返回结构完整', async () => {
    const p = tmpFile('edit-crlf.txt', 'line1\r\nline2\r\nline3\r\nline4\r\n')
    const tool = new EditTool()
    const res = await tool.execute(
      { file_path: p, old_string: 'line2\nline3', new_string: 'X\nY' },
      {}
    )
    expect(res.ok).toBe(true)
    const data = res.data as Record<string, unknown>
    expect(data.replacements).toBe(1)
    expect(data.strategy).toBeTruthy()
    expect(data.addedLines).toBe(2)
    expect(data.removedLines).toBe(2)
    // 行尾保持 CRLF
    const after = fs.readFileSync(p, 'utf-8')
    expect(after).toBe('line1\r\nX\r\nY\r\nline4\r\n')
  })

  it('CRLF 文件 + 单行匹配：编辑成功且不破坏其余行', async () => {
    const p = tmpFile('edit-crlf2.txt', 'a\r\nb\r\nc\r\n')
    const tool = new EditTool()
    const res = await tool.execute({ file_path: p, old_string: 'b', new_string: 'B2' }, {})
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(p, 'utf-8')).toBe('a\r\nB2\r\nc\r\n')
  })

  it('BOM + CRLF 文件：BOM 保持', async () => {
    const p = tmpFile('edit-bom.txt', '\uFEFFx\r\ny\r\nz\r\n')
    const tool = new EditTool()
    const res = await tool.execute({ file_path: p, old_string: 'y', new_string: 'Y2' }, {})
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(p, 'utf-8')).toBe('\uFEFFx\r\nY2\r\nz\r\n')
  })

  it('replace_all：全文替换 + 行尾保持', async () => {
    const p = tmpFile('edit-all.txt', '1\r\nfoo\r\n2\r\nfoo\r\n3\r\n')
    const tool = new EditTool()
    const res = await tool.execute(
      { file_path: p, old_string: 'foo', new_string: 'BAR', replace_all: true },
      {}
    )
    expect(res.ok).toBe(true)
    expect((res.data as Record<string, unknown>).replacements).toBe(2)
    expect(fs.readFileSync(p, 'utf-8')).toBe('1\r\nBAR\r\n2\r\nBAR\r\n3\r\n')
  })

  it('编辑已应用（old 已被替换）：返回 ok 且 note 说明', async () => {
    const p = tmpFile('edit-applied.txt', 'already BAR here')
    const tool = new EditTool()
    const res = await tool.execute({ file_path: p, old_string: 'foo', new_string: 'BAR' }, {})
    expect(res.ok).toBe(true)
    expect((res.data as Record<string, unknown>).replacements).toBe(0)
  })

  it('匹配失败：报错 + 无文件改动', async () => {
    const p = tmpFile('edit-miss.txt', 'hello world')
    const tool = new EditTool()
    const res = await tool.execute({ file_path: p, old_string: 'nonexistent', new_string: 'x' }, {})
    expect(res.ok).toBe(false)
    expect(fs.readFileSync(p, 'utf-8')).toBe('hello world')
  })
})

describe('WriteTool 真实工具链', () => {
  it('覆盖 CRLF 文件：行尾保持 + verified', async () => {
    const p = tmpFile('write-crlf.txt', 'old\r\ncontent\r\n')
    const tool = new WriteTool()
    const res = await tool.execute({ file_path: p, content: 'new\ncontent' }, {})
    expect(res.ok).toBe(true)
    expect((res.data as Record<string, unknown>).verified).toBe(true)
    expect(fs.readFileSync(p, 'utf-8')).toBe('new\r\ncontent')
  })

  it('新文件：内容原样写入 + 字节数正确', async () => {
    const p = path.join(tmpDir, 'write-new.txt')
    const tool = new WriteTool()
    const res = await tool.execute({ file_path: p, content: 'a\nb\nc' }, {})
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(p, 'utf-8')).toBe('a\nb\nc')
    expect((res.data as Record<string, unknown>).bytes).toBe(5)
  })
})

describe('文件编辑审计（会话级）', () => {
  it('Write 落盘成功后写入会话审计（记录路径与行数口径一致）', async () => {
    clearFileHistory('audit-s')
    const p = tmpFile('audit-write.txt', 'old\ncontent\n')
    const tool = new WriteTool()
    const res = await tool.execute(
      { file_path: p, content: 'new\nline\n' },
      { sessionId: 'audit-s' }
    )
    expect(res.ok).toBe(true)
    const history = getFileHistory('audit-s')
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      sessionId: 'audit-s',
      op: 'Write',
      filePath: p,
      addedLines: (res.data as Record<string, unknown>).addedLines,
      removedLines: (res.data as Record<string, unknown>).removedLines
    })
    expect(history[0].sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('Edit 落盘成功后写入会话审计', async () => {
    clearFileHistory('audit-e')
    const p = tmpFile('audit-edit.txt', 'line1\nold\nline3\n')
    const tool = new EditTool()
    const res = await tool.execute(
      { file_path: p, old_string: 'old', new_string: 'new' },
      { sessionId: 'audit-e' }
    )
    expect(res.ok).toBe(true)
    const history = getFileHistory('audit-e')
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ sessionId: 'audit-e', op: 'Edit', filePath: p })
    expect(history[0].addedLines).toBe(1)
    expect(history[0].removedLines).toBe(1)
  })

  it('编辑已应用（无实际修改）不写审计', async () => {
    clearFileHistory('audit-noop')
    const p = tmpFile('audit-noop.txt', 'already applied')
    const tool = new EditTool()
    const res = await tool.execute(
      { file_path: p, old_string: 'missing', new_string: 'x' },
      { sessionId: 'audit-noop' }
    )
    expect(res.ok).toBe(false)
    expect(getFileHistory('audit-noop')).toHaveLength(0)
  })

  it('不同会话的审计互相隔离', async () => {
    clearFileHistory()
    const p1 = tmpFile('audit-iso1.txt', 'a')
    const p2 = tmpFile('audit-iso2.txt', 'b')
    await new WriteTool().execute({ file_path: p1, content: 'x' }, { sessionId: 'iso-1' })
    await new WriteTool().execute({ file_path: p2, content: 'y' }, { sessionId: 'iso-2' })
    expect(getFileHistory('iso-1')).toHaveLength(1)
    expect(getFileHistory('iso-2')).toHaveLength(1)
    expect(getFileHistory('iso-1')[0].filePath).toBe(p1)
  })
})

describe('EditTool/WriteTool 修复回归（MAJOR 假成功 + 输入守卫）', () => {
  it('replace_all 模糊策略命中但无法全文 split：不再假成功，退化为偏移替换并真实改动', async () => {
    // 行内空白为 tab：old_string 用 3 空格写，whitespace 策略折叠后命中，
    // 但归一化 old（含空格）不以原样出现在归一化 content（含 tab）中 → split 0 命中。
    // 修复前：写回原文却返回 ok:true + replacements:0（假成功）；修复后：真实替换一次并提示退化。
    const p = tmpFile('edit-major.txt', 'foo\tbar\nbaz\n')
    const tool = new EditTool()
    const res = await tool.execute(
      { file_path: p, old_string: 'foo   bar', new_string: 'qux', replace_all: true },
      {}
    )
    expect(res.ok).toBe(true)
    const data = res.data as Record<string, unknown>
    expect(data.replacements).toBe(1)
    expect(data.strategy).toBeTruthy()
    expect(data.note).toContain('退化为替换首个匹配')
    // 关键断言：文件必须真实被改，而不是假成功
    expect(fs.readFileSync(p, 'utf-8')).toBe('qux\nbaz\n')
  })

  it('replace_all 精确匹配仍全文替换（不回归）', async () => {
    const p = tmpFile('edit-all2.txt', '1\nfoo\n2\nfoo\n3\n')
    const tool = new EditTool()
    const res = await tool.execute(
      { file_path: p, old_string: 'foo', new_string: 'BAR', replace_all: true },
      {}
    )
    expect(res.ok).toBe(true)
    expect((res.data as Record<string, unknown>).replacements).toBe(2)
    expect(fs.readFileSync(p, 'utf-8')).toBe('1\nBAR\n2\nBAR\n3\n')
  })

  it('edit 空 file_path：运行时校验拒绝', async () => {
    const res = await new EditTool().execute({ file_path: '', old_string: 'a', new_string: 'b' }, {})
    expect(res.ok).toBe(false)
    expect((res.error ?? '').toString()).toContain('file_path 必填')
  })

  it('edit 不存在的文件：可读报错（ENOENT）', async () => {
    const missing = path.join(tmpDir, 'not-exist-edit.txt')
    const res = await new EditTool().execute({ file_path: missing, old_string: 'a', new_string: 'b' }, {})
    expect(res.ok).toBe(false)
    expect((res.error ?? '').toString()).toContain('文件不存在')
  })

  it('write 空 file_path：运行时校验拒绝', async () => {
    const res = await new WriteTool().execute({ file_path: '', content: 'x' }, {})
    expect(res.ok).toBe(false)
    expect((res.error ?? '').toString()).toContain('file_path 必填')
  })

  it('write content 非字符串：运行时校验拒绝', async () => {
    const res = await new WriteTool().execute(
      { file_path: path.join(tmpDir, 'w-bad.txt'), content: 123 as unknown as string },
      {}
    )
    expect(res.ok).toBe(false)
    expect((res.error ?? '').toString()).toContain('content 必填')
  })
})
