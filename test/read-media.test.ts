import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import JSZip from 'jszip'
import { ReadTool } from '../electron/main/tools/read'

/**
 * Read 媒体处理（2026-10）：pdf/docx/xlsx/ipynb 复用 document-extract 提取为文本；
 * 图片返回头部元信息（格式/尺寸/大小）而非报错。文本行为保持不变。
 */

describe('Read 办公文档提取', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'read-media-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  async function makeDocx(): Promise<Buffer> {
    const zip = new JSZip()
    zip.file(
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>第一段 Hello</w:t></w:r></w:p>
    <w:p><w:r><w:t>第二段 World</w:t></w:r></w:p>
  </w:body>
</w:document>`
    )
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
    return zip.generateAsync({ type: 'nodebuffer' })
  }

  it('docx 提取为文本（type=document + content）', async () => {
    const p = join(root, 'note.docx')
    writeFileSync(p, await makeDocx())
    const res = await new ReadTool().execute({ file_path: p })
    expect(res.ok).toBe(true)
    const data = res.data as { type: string; format: string; content: string; totalChars: number }
    expect(data.type).toBe('document')
    expect(data.format).toBe('docx')
    expect(data.content).toContain('第一段 Hello')
    expect(data.content).toContain('第二段 World')
    expect(data.totalChars).toBeGreaterThan(0)
  })

  it('ipynb 提取为文本（markdown/code 分节）', async () => {
    const nb = Buffer.from(
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
          { cell_type: 'markdown', metadata: {}, source: ['# 标题\n', '说明文字'] },
          { cell_type: 'code', metadata: {}, source: ['print(1)'], outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }] }
        ]
      })
    )
    const p = join(root, 'demo.ipynb')
    writeFileSync(p, nb)
    const res = await new ReadTool().execute({ file_path: p })
    expect(res.ok).toBe(true)
    const data = res.data as { type: string; format: string; content: string }
    expect(data.type).toBe('document')
    expect(data.format).toBe('ipynb')
    expect(data.content).toContain('标题')
    expect(data.content).toContain('print(1)')
  })

  it('损坏的文档返回明确错误（不吐字节）', async () => {
    const bad = join(root, 'broken.docx')
    writeFileSync(bad, Buffer.from('definitely not a zip file content'))
    const res = await new ReadTool().execute({ file_path: bad })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('文档解析失败')
  })
})

describe('Read 图片元信息', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'read-img-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('PNG 返回宽高与格式', async () => {
    const p = join(root, 'a.png')
    writeFileSync(p, Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
      Buffer.from([0x00, 0x00, 0x02, 0x58, 0x00, 0x00, 0x01, 0x90])
    ]))
    const res = await new ReadTool().execute({ file_path: p })
    expect(res.ok).toBe(true)
    const data = res.data as { type: string; format: string; width: number; height: number }
    expect(data.type).toBe('image')
    expect(data.format).toBe('png')
    expect(data.width).toBe(600)
    expect(data.height).toBe(400)
  })

  it('JPEG 扫描 SOF 标记返回宽高', async () => {
    // FFD8 + 一个 APP0 段（长度 16）+ SOF0 段（精度 8 + 高 200 + 宽 300）
    const jpg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xc8, 0x01, 0x2c, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0x04, 0x11, 0x00, 0x05])
    ])
    const p = join(root, 'b.jpg')
    writeFileSync(p, jpg)
    const res = await new ReadTool().execute({ file_path: p })
    expect(res.ok).toBe(true)
    const data = res.data as { type: string; format: string; width: number; height: number }
    expect(data.format).toBe('jpeg')
    expect(data.width).toBe(300)
    expect(data.height).toBe(200)
  })

  it('GIF 返回宽高（小端）', async () => {
    const p = join(root, 'c.gif')
    writeFileSync(p, Buffer.concat([
      Buffer.from('GIF89a'),
      Buffer.from([0x40, 0x01, 0x2c, 0x01, 0x00, 0x00, 0x00])
    ]))
    const res = await new ReadTool().execute({ file_path: p })
    expect(res.ok).toBe(true)
    const data = res.data as { type: string; format: string; width: number; height: number }
    expect(data.format).toBe('gif')
    expect(data.width).toBe(320)
    expect(data.height).toBe(300)
  })

  it('WebP VP8 返回宽高', async () => {
    // RIFF 头 + VP8 块（宽高在 26/28 偏移）
    const webp = Buffer.alloc(30)
    webp.write('RIFF', 0, 'ascii')
    webp.writeUInt32LE(26, 4)
    webp.write('WEBP', 8, 'ascii')
    webp.write('VP8 ', 12, 'ascii')
    webp.writeUInt32LE(10, 16)
    webp.writeUInt16LE(0x9d, 20)
    webp.writeUInt16LE(0x012a, 22)
    webp.writeUInt16LE(400, 24)
    webp.writeUInt16LE(320, 26)
    webp.writeUInt16LE(200, 28)
    const p = join(root, 'd.webp')
    writeFileSync(p, webp)
    const res = await new ReadTool().execute({ file_path: p })
    expect(res.ok).toBe(true)
    const data = res.data as { type: string; format: string; width: number; height: number }
    expect(data.format).toBe('webp')
    expect(data.width).toBe(320)
    expect(data.height).toBe(200)
  })

  it('SVG 按文本读取（源码可见宽高属性）', async () => {
    const p = join(root, 'e.svg')
    writeFileSync(p, '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80"/></svg>')
    const res = await new ReadTool().execute({ file_path: p })
    expect(res.ok).toBe(true)
    // SVG 是文本文件：不走图片元信息分支，直接返回源码（含 width/height 属性）
    const data = res.data as { content: string; totalLines: number }
    expect(data.content).toContain('width="120"')
    expect(data.content).toContain('height="80"')
    expect(data.totalLines).toBeGreaterThan(0)
  })

  it('未知二进制仍报错（不吐乱码）', async () => {
    const p = join(root, 'x.bin')
    writeFileSync(p, Buffer.from([0x00, 0x01, 0x02, 0xff]))
    const res = await new ReadTool().execute({ file_path: p })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('二进制文件')
  })

  it('文本文件回归：仍返回行号内容', async () => {
    const p = join(root, 't.txt')
    writeFileSync(p, 'a\nb\nc\n', 'utf-8')
    const res = await new ReadTool().execute({ file_path: p })
    expect(res.ok).toBe(true)
    const data = res.data as { totalLines: number; content: string }
    expect(data.totalLines).toBe(4)
    expect(data.content).toContain('→b')
  })
})