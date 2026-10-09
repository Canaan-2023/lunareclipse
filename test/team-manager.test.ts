import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  TeamManager,
  runWithTeamContext,
  getTeamContext,
  isValidTeamId,
  isValidMemberId,
  type TeamConfig
} from '../electron/main/services/team-manager'

describe('TeamManager（任务模式 / Agent Teams，2026-08-16）', () => {
  let root: string
  let tm: TeamManager

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'team-test-'))
    tm = new TeamManager(join(root, 'teams'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function makeCfg(): TeamConfig {
    return tm.createTeam({
      teamId: 'team_t1',
      name: '重构团队',
      goal: '把认证模块重构为 TypeScript',
      members: [
        { id: 'm1', name: '前端工程师', role: '实现 UI 组件' },
        { id: 'm2', name: '后端工程师', role: '实现 API' }
      ],
      tasks: [
        { id: 't1', title: '设计接口', status: 'pending', dependsOn: [] },
        { id: 't2', title: '实现 UI', status: 'pending', dependsOn: ['t1'] }
      ]
    })
  }

  it('createTeam 建目录 + config + inbox + 任务板', () => {
    const cfg = makeCfg()
    expect(existsSync(tm.teamDir('team_t1'))).toBe(true)
    expect(existsSync(tm.inboxPath('team_t1', 'm1'))).toBe(true)
    expect(existsSync(tm.taskPath('team_t1', 't1'))).toBe(true)
    expect(cfg.members.length).toBe(2)
    expect(cfg.tasks.length).toBe(2)
  })

  it('readConfig / listTeams / deleteTeam', () => {
    makeCfg()
    const cfg = tm.readConfig('team_t1')
    expect(cfg?.name).toBe('重构团队')
    const list = tm.listTeams()
    expect(list.length).toBe(1)
    expect(tm.deleteTeam('team_t1')).toBe(true)
    expect(existsSync(tm.teamDir('team_t1'))).toBe(false)
  })

  it('任务认领：无依赖直接 in_progress，assignee 写入', () => {
    makeCfg()
    const res = tm.updateTask('team_t1', 't1', { status: 'in_progress' }, 'm1')
    expect(res.ok).toBe(true)
    expect(res.task?.status).toBe('in_progress')
    expect(res.task?.assignee).toBe('m1')
  })

  it('任务认领：依赖未完成 → blocked', () => {
    makeCfg()
    const res = tm.updateTask('team_t1', 't2', { status: 'in_progress' }, 'm2')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('依赖未完成')
    expect(tm.readTask('team_t1', 't2')?.status).toBe('blocked')
  })

  it('依赖完成后被依赖任务可认领', () => {
    makeCfg()
    tm.updateTask('team_t1', 't1', { status: 'in_progress' }, 'm1')
    tm.updateTask('team_t1', 't1', { status: 'completed', output: '接口定义完成' }, 'm1')
    const res = tm.updateTask('team_t1', 't2', { status: 'in_progress' }, 'm2')
    expect(res.ok).toBe(true)
    expect(res.task?.status).toBe('in_progress')
  })

  it('非认领人不能改状态', () => {
    makeCfg()
    tm.updateTask('team_t1', 't1', { status: 'in_progress' }, 'm1')
    const res = tm.updateTask('team_t1', 't1', { status: 'completed' }, 'm2')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('已被 m1 认领')
  })

  it('未认领不能直接完成', () => {
    makeCfg()
    const res = tm.updateTask('team_t1', 't1', { status: 'completed' }, 'm1')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('未认领')
  })

  it('完成写入 output', () => {
    makeCfg()
    tm.updateTask('team_t1', 't1', { status: 'in_progress' }, 'm1')
    const res = tm.updateTask('team_t1', 't1', { status: 'completed', output: 'UI 完成' }, 'm1')
    expect(res.ok).toBe(true)
    expect(tm.readTask('team_t1', 't1')?.output).toBe('UI 完成')
  })

  it('sendMessage 写目标收件箱；to=all 广播全员', () => {
    const cfg = makeCfg()
    const res = tm.sendMessage('team_t1', cfg, { from: 'm1', to: 'm2', text: '接口好了吗' })
    expect(res.ok).toBe(true)
    expect(res.delivered).toEqual(['m2'])
    const box = tm.readInbox('team_t1', 'm2')
    expect(box.length).toBe(1)
    expect(box[0].from).toBe('m1')
    expect(box[0].text).toBe('接口好了吗')

    tm.sendMessage('team_t1', cfg, { from: 'm1', to: 'all', text: '全员注意' })
    expect(tm.readInbox('team_t1', 'm1').length).toBe(1)
    expect(tm.readInbox('team_t1', 'm2').length).toBe(2)
  })

  it('sendMessage 给不存在的成员报错', () => {
    const cfg = makeCfg()
    const res = tm.sendMessage('team_t1', cfg, { from: 'm1', to: 'nobody', text: 'hi' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('成员不存在')
  })

  it('文件锁：acquire → 他人 acquire 失败 → holder 释放 → 可再 acquire', () => {
    makeCfg()
    const r1 = tm.acquireLock('team_t1', 'D:/proj/src/app.ts', 'm1')
    expect(r1.ok).toBe(true)
    const r2 = tm.acquireLock('team_t1', 'D:/proj/src/app.ts', 'm2')
    expect(r2.ok).toBe(false)
    expect(r2.error).toContain('已被 m1 锁定')

    const rel = tm.releaseLock('team_t1', 'D:/proj/src/app.ts', 'm2')
    expect(rel.ok).toBe(false) // 非持有者不能释放
    const rel2 = tm.releaseLock('team_t1', 'D:/proj/src/app.ts', 'm1')
    expect(rel2.ok).toBe(true)
    const r3 = tm.acquireLock('team_t1', 'D:/proj/src/app.ts', 'm2')
    expect(r3.ok).toBe(true)
  })

  it('runWithTeamContext 注入身份，getTeamContext 读到', async () => {
    const ctx = { teamId: 'team_t1', memberId: 'm2' }
    let seen: ReturnType<typeof getTeamContext> = null
    await runWithTeamContext(ctx, async () => {
      seen = getTeamContext()
    })
    expect(seen).toEqual(ctx)
    expect(getTeamContext()).toBeNull() // 外层无身份
  })

  it('isValidTeamId / isValidMemberId 防路径穿越', () => {
    expect(isValidTeamId('team_abc')).toBe(true)
    expect(isValidTeamId('team/../evil')).toBe(false)
    expect(isValidTeamId('')).toBe(false)
    expect(isValidMemberId('m1')).toBe(true)
    expect(isValidMemberId('../x')).toBe(false)
  })

  it('writeTask 原子写（.tmp 不应残留）', () => {
    makeCfg()
    tm.writeTask('team_t1', { id: 't9', title: 'x', status: 'pending' })
    expect(existsSync(tm.taskPath('team_t1', 't9'))).toBe(true)
    expect(existsSync(tm.taskPath('team_t1', 't9') + '.tmp')).toBe(false)
  })

  // ===== 2026-08-18 优化回归：终态守卫 / 锁 TTL / inbox 上限 =====

  it('已完成任务不可重复认领（终态守卫）', () => {
    makeCfg()
    tm.updateTask('team_t1', 't1', { status: 'in_progress' }, 'm1')
    tm.updateTask('team_t1', 't1', { status: 'completed', output: '接口定义完成' }, 'm1')
    // 原 assignee 重复 claim → 拒绝，状态保持 completed（此前会打回 in_progress）
    const res = tm.updateTask('team_t1', 't1', { status: 'in_progress' }, 'm1')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('已完成')
    expect(tm.readTask('team_t1', 't1')?.status).toBe('completed')
  })

  it('文件锁过期（TTL）后可被接管，未过期仍拒绝', () => {
    makeCfg()
    const target = 'D:/proj/src/stale.ts'
    const p = tm.lockPath('team_t1', target)
    // 构造 2 小时前的残留锁（LOCK_TTL_MS=1h）
    writeFileSync(p, JSON.stringify({ holder: 'm1', ts: Date.now() - 2 * 60 * 60 * 1000, targetFile: target }), 'utf-8')
    const r = tm.acquireLock('team_t1', target, 'm2')
    expect(r.ok).toBe(true) // 过期锁可接管
    expect(r.lock?.holder).toBe('m2')

    // 未过期的锁仍拒绝
    const p2 = tm.lockPath('team_t1', 'D:/proj/src/fresh.ts')
    writeFileSync(p2, JSON.stringify({ holder: 'm1', ts: Date.now() }, 'utf-8'), 'utf-8')
    const r2 = tm.acquireLock('team_t1', 'D:/proj/src/fresh.ts', 'm2')
    expect(r2.ok).toBe(false)
    expect(r2.error).toContain('已被 m1 锁定')
  })

  it('收件箱超上限截断（保留最近 100 条）', () => {
    const cfg = makeCfg()
    for (let i = 0; i < 105; i++) {
      tm.sendMessage('team_t1', cfg, { from: 'm1', to: 'm2', text: `msg-${i}` })
    }
    const box = tm.readInbox('team_t1', 'm2')
    expect(box.length).toBe(100)
    expect(box[0].text).toBe('msg-5') // 最旧 5 条被丢弃
    expect(box[99].text).toBe('msg-104')
  })

  // ===== 2026-09-25 团队共享记忆（业界通行的团队共享记忆模式） =====

  it('writeMemo 落盘 / readMemos 读取 / 按 key 精确查', () => {
    makeCfg()
    const r1 = tm.writeMemo('team_t1', { key: 'coding-convention', content: '统一 TS strict 模式', author: 'm1' })
    expect(r1.ok).toBe(true)
    const r2 = tm.writeMemo('team_t1', { key: 'api-design', content: '返回 {code,data,msg} 结构', author: 'm2' })
    expect(r2.ok).toBe(true)

    const memos = tm.readMemos('team_t1')
    expect(memos.length).toBe(2)
    expect(memos[0].key).toBe('coding-convention')
    expect(memos[1].author).toBe('m2')

    const one = tm.readMemo('team_t1', 'api-design')
    expect(one?.content).toBe('返回 {code,data,msg} 结构')
    expect(tm.readMemo('team_t1', 'nope')).toBeNull()
  })

  it('writeMemo 同 key 覆盖（演进式更新，不新增行）', () => {
    makeCfg()
    tm.writeMemo('team_t1', { key: 'k', content: 'v1', author: 'm1' })
    const r = tm.writeMemo('team_t1', { key: 'k', content: 'v2（改版）', author: 'm2' })
    expect(r.ok).toBe(true)
    const memos = tm.readMemos('team_t1')
    expect(memos.length).toBe(1) // 覆盖不膨胀
    expect(memos[0].content).toBe('v2（改版）')
    expect(memos[0].author).toBe('m2')
  })

  it('writeMemo key 非法 / 空内容拒绝；坏记忆文件容错返回空', () => {
    makeCfg()
    expect(tm.writeMemo('team_t1', { key: '../evil', content: 'x', author: 'm1' }).ok).toBe(false)
    expect(tm.writeMemo('team_t1', { key: 'ok', content: '  ', author: 'm1' }).ok).toBe(false)
    expect(tm.writeMemo('team_t1', { key: 'ok', content: '', author: 'm1' }).ok).toBe(false)
    // 损坏记忆文件：读取容错为空，不拖垮团队
    writeFileSync(tm.memoryPath('team_t1'), '{broken json', 'utf-8')
    expect(tm.readMemos('team_t1')).toEqual([])
  })

  it('共享记忆超上限截断（保留最近 200 条）', () => {
    makeCfg()
    for (let i = 0; i < 205; i++) {
      tm.writeMemo('team_t1', { key: `memo-${i}`, content: `内容 ${i}`, author: 'm1' })
    }
    const memos = tm.readMemos('team_t1')
    expect(memos.length).toBe(200)
    expect(memos[0].key).toBe('memo-5') // 最旧 5 条被丢弃
    expect(memos[199].key).toBe('memo-204')
  })

  it('writeMemo 原子写（.tmp 不应残留）', () => {
    makeCfg()
    const r = tm.writeMemo('team_t1', { key: 'atomic', content: '原子写验证', author: 'm1' })
    expect(r.ok).toBe(true)
    expect(existsSync(tm.memoryPath('team_t1'))).toBe(true)
    expect(existsSync(tm.memoryPath('team_t1') + '.tmp')).toBe(false)
  })
})
