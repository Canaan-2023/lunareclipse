/**
 * 内部会话的 AI 隔离（ADR-25 L5）契约测试。
 *
 * 为什么存在：迁移前内部会话根恒为 `sessions/U{uid}/AI1/`（所有 AI 共用），
 * 两个 AI 用同一 ownerSessionId 时会共享内部会话，与「个算个的」直接冲突。
 * 现改为按 owner 会话**所属 AI** 解析（`sessions/U{uid}/AI{aiId}/{owner}/ai`）。
 *
 * 本文件钉住两条契约（ADR-25 §6 具名回归验证点）：
 * - **隔离**：不同 AI 用同一 ownerSessionId 互不可见；
 * - **兼容读**：老数据在 AI1 下，主目录尚未建立时仍可读，且读与写同址（老会话不消失）。
 *
 * 口径：`getRoot` = 该 AI 的会话根（`…/AI{aiId}`）；`getLegacyRoot` = AI1 的会话根（无兜底传 undefined）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { InternalSessionStore } from '../electron/main/services/internal-session-store'

const OWNER = 's_shared_owner'
let root = ''

const aiRoot = (aiId: number): string => join(root, 'sessions', 'U1', `AI${aiId}`)
const aiDir = (aiId: number, owner: string = OWNER): string => join(aiRoot(aiId), owner, 'ai')

/** 造一个内部会话 JSON 直接落盘（模拟迁移前写在 AI1 下的老数据）。 */
function seedSession(dir: string, id: string, title: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({
      id,
      ownerSessionId: OWNER,
      title,
      summary: '',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      totalChars: 0,
      cacheLocations: [],
      filePath: `${id}.json`
    })
  )
}

function makeStore(aiId: number, legacyAiId?: number): InternalSessionStore {
  return new InternalSessionStore(
    () => aiRoot(aiId),
    legacyAiId === undefined ? undefined : () => aiRoot(legacyAiId)
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'le-ai-scope-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('内部会话 AI 隔离（L5）', () => {
  it('不同 AI 用同一 ownerSessionId 互不可见（各落各自 AI 目录）', () => {
    const s1 = makeStore(1)
    const s2 = makeStore(2)
    const a = s1.create(OWNER, { title: 'AI1 的会话' })
    const b = s2.create(OWNER, { title: 'AI2 的会话' })

    expect(existsSync(join(aiDir(1), `${a.id}.json`))).toBe(true)
    expect(existsSync(join(aiDir(2), `${b.id}.json`))).toBe(true)

    expect(s1.list(OWNER).map((s) => s.id)).toEqual([a.id])
    expect(s2.list(OWNER).map((s) => s.id)).toEqual([b.id])
    expect(s1.get(OWNER, b.id)).toBeNull()
    expect(s2.get(OWNER, a.id)).toBeNull()
  })

  it('新 owner（无老目录）直接落主目录', () => {
    const s = makeStore(2, 1)
    const n = s.create(OWNER, { title: '新会话' })
    expect(existsSync(join(aiDir(2), `${n.id}.json`))).toBe(true)
    expect(existsSync(aiDir(1))).toBe(false)
  })

  it('主目录未建立而老目录存在 → 老数据仍可读，且读写同址（老会话不消失）', () => {
    seedSession(aiDir(1), 'is_legacy_1', '老会话')
    const s = makeStore(2, 1)

    expect(s.list(OWNER).map((x) => x.id)).toEqual(['is_legacy_1'])
    expect(s.get(OWNER, 'is_legacy_1')?.title).toBe('老会话')
    // 绝对路径也指向老目录（AI 回翻原话文件时路径必须真实）
    expect(s.absFilePath(OWNER, 'is_legacy_1.json')).toBe(
      join(aiDir(1), 'is_legacy_1.json').replace(/\\/g, '/')
    )

    const n = s.create(OWNER, { title: '新会话' })
    expect(existsSync(join(aiDir(1), `${n.id}.json`))).toBe(true)
    expect(s.list(OWNER).map((x) => x.id).sort()).toEqual(['is_legacy_1', n.id].sort())
  })

  it('主目录已建立 → 以主目录为准，不回看老目录（避免跨 AI 串读）', () => {
    seedSession(aiDir(1), 'is_old', 'AI1 老会话')
    seedSession(aiDir(2), 'is_new', 'AI2 会话')
    const s = makeStore(2, 1)
    expect(s.list(OWNER).map((x) => x.id)).toEqual(['is_new'])
  })

  it('无老目录兜底（undefined）时行为与旧版一致（仅主目录）', () => {
    const s = makeStore(1)
    const n = s.create(OWNER, { title: '会话' })
    expect(existsSync(join(aiDir(1), `${n.id}.json`))).toBe(true)
    expect(s.get(OWNER, n.id)?.title).toBe('会话')
  })
})

describe('自主域不再特殊（0.53.17 撤销保护）', () => {
  const AUTONOMOUS_OWNER = 'room-autonomous-U1-AI1'

  it('自主 owner 与普通会话一样直接级联删除', () => {
    const s = makeStore(1)
    const n = s.create(AUTONOMOUS_OWNER, { title: '自主会话' })
    expect(s.deleteByOwner(AUTONOMOUS_OWNER)).toBe(true)
    expect(s.get(AUTONOMOUS_OWNER, n.id)).toBeNull()
  })

  it('普通 owner 行为不变', () => {
    const s = makeStore(1)
    const n = s.create(OWNER, { title: '普通会话' })
    expect(s.deleteByOwner(OWNER)).toBe(true)
    expect(s.get(OWNER, n.id)).toBeNull()
  })
})
