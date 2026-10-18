import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readCounter, writeCounter, consumeNextSeq } from '../electron/main/models/counter'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('counter 纯函数', () => {
  let tmpDir: string
  let counterPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'counter-test-'))
    counterPath = join(tmpDir, '计数器.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('readCounter 文件不存在时返回 1', () => {
    expect(readCounter(counterPath)).toEqual({ 下一个序号: 1 })
  })

  it('writeCounter 创建文件并写入', () => {
    writeCounter(counterPath, { 下一个序号: 42 })
    expect(existsSync(counterPath)).toBe(true)
    const raw = JSON.parse(readFileSync(counterPath, 'utf-8'))
    expect(raw.下一个序号).toBe(42)
  })

  it('readCounter 读取已写入的值', () => {
    writeCounter(counterPath, { 下一个序号: 7 })
    expect(readCounter(counterPath)).toEqual({ 下一个序号: 7 })
  })

  it('readCounter 无效 JSON 返回 1', () => {
    writeFileSync(counterPath, 'not json', 'utf-8')
    expect(readCounter(counterPath)).toEqual({ 下一个序号: 1 })
  })

  it('readCounter 序号 < 1 返回 1', () => {
    writeCounter(counterPath, { 下一个序号: 0 })
    expect(readCounter(counterPath)).toEqual({ 下一个序号: 1 })
  })

  it('consumeNextSeq 返回当前序号并递增', () => {
    writeCounter(counterPath, { 下一个序号: 5 })
    expect(consumeNextSeq(counterPath)).toBe(5)
    expect(readCounter(counterPath)).toEqual({ 下一个序号: 6 })
  })

  it('consumeNextSeq 连续调用递增', () => {
    expect(consumeNextSeq(counterPath)).toBe(1)
    expect(consumeNextSeq(counterPath)).toBe(2)
    expect(consumeNextSeq(counterPath)).toBe(3)
  })
})
