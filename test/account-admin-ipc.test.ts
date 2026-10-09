import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// mock electron：register-account-ipc 顶层 import { shell }（打开记忆文件夹用）
vi.mock('electron', () => ({
  shell: {
    showItemInFolder: () => {}
  }
}))

import { registerAccountIpc, type AccountIpcCtx } from '../electron/main/multi-instance/ipc/register-account-ipc'
import type { AiAgentConfigStore } from '../electron/main/multi-instance/ai-agent-config-store'
import type { MasterRegistry } from '../electron/main/multi-instance/master/master-registry'

/**
 * 账号管理局人用检索 IPC（multi:adminSearchUsers / multi:adminGetUserProfile）：
 * - 复用 AI 侧检索工具逻辑（只读 users.json + ABYSS/U{uid}/USER.md，不含密码字段）
 * - 参数校验（keyword 类型/长度、uid 正整数）
 */
function makeIpcMock(): { handle: ReturnType<typeof vi.fn>; handlers: Map<string, (...args: unknown[]) => unknown> } {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const handle = vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
    handlers.set(channel, fn)
  })
  return { handle, handlers }
}

function makeCtx(root: string, master = true): AccountIpcCtx {
  return {
    root,
    getUserStore: () => null,
    getRegistry: () =>
      master
        ? ({ listSatellites: () => [] } as unknown as MasterRegistry)
        : null,
    getAiAgentConfig: () => ({}) as unknown as AiAgentConfigStore,
    probeMaster: async () => ({ ok: false }),
    setPendingSatellite: () => ({ ok: false }),
    getJoinInfo: () => null,
    rotateJoinCode: () => ({ ok: false }),
    resetRole: () => ({ ok: false })
  }
}

interface SearchResponse {
  ok: boolean
  error?: string
  users?: Array<{ UID: number; 用户名: string; 昵称?: string; 姓名?: string; 禁用: boolean }>
  count?: number
}

interface ProfileResponse {
  ok: boolean
  error?: string
  UID?: number
  用户名?: string
  userMd?: string | null
  chars?: number
  truncated?: boolean
}

describe('registerAccountIpc：账号资料检索 IPC', () => {
  let tmpDir: string
  let handlers: Map<string, (...args: unknown[]) => unknown>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'admin-ipc-test-'))
    const abyss = join(tmpDir, 'ABYSS')
    mkdirSync(join(abyss, 'U1'), { recursive: true })
    mkdirSync(join(abyss, 'U2'), { recursive: true })
    mkdirSync(join(tmpDir, 'users'), { recursive: true })
    writeFileSync(
      join(tmpDir, 'users', 'users.json'),
      JSON.stringify(
        {
          users: [
            { UID: 1, 用户名: 'alice', 密码哈希: 'deadbeef', 盐: 'salt1', 创建时间: '2026-01-01', 昵称: '爱丽丝' },
            { UID: 2, 用户名: 'bob', 密码哈希: 'cafebabe', 盐: 'salt2', 创建时间: '2026-01-02', 禁用: true }
          ],
          next_uid: 3
        },
        null,
        2
      ),
      'utf-8'
    )
    writeFileSync(join(abyss, 'U1', 'USER.md'), '| 姓名 | 张三 |\n| 职业 | 工程师 |\n', 'utf-8')
    const ipc = makeIpcMock()
    handlers = ipc.handlers
    registerAccountIpc({ handle: ipc.handle } as never, makeCtx(tmpDir))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('multi:adminSearchUsers 按 USER.md 姓名命中并返回白名单字段', async () => {
    const fn = handlers.get('multi:adminSearchUsers')!
    const res = (await fn({} as never, '张三')) as SearchResponse
    expect(res.ok).toBe(true)
    expect(res.users).toHaveLength(1)
    expect(res.users![0]).toMatchObject({ UID: 1, 用户名: 'alice', 姓名: '张三' })
    expect(res.users![0]).not.toHaveProperty('密码哈希')
    expect(res.users![0]).not.toHaveProperty('盐')
  })

  it('multi:adminSearchUsers 空关键词返回全部账号并带禁用标记', async () => {
    const fn = handlers.get('multi:adminSearchUsers')!
    const res = (await fn({} as never, '')) as SearchResponse
    expect(res.ok).toBe(true)
    expect(res.users).toHaveLength(2)
    expect(res.users!.find((u) => u.UID === 2)?.禁用).toBe(true)
  })

  it('multi:adminSearchUsers 参数校验：非字符串 / 超长关键词返回错误', async () => {
    const fn = handlers.get('multi:adminSearchUsers')!
    const badType = (await fn({} as never, 123 as unknown as string)) as SearchResponse
    expect(badType.ok).toBe(false)
    expect(badType.error).toContain('参数不合法')
    const tooLong = (await fn({} as never, 'x'.repeat(101))) as SearchResponse
    expect(tooLong.ok).toBe(false)
    expect(tooLong.error).toContain('过长')
  })

  it('multi:adminGetUserProfile 读取 USER.md 原文', async () => {
    const fn = handlers.get('multi:adminGetUserProfile')!
    const res = (await fn({} as never, 1)) as ProfileResponse
    expect(res.ok).toBe(true)
    expect(res.UID).toBe(1)
    expect(res.用户名).toBe('alice')
    expect(res.userMd).toContain('张三')
    expect(res.truncated).toBe(false)
  })

  it('multi:adminGetUserProfile USER.md 未填写返回 userMd=null 而非报错', async () => {
    const fn = handlers.get('multi:adminGetUserProfile')!
    const res = (await fn({} as never, 2)) as ProfileResponse
    expect(res.ok).toBe(true)
    expect(res.userMd).toBeNull()
  })

  it('multi:adminGetUserProfile UID 不存在返回错误', async () => {
    const fn = handlers.get('multi:adminGetUserProfile')!
    const res = (await fn({} as never, 99)) as ProfileResponse
    expect(res.ok).toBe(false)
    expect(res.error).toContain('用户不存在')
  })

  it('multi:adminGetUserProfile 参数校验：非正整数返回错误', async () => {
    const fn = handlers.get('multi:adminGetUserProfile')!
    expect(((await fn({} as never, -1)) as ProfileResponse).ok).toBe(false)
    expect(((await fn({} as never, 1.5)) as ProfileResponse).ok).toBe(false)
    expect(((await fn({} as never, '1' as unknown as number)) as ProfileResponse).ok).toBe(false)
  })

  it('非主系统（registry 为 null）时两个检索 IPC 均返回 非主系统', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'admin-ipc-sat-test-'))
    try {
      const ipc = makeIpcMock()
      registerAccountIpc({ handle: ipc.handle } as never, makeCtx(tmp, false))
      const search = (await ipc.handlers.get('multi:adminSearchUsers')!({} as never, '张三')) as SearchResponse
      expect(search.ok).toBe(false)
      expect(search.error).toBe('非主系统')
      const profile = (await ipc.handlers.get('multi:adminGetUserProfile')!({} as never, 1)) as ProfileResponse
      expect(profile.ok).toBe(false)
      expect(profile.error).toBe('非主系统')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})