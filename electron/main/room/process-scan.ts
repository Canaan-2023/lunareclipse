/**
 * @category ROOM
 * @summary 后台进程扫描：列出当前运行进程（名称 / PID / 内存占用）
 *
 * 为什么存在：用户要求采集器「不光要屏幕采集，还有当前的后台进程有什么」——
 * AI 感知环境时，进程列表是判断「机器在忙什么」的直接证据。
 *
 * 不删理由：删掉即环境采集只剩 CPU/内存总量，看不到「是谁在占用」。
 *
 * 平台口径：Windows 走 `tasklist /FO CSV /NH`（系统自带，**不引第三方依赖**）；
 * 解析为纯函数便于单测（注入 exec，不真起子进程）。**只取前 N 条**（按内存降序）——
 * 进程列表可能上千条，全量塞进 AI 上下文既贵又无用。
 */

export interface ProcessInfo {
  /** 进程名（如 chrome.exe） */
  name: string
  pid: number
  /** 内存占用（MB，取整） */
  memMB: number
}

import { execFile } from 'node:child_process'

/** 默认只取内存占用最高的 N 条。 */
export const DEFAULT_PROCESS_LIMIT = 20

/** 执行器签名（注入以便单测；生产接 `execFile('tasklist', …)`）。 */
export type CommandRunner = (file: string, args: string[]) => Promise<string>

/** 解析一行 CSV（处理引号包裹与其中的逗号）。 */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

/** 解析 `tasklist /FO CSV /NH` 输出：`"name","pid","session","#","1,234 K"`。 */
export function parseTasklistCsv(csv: string, limit: number = DEFAULT_PROCESS_LIMIT): ProcessInfo[] {
  const rows: ProcessInfo[] = []
  for (const raw of csv.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const cols = splitCsvLine(line)
    if (cols.length < 5) continue
    const name = cols[0].trim()
    const pid = Number.parseInt(cols[1].trim(), 10)
    // 内存列形如 "12,345 K"（千字节）
    const memRaw = cols[4].replace(/[^\d]/g, '')
    const memKB = memRaw ? Number.parseInt(memRaw, 10) : NaN
    if (!name || !Number.isFinite(pid) || pid <= 0) continue
    rows.push({ name, pid, memMB: Number.isFinite(memKB) ? Math.round(memKB / 1024) : 0 })
  }
  rows.sort((a, b) => b.memMB - a.memMB)
  return rows.slice(0, Math.max(1, limit))
}

/** 扫描进程：Windows 走 tasklist；其它平台返回空（不猜命令）。失败一律返回空数组（采集失败不阻断循环）。 */
export async function collectProcesses(
  run: CommandRunner,
  limit: number = DEFAULT_PROCESS_LIMIT
): Promise<ProcessInfo[]> {
  if (process.platform !== 'win32') return []
  try {
    const out = await run('tasklist', ['/FO', 'CSV', '/NH'])
    return parseTasklistCsv(out, limit)
  } catch {
    return []
  }
}

/** 生产用执行器：`execFile` + 超时 + 不弹窗（Windows 下会闪黑框）。 */
export function createExecFileRunner(timeoutMs = 5000): CommandRunner {
  return (file, args) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err) reject(err)
          else resolve(String(stdout))
        }
      )
    })
}
