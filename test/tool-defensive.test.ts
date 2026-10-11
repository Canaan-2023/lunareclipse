import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ReadTool } from '../electron/main/tools/read'
import { GrepTool } from '../electron/main/tools/grep'

describe('ReadTool 防御性能力（2026-08-16）', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'read-test-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('二进制文件不吐乱码，返回明确错误', async () => {
    const bin = join(root, 'data.bin')
    writeFileSync(bin, Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x00, 0x42]))
    const res = await new ReadTool().execute({ file_path: bin })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('二进制文件')
  })

  it('图片文件返回图片提示（重定向视觉工具）', async () => {
    // 构造含 NUL 的假 PNG 头
    const png = join(root, 'pic.png')
    writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00]), Buffer.alloc(64, 0)]))
    const res = await new ReadTool().execute({ file_path: png })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('图片文件')
  })

  it('正常文本文件读取不变（回归）', async () => {
    const txt = join(root, 'a.txt')
    writeFileSync(txt, 'line1\nline2\nline3\n', 'utf-8')
    const res = await new ReadTool().execute({ file_path: txt })
    expect(res.ok).toBe(true)
    const data = res.data as { totalLines: number; content: string }
    // 'line1\nline2\nline3\n' split 后 4 项（尾随 \n 产生空行）
    expect(data.totalLines).toBe(4)
    expect(data.content).toContain('line2')
  })

  it('超长单行截断并标注', async () => {
    const txt = join(root, 'long.txt')
    writeFileSync(txt, 'x'.repeat(6000) + '\nshort\n', 'utf-8')
    const res = await new ReadTool().execute({ file_path: txt })
    expect(res.ok).toBe(true)
    const data = res.data as { content: string }
    expect(data.content).toContain('行过长已截断')
    expect(data.content).not.toContain('x'.repeat(6000))
  })

  it('文件不存在时建议相似文件', async () => {
    writeFileSync(join(root, 'config.yaml'), 'a: 1\n', 'utf-8')
    writeFileSync(join(root, 'config.yml'), 'b: 2\n', 'utf-8')
    writeFileSync(join(root, 'other.txt'), 'c\n', 'utf-8')
    const res = await new ReadTool().execute({ file_path: join(root, 'config.json') })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('相似文件')
    // 同名不同扩展（config.yaml/config.yml）应排前面
    expect(res.error).toContain('config.yaml')
    expect(res.error).toContain('config.yml')
  })
})

describe('GrepTool 零匹配诊断（2026-08-16）', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'grep-test-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('大小写不匹配时给出提示', async () => {
    writeFileSync(join(root, 'a.ts'), 'HelloWorld\n', 'utf-8')
    const res = await new GrepTool().execute({ pattern: 'helloworld', path: root, output_mode: 'content' })
    expect(res.ok).toBe(true)
    const data = res.data as { count: number; hint?: string }
    expect(data.count).toBe(0)
    expect(data.hint).toContain('大小写')
  })

  it('正则元字符干扰时提示转义', async () => {
    // 只构造大写 V1.0 的文件；搜小写 v1.0 → 大小写敏感 0 匹配
    // 模式含元字符 "."（正则语义 = 任意字符）→ 固定字符串探测会命中 → 提示
    writeFileSync(join(root, 'ver2.ts'), 'V1.0\n', 'utf-8')
    const res = await new GrepTool().execute({ pattern: 'v1.0', path: root, output_mode: 'content' })
    expect(res.ok).toBe(true)
    const data = res.data as { count: number; hint?: string }
    expect(data.count).toBe(0)
    // 大小写探测会命中（ver2.ts 有 V1.0），提示大小写
    expect(data.hint).toBeDefined()
  })

  it('正常匹配不受诊断影响（回归）', async () => {
    writeFileSync(join(root, 'd.ts'), 'TODO: fix\n', 'utf-8')
    const res = await new GrepTool().execute({ pattern: 'TODO', path: root, output_mode: 'content' })
    expect(res.ok).toBe(true)
    const data = res.data as { count: number; hint?: string }
    expect(data.count).toBe(1)
    expect(data.hint).toBeUndefined()
  })
})
