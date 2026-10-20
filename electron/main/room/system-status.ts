/**
 * @category ROOM
 * @summary 电脑状态采集：磁盘与 GPU（CPU / 内存已在 `performance/runtime-profile`）
 *
 * 为什么存在：用户要求采集「当前电脑状态，比如 CPU/GPU/内存/磁盘状态」。CPU 与内存已有单源
 * （`getRuntimeProfile`），缺磁盘与 GPU——本模块补齐这两项，使「电脑状态」完整。
 *
 * 不删理由：删掉即 AI 只能看到 CPU/内存，判断不出「磁盘快满了」「有没有独显」。
 *
 * 平台口径：Windows 经 PowerShell `Get-CimInstance`（系统自带，**不引第三方依赖**）；
 * 解析为纯函数便于单测（注入 runner）。失败一律返回空数组（采集失败不阻断循环）。
 */
import type { CommandRunner } from './process-scan'

export interface DiskInfo {
  /** 盘符（如 C:） */
  drive: string
  totalGB: number
  freeGB: number
  /** 已用百分比（0~100，取整） */
  usedPercent: number
}

export interface GpuInfo {
  name: string
  /** 显存（GB，一位小数）；`AdapterRAM` 常为 0/负（WMI 已知限制）→ null */
  vramGB: number | null
}

const gb = (bytes: number): number => Math.round((bytes / 1024 ** 3) * 10) / 10

/** 解析 `Win32_LogicalDisk` 的 JSON（数组或单对象）。 */
export function parseDisksJson(json: string): DiskInfo[] {
  try {
    const raw = JSON.parse(json) as unknown
    const arr = Array.isArray(raw) ? raw : [raw]
    const out: DiskInfo[] = []
    for (const item of arr) {
      const o = (item ?? {}) as { DeviceID?: unknown; Size?: unknown; FreeSpace?: unknown }
      const drive = typeof o.DeviceID === 'string' ? o.DeviceID : ''
      const total = Number(o.Size)
      const free = Number(o.FreeSpace)
      if (!drive || !Number.isFinite(total) || total <= 0) continue
      const freeBytes = Number.isFinite(free) && free >= 0 ? free : 0
      out.push({
        drive,
        totalGB: gb(total),
        freeGB: gb(freeBytes),
        usedPercent: Math.round(((total - freeBytes) / total) * 100)
      })
    }
    return out
  } catch {
    return []
  }
}

/** 解析 `Win32_VideoController` 的 JSON（数组或单对象）。 */
export function parseGpusJson(json: string): GpuInfo[] {
  try {
    const raw = JSON.parse(json) as unknown
    const arr = Array.isArray(raw) ? raw : [raw]
    const out: GpuInfo[] = []
    for (const item of arr) {
      const o = (item ?? {}) as { Name?: unknown; AdapterRAM?: unknown }
      const name = typeof o.Name === 'string' ? o.Name.trim() : ''
      if (!name) continue
      const ram = Number(o.AdapterRAM)
      // AdapterRAM 是 32 位字段：>4GB 的显存会回绕成负数或 0（WMI 已知限制）→ 如实报 null
      const vramGB = Number.isFinite(ram) && ram > 0 ? Math.round((ram / 1024 ** 3) * 10) / 10 : null
      out.push({ name, vramGB })
    }
    return out
  } catch {
    return []
  }
}

const PS = (cmd: string): string[] => ['-NoProfile', '-NonInteractive', '-Command', cmd]

/** 采集固定磁盘（DriveType=3 本地盘）。非 Windows 或失败 → 空数组。 */
export async function collectDisks(run: CommandRunner): Promise<DiskInfo[]> {
  if (process.platform !== 'win32') return []
  try {
    const out = await run('powershell', [
      ...PS('Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress')
    ])
    return parseDisksJson(out)
  } catch {
    return []
  }
}

/** 采集显卡。非 Windows 或失败 → 空数组。 */
export async function collectGpus(run: CommandRunner): Promise<GpuInfo[]> {
  if (process.platform !== 'win32') return []
  try {
    const out = await run('powershell', [
      ...PS('Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress')
    ])
    return parseGpusJson(out)
  } catch {
    return []
  }
}
