import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SearchUsersTool, GetUserProfileTool } from '../electron/main/tools/account-lookup'
import type { ToolContext } from '../electron/main/tools/base-tool'

/**
 * 账号检索工具（search_users / get_user_profile）：
 * - 按姓名/昵称/用户名 检索 UID，返回不含密码哈希/盐等敏感字段
 * - 按 UID 读取 ABYSS/U{uid}/USER.md（截断保护 + 存在性校验）
 */
describe('SearchUsersTool（按姓名→UID 检索）', () => {
  let tmpDir: string
  let ctx: ToolContext

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'account-search-test-'))
    const abyss = join(tmpDir, 'ABYSS')
    mkdirSync(join(abyss, 'U1'), { recursive: true })
    mkdirSync(join(abyss, 'U2'), { recursive: true })
    writeFileSync(
      join(tmpDir, 'users.json'),
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
    ctx = { paths: { usersJson: join(tmpDir, 'users.json'), abyss } } as unknown as ToolContext
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('按登录用户名命中', async () => {
    const res = await new SearchUsersTool().execute({ keyword: 'alice' }, ctx)
    expect(res.ok).toBe(true)
    const users = (res.data as { users: Array<{ UID: number; 用户名: string }> }).users
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ UID: 1, 用户名: 'alice' })
  })

  it('按昵称命中（中文）', async () => {
    const res = await new SearchUsersTool().execute({ keyword: '爱丽丝' }, ctx)
    expect(res.ok).toBe(true)
    const users = (res.data as { users: Array<{ UID: number }> }).users
    expect(users.some((u) => u.UID === 1)).toBe(true)
  })

  it('按 USER.md 姓名（张三）命中 UID1，bob 未填姓名不命中', async () => {
    const res = await new SearchUsersTool().execute({ keyword: '张三' }, ctx)
    expect(res.ok).toBe(true)
    const users = (res.data as { users: Array<{ UID: number; 姓名?: string }> }).users
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ UID: 1, 姓名: '张三' })
  })

  it('绝不返回密码哈希/盐等敏感字段', async () => {
    const res = await new SearchUsersTool().execute({ keyword: '' }, ctx)
    expect(res.ok).toBe(true)
    const users = (res.data as Array<Record<string, unknown>> & { users: Array<Record<string, unknown>> }).users
    expect(users).toHaveLength(2)
    for (const u of users) {
      expect(u.密码哈希).toBeUndefined()
      expect(u.盐).toBeUndefined()
    }
  })

  it('bob 禁用状态如实标记', async () => {
    const res = await new SearchUsersTool().execute({ keyword: 'bob' }, ctx)
    expect(res.ok).toBe(true)
    const users = (res.data as { users: Array<{ 禁用: boolean }> }).users
    expect(users[0].禁用).toBe(true)
  })

  it('无匹配返回空列表（不报错）', async () => {
    const res = await new SearchUsersTool().execute({ keyword: '不存在的名字xyz' }, ctx)
    expect(res.ok).toBe(true)
    const users = (res.data as { users: unknown[] }).users
    expect(users).toHaveLength(0)
  })

  it('keyword 超长返回错误（防滥用）', async () => {
    const res = await new SearchUsersTool().execute({ keyword: 'x'.repeat(101) }, ctx)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('过长')
  })

  it('users.json 不可读时返回空列表', async () => {
    rmSync(join(tmpDir, 'users.json'))
    const res = await new SearchUsersTool().execute({ keyword: 'alice' }, ctx)
    expect(res.ok).toBe(true)
    const users = (res.data as { users: unknown[] }).users
    expect(users).toHaveLength(0)
  })
})

describe('GetUserProfileTool（按 UID→USER.md）', () => {
  let tmpDir: string
  let ctx: ToolContext

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'account-profile-test-'))
    const abyss = join(tmpDir, 'ABYSS')
    mkdirSync(join(abyss, 'U1'), { recursive: true })
    writeFileSync(
      join(tmpDir, 'users.json'),
      JSON.stringify({ users: [{ UID: 1, 用户名: 'alice', 密码哈希: 'x', 盐: 'y', 创建时间: '2026-01-01' }], next_uid: 2 }),
      'utf-8'
    )
    ctx = { paths: { usersJson: join(tmpDir, 'users.json'), abyss } } as unknown as ToolContext
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('读取 USER.md 内容', async () => {
    writeFileSync(join(tmpDir, 'ABYSS', 'U1', 'USER.md'), '| 姓名 | 张三 |\n| 联系方式 | email@example.com |\n', 'utf-8')
    const res = await new GetUserProfileTool().execute({ uid: 1 }, ctx)
    expect(res.ok).toBe(true)
    const data = res.data as { UID: number; 用户名: string; userMd: string; truncated: boolean }
    expect(data.UID).toBe(1)
    expect(data.用户名).toBe('alice')
    expect(data.userMd).toContain('张三')
    expect(data.truncated).toBe(false)
  })

  it('UID 不存在返回明确错误（防任意路径拼接）', async () => {
    const res = await new GetUserProfileTool().execute({ uid: 99 }, ctx)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('用户不存在')
  })

  it('USER.md 未填写返回 null 提示', async () => {
    const res = await new GetUserProfileTool().execute({ uid: 1 }, ctx)
    expect(res.ok).toBe(true)
    const data = res.data as { userMd: null; message: string }
    expect(data.userMd).toBeNull()
    expect(data.message).toContain('尚未填写')
  })

  it('超长内容截断并标记 truncated', async () => {
    writeFileSync(join(tmpDir, 'ABYSS', 'U1', 'USER.md'), 'x'.repeat(9000), 'utf-8')
    const res = await new GetUserProfileTool().execute({ uid: 1 }, ctx)
    expect(res.ok).toBe(true)
    const data = res.data as { userMd: string; chars: number; truncated: boolean }
    expect(data.chars).toBe(9000)
    expect(data.truncated).toBe(true)
    expect(data.userMd.length).toBeLessThan(9000)
  })

  it('权限弹框被拒绝时返回明确错误（不读取内容）', async () => {
    writeFileSync(join(tmpDir, 'ABYSS', 'U1', 'USER.md'), '| 姓名 | 张三 |\n', 'utf-8')
    const deniedCtx = {
      ...ctx,
      requestPermission: async () => ({ allowed: false, reason: '用户不想看' })
    } as unknown as ToolContext
    const res = await new GetUserProfileTool().execute({ uid: 1 }, deniedCtx)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('拒绝')
  })

  it('uid 参数非法（NaN/负数/非整数）返回错误', async () => {
    expect((await new GetUserProfileTool().execute({ uid: -1 }, ctx)).ok).toBe(false)
    expect((await new GetUserProfileTool().execute({ uid: 1.5 }, ctx)).ok).toBe(false)
    expect((await new GetUserProfileTool().execute({ uid: '1' as unknown as number }, ctx)).ok).toBe(false)
  })
})