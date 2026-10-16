import { describe, it, expect } from 'vitest'
import { parseSedEditCommand } from '../electron/main/tools/security-engine/sed-edit-parser'

/**
 * sed -i 内联编辑解析器测试（M4，sedEditParser 接入）。
 * 语义：
 *  - 只解析 sed 脚本结构（参数级替代语法树方案，Windows/PowerShell 场景不引入 tree-sitter）；
 *  - sed -i 原地编辑 + 危险表达式（整行删除/插入/控制字符注入/命令替换）→ dangerous=true，
 *    由 run_command 直接拒绝；解析失败返回空结果（不误拦）；
 *  - 非 sed 命令一律返回空结构。
 */

describe('parseSedEditCommand（sed 编辑结构解析）', () => {
  it('非 sed 命令返回空结果', () => {
    const r = parseSedEditCommand('grep -r foo .')
    expect(r.edits).toHaveLength(0)
    expect(r.inPlace).toBe(false)
    expect(r.dangerous).toBe(false)
  })

  it('解析基础替换脚本与目标文件', () => {
    const r = parseSedEditCommand("sed -i 's/old/new/g' a.txt")
    expect(r.inPlace).toBe(true)
    expect(r.files).toEqual(['a.txt'])
    expect(r.edits).toHaveLength(1)
    expect(r.edits[0].command).toBe('s')
    expect(r.edits[0].pattern).toBe('old')
    expect(r.edits[0].replacement).toBe('new')
    expect(r.edits[0].flags).toBe('g')
    expect(r.dangerous).toBe(false)
  })

  it('解析 -e 多脚本与 --in-place 长选项', () => {
    const r = parseSedEditCommand("sed -e 's/a/b/' -e 's/c/d/' --in-place x.txt")
    expect(r.inPlace).toBe(true)
    expect(r.edits).toHaveLength(2)
    expect(r.files).toEqual(['x.txt'])
  })

  it('解析 -i.bak 备份形式', () => {
    const r = parseSedEditCommand("sed -i.bak 's/a/b/' x.txt")
    expect(r.inPlace).toBe(true)
  })

  it('不带 -i 的 sed 不视为原地编辑', () => {
    const r = parseSedEditCommand("sed 's/a/b/' x.txt")
    expect(r.inPlace).toBe(false)
  })

  it('行删除（d 命令）标记为危险', () => {
    const r = parseSedEditCommand("sed -i '3d' a.txt")
    expect(r.inPlace).toBe(true)
    expect(r.dangerous).toBe(true)
    expect(r.reason).toContain('行删除')

    // 地址前缀 + d：必须识别为 d 而非地址正则里的字母（回归：早期实现把 /pat/d 的
    // 首字母 p 误当成命令字母 → 漏拦整行删除）
    const r2 = parseSedEditCommand("sed -i '/debug/d' a.txt")
    expect(r2.dangerous).toBe(true)
    const r3 = parseSedEditCommand("sed -i '/pat/d' a.txt")
    expect(r3.dangerous).toBe(true)
    expect(r3.reason).toContain('行删除')
    expect(parseSedEditCommand("sed -i '1,5d' a.txt").dangerous).toBe(true)
    expect(parseSedEditCommand("sed -i '$d' a.txt").dangerous).toBe(true)
  })

  it('插入/整行替换（a/i/c 命令）标记为危险', () => {
    expect(parseSedEditCommand("sed -i '$a newline' a.txt").dangerous).toBe(true)
    expect(parseSedEditCommand("sed -i '1i header' a.txt").dangerous).toBe(true)
    expect(parseSedEditCommand("sed -i '2c replaced' a.txt").dangerous).toBe(true)
  })

  it('替换文本含换行控制字符标记为危险', () => {
    const r = parseSedEditCommand("sed -i 's/old/new\\nnew2/g' a.txt")
    expect(r.dangerous).toBe(true)
    expect(r.reason).toContain('控制字符')
  })

  it('模式/替换文本含命令替换标记为危险', () => {
    expect(parseSedEditCommand("sed -i 's/$(whoami)/x/g' a.txt").dangerous).toBe(true)
    expect(parseSedEditCommand('sed -i "s/old/`date`/g" a.txt').dangerous).toBe(true)
  })

  it('普通替换不含危险，safe', () => {
    const r = parseSedEditCommand("sed -i 's/\\/tmp\\/old/\\/tmp\\/new/' a.txt")
    expect(r.dangerous).toBe(false)
  })

  it('地址前缀 + 非删除命令不被误拦（回归：/debug/q 不得误判为 d）', () => {
    // 匹配 debug 的行退出：动作字母是 q，不是地址正则里的 d
    const r = parseSedEditCommand("sed -i '/debug/q' a.txt")
    expect(r.dangerous).toBe(false)
    expect(r.edits[0]?.command).toBe('q')

    // 地址前缀 + 替换：命令字母取 s，pattern/replacement 正确拆分
    const r2 = parseSedEditCommand("sed -i '/pat/s/old/new/g' a.txt")
    expect(r2.dangerous).toBe(false)
    expect(r2.edits[0]?.command).toBe('s')
    expect(r2.edits[0]?.pattern).toBe('old')
    expect(r2.edits[0]?.replacement).toBe('new')

    // 地址前缀 + 打印：命令字母取 p
    const r3 = parseSedEditCommand("sed -i '/pat/p' a.txt")
    expect(r3.dangerous).toBe(false)
    expect(r3.edits[0]?.command).toBe('p')
  })

  it('解析失败/畸形输入不抛错，返回空结构', () => {
    expect(parseSedEditCommand('').edits).toHaveLength(0)
    expect(parseSedEditCommand('sed').inPlace).toBe(false)
    expect(parseSedEditCommand('sed -- -x').edits).toHaveLength(0)
  })
})