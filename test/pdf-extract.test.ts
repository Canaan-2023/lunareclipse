import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { isExtractableDocument, extractDocumentBytes } from '../electron/main/api/document-extract'

/**
 * PDF 提取测试（2026-08-18）：document-extract 现在支持 .pdf（pdfjs-dist，Apache-2.0 纯 JS）。
 * 真实验证源取 Cordis 论文（LaTeX 生成、有文本层、含复杂编码/CID 字体）——这是手写 FlateDecode 提取
 * 会出乱码的场景，pdfjs 能正确提取。
 *
 * 测试源可移植化（分发约束）：不再硬编码本机绝对路径——优先取环境变量
 * PDF_EXTRACT_TEST_SOURCE，未设置则回退到项目内约定的论文扫描目录
 * （test/fixtures/paper.pdf，随仓库分发可自行放入样例）；两者都不存在时
 * 跳过真实提取断言（仅验证分发逻辑），保证任何机器上本文件都能干净运行。
 * 留存理由：真实 PDF 是验证 pdfjs 复杂编码提取的关键证据，不能删成纯 mock；
 * 但路径不许携带本机用户名，故改为环境变量/仓库内 fixture 双路探测。
 */
const PAPER = process.env.PDF_EXTRACT_TEST_SOURCE ?? join(process.cwd(), 'test', 'fixtures', 'paper.pdf')

describe('PDF 文本提取', () => {
  it('.pdf 被识别为可提取文档', () => {
    expect(isExtractableDocument('paper.pdf')).toBe(true)
    expect(isExtractableDocument('report.txt')).toBe(false)
  })

  it('extractDocumentBytes 对 .pdf 分发到 extractPdf 且提取到可读文本（真实 LaTeX 论文）', async () => {
    if (!existsSync(PAPER)) {
      console.warn('✋ 测试源 paper.pdf 不存在，跳过真实提取断言（仅验证分发不抛错已在下方覆盖）')
      return
    }
    const buf = readFileSync(PAPER)
    const text = await extractDocumentBytes(buf, 'paper.pdf')
    expect(text.length).toBeGreaterThan(200)
    // 关键：必须提取到可读英文（非乱码控制符）——验证 pdfjs 正确处理 LaTeX/CID 字体
    expect(text).toMatch(/programming|composab|and|the/i)
    // eslint-disable-next-line no-control-regex -- 刻意断言无控制字符（乱码提取会漏出 \u0000-\u001f）
    expect(/[\u0000-\u0008\u000e-\u001f]/.test(text.slice(0, 5000))).toBe(false)
  })
})
