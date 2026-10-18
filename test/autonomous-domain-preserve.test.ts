/**
 * 自主域不清空（ADR-25 支柱 3 / B13e）契约测试。
 *
 * 用户原话：「**只要 AI 存在，那就不清空**自主模式产生的内部会话和 ROOM 之内的东西」。
 * 自主域 = ROOM 数据（`{root}/room/**`）+ 自主内部会话（owner 前缀 `room-autonomous*`）
 * + 自主轮次 RAW（`source === 'autonomous'`）。
 *
 * 本文件锁定两条**清理路径的边界**（判据用来源标记，不用路径猜）：
 * - `purgeUserWorkspace(uid)`（清理本机工作域）：清记忆/会话/技能/配置…但**不碰** `{root}/room/**`；
 * - `purgeAiWorkspace(aiId)`（删 AI 时调用）：清该 AI 的记忆/会话/缓存…但**不碰** `{root}/room/**`。
 * 自主**内部会话**的保护见 `test/internal-session-ai-scope.test.ts`（`deleteByOwner` 自主域守卫）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { purgeAiWorkspace } from '../electron/main/services/ai-workspace-purge'
import { purgeUserWorkspace } from '../electron/main/services/user-workspace-purge'
import { buildDataPaths } from '../electron/main/models/paths'

let tmp = ''
let root = ''

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'le-autonomous-domain-'))
  root = buildDataPaths(tmp).root
  // ROOM 数据（工具区 / 运行时快照 / 模型切换审计）
  mkdirSync(join(root, 'room'), { recursive: true })
  writeFileSync(join(root, 'room', 'tool-zone.json'), '[]')
  writeFileSync(join(root, 'room', 'model-switch.jsonl'), '{}\n')
  // 记忆域（清理目标，用来证明清理确实跑了）
  mkdirSync(join(root, 'memory', 'U1', 'AI1', 'raw_memory'), { recursive: true })
  writeFileSync(join(root, 'memory', 'U1', 'AI1', 'raw_memory', 'keep.md'), '# RAW\n')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('自主域不清空：ROOM 数据不被清理路径触碰', () => {
  it('purgeUserWorkspace 清掉记忆域，但 {root}/room/** 原样保留', () => {
    const res = purgeUserWorkspace(root, 1)
    expect(res.removedDirs.some((d) => d.includes('memory'))).toBe(true)
    expect(existsSync(join(root, 'memory', 'U1'))).toBe(false)
    // ROOM 数据必须还在（用户点名要求「不清空 ROOM 之内的东西」）
    expect(existsSync(join(root, 'room', 'tool-zone.json'))).toBe(true)
    expect(existsSync(join(root, 'room', 'model-switch.jsonl'))).toBe(true)
  })

  it('purgeAiWorkspace 清掉该 AI 的记忆域，但 {root}/room/** 原样保留', () => {
    const res = purgeAiWorkspace(buildDataPaths(tmp), 1)
    expect(res.removedDirs.some((d) => d.includes(join('memory', 'U1', 'AI1')))).toBe(true)
    expect(existsSync(join(root, 'memory', 'U1', 'AI1'))).toBe(false)
    expect(existsSync(join(root, 'room', 'tool-zone.json'))).toBe(true)
  })
})
