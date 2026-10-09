import { describe, it, expect } from 'vitest'
import { countFileToolChanges } from '../electron/main/api/stream-file-changes'
import type { ToolCallRow } from '@shared/types'

/**
 * 文件类工具变更统计（turnHeader 的 fileChanges 字段唯一来源）的契约测试。
 *
 * 为什么存在：`countFileToolChanges` 原先内联在 stream-runner.ts（更早住在 server-utils.ts），
 * 是主链路上「本轮改动了几个文件」的唯一事实来源；它的三个分支（success 状态过滤 / 工具名清单 /
 * 路径键优先级）错了都**不会报错**，只会让 UI 上的变更计数悄悄变错数，没有任何运行时信号可依赖。
 * 本文件把当前口径逐条钉死，使「不动脑子的顺手改动」可被证伪。
 * 作用：覆盖状态过滤、写/删两类工具清单、路径提取的键优先级与去重口径、脏 input 放行。
 * 不删理由：这是该统计唯一的验证手段；E2E（test/api-server.test.ts）只断言 happy path 的
 *   工具往返，不会构造「失败的工具调用」「同一文件被写两次」「input 缺键」这些样本。
 */

/** 构造 ToolCallRow：只补测试关心的字段，其余给稳定默认值 */
function row(
  toolName: string,
  status: ToolCallRow['status'],
  input?: unknown,
  toolCallId = `${toolName}-${status}`
): ToolCallRow {
  return {
    kind: 'toolCall',
    rowId: 1,
    turnId: 'turn-1',
    createdAt: 1_700_000_000_000,
    createdAtSeq: 1,
    toolCallId,
    toolName,
    status,
    inputText: '',
    input
  }
}

/** 构造「toolCallId → 行」的行表（与 stream-runner 的内存结构一致） */
function rows(...list: ToolCallRow[]): Map<string, ToolCallRow> {
  const m = new Map<string, ToolCallRow>()
  list.forEach((r, i) => m.set(r.toolCallId || `r${i}`, r))
  return m
}

describe('countFileToolChanges · 状态过滤', () => {
  it('只有 success 计入：running / error / cancelled / pendingApproval / inputStreaming 一律不计', () => {
    const out = countFileToolChanges(
      rows(
        row('Write', 'running', { file_path: 'a.ts' }, 'r1'),
        row('Write', 'error', { file_path: 'b.ts' }, 'r2'),
        row('Write', 'cancelled', { file_path: 'c.ts' }, 'r3'),
        row('Write', 'pendingApproval', { file_path: 'd.ts' }, 'r4'),
        row('Write', 'inputStreaming', { file_path: 'e.ts' }, 'r5')
      )
    )
    expect(out).toEqual({ additions: 0, deletions: 0, files: 0 })
  })

  it('success 的 DeleteFile 计入删；失败的 DeleteFile 不计', () => {
    const out = countFileToolChanges(
      rows(
        row('DeleteFile', 'error', { file_paths: ['x.ts'] }, 'd1'),
        row('DeleteFile', 'success', { file_paths: ['y.ts'] }, 'd2')
      )
    )
    expect(out).toEqual({ additions: 0, deletions: 1, files: 1 })
  })
})

describe('countFileToolChanges · 工具名清单', () => {
  it.each(['Write', 'Edit', 'MoveFile', 'CopyFile', 'Mkdir'])('%s 属写入类，计一次增', (tool) => {
    const out = countFileToolChanges(rows(row(tool, 'success', { file_path: 'a.ts' })))
    expect(out.additions).toBe(1)
    expect(out.deletions).toBe(0)
  })

  it.each(['DeleteFile'])('%s 属删除类，计一次删', (tool) => {
    const out = countFileToolChanges(rows(row(tool, 'success', { file_paths: ['a.ts'] })))
    expect(out.additions).toBe(0)
    expect(out.deletions).toBe(1)
  })

  it.each(['Read', 'Glob', 'Grep', 'Bash', 'WriteFile', 'write'])(
    '非清单工具 %s 不计（清单是精确匹配，不做前缀/大小写归一）',
    (tool) => {
      const out = countFileToolChanges(rows(row(tool, 'success', { file_path: 'a.ts' })))
      expect(out).toEqual({ additions: 0, deletions: 0, files: 0 })
    }
  )

  it('空行表 → 全零', () => {
    expect(countFileToolChanges(new Map())).toEqual({ additions: 0, deletions: 0, files: 0 })
  })
})

