import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createToolRegistry, executeTool, type AnyTool } from '../electron/main/tools/index'
import {
  NotebookEditTool,
  writeNotebook,
  parseNotebook,
  serializeNotebook,
  sourceToString
} from '../electron/main/tools/notebook-edit'

/**
 * Notebook 编辑工具（NotebookEdit）：按单元格 replace/insert/delete 编辑 .ipynb。
 * 零外部依赖纯 JSON 操作：nbformat>=4 的 cells 数组定位改写，其余字段原样保留。
 * 本测试覆盖：三种编辑模式、定位与错误边界、nbformat 校验、写盘持久化与写失败返回错误。
 */

let dir: string

function makeNotebook(): unknown {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3' } },
    cells: [
      {
        id: 'cell-aaa',
        cell_type: 'code',
        execution_count: 1,
        metadata: {},
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['hi\n'] }],
        source: ['print(1)', 'print(2)']
      },
      {
        id: 'cell-bbb',
        cell_type: 'markdown',
        metadata: {},
        source: ['# Title']
      }
    ]
  }
}

function writeNotebookFile(name: string, notebook: unknown): string {
  const p = join(dir, name)
  writeFileSync(p, JSON.stringify(notebook, null, 2), 'utf-8')
  return p
}

function readNotebookFile(p: string): unknown {
  return JSON.parse(readFileSync(p, 'utf-8'))
}

/** executeTool 的返回 `data` 在类型上是空对象；测试按 NotebookEdit 的实际输出形状断言 */
interface NotebookData {
  edit_mode?: string
  cell_id?: string
  cell_type?: string
  cell_index?: number
  total_cells?: number
}
const execNotebook = async (
  registry: ReturnType<typeof createToolRegistry>,
  params: Record<string, unknown>
): Promise<{ ok: boolean; error?: string; data?: NotebookData }> =>
  (await executeTool(registry, 'NotebookEdit', params)) as { ok: boolean; error?: string; data?: NotebookData }
function makeRegistry(): ReturnType<typeof createToolRegistry> {
  const r = createToolRegistry({ config: {} } as never, {} as never)
  r.tools.set('NotebookEdit', new NotebookEditTool() as unknown as AnyTool)
  return r
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'notebook-edit-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('NotebookEdit × replace', () => {
  it('按 cell_id 重写单元格源码并持久化，保留 outputs/metadata/id', async () => {
    const p = writeNotebookFile('replace-id.ipynb', makeNotebook())
    const registry = makeRegistry()

    const r = await execNotebook(registry, {
      notebook_path: p,
      edit_mode: 'replace',
      cell_id: 'cell-aaa',
      new_source: 'x = 1'
    })
    expect(r.ok).toBe(true)
    expect(r.data?.edit_mode).toBe('replace')
    expect(r.data?.cell_id).toBe('cell-aaa')

    const nb = readNotebookFile(p) as { cells: Array<Record<string, unknown>> }
    const cell = nb.cells[0]
    expect(sourceToString(cell.source)).toBe('x = 1')
    expect(cell.id).toBe('cell-aaa')
    expect(cell.outputs).toHaveLength(1) // outputs 原样保留
    expect(cell.metadata).toEqual({})
    expect(nb.cells).toHaveLength(2)
  })

  it('按 cell_index 定位，原数组 source 写回保持数组形态（按行拆分）', async () => {
    const p = writeNotebookFile('replace-idx.ipynb', makeNotebook())
    const registry = makeRegistry()

    const r = await execNotebook(registry, {
      notebook_path: p,
      edit_mode: 'replace',
      cell_index: 1,
      new_source: 'line1\nline2'
    })
    expect(r.ok).toBe(true)
    expect(r.data?.cell_type).toBe('markdown')
    expect(r.data?.cell_index).toBe(1)

    const nb = readNotebookFile(p) as { cells: Array<{ source: string | string[] }> }
    // 原 source 是数组 → 新 source 仍为数组（末段不含换行）
    expect(Array.isArray(nb.cells[1].source)).toBe(true)
    expect(sourceToString(nb.cells[1].source)).toBe('line1\nline2')
  })

  it('replace 可同时改 cell_type', async () => {
    const p = writeNotebookFile('replace-type.ipynb', makeNotebook())
    const registry = makeRegistry()

    const r = await execNotebook(registry, {
      notebook_path: p,
      edit_mode: 'replace',
      cell_id: 'cell-bbb',
      cell_type: 'code',
      new_source: 'print("now code")'
    })
    expect(r.ok).toBe(true)
    const nb = readNotebookFile(p) as { cells: Array<{ cell_type: string }> }
    expect(nb.cells[1].cell_type).toBe('code')
  })
})

