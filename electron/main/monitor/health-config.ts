/**
 * 健康检查配置与运行时事件映射（0.53.10）。
 *
 * 检查项本身不在这里枚举——见 `health-check-registry.ts`：
 * `config.checks` 是 `Record<string, boolean>`，新增检查项只加一个定义对象，
 * 默认开关/标签/模块映射/可用性/执行体都随定义走。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createDefaultChecks } from './health-check-registry'

/** 检查项 key（运行时是开放字符串：未知 key 会在执行时明确报错，而不是被静默忽略） */
export type HealthCheckKey = string

/** 运行时事件类型（主进程崩溃监听接入，走同一 AlertGate 去重/冷却） */
export type RuntimeEventKind = 'uncaughtException' | 'unhandledRejection' | 'render-process-gone'

export const RUNTIME_TO_MODULE: Record<RuntimeEventKind, string> = {
  uncaughtException: 'main',
  unhandledRejection: 'main',
  'render-process-gone': 'render-ui'
}

/** 健康检查配置（持久化到 {dataDir}/.health_check/config.json） */
export interface HealthCheckConfig {
  /** 总开关 */
  enabled: boolean
  /** 检查间隔（分钟） */
  interval_minutes: number
  /** 各检查项开关（开放键：由注册表定义默认值，未知键执行时报错） */
  checks: Record<string, boolean>
  /** 同指纹错误冷却期（分钟）：冷却期内不重复提醒；不做连续失败静默 */
  cooldown_minutes: number
}

export const DEFAULT_HEALTH_CHECK_CONFIG: HealthCheckConfig = {
  enabled: true,
  interval_minutes: 30,
  checks: createDefaultChecks(),
  cooldown_minutes: 30
}

/** 配置值夹取：防止 interval=0 造成 setInterval 空转、负冷却让去重失效 */
function clampConfig(raw: HealthCheckConfig): HealthCheckConfig {
  const int = (v: unknown, fallback: number): number => {
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) ? Math.floor(n) : fallback
  }
  return {
    ...raw,
    // 间隔至少 1 分钟；上限 7 天（再长等于关闭周期检查，用户应直接改 enabled）
    interval_minutes: Math.min(7 * 24 * 60, Math.max(1, int(raw.interval_minutes, 30))),
    cooldown_minutes: Math.max(0, int(raw.cooldown_minutes, 30)),
    checks: { ...raw.checks }
  }
}

export function loadConfig(configDir: string): HealthCheckConfig {
  const configPath = join(configDir, 'config.json')
  if (!existsSync(configPath)) {
    mkdirSync(configDir, { recursive: true })
    const fresh = clampConfig({ ...DEFAULT_HEALTH_CHECK_CONFIG, checks: createDefaultChecks() })
    writeFileSync(configPath, JSON.stringify(fresh, null, 2), 'utf-8')
    return fresh
  }
  try {
    const raw = readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<HealthCheckConfig>
    // 合并而不是逐键白名单：新增检查项自动拿到默认值；
    // 配置里的未知 key 原样保留，执行时由 HealthCheck 明确报「未知检查项」。
    return clampConfig({
      enabled: parsed.enabled ?? DEFAULT_HEALTH_CHECK_CONFIG.enabled,
      interval_minutes: parsed.interval_minutes ?? DEFAULT_HEALTH_CHECK_CONFIG.interval_minutes,
      cooldown_minutes: parsed.cooldown_minutes ?? DEFAULT_HEALTH_CHECK_CONFIG.cooldown_minutes,
      checks: { ...createDefaultChecks(), ...(parsed.checks ?? {}) }
    })
  } catch {
    // 配置损坏：回退默认值（不阻断启动；下次保存会重写合法 JSON）
    return clampConfig({ ...DEFAULT_HEALTH_CHECK_CONFIG, checks: createDefaultChecks() })
  }
}
