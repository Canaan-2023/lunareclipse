/**
 * 为什么存在：监控体系各项节流/开关/预算参数需要集中可调并落盘，避免散落硬编码导致运行时无法调优。
 * 作用：导出默认监控配置并提供 load/save/merge 工具（memory/diary/sessionSummary 等工作流参数）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { MonitorConfig } from '@shared/types'

export type { MonitorConfig }

export const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  abyssac_root: 'abyssac_data',
  // 记忆处理工作流调度（替代旧 DMN + heartbeat，由 raw_memory 驱动 L8 工作流引擎）
  memoryWorkflow: {
    enabled: true,
    check_interval_seconds: 10,
    // 修复：v1 时代遗留默认值 3 → v2 架构（主调度器 → 子 AGENT → review）
    // 每批只处理 1 个封口 RAW（调度器只取 batch[0]），batch_size>1 时第 2/3 个 RAW 被永久跳过
    batch_size: 1
  },
  // 日记工作流调度（后端自主日记调度，替代 AI 侧 cron diary-daily-write）
  diaryWorkflow: {
    enabled: true,
    check_interval_seconds: 30
  },
// 双层会话摘要/路由配置（替代旧 contextTree 段；AI 存储整理阈值，非注入限制）
  // summaryBudgetChars=0 表示自动推导：server 侧按模型窗口 × 1/4（SESSION_BUDGET_RATIO，保底 30000）
  // 动态计算。取 1/4 而非 1/2 的理由：存储阈值是「超限即继承」的触发线，需与注入预算
  // （模型窗口 × 1/2）拉开距离，避免存满即触发时上下文余量不足（见 internal-session.ts）。
  // 迁移说明：0.15 前默认 700000 字符远超主流模型窗口，超限继承永不触发（评审 K1）；
  // 留 0 语义让预算跟随所选模型，旧落盘文件中的 700000 一并迁移为 0。
  sessionSummary: {
    enabled: true,
    summaryMaxChars: 200,
    summaryBudgetChars: 0,
    routerMaxSessions: 50,
    userShardMaxBytes: 500000,
    // 路由前预览用户界面会话的对话对数（一个对话对 = 用户输入 + AI 输出）；
    // 默认 4 对：选取内部会话前让 AI 看到最近 4 对历史作为参考上下文，仍不注入主链路
    routePreviewTurnPairs: 4
  },
  mutex: {
    acquire_timeout_seconds: 30
  },
  watchdog: {
    timeout_minutes: 2,
    tool_timeout_seconds: 30,
    continue_check_seconds: 10,
    max_retry: 2
  },
  freeze: {
    timeout_minutes: 5
  },
  task_log_max_entries: 200,
  shutdown: {
    grace_period_seconds: 30
  }
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj))
}

export function loadMonitorConfig(configDir: string): MonitorConfig {
  const configPath = join(configDir, 'config.json')
  if (!existsSync(configPath)) {
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      configPath,
      JSON.stringify(DEFAULT_MONITOR_CONFIG, null, 2),
      'utf-8'
    )
    return deepClone(DEFAULT_MONITOR_CONFIG)
  }
  try {
    const raw = readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<MonitorConfig>
    return mergeConfig(DEFAULT_MONITOR_CONFIG, parsed)
  } catch {
    return deepClone(DEFAULT_MONITOR_CONFIG)
  }
}

export function saveMonitorConfig(configDir: string, config: MonitorConfig): void {
  mkdirSync(configDir, { recursive: true })
  const configPath = join(configDir, 'config.json')
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
}

export function mergeConfig(base: MonitorConfig, override: Partial<MonitorConfig>): MonitorConfig {
  return {
    abyssac_root: override.abyssac_root ?? base.abyssac_root,
    memoryWorkflow: {
      enabled: override.memoryWorkflow?.enabled ?? base.memoryWorkflow.enabled,
      check_interval_seconds:
        override.memoryWorkflow?.check_interval_seconds ??
        base.memoryWorkflow.check_interval_seconds,
      batch_size: override.memoryWorkflow?.batch_size ?? base.memoryWorkflow.batch_size
    },
    diaryWorkflow: {
      enabled: override.diaryWorkflow?.enabled ?? base.diaryWorkflow.enabled,
      check_interval_seconds:
        override.diaryWorkflow?.check_interval_seconds ??
        base.diaryWorkflow.check_interval_seconds
    },
    sessionSummary: {
      enabled: override.sessionSummary?.enabled ?? base.sessionSummary.enabled,
      summaryMaxChars:
        override.sessionSummary?.summaryMaxChars ?? base.sessionSummary.summaryMaxChars,
      summaryBudgetChars:
        override.sessionSummary?.summaryBudgetChars ?? base.sessionSummary.summaryBudgetChars,
      routerMaxSessions:
        override.sessionSummary?.routerMaxSessions ?? base.sessionSummary.routerMaxSessions,
      userShardMaxBytes:
        override.sessionSummary?.userShardMaxBytes ?? base.sessionSummary.userShardMaxBytes,
      routePreviewTurnPairs:
        override.sessionSummary?.routePreviewTurnPairs ?? base.sessionSummary.routePreviewTurnPairs
    },
    mutex: {
      acquire_timeout_seconds:
        override.mutex?.acquire_timeout_seconds ?? base.mutex.acquire_timeout_seconds
    },
    watchdog: {
      timeout_minutes:
        override.watchdog?.timeout_minutes ?? base.watchdog.timeout_minutes,
      tool_timeout_seconds:
        override.watchdog?.tool_timeout_seconds ?? base.watchdog.tool_timeout_seconds,
      continue_check_seconds:
        override.watchdog?.continue_check_seconds ??
        base.watchdog.continue_check_seconds,
      max_retry: override.watchdog?.max_retry ?? base.watchdog.max_retry
    },
    freeze: {
      timeout_minutes:
        override.freeze?.timeout_minutes ?? base.freeze.timeout_minutes
    },
    task_log_max_entries:
      override.task_log_max_entries ?? base.task_log_max_entries,
    shutdown: {
      grace_period_seconds:
        override.shutdown?.grace_period_seconds ?? base.shutdown.grace_period_seconds
    }
  }
}
