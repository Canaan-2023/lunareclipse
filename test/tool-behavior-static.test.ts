import { describe, it, expect } from 'vitest'
import { ReadTool } from '../electron/main/tools/read'
import { ReadMdTool } from '../electron/main/tools/read-md'
import { GlobTool } from '../electron/main/tools/glob'
import { GrepTool } from '../electron/main/tools/grep'
import { LSTool } from '../electron/main/tools/ls'
import { MkdirTool } from '../electron/main/tools/mkdir'
import { MoveFileTool } from '../electron/main/tools/move-file'
import { CopyFileTool } from '../electron/main/tools/copy-file'
import { WriteTool } from '../electron/main/tools/write'
import { EditTool } from '../electron/main/tools/edit'
import { DeleteFileTool } from '../electron/main/tools/delete-file'
import { resolveToolBehavior } from '../electron/main/tools/base-tool'

/**
 * M5 工具行为标注静态测试。
 * 语义（工具层改造方案 M5）：
 *  - 只读工具（Read/read_md/Glob/Grep/LS）声明 readOnly=true（等价去重/只读免审判定准入条件）；
 *  - Read/read_md 声明结果体积阈值（大结果落盘）；
 *  - 写类工具（Write/Edit/DeleteFile/MoveFile/CopyFile）声明 destructive=true +
 *    concurrencySafe=false（破坏性提示 + 同会话串行防竞态）；Mkdir 仅声明非并发安全。
 *  - resolveToolBehavior 缺省填平：未声明字段取 fail-closed 默认值（只读=false、破坏性=false）。
 */

describe('M5 工具行为标注（静态声明）', () => {
  it('只读工具 readOnly=true', () => {
    expect(new ReadTool().behavior?.readOnly).toBe(true)
    expect(new ReadMdTool().behavior?.readOnly).toBe(true)
    expect(new GlobTool().behavior?.readOnly).toBe(true)
    expect(new GrepTool().behavior?.readOnly).toBe(true)
    expect(new LSTool().behavior?.readOnly).toBe(true)
  })

  it('Read/read_md 声明结果体积阈值（大结果落盘）', () => {
    const read = resolveToolBehavior(new ReadTool().behavior)
    expect(read.readOnly).toBe(true)
    expect(read.resultLimitChars).toBeGreaterThan(0)
    const readMd = resolveToolBehavior(new ReadMdTool().behavior)
    expect(readMd.resultLimitChars).toBeGreaterThan(0)
  })

  it('写类工具 destructive=true 且非并发安全', () => {
    for (const Ctor of [WriteTool, EditTool, DeleteFileTool, MoveFileTool, CopyFileTool]) {
      const b = resolveToolBehavior(new Ctor().behavior)
      expect(b.destructive).toBe(true)
      expect(b.concurrencySafe).toBe(false)
    }
  })

  it('Mkdir 非并发安全（写状态但非破坏性）', () => {
    const b = resolveToolBehavior(new MkdirTool().behavior)
    expect(b.concurrencySafe).toBe(false)
    expect(b.destructive).toBe(false)
  })

  it('resolveToolBehavior 缺省填平：未声明工具保持 fail-closed 默认', () => {
    const b = resolveToolBehavior(undefined)
    expect(b.readOnly).toBe(false)
    expect(b.destructive).toBe(false)
    expect(b.concurrencySafe).toBe(true) // 无 riskLevel 时按 low 并行
  })
})