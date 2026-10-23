/**
 * 会话删除在自主域上**没有例外**（0.53.17）。
 *
 * 背景：ADR-25 曾要求自主会话「不随用户删会话清空」，先是在入口拒绝，0.53.16 又改成
 * 显式删除才放行。用户 2026-10-23 裁决撤销整条保护：「干净没啥用还烦死了」。
 * 现在 `session:delete` 与 `deleteByOwner` 都不再判断 `room-autonomous-*`，
 * 删除语义对普通会话与自主会话完全一致。
 *
 * 这里锁三件事：
 * - 自主会话与普通会话：目录真删、内部会话同样级联清；
 * - 级联调用不再携带任何 includeAutonomous 选项；
 * - 非法 id 直接 false，不触碰存储。
 */
import { describe, it, expect } from 'vitest'
import { registerSessionHandlers } from '../electron/main/ipc/handlers/session'

type Handler = (event: unknown, ...args: unknown[]) => unknown

function setup(): {
  handlers: Map<string, Handler>
  deleted: string[]
  ownerDeletes: string[]
} {
  const handlers = new Map<string, Handler>()
  const deleted: string[] = []
  const ownerDeletes: string[] = []
  const ipc = { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) }
  const sessionStore = {
    list: () => [],
    get: () => null,
    create: () => ({}),
    rename: () => undefined,
    delete: async (id: string) => {
      deleted.push(id)
    }
  }
  const internalStore = {
    delete: () => undefined,
    deleteByOwner: (id: string) => {
      ownerDeletes.push(id)
      return true
    }
  }
  registerSessionHandlers(
    ipc as never,
    sessionStore as never,
    {} as never,
    () => internalStore as never
  )
  return { handlers, deleted, ownerDeletes }
}

describe('session:delete 不再区分自主域', () => {
  it('自主会话：真删，并级联清内部会话', async () => {
    const { handlers, deleted, ownerDeletes } = setup()
    const run = handlers.get('session:delete')
    expect(run).toBeTypeOf('function')

    await expect(run!({}, 'room-autonomous-U1-AI2')).resolves.toBe(true)
    expect(deleted).toEqual(['room-autonomous-U1-AI2'])
    expect(ownerDeletes).toEqual(['room-autonomous-U1-AI2'])
  })

  it('普通会话：删除路径与自主会话完全相同', async () => {
    const { handlers, deleted, ownerDeletes } = setup()
    await expect(handlers.get('session:delete')!({}, 's_1700000000000')).resolves.toBe(true)
    expect(deleted).toEqual(['s_1700000000000'])
    expect(ownerDeletes).toEqual(['s_1700000000000'])
  })

  it('非法 id：返回 false，且不触碰任何存储', async () => {
    const { handlers, deleted, ownerDeletes } = setup()
    await expect(handlers.get('session:delete')!({}, '')).resolves.toBe(false)
    await expect(handlers.get('session:delete')!({}, null)).resolves.toBe(false)
    expect(deleted).toEqual([])
    expect(ownerDeletes).toEqual([])
  })
})
