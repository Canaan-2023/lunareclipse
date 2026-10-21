/**
 * renameFileWithRetry（atomic-write）单元测试：Windows 文件锁 EPERM 容错。
 *
 * 通过 vi.mock('fs') 部分替换 renameSync/unlinkSync 为可控 mock，其余 fs API 保留真实
 * 实现，以便断言「重试后真实文件最终写入成功」这一可观测结果（而非只验证调用次数）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { renameFileWithRetry } from '../electron/main/utils/atomic-write'

const mocks = vi.hoisted(() => ({
  renameSyncMock: vi.fn(),
  unlinkSyncMock: vi.fn(),
  actualRename: undefined as unknown as typeof import('fs').renameSync,
  actualUnlink: undefined as unknown as typeof import('fs').unlinkSync,
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  mocks.actualRename = actual.renameSync
  mocks.actualUnlink = actual.unlinkSync
  return { ...actual, renameSync: mocks.renameSyncMock, unlinkSync: mocks.unlinkSyncMock }
})

function eperm(): NodeJS.ErrnoException {
  const e = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException
  e.code = 'EPERM'
  return e
}

describe('renameFileWithRetry（EPERM 容错）', () => {
  let root: string
  let src: string
  let dest: string
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'atomic-write-test-'))
    src = join(root, 'src.json')
    dest = join(root, 'dest.json')
    writeFileSync(src, '{}', 'utf-8')
    mocks.renameSyncMock.mockReset()
    mocks.unlinkSyncMock.mockReset()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    rmSync(root, { recursive: true, force: true })
  })

  it('无锁冲突：一次 rename 成功，dest 落盘', () => {
    mocks.renameSyncMock.mockImplementation((s: string, d: string) => mocks.actualRename(s, d))
    renameFileWithRetry(src, dest, { retries: 3, retryDelayMs: 0 })
    expect(mocks.renameSyncMock).toHaveBeenCalledTimes(1)
    expect(mocks.unlinkSyncMock).not.toHaveBeenCalled()
    expect(existsSync(dest)).toBe(true)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('EPERM 一次后重试成功：重试 2 次、不删目标、dest 落盘', () => {
    mocks.renameSyncMock
      .mockImplementationOnce(() => {
        throw eperm()
      })
      .mockImplementation((s: string, d: string) => mocks.actualRename(s, d))
    renameFileWithRetry(src, dest, { retries: 3, retryDelayMs: 0 })
    expect(mocks.renameSyncMock).toHaveBeenCalledTimes(2)
    expect(mocks.unlinkSyncMock).not.toHaveBeenCalled()
    expect(existsSync(dest)).toBe(true)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('EPERM 持续：重试耗尽后删除目标再 rename 成功', () => {
    // 预置已存在的 dest；模拟「目标存在即被占用」→ rename 持续 EPERM，unlink 后 rename 才成功
    writeFileSync(dest, 'old', 'utf-8')
    mocks.renameSyncMock.mockImplementation((s: string, d: string) => {
      if (existsSync(d)) throw eperm()
      return mocks.actualRename(s, d)
    })
    mocks.unlinkSyncMock.mockImplementation((d: string) => mocks.actualUnlink(d))
    renameFileWithRetry(src, dest, { retries: 2, retryDelayMs: 0 })
    // retries=2：主循环 3 次（attempt 0/1/2）全 EPERM → fallback unlink（成功）→ 最后 rename 成功
    expect(mocks.renameSyncMock).toHaveBeenCalledTimes(4)
    expect(mocks.unlinkSyncMock).toHaveBeenCalledTimes(1)
    expect(existsSync(dest)).toBe(true)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('EPERM 持续且删除目标也失败：抛出最后一次错误', () => {
    mocks.renameSyncMock.mockImplementation(() => {
      throw eperm()
    })
    mocks.unlinkSyncMock.mockImplementation(() => {
      throw eperm()
    })
    expect(() => renameFileWithRetry(src, dest, { retries: 2, retryDelayMs: 0 })).toThrow(/EPERM/)
    expect(mocks.renameSyncMock).toHaveBeenCalledTimes(4) // 主循环 3 次 + fallback 1 次
    expect(mocks.unlinkSyncMock).toHaveBeenCalledTimes(1)
  })

  it('非 EPERM 错误（ENOENT）不重试，原样抛出', () => {
    const e = new Error('ENOENT: no such file') as NodeJS.ErrnoException
    e.code = 'ENOENT'
    mocks.renameSyncMock.mockImplementation(() => {
      throw e
    })
    expect(() => renameFileWithRetry(src, dest, { retries: 3, retryDelayMs: 0 })).toThrow(/ENOENT/)
    expect(mocks.renameSyncMock).toHaveBeenCalledTimes(1)
    expect(mocks.unlinkSyncMock).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })
})