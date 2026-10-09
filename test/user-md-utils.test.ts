/**
 * shared/utils/user-md.ts — USER.md 字段表解析/序列化单测
 *
 * 覆盖：默认模板生成、解析已知/未知字段、序列化往返、未知字段保留、空值回退（未填写）。
 */
import { describe, it, expect } from 'vitest'
import {
  USER_MD_FIELDS,
  USER_MD_EMPTY,
  buildUserMdTemplate,
  parseUserMd,
  serializeUserMd,
  extractUnknown
} from '../shared/utils/user-md'

describe('shared/utils/user-md', () => {
  it('buildUserMdTemplate 生成含全部字段且均为（未填写）的表格', () => {
    const tmpl = buildUserMdTemplate()
    expect(tmpl).toContain('# 用户个人资料卡')
    expect(tmpl).toContain('| 字段 | 内容 |')
    for (const f of USER_MD_FIELDS) {
      expect(tmpl).toContain(`| ${f.key} | ${USER_MD_EMPTY} |`)
    }
  })

  it('parseUserMd 解析已知字段内容，忽略表头/分隔行', () => {
    const md = `# 用户个人资料卡

| 字段 | 内容 |
| ---- | ---- |
| 姓名 | 小明 |
| 职业 | 前端工程师 |
| 偏好 | 喜欢简洁回答 |
| 备注 | （未填写） |
`
    const { values, unknown } = parseUserMd(md)
    expect(values['姓名']).toBe('小明')
    expect(values['职业']).toBe('前端工程师')
    expect(values['偏好']).toBe('喜欢简洁回答')
    expect(values['备注']).toBe(USER_MD_EMPTY)
    expect(values['字段']).toBeUndefined()
    expect(unknown).toEqual([])
  })

  it('parseUserMd 收集未知字段行到 unknown', () => {
    const md = `# 用户个人资料卡

| 字段 | 内容 |
| ---- | ---- |
| 姓名 | 小明 |
| 自定义字段 | 自定义值 |
`
    const { values, unknown } = parseUserMd(md)
    expect(values['姓名']).toBe('小明')
    expect(unknown.length).toBe(1)
    expect(unknown[0]).toContain('自定义字段')
  })

  it('serializeUserMd 往返：解析→序列化后已知字段一致且顺序符合 schema', () => {
    const md = `# 用户个人资料卡

| 字段 | 内容 |
| ---- | ---- |
| 姓名 | 小明 |
| 联系方式 | 邮箱（test@example.com） |
`
    const { values, unknown } = parseUserMd(md)
    const out = serializeUserMd(values, extractUnknown(values, unknown))
    const { values: back } = parseUserMd(out)
    expect(back['姓名']).toBe('小明')
    expect(back['联系方式']).toBe('邮箱（test@example.com）')
    // 顺序：schema 顺序在前
    const lines = out.split('\n')
    const nameIdx = lines.findIndex((l) => l.startsWith('| 姓名'))
    const genderIdx = lines.findIndex((l) => l.startsWith('| 性别'))
    expect(nameIdx).toBeGreaterThan(-1)
    expect(genderIdx).toBeGreaterThan(nameIdx)
  })

  it('serializeUserMd 空值回退（未填写），未知字段追加在 schema 之后', () => {
    const values: Record<string, string> = { 姓名: '小明', 职业: '' }
    const extra = { 自定义字段: '自定义值' }
    const out = serializeUserMd(values, extra)
    const { values: back, unknown } = parseUserMd(out)
    expect(back['姓名']).toBe('小明')
    expect(back['职业']).toBe(USER_MD_EMPTY)
    // 未知字段作为 extra 追加后，解析回 unknown 而非 values（语义见 parseUserMd）
    expect(unknown.join('\n')).toContain('自定义字段')
    expect(unknown.join('\n')).toContain('自定义值')
    // 自定义字段应出现在 schema 字段之后
    const customIdx = out.split('\n').findIndex((l) => l.startsWith('| 自定义字段'))
    const notesIdx = out.split('\n').findIndex((l) => l.startsWith('| 备注'))
    expect(customIdx).toBeGreaterThan(notesIdx)
  })

  it('extractUnknown 只提取未识别的字段行', () => {
    const { values, unknown } = parseUserMd(`# 用户个人资料卡

| 字段 | 内容 |
| ---- | ---- |
| 姓名 | 小明 |
| 自定义 | x |
`)
    const extra = extractUnknown(values, unknown)
    expect(extra['自定义']).toBe('x')
    expect(extra['姓名']).toBeUndefined()
  })
})