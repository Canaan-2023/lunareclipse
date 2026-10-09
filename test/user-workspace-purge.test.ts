/**
 * 用户工作域级联清理回归测试（purgeUserWorkspace）。
 *
 * 覆盖清理系统的核心安全与正确性契约：
 *  ① 按 uid 清空该账号全部 AI 作用域（memory/NNG/cache/sessions/skills/config/ABYSS/backup/
 *     sessions_satellite/ai-chats），跨 AI、跨域零残留；
 *  ② 分系统归集会话（sessions_satellite/{instanceId}/U{uid}）随清理一并移除；
 *  ③ 只清目标 uid，不误删其它 uid 数据（隔离性）；
 *  ④ 全局共享数据不触碰：users.json / ai-registry.json / master_seq / plugins / cron；
 *  ⑤ skill-market manifest 中该 uid 作用域安装记录被清空、保留其它 uid 记录；
 *  ⑥ 幂等：目录不存在时静默跳过、重复调用无副作用；
 *  ⑦ 越界防护：非法 uid 抛错。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { purgeUserWorkspace } from '../electron/main/services/user-workspace-purge'

const TEST_ROOT = join(process.cwd(), 'tmp', 'user-workspace-purge-test')
const ROOT = join(TEST_ROOT, 'abyssac_data')

/** 构造真实目录结构（模拟某账号 uid 多 AI + 另一账号 + 全局文件） */
function buildFakeData(): void {
  const root = ROOT
  // uid=1 的两个 AI
  mkdirSync(join(root, 'memory', 'U1', 'AI1', 'raw_memory', '2026'), { recursive: true })
  mkdirSync(join(root, 'memory', 'U1', 'AI2', 'normal'), { recursive: true })
  mkdirSync(join(root, 'memory', 'U1', 'AI2', 'calendar'), { recursive: true })
  mkdirSync(join(root, 'memory', 'U1', 'AI2', 'diary'), { recursive: true })
  writeFileSync(join(root, 'memory', 'U1', 'AI1', '计数器.json'), '{}', 'utf-8')
  // uid=1 的 NNG / cache（AI 在前，uid 在后）
  mkdirSync(join(root, 'NNG', 'AI1', 'U1', 'root'), { recursive: true })
  mkdirSync(join(root, 'NNG', 'AI2', 'U1', 'root'), { recursive: true })
  mkdirSync(join(root, 'cache', 'AI1', 'U1', 'index'), { recursive: true })
  mkdirSync(join(root, 'cache', 'AI2', 'U1', 'index'), { recursive: true })
  mkdirSync(join(root, 'cache', 'AI2', 'U1', 'injection'), { recursive: true })
  writeFileSync(join(root, 'cache', 'AI2', 'U1', 'injection', 'x.txt'), 'x', 'utf-8')
  // uid=1 的会话（含旧裸数字残留 1/1）
  mkdirSync(join(root, 'sessions', 'U1', 'AI1'), { recursive: true })
  mkdirSync(join(root, 'sessions', '1', '1'), { recursive: true })
  // uid=1 的 skills / skills_domains / config（含旧裸数字残留）
  mkdirSync(join(root, 'skills', 'U1', 'AI1'), { recursive: true })
  mkdirSync(join(root, 'skills_domains', 'U1', 'AI2'), { recursive: true })
  mkdirSync(join(root, 'config', 'U1', 'AI1'), { recursive: true })
  mkdirSync(join(root, 'config', '1', '1'), { recursive: true })
  // uid=1 的 ABYSS（USER.md + AI.md）与头像
  mkdirSync(join(root, 'ABYSS', 'U1', 'AI1'), { recursive: true })
  writeFileSync(join(root, 'ABYSS', 'U1', 'USER.md'), '# 用户1', 'utf-8')
  writeFileSync(join(root, 'ABYSS', 'U1', 'AI1', 'AI.md'), '# AI1', 'utf-8')
  mkdirSync(join(root, 'avatars', 'user', 'U1'), { recursive: true })
  // uid=1 的日备份与分系统归集会话
  mkdirSync(join(root, 'backup', 'U1', '2026-10-01', 'memory', 'U1'), { recursive: true })
  mkdirSync(join(root, 'sessions_satellite', 'inst-a', 'U1', 'AI1'), { recursive: true })
  // AI 社交私聊（首段 uid）
  mkdirSync(join(root, 'federation', 'ai-chats'), { recursive: true })
  writeFileSync(join(root, 'federation', 'ai-chats', 'ai_1_2_3.json'), '[]', 'utf-8')
  // skill-market manifest：uid1 两条作用域 + uid2 一条
  mkdirSync(join(root, 'skill-market'), { recursive: true })
  writeFileSync(
    join(root, 'skill-market', 'manifest.json'),
    JSON.stringify({
      sources: [{ id: 's1', name: '市场', url: 'builtin://market-repo', type: 'dir' }],
      installed: {
        'U1/AI1': { hello: { source: 's1', installedAt: 1, userModified: false, synced: true } },
        'U1/AI2': { world: { source: 's1', installedAt: 2, userModified: false, synced: true } },
        'U2/AI1': { keep: { source: 's1', installedAt: 3, userModified: false, synced: true } }
      }
    }),
    'utf-8'
  )

  // 其他账号 uid=2（不应被误删）
  mkdirSync(join(root, 'memory', 'U2', 'AI1', 'normal'), { recursive: true })
  mkdirSync(join(root, 'NNG', 'AI1', 'U2', 'root'), { recursive: true })
  mkdirSync(join(root, 'cache', 'AI1', 'U2', 'index'), { recursive: true })
  mkdirSync(join(root, 'sessions', 'U2', 'AI1'), { recursive: true })
  mkdirSync(join(root, 'skills', 'U2', 'AI1'), { recursive: true })
  mkdirSync(join(root, 'config', 'U2', 'AI1'), { recursive: true })
  mkdirSync(join(root, 'ABYSS', 'U2', 'AI1'), { recursive: true })
  writeFileSync(join(root, 'ABYSS', 'U2', 'USER.md'), '# 用户2', 'utf-8')
  mkdirSync(join(root, 'backup', 'U2', '2026-10-01'), { recursive: true })

  // 全局共享数据（不应被触碰）
  mkdirSync(join(root, 'users'), { recursive: true })
  writeFileSync(join(root, 'users', 'users.json'), '[]', 'utf-8')
  writeFileSync(join(root, 'ai-registry.json'), '{"ais":[]}', 'utf-8')
  mkdirSync(join(root, 'master_seq'), { recursive: true })
  writeFileSync(join(root, 'master_seq', 'inst-a.json'), '{}', 'utf-8')
  mkdirSync(join(root, 'plugins'), { recursive: true })
  mkdirSync(join(root, 'cron'), { recursive: true })
  mkdirSync(join(root, 'task_details'), { recursive: true })
}

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe('purgeUserWorkspace', () => {
  it('按 uid 清空该账号全部 AI 作用域（memory/NNG/cache/sessions/skills/config/ABYSS/backup/归集会话/ai-chats）', () => {
    buildFakeData()
    const result = purgeUserWorkspace(ROOT, 1)
    // 目录全部消失
    for (const p of [
      'memory/U1', 'NNG/AI1/U1', 'NNG/AI2/U1', 'cache/AI1/U1', 'cache/AI2/U1',
      'sessions/U1', 'sessions/1', 'skills/U1', 'skills_domains/U1', 'config/U1', 'config/1',
      'ABYSS/U1', 'avatars/user/U1', 'backup/U1', 'sessions_satellite/inst-a/U1'
    ]) {
      expect(existsSync(join(ROOT, p)), `${p} 应被删除`).toBe(false)
    }
    // ai-chats 首段 uid=1 命中删除
    expect(existsSync(join(ROOT, 'federation', 'ai-chats', 'ai_1_2_3.json'))).toBe(false)
    // 返回统计非空
    expect(result.removedDirs.length).toBeGreaterThan(0)
  })

  it('隔离性：只清目标 uid，其它 uid 数据完整保留', () => {
    buildFakeData()
    purgeUserWorkspace(ROOT, 1)
    for (const p of [
      'memory/U2', 'NNG/AI1/U2', 'cache/AI1/U2', 'sessions/U2', 'skills/U2',
      'config/U2', 'ABYSS/U2', 'backup/U2'
    ]) {
      expect(existsSync(join(ROOT, p)), `${p} 不应被误删`).toBe(true)
    }
    expect(readFileSync(join(ROOT, 'ABYSS', 'U2', 'USER.md'), 'utf-8')).toBe('# 用户2')
  })

  it('全局共享数据不触碰：users.json / ai-registry / master_seq / plugins / cron / task_details', () => {
    buildFakeData()
    purgeUserWorkspace(ROOT, 1)
    for (const p of [
      'users/users.json', 'ai-registry.json', 'master_seq/inst-a.json',
      'plugins', 'cron', 'task_details'
    ]) {
      expect(existsSync(join(ROOT, p)), `${p} 不应被全局清理`).toBe(true)
    }
  })

  it('skill-market manifest：清空目标 uid 全部作用域记录、保留其它 uid', () => {
    buildFakeData()
    purgeUserWorkspace(ROOT, 1)
    const manifest = JSON.parse(readFileSync(join(ROOT, 'skill-market', 'manifest.json'), 'utf-8'))
    expect(Object.keys(manifest.installed)).toEqual(['U2/AI1'])
  })

  it('幂等：目标不存在时静默返回，重复调用无副作用', () => {
    buildFakeData()
    const first = purgeUserWorkspace(ROOT, 1)
    const second = purgeUserWorkspace(ROOT, 1)
    expect(first.removedDirs.length).toBeGreaterThan(0)
    // 第二次不再删除任何内容且不抛错
    expect(second.removedDirs.length).toBe(0)
    expect(second.removedFiles.length).toBe(0)
  })

  it('越界防护：非正整数 uid 拒绝执行', () => {
    buildFakeData()
    expect(() => purgeUserWorkspace(ROOT, 0)).toThrow(/正整数/)
    expect(() => purgeUserWorkspace(ROOT, -1)).toThrow(/正整数/)
    expect(() => purgeUserWorkspace(ROOT, 1.5)).toThrow(/正整数/)
  })

  it('目录不存在时（空数据根）幂等返回空结果', () => {
    const result = purgeUserWorkspace(join(TEST_ROOT, 'empty', 'abyssac_data'), 1)
    expect(result.removedDirs).toEqual([])
    expect(result.removedFiles).toEqual([])
  })
})