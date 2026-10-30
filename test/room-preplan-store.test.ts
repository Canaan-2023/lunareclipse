/**
 * 前置规划配置与滚动历史（PreplanStore）回归测试。
 *
 * 为什么存在：前置规划是主AI的影子（2026-10-31 裁决：不占 aiId、不写 RAW、不进记忆工作流），
 * preplan.json 是它**唯一**的持久体。三条性质必须有回归网：
 * ① 读不到/损坏 = 空配置回退（不抛错——历史丢了只是规划变朴素，不是故障）；
 * ② 历史环超上限自动删减（自管理口径：清理删减自由）；
 * ③ 开关与历史按 (uid, aiId) 隔离（不同主AI的前置规划互不可见）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PreplanStore, PREPLAN_MAX_HISTORY, preplanScopeKey, setPreplanAccess, getPreplanAccess } from '../electron/main/room/preplan-store'

let dir = ''
afterEach(() => {
  setPreplanAccess(null)
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

function makeStore(): PreplanStore {
  dir = mkdtempSync(join(tmpdir(), 'preplan-'))
  return new PreplanStore(dir)
}

describe('PreplanStore：配置读写与回退', () => {
  it('无文件 → 未启用 + 空历史（不抛错）', () => {
    const s = makeStore()
    const cfg = s.load(1, 1)
    expect(cfg.enabled).toBe(false)
    expect(cfg.history).toEqual([])
  })

  it('损坏 JSON → 空配置回退（不抛错）', () => {
    const s = makeStore()
    writeFileSync(join(dir, 'preplan.json'), '{oops', 'utf-8')
    expect(s.load(1, 1).enabled).toBe(false)
  })

  it('setEnabled 持久化；不同 (uid, aiId) 互不可见', () => {
    const s = makeStore()
    s.setEnabled(1, 1, true)
    s.setEnabled(1, 2, false)
    expect(s.load(1, 1).enabled).toBe(true)
    expect(s.load(1, 2).enabled).toBe(false)
    expect(s.load(2, 1).enabled).toBe(false)
    // 键格式锁定
    expect(preplanScopeKey(7, 3)).toBe('7_3')
    const file = JSON.parse(readFileSync(join(dir, 'preplan.json'), 'utf-8'))
    expect(Object.keys(file.rooms).sort()).toEqual(['1_1', '1_2'])
  })
})

describe('PreplanStore：滚动历史环', () => {
  it('appendHistory 追加且持久化；超出环长自动砍最旧', () => {
    const s = makeStore()
    for (let i = 1; i <= PREPLAN_MAX_HISTORY + 5; i++) {
      s.appendHistory(1, 1, { ts: i, instruction: `指令${i}`, results: `结果${i}` })
    }
    const cfg = s.load(1, 1)
    expect(cfg.history).toHaveLength(PREPLAN_MAX_HISTORY)
    // 砍头留尾：最早 5 条已被删减，最新一条在环尾
    expect(cfg.history[0].instruction).toBe('指令6')
    expect(cfg.history[cfg.history.length - 1].instruction).toBe(`指令${PREPLAN_MAX_HISTORY + 5}`)
  })

  it('clearHistory 只清历史、不动开关', () => {
    const s = makeStore()
    s.setEnabled(1, 1, true)
    s.appendHistory(1, 1, { ts: 1, instruction: 'a', results: 'b' })
    s.clearHistory(1, 1)
    const cfg = s.load(1, 1)
    expect(cfg.enabled).toBe(true)
    expect(cfg.history).toEqual([])
  })

  it('历史中的缺名字段不崩（损坏条目按空环回退）', () => {
    const s = makeStore()
    writeFileSync(
      join(dir, 'preplan.json'),
      JSON.stringify({ rooms: { '1_1': { enabled: true, history: 'not-array' } } }),
      'utf-8'
    )
    const cfg = s.load(1, 1)
    expect(cfg.enabled).toBe(true)
    expect(cfg.history).toEqual([])
  })
})

describe('进程级访问点（IPC 取用）', () => {
  it('setPreplanAccess / getPreplanAccess 注册与清空', () => {
    const s = makeStore()
    expect(getPreplanAccess()).toBeNull()
    setPreplanAccess(s, () => 42)
    const access = getPreplanAccess()
    expect(access?.store).toBe(s)
    expect(access?.getUid()).toBe(42)
    setPreplanAccess(null)
    expect(getPreplanAccess()).toBeNull()
    // 文件确实落在给定目录（原子写产物存在）
    s.setEnabled(42, 1, true)
    expect(existsSync(join(dir, 'preplan.json'))).toBe(true)
  })
})
