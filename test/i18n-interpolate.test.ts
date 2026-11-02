/**
 * i18n 占位符插值回归。
 *
 * 为什么测：useT 从「按变量个数逐个 new RegExp」改为单次正则扫描，属于热路径重构，
 * 必须锁住占位符语义不变：缺失变量原样保留、重复变量全部替换、变量值里的特殊字符按字面量处理。
 */
import { describe, expect, it } from 'vitest'
import { interpolate } from '../src/i18n/useT'

describe('interpolate · 占位符替换', () => {
  it('无变量时原样返回', () => {
    expect(interpolate('纯文本 {x}', undefined)).toBe('纯文本 {x}')
  })

  it('替换存在的变量', () => {
    expect(interpolate('已复制 {count} 条', { count: 3 })).toBe('已复制 3 条')
  })

  it('缺失的变量保留原占位符（不产生 undefined）', () => {
    expect(interpolate('{a}/{b}', { a: 'x' })).toBe('x/{b}')
  })

  it('同一变量重复出现时全部替换', () => {
    expect(interpolate('{name} · {name}', { name: '月蚀' })).toBe('月蚀 · 月蚀')
  })

  it('变量值含正则/替换特殊字符时按字面量输出', () => {
    expect(interpolate('路径：{path}', { path: 'C:\\a$&b$1{c}' })).toBe('路径：C:\\a$&b$1{c}')
  })

  it('占位符名允许非单词字符（与旧实现按变量名精确匹配一致）', () => {
    expect(interpolate('{a.b} 与 {a-b}', { 'a.b': '1', 'a-b': '2' })).toBe('1 与 2')
  })

  it('未闭合或空括号不视为占位符', () => {
    expect(interpolate('{ {x} }', { x: '1' })).toBe('{ 1 }')
  })
})
