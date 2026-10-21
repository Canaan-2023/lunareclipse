import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { extractDocumentBytes, ExtractionError, isExtractableDocument } from '../electron/main/api/document-extract'

const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const NS_S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'

async function makeDocx(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${NS_W}">
  <w:body>
    <w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>World</w:t></w:r></w:p>
    <w:p><w:r><w:t>Line1</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>Line2</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">  indented  </w:t></w:r></w:p>
  </w:body>
</w:document>`
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function makeXlsx(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="${NS_S}" xmlns:r="${NS_REL}">
  <sheets>
    <sheet name="Data" sheetId="1" r:id="rId1"/>
    <sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/>
  </sheets>
</workbook>`
  )
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="${NS_PKG_REL}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`
  )
  zip.file(
    'xl/sharedStrings.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="${NS_S}">
  <si><t>Apple</t></si>
  <si><t>Banana</t></si>
</sst>`
  )
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="${NS_S}">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1"><v>42</v></c>
      <c r="C1" t="inlineStr"><is><t>Inline</t></is></c>
      <c r="D1" t="b"><v>1</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>1</v></c>
      <c r="C2"><v>3.14</v></c>
    </row>
    <row r="3"><c r="A3" t="e"><v>#DIV/0!</v></c></row>
  </sheetData>
</worksheet>`
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

const IPYNB_V4 = Buffer.from(
  JSON.stringify({
    cells: [
      { cell_type: 'markdown', source: ['# Title\n', 'Intro text'] },
      {
        cell_type: 'code',
        source: ["print('hi')"],
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['hi\n', 'bye\r\n'] }]
      },
      {
        cell_type: 'code',
        source: ['1/0'],
        outputs: [
          {
            output_type: 'error',
            ename: 'ZeroDivisionError',
            evalue: 'division by zero',
            traceback: ['Traceback (most recent call last):', 'ZeroDivisionError: division by zero']
          }
        ]
      },
      {
        cell_type: 'code',
        source: ['plot()'],
        outputs: [
          {
            output_type: 'display_data',
            data: { 'image/png': Buffer.from('fake-image-bytes').toString('base64') }
          }
        ]
      }
    ],
    nbformat: 4,
    nbformat_minor: 5
  })
)

describe('isExtractableDocument', () => {
  it('识别文档扩展名（含新增 pdf）', () => {
    expect(isExtractableDocument('a.docx')).toBe(true)
    expect(isExtractableDocument('b.XLSX')).toBe(true)
    expect(isExtractableDocument('c.ipynb')).toBe(true)
    expect(isExtractableDocument('e.pdf')).toBe(true) // 2026-08-18 起支持 PDF
    expect(isExtractableDocument('d.txt')).toBe(false)
  })
})

describe('extractDocumentBytes - ipynb', () => {
  it('提取 v4 notebook：markdown/code 分节 + 输出渲染', async () => {
    const text = await extractDocumentBytes(IPYNB_V4, 'demo.ipynb')
    expect(text).toContain('# ── Markdown cell 1 ──')
    expect(text).toContain('# Title')
    expect(text).toContain('Intro text')
    expect(text).toContain('# ── Code cell 1 ──')
    expect(text).toContain("print('hi')")
    expect(text).toContain('# ── Output (cell 1) ──')
    expect(text).toContain('hi')
    expect(text).toContain('# ── Code cell 2 ──')
    expect(text).toContain('Error: ZeroDivisionError: division by zero')
    // 图片输出占位（base64 10 字节 → "16 B"）
    expect(text).toContain('[image/png output — 16 B, omitted]')
  })

  it('坏 JSON 抛 ExtractionError', async () => {
    await expect(extractDocumentBytes(Buffer.from('{not json'), 'bad.ipynb')).rejects.toThrow(ExtractionError)
  })
})

describe('extractDocumentBytes - docx', () => {
  it('提取段落文本：tab/换行/空白保留', async () => {
    const buf = await makeDocx()
    const text = await extractDocumentBytes(buf, 'test.docx')
    const lines = text.split('\n')
    expect(lines[0]).toBe('Hello\tWorld')
    // w:br 拆成两行
    expect(lines[1]).toBe('Line1')
    expect(lines[2]).toBe('Line2')
    expect(text).toContain('Line1')
    expect(text).toContain('Line2')
    expect(text).toContain('  indented  ')
  })

  it('非 docx（非 zip）抛 ExtractionError', async () => {
    await expect(extractDocumentBytes(Buffer.from('not a zip'), 'fake.docx')).rejects.toThrow(ExtractionError)
  })
})

describe('extractDocumentBytes - xlsx', () => {
  it('提取多 sheet：sharedStrings/数字/内联/布尔/错误，隐藏 sheet 跳过', async () => {
    const buf = await makeXlsx()
    const text = await extractDocumentBytes(buf, 'test.xlsx')
    expect(text).toContain('# ── Sheet: Data ──')
    expect(text).toContain('Apple\t42\tInline\tTRUE')
    expect(text).toContain('Banana\t\t3.14')
    expect(text).toContain('#DIV/0!')
    expect(text).not.toContain('Hidden')
  })

  it('非 xlsx 抛 ExtractionError', async () => {
    await expect(extractDocumentBytes(Buffer.from('nope'), 'fake.xlsx')).rejects.toThrow(ExtractionError)
  })
})

describe('extractDocumentBytes - 通用', () => {
  it('不支持的扩展名抛错', async () => {
    await expect(extractDocumentBytes(Buffer.from('x'), 'a.xyz')).rejects.toThrow('Unsupported document type')
  })

  it('无效 PDF 抛 Invalid PDF structure（.pdf 已支持，内容非 PDF 时报结构错）', async () => {
    await expect(extractDocumentBytes(Buffer.from('not a pdf'), 'a.pdf')).rejects.toThrow(/Invalid PDF structure|PDF/i)
  })

  it('超大文件拒绝（>50MB）', async () => {
    const big = Buffer.alloc(51 * 1024 * 1024, 0)
    await expect(extractDocumentBytes(big, 'big.docx')).rejects.toThrow('too large')
  })
})