describe('countFileToolChanges · 增删次数与文件数是两个口径', () => {
  it('同一文件被写两次：additions=2 但 files=1（计数是次数，files 是去重集合）', () => {
    const out = countFileToolChanges(
      rows(
        row('Write', 'success', { file_path: 'a.ts' }, 'r1'),
        row('Edit', 'success', { file_path: 'a.ts' }, 'r2')
      )
    )
    expect(out).toEqual({ additions: 2, deletions: 0, files: 1 })
  })

  it('被写又被删的同一路径只算一个文件，但增删各计一次', () => {
    const out = countFileToolChanges(
      rows(
        row('Write', 'success', { file_path: 'a.ts' }, 'r1'),
        row('DeleteFile', 'success', { file_paths: ['a.ts'] }, 'r2')
      )
    )
    expect(out).toEqual({ additions: 1, deletions: 1, files: 1 })
  })

  it('同一次 DeleteFile 删多个文件：deletions=1 而 files 按数组项展开', () => {
    const out = countFileToolChanges(
      rows(row('DeleteFile', 'success', { file_paths: ['a.ts', 'b.ts', 'c.ts'] }))
    )
    expect(out).toEqual({ additions: 0, deletions: 1, files: 3 })
  })
})

describe('countFileToolChanges · 路径提取', () => {
  it('file_path 优先于 target_path 与 source_path（第一个为 string 的胜出）', () => {
    // 利用「files 是去重集合」反证取到了哪个键：若取了 target_path，两行会同名而合并为 1 个文件
    const out = countFileToolChanges(
      rows(
        row('MoveFile', 'success', {
          file_path: 'from-a.ts',
          target_path: 'to-b.ts',
          source_path: 'src-c.ts'
        }, 'r1'),
        row('MoveFile', 'success', { file_path: 'to-b.ts' }, 'r2')
      )
    )
    expect(out).toEqual({ additions: 2, deletions: 0, files: 2 })
  })

  it('file_path 非 string 时让位给 target_path（typeof 判定，不接受数字/对象）', () => {
    const withTarget = countFileToolChanges(
      rows(row('MoveFile', 'success', { file_path: 123, target_path: 'to-b.ts' }))
    )
    const targetOnly = countFileToolChanges(rows(row('MoveFile', 'success', { target_path: 'to-b.ts' })))
    expect(withTarget).toEqual(targetOnly)
    expect(withTarget).toEqual({ additions: 1, deletions: 0, files: 1 })
  })

  it('只有 source_path 时也能提取到（兜底键）', () => {
    const out = countFileToolChanges(rows(row('CopyFile', 'success', { source_path: 'src.ts' })))
    expect(out).toEqual({ additions: 1, deletions: 0, files: 1 })
  })

  it('三个键都缺：additions 照计，files 不计（无路径可去重）', () => {
    const out = countFileToolChanges(rows(row('Edit', 'success', { old_string: 'a', new_string: 'b' })))
    expect(out).toEqual({ additions: 1, deletions: 0, files: 0 })
  })

  it('input 为 undefined 不抛错：additions 照计，files 不计（?? {} 兜底）', () => {
    const out = countFileToolChanges(rows(row('Write', 'success', undefined)))
    expect(out).toEqual({ additions: 1, deletions: 0, files: 0 })
  })

  it('input 为脏数据（字符串/数字/null）不抛错：仍计增，Files 不计', () => {
    const out = countFileToolChanges(
      rows(
        row('Write', 'success', 'not-an-object', 'r1'),
        row('Edit', 'success', 42, 'r2'),
        row('Mkdir', 'success', null, 'r3')
      )
    )
    expect(out).toEqual({ additions: 3, deletions: 0, files: 0 })
  })

  it('DeleteFile 的 file_paths 非数组（脏数据）→ deletions 照计，files 不计', () => {
    const out = countFileToolChanges(rows(row('DeleteFile', 'success', { file_paths: 'a.ts' })))
    expect(out).toEqual({ additions: 0, deletions: 1, files: 0 })
  })

  it('DeleteFile 的 file_paths 含非 string 项 → 跳过该项，只收 string', () => {
    const out = countFileToolChanges(
      rows(row('DeleteFile', 'success', { file_paths: ['a.ts', 1, null, 'b.ts'] }))
    )
    expect(out).toEqual({ additions: 0, deletions: 1, files: 2 })
  })

  it('Mkdir 的路径参数是 path 而非 file_path → additions 计，files 不计（现状口径，非缺陷）', () => {
    const out = countFileToolChanges(rows(row('Mkdir', 'success', { path: 'new-dir' })))
    expect(out).toEqual({ additions: 1, deletions: 0, files: 0 })
  })
})
