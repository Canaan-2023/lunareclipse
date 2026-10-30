import { describe, it, expect } from 'vitest'
import {
  toWindowsPath,
  toAbsolutePath,
  normalizePath,
  buildDataPaths,
  resolveScopePaths
} from '../electron/main/models/paths'
import { applyPromptPaths, applyPromptPathMap, getPromptPathMap } from '../electron/main/prompts/prompt-paths'

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

describe('提示词路径占位符预替换（prompt-paths）', () => {
  const base = buildDataPaths('D:/data')
  const scope = { uid: 1, aiId: 2 }

  it('占位符替换成当前作用域的真实绝对路径', () => {
    const expected = resolveScopePaths(base, scope)
    const out = applyPromptPaths('RAW：{RAW 目录}，NNG 索引：{NNG 一级索引}', base, scope)
    expect(out).not.toContain('{RAW 目录}')
    expect(out).toBe(`RAW：${expected.rawMemory}，NNG 索引：${expected.nngRootJson}`)
  })

  it('未注册的花括号示例（{YYYY} 等）保持原样，不被当成路径', () => {
    const text = '{YYYY}/{MM}/{DD}/{序号}_{关键词}.md'
    expect(applyPromptPaths(text, base, scope)).toBe(text)
  })

  it('未提供占位符表时原样返回（非记忆类工作流的快速路径）', () => {
    expect(applyPromptPathMap('{RAW 目录}', undefined)).toBe('{RAW 目录}')
  })

  it('同一作用域每次现算路径表：uid/aiId 不同即得到不同地址', () => {
    const other = resolveScopePaths(base, { uid: 2, aiId: 1 })
    expect(getPromptPathMap(base, { uid: 1, aiId: 2 })['{NNG 根}']).not.toBe(other.nngRoot)
    expect(getPromptPathMap(base, scope)['{RAW 目录}']).toBe(resolveScopePaths(base, scope).rawMemory)
  })
})