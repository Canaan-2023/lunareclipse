/**
 * @category ROOM
 * @summary 上传 / 下载监控：系统网卡累计字节 → 速率，并汇总本应用自己的传输
 *
 * 为什么存在：用户要求「当前的上传和下载都要有所监控」。分两层：
 * ① **系统层**：网卡累计收发字节的差分 → 实时速率（Windows 经 `Get-NetAdapterStatistics`，
 *    系统自带、不引依赖）；② **应用层**：本应用自己的传输（LAN 流 / 中继待取件）——
 *    这一层 AI 最需要知道「我正在传什么」。
 *
 * 不删理由：删掉即「上传下载」只剩一个静态数字，看不出当前是否在传、传得多快。
 *
 * 差分语义：速率必须两次采样才有值——首次采样返回 `null` 速率（**不假装 0**，
 * 「不知道」与「没流量」是两件事）。采样失败一律返回 null，不阻断循环。
 */

import { execFile } from 'node:child_process'

export interface NetCounters {
  /** 累计接收字节 */
  rxBytes: number
  /** 累计发送字节 */
  txBytes: number
}

export interface NetStats {
  /** 采样时刻（epoch ms） */
  ts: number
  /** 接收速率（字节/秒）；首次采样或不可得 = null */
  rxBytesPerSec: number | null
  /** 发送速率（字节/秒）；首次采样或不可得 = null */
  txBytesPerSec: number | null
  /** 累计接收（MB，一位小数） */
  rxTotalMB: number
  /** 累计发送（MB，一位小数） */
  txTotalMB: number
}

/** 本应用自己的传输摘要（由调用方注入，接 LAN 流 / 中继）。 */
export interface AppTransferSummary {
  /** 活跃的 LAN 流数量 */
  activeLanStreams: number
  /** 中继待取件条数 */
  relayPending: number
  /** 备注（如「局域网未启动」） */
  note?: string
}

export interface NetMonitorDeps {
  /** 读系统累计计数器；失败/不可得返回 null */
  readCounters: () => Promise<NetCounters | null>
  /** 读本应用传输摘要（可选） */
  readAppTransfers?: () => AppTransferSummary
  now?: () => number
}

export interface NetMonitor {
  /** 采样一次并算出速率（内部保存上次样本） */
  read: () => Promise<NetStats & { app?: AppTransferSummary }>
}

const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10

export function createNetMonitor(deps: NetMonitorDeps): NetMonitor {
  const now = deps.now ?? (() => Date.now())
  let prev: { ts: number; counters: NetCounters } | null = null

  return {
    async read() {
      const counters = await deps.readCounters()
      const ts = now()
      let app: AppTransferSummary | undefined
      try {
        app = deps.readAppTransfers?.()
      } catch {
        app = undefined
      }

      if (!counters) {
        return { ts, rxBytesPerSec: null, txBytesPerSec: null, rxTotalMB: 0, txTotalMB: 0, ...(app ? { app } : {}) }
      }

      let rxRate: number | null = null
      let txRate: number | null = null
      if (prev && ts > prev.ts) {
        const secs = (ts - prev.ts) / 1000
        const drx = counters.rxBytes - prev.counters.rxBytes
        const dtx = counters.txBytes - prev.counters.txBytes
        // 计数器回绕（重启网卡）→ 负数：本次不报速率，只更新基线
        if (drx >= 0 && dtx >= 0) {
          rxRate = Math.round(drx / secs)
          txRate = Math.round(dtx / secs)
        }
      }
      prev = { ts, counters }

      return {
        ts,
        rxBytesPerSec: rxRate,
        txBytesPerSec: txRate,
        rxTotalMB: mb(counters.rxBytes),
        txTotalMB: mb(counters.txBytes),
        ...(app ? { app } : {})
      }
    }
  }
}

/** 解析 Windows `Get-NetAdapterStatistics` 的 JSON 输出（数组或单对象）。 */
export function parseAdapterStatistics(json: string): NetCounters | null {
  try {
    const raw = JSON.parse(json) as unknown
    const arr = Array.isArray(raw) ? raw : [raw]
    let rx = 0
    let tx = 0
    let seen = false
    for (const item of arr) {
      const o = (item ?? {}) as { ReceivedBytes?: unknown; SentBytes?: unknown }
      const r = Number(o.ReceivedBytes)
      const t = Number(o.SentBytes)
      if (Number.isFinite(r)) {
        rx += r
        seen = true
      }
      if (Number.isFinite(t)) {
        tx += t
        seen = true
      }
    }
    return seen ? { rxBytes: rx, txBytes: tx } : null
  } catch {
    return null
  }
}

/**
 * 生产用计数器读取：Windows 经 PowerShell `Get-NetAdapterStatistics` 汇总全部网卡。
 * 非 Windows / 失败一律返回 null（不阻断采集，也不假装 0）。
 */
export async function readWindowsAdapterCounters(timeoutMs = 8000): Promise<NetCounters | null> {
  if (process.platform !== 'win32') return null
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-NetAdapterStatistics | Select-Object ReceivedBytes,SentBytes | ConvertTo-Json -Compress'
        ],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(String(stdout)))
      )
    })
    return parseAdapterStatistics(out)
  } catch {
    return null
  }
}