describe('NotebookEdit × insert', () => {
  it('insert 到定位 cell 之后（默认 code），新 cell 结构与相邻一致（含 id）', async () => {
    const p = writeNotebookFile('insert-after.ipynb', makeNotebook())
    const registry = makeRegistry()

    const r = await execNotebook(registry, {
      notebook_path: p,
      edit_mode: 'insert',
      cell_id: 'cell-aaa',
      cell_type: 'markdown',
      new_source: '## inserted'
    })
    expect(r.ok).toBe(true)
    expect(r.data?.cell_index).toBe(1)
    expect(r.data?.cell_type).toBe('markdown')

    const nb = readNotebookFile(p) as {
      cells: Array<{ id?: string; cell_type: string; source: unknown; metadata: unknown; outputs: unknown }>
    }
    expect(nb.cells).toHaveLength(3)
    const inserted = nb.cells[1]
    expect(inserted.cell_type).toBe('markdown')
    expect(sourceToString(inserted.source)).toBe('## inserted')
    expect(typeof inserted.id).toBe('string')
    expect(inserted.metadata).toEqual({})
    expect(inserted.outputs).toEqual([])
  })

  it('insert 未指定位置 → 插入到开头；未按 cell_index 可省略', async () => {
    const p = writeNotebookFile('insert-head.ipynb', makeNotebook())
    const registry = makeRegistry()

    const r = await execNotebook(registry, {
      notebook_path: p,
      edit_mode: 'insert',
      cell_type: 'code',
      new_source: 'x=0'
    })
    expect(r.ok).toBe(true)
    expect(r.data?.cell_index).toBe(0)

    const nb = readNotebookFile(p) as { cells: Array<{ id?: string; cell_type: string; source: unknown }> }
    expect(nb.cells).toHaveLength(3)
    expect(nb.cells[0].cell_type).toBe('code')
    expect(sourceToString(nb.cells[0].source)).toBe('x=0')
  })

  it('code cell 的 execution_count 为 null、markdown 无 execution_count 字段', async () => {
    const p = writeNotebookFile('insert-exec.ipynb', makeNotebook())
    const registry = makeRegistry()

    await execNotebook(registry, {
      notebook_path: p,
      edit_mode: 'insert',
      cell_type: 'code',
      new_source: 'code'
    })
    // 第二次未定位插入 → 开头，原 code 后移一位
    await execNotebook(registry, {
      notebook_path: p,
      edit_mode: 'insert',
      cell_type: 'markdown',
      new_source: 'md'
    })
    const nb = readNotebookFile(p) as { cells: Array<Record<string, unknown>> }
    const codeCell = nb.cells[1]
    const mdCell = nb.cells[0]
    expect(codeCell.execution_count).toBeNull()
    expect('execution_count' in mdCell).toBe(false)
  })
})

describe('NotebookEdit × delete', () => {
  it('按 cell_index 删除目标单元格', async () => {
    const p = writeNotebookFile('delete-idx.ipynb', makeNotebook())
    const registry = makeRegistry()

    const r = await execNotebook(registry, {
      notebook_path: p,
      edit_mode: 'delete',
      cell_index: 0
    })
    expect(r.ok).toBe(true)
    expect(r.data?.total_cells).toBe(1)

    const nb = readNotebookFile(p) as { cells: Array<{ id: string }> }
    expect(nb.cells).toHaveLength(1)
    expect(nb.cells[0].id).toBe('cell-bbb')
  })

  it('按 cell_id 删除目标单元格', async () => {
    const p = writeNotebookFile('delete-id.ipynb', makeNotebook())
    const registry = makeRegistry()

    const r = await execNotebook(registry, {
      notebook_path: p,
      edit_mode: 'delete',
      cell_id: 'cell-bbb'
    })
    expect(r.ok).toBe(true)
    expect(r.data?.total_cells).toBe(1)

    const nb = readNotebookFile(p) as { cells: Array<{ id: string }> }
    expect(nb.cells[0].id).toBe('cell-aaa')
  })
})

