/**
 * @category 工具
 * @summary 采集器工具（AI 侧）：采集本机环境状态与可选桌面截图
 *
 * 为什么存在：交接单 §7 要求采集器「采集环境状态（桌面等）交给 AI」，且 §0 T1-1 把它列为
 * **默认关、范围可配、用户可见**的显式授予能力。本工具是 AI 侧的采集入口，
 * **必须先过 `t1.collector` 授予裁决**（ADR-11 唯一 policy 检查点）。
 *
 * 不删理由：删掉即 AI 无法感知当前环境；或退化成绕过权限层直接读屏。
 *
 * 复用而非重造：
 * - 环境状态：`performance/runtime-profile.getRuntimeProfile()`（既有单源，5s TTL 缓存）；
 * - 桌面截图：`api/system-input.captureScreen()`（既有实现，desktopCapturer → PNG 落 userData/system-shots）。
 */
import type { AnyTool, ToolParameter, ToolResult, ToolContext } from './base-tool'
import type { AuditSink, SecurityGrants } from '@shared/types/permission'
import type { CollectorConfig } from '@shared/types/collector'
import { getRuntimeProfile } from '../performance/runtime-profile'
import { collectProcesses, createExecFileRunner } from '../room/process-scan'
import { collectDisks, collectGpus } from '../room/system-status'
import { captureAllScreens } from '../room/screen-capture'
import { join } from 'path'
import {
  createNetMonitor,
  readWindowsAdapterCounters,
  type AppTransferSummary,
  type NetStats
} from '../room/net-monitor'
import { EMPTY_GRANTS, evaluatePolicy } from './security-engine/policy-gate'
import { createFileAuditSink, defaultAuditFilePath } from './security-engine/audit-log'

/** 本应用传输摘要的注入点（由组合根接 LAN 流 / 中继；未注入则不报该段）。 */
let appTransfersProvider: (() => AppTransferSummary) | null = null

export function setCollectorAppTransfers(provider: (() => AppTransferSummary) | null): void {
  appTransfersProvider = provider
}

/** 进程扫描执行器（生产用 execFile；模块级复用，避免每次采集新建） */
const processRunner = createExecFileRunner()

/** 网络监控（系统网卡差分 + 本应用传输） */
const netMonitor = createNetMonitor({
  readCounters: readWindowsAdapterCounters,
  readAppTransfers: () => appTransfersProvider?.() ?? { activeLanStreams: 0, relayPending: 0 }
})

/** 电脑状态（CPU/内存/负载 + 磁盘 + GPU）：env 段与自主循环采集输入共用。 */
export async function collectComputerStatus(): Promise<{
  environment: EnvironmentSnapshot
  disks: Awaited<ReturnType<typeof collectDisks>>
  gpus: Awaited<ReturnType<typeof collectGpus>>
}> {
  const [disks, gpus] = await Promise.all([collectDisks(processRunner), collectGpus(processRunner)])
  return { environment: collectEnvironment(), disks, gpus }
}

/** 采集系统段：后台进程 + 上传下载（受 `collector.processes` / `collector.network` 两个开关约束）。 */
export async function collectSystem(
  cfg: CollectorConfig | undefined
): Promise<{ processes?: unknown; network?: NetStats | null; notes: string[] }> {
  const notes: string[] = []
  const out: { processes?: unknown; network?: NetStats | null; notes: string[] } = { notes }

  if (cfg?.processes === true) {
    out.processes = await collectProcesses(processRunner)
  } else {
    notes.push('后台进程未开启（设置 → 自主房间 → 采集器）')
  }

  if (cfg?.network === true) {
    out.network = await netMonitor.read()
  } else {
    notes.push('上传下载监控未开启（设置 → 自主房间 → 采集器）')
  }
  return out
}

/** 环境状态快照（只读元数据，不含任何用户数据）。 */
export interface EnvironmentSnapshot {
  platform: string
  cpuModel: string
  logicalCores: number
  physicalCores: number | null
  totalMemGB: number
  freeMemGB: number
  cpuUsagePct: number
  sampledAt: number
}

