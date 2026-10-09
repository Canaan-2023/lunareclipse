/**
 * tool-edit-write.test.ts
 * 真实工具链集成测试：实例化 EditTool / WriteTool 走完整 execute 流程，
 * 验证 CRLF/BOM 文件在新引擎下编辑后行尾保持、返回结构完整（addedLines/removedLines）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { EditTool } from '../app/electron/main/tools/edit'
import { WriteTool } from '../app/electron/main/tools/write'

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
