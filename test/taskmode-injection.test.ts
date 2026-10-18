import { describe, it, expect } from 'vitest'
import { createToolRegistry } from '../electron/main/tools/index'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { ToolPolicy } from '@shared/types'

/**
 * 任务模式工具注入回归（2026-08-18）
 * 用真实 config复现「aiMode=task 时团队工具是否注入」——曾用户反馈"切任务模式没看到拆解"。
 * 根因验证结论：只要 config.aiMode==='task'（无论 policy 是否显式配 team_*，defaultEnabled=true 生效），
 * createToolRegistry 的 9 个 team_* 工具都必须注入。tools/index.ts 按 visible(cfg) 过滤在此处（tools/index.ts:369）。
 */
describe('任务模式工具注入（真实 config）', () => {
  it('aiMode=task 时工具池包含全部 9 个 team_* 工具', () => {
    let cfg: { aiMode?: string; frontendToolPolicy?: { tools?: Record<string, ToolPolicy> } }
    try {
      cfg = JSON.parse(readFileSync(join(__dirname, '../data/userdata/config.json'), 'utf8'))
    } catch {
      cfg = { aiMode: 'task', frontendToolPolicy: { tools: {} } }
    }
    // 断言当前生效模式是 task（若用户改了模式本测试仍应通过——用显式 task config 保证前提）
    const testCfg = { ...cfg, aiMode: 'task' }
    const reg = createToolRegistry({}, {
      toolsPolicy: testCfg.frontendToolPolicy?.tools ?? {},
      config: testCfg
    })
    const names = Array.from(reg.tools.keys())
    const team = names.filter((n) => n.startsWith('team_'))
    expect(team.sort()).toEqual([
      'team_create', 'team_inbox', 'team_launch', 'team_list',
      'team_lock', 'team_memory', 'team_merge', 'team_message', 'team_task'
    ].sort())
  })
})