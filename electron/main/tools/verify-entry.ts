/**
 * 工具注册自检入口：为什么存在——工具池拆分成多文件后需要一道快速自检确认注册链完整，
 * 供接入方 / 测试复用，避免回归遗漏。
 * 作用：run(cfg) 创建工具注册表并返回工具总数、team_* 工具清单与采样列表。
 */
import { createToolRegistry } from './index'
import type { ToolPolicy } from '@shared/types'

type EntryConfig = {
  frontendToolPolicy?: { tools?: Record<string, ToolPolicy> }
  webSearchEnabled?: boolean
}

export const run = (cfg: EntryConfig) => {
  const reg = createToolRegistry({}, { toolsPolicy: cfg.frontendToolPolicy?.tools ?? {}, config: cfg })
  const names = Array.from(reg.tools.keys())
  const team = names.filter(n => n.startsWith('team_'))
  return { total: names.length, team, hasTeam: team.length > 0, sample: names.slice(0, 15) }
}