describe('NotebookEdit × 错误边界', () => {
  it('replace/delete 无定位时报错引导', async () => {
    const p = writeNotebookFile('err-noloc.ipynb', makeNotebook())
    const registry = makeRegistry()

    const r = await execNotebook(registry, {
      notebook_path: p,
      edit_mode: 'replace',
      new_source: 'x=1'
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('需要定位')
  })

  it('cell_id 不存在时报错', async () => {
    const p = writeNotebookFile('err-noid.ipynb', makeNotebook())
    const registry = makeRegistry()

    const r = await execNotebook(registry, {
      notebook_path: p,
      cell_id: 'cell-zzz',
      new_source: 'x=1'
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('未找到 cell_id')
  })

  it('cell_index 越界时报错', async () => {
    const p = writeNotebookFile('err-idx.ipynb', makeNotebook())
    const registry = makeRegistry()

    const r = await execNotebook(registry, {
      notebook_path: p,
      edit_mode: 'delete',
      cell_index: 99
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('越界')
  })

  it('replace/insert 缺 new_source 时报错', async () => {
    const p = writeNotebookFile('err-nosrc.ipynb', makeNotebook())
    const registry = makeRegistry()

    const r = await execNotebook(registry, {
      notebook_path: p,
      cell_id: 'cell-aaa'
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('必须提供 new_source')
  })

  it('非法 edit_mode / cell_type 时报错', async () => {
    const p = writeNotebookFile('err-mode.ipynb', makeNotebook())
    const registry = makeRegistry()

    const badMode = await execNotebook(registry, {
      notebook_path: p,
      edit_mode: 'upsert',
      cell_id: 'cell-aaa',
      new_source: 'x=1'
    })
    expect(badMode.ok).toBe(false)
    expect(badMode.error).toContain('edit_mode 无效')

    const badType = await execNotebook(registry, {
      notebook_path: p,
      edit_mode: 'insert',
      cell_type: 'raw',
      new_source: 'x=1'
    })
    expect(badType.ok).toBe(false)
    expect(badType.error).toContain('cell_type 无效')
  })

  it('非 JSON / 缺 cells / nbformat<4 均被拒', async () => {
    const registry = makeRegistry()

    const notJson = join(dir, 'not-json.ipynb')
    writeFileSync(notJson, '{not json', 'utf-8')
    const r1 = await execNotebook(registry, { notebook_path: notJson })
    expect(r1.ok).toBe(false)
    expect(r1.error).toContain('不是合法 JSON')

    const noCells = join(dir, 'no-cells.ipynb')
    writeFileSync(noCells, JSON.stringify({ nbformat: 4 }), 'utf-8')
    const r2 = await execNotebook(registry, { notebook_path: noCells })
    expect(r2.ok).toBe(false)
    expect(r2.error).toContain('缺少 cells')

    const oldVer = join(dir, 'old-ver.ipynb')
    writeFileSync(oldVer, JSON.stringify({ nbformat: 3, cells: [] }), 'utf-8')
    const r3 = await execNotebook(registry, { notebook_path: oldVer })
    expect(r3.ok).toBe(false)
    expect(r3.error).toContain('nbformat=3')
  })

  it('写回失败（目录不存在）返回错误而非假成功', async () => {
    const missing = join(dir, 'no-such-dir', 'x.ipynb')
    const registry = makeRegistry()

    const r = await execNotebook(registry, {
      notebook_path: missing,
      cell_id: 'cell-aaa',
      new_source: 'x=1'
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('无法读取 notebook')
  })

  it('写回目标目录不存在时 writeNotebook 返回失败而非假成功', async () => {
    const missing = join(dir, 'write-fail-dir', 'x.ipynb')
    const res = writeNotebook(missing, { nbformat: 4, cells: [] })
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
  })
})

describe('NotebookEdit × 纯函数', () => {
  it('serializeNotebook 输出 2 空格缩进 + 末尾换行', () => {
    const text = serializeNotebook({ nbformat: 4, cells: [] })
    expect(text).toBe('{\n  "nbformat": 4,\n  "cells": []\n}\n')
  })

  it('parseNotebook 正常解析 / 非 JSON 报错', () => {
    const ok = parseNotebook(JSON.stringify({ nbformat: 4, cells: [] }))
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.notebook.nbformat).toBe(4)

    const bad = parseNotebook('{bad')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('JSON')
  })
})