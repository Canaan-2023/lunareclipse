import { describe, it, expect } from 'vitest'
import { toWindowsPath, toAbsolutePath, normalizePath } from '../electron/main/models/paths'

describe('toWindowsPath', () => {
  it('正斜杠 → 单反斜杠 + 盘符大写', () => {
    expect(toWindowsPath('d:/example/app')).toBe('D:\\example\\app')
  })

  it('小写盘符统一大写', () => {
    expect(toWindowsPath('c:/x/y')).toBe('C:\\x\\y')
  })

  it('连续斜杠归一为单分隔符', () => {
    expect(toWindowsPath('D:/a///b')).toBe('D:\\a\\b')
  })

  it('反斜杠输入幂等', () => {
    expect(toWindowsPath('D:\\a\\b')).toBe('D:\\a\\b')
  })

  it('混合分隔符统一为单反斜杠', () => {
    expect(toWindowsPath('D:/a\\b/c')).toBe('D:\\a\\b\\c')
  })

  it('输出永不含双反斜杠（防路径分裂导致 nng-sync includes 字符串比较失效）', () => {
    const out = toWindowsPath('D:/a/b/c/root.json')
    expect(out.includes('\\\\')).toBe(false)
    expect(out).toBe('D:\\a\\b\\c\\root.json')
  })
})

describe('toAbsolutePath / normalizePath', () => {
  it('toAbsolutePath 统一为正斜杠', () => {
    expect(toAbsolutePath('D:\\a\\b')).toBe('D:/a/b')
  })

  it('normalizePath 统一为正斜杠', () => {
    expect(normalizePath('D:/a\\b')).toBe('D:/a/b')
  })
})