/** 采集环境状态快照（复用既有 runtime-profile 单源）。 */
export function collectEnvironment(): EnvironmentSnapshot {
  const profile = getRuntimeProfile()
  const hw = profile.hardware
  const gb = (bytes: number): number => Math.round((bytes / 1024 ** 3) * 10) / 10
  return {
    platform: hw.platform,
    cpuModel: hw.cpuModel,
    logicalCores: hw.logicalCores,
    physicalCores: hw.physicalCores,
    totalMemGB: gb(hw.totalMemBytes),
    freeMemGB: gb(profile.freeMemBytes),
    cpuUsagePct: Math.round(profile.cpuUsagePct * 10) / 10,
    sampledAt: profile.sampledAt
  }
}

export class CollectEnvironmentTool implements AnyTool {
  /**
   * @param audit 审计落点；缺省写锚点派生的 JSONL。测试注入 no-op，避免单测写仓库 `data/`（R-T2）。
   */
  constructor(private readonly audit?: AuditSink) {}

  name = 'collect_environment'
  description =
    '采集本机环境状态、系统运行信息与（可选）桌面截图，供你感知当前运行环境。' +
    'scope=env 采集电脑状态（平台/CPU/内存/负载 + 磁盘 + GPU，只读元数据）；scope=desktop 采集整屏截图并返回图片路径；' +
    'scope=system 采集后台进程（名称/PID/内存）与上传下载监控（网卡速率 + 本应用传输）；scope=all 三者都采。' +
    '本能力属 T1 显式授予（键 t1.collector）：未获用户授予时会被拒绝，并返回如何授予的提示。'
  parameters: ToolParameter[] = [
    {
      name: 'scope',
      type: 'string',
      description: '采集范围：env（环境状态，默认）/ desktop（桌面截图）/ system（进程 + 上传下载）/ all（全部）',
      required: false
    }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const scope = String(params.scope ?? 'env').trim().toLowerCase()
    if (scope !== 'env' && scope !== 'desktop' && scope !== 'system' && scope !== 'all') {
      return { ok: false, error: `未知 scope「${scope}」：可选 env / desktop / system / all` }
    }

    // 显式授予裁决（ADR-11 唯一检查点）
    const grants = (ctx?.config as { securityGrants?: SecurityGrants } | undefined)?.securityGrants ?? EMPTY_GRANTS
    const audit: AuditSink = this.audit ?? createFileAuditSink(defaultAuditFilePath())
    const decision = evaluatePolicy(
      { capability: 't1.collector', action: `collect.${scope}`, actor: 'ai' },
      { getGrants: () => grants, now: () => Date.now(), audit }
    )
    if (!decision.allowed) {
      const hint = decision.grantHint ? `；${decision.grantHint}` : ''
      return { ok: false, error: `${decision.reason}${hint}` }
    }

    const data: Record<string, unknown> = {}
    if (scope === 'env' || scope === 'all') {
      try {
        const st = await collectComputerStatus()
        data.environment = st.environment
        data.disks = st.disks
        data.gpus = st.gpus
      } catch (err) {
        data.systemStatus = { error: (err as Error).message }
      }
    }
    if (scope === 'desktop' || scope === 'all') {
      // 优先「全部显示器」（既有 system-input.captureScreen 只取主屏）；失败回落既有实现
      let done = false
      try {
        const { app } = await import('electron')
        const shots = await captureAllScreens(join(app.getPath('userData'), 'system-shots'))
        if (shots.length > 0) {
          data.screens = shots
          done = true
        }
      } catch {
        /* 回落既有实现 */
      }
      if (!done) {
        const si = ctx?.getSystemInput?.()
        if (!si) {
          data.desktop = { ok: false, error: '系统输入引擎不可用（当前环境未注入 getSystemInput）' }
        } else {
          try {
            data.desktop = await si.captureScreen()
          } catch (err) {
            data.desktop = { ok: false, error: (err as Error).message }
          }
        }
      }
    }
    if (scope === 'system' || scope === 'all') {
      const collectorCfg = (ctx?.config as { collector?: CollectorConfig } | undefined)?.collector
      try {
        const sys = await collectSystem(collectorCfg)
        data.processes = sys.processes
        data.network = sys.network
        if (sys.notes.length > 0) data.notes = sys.notes
      } catch (err) {
        data.system = { error: (err as Error).message }
      }
    }
    return { ok: true, data }
  }
}
