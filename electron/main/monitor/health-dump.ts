/**
 * 健康检查完整输出落盘（从 health-check.ts 拆出，0.53.10 体量让位）。
 *
 * 为什么异步写：失败输出可达数十 MB（命令单流上限 32MB），同步写会把 Electron 主进程
 * （IPC/WS/渲染）整体冻住。这里用 fs/promises，且只在「真正要唤醒 AI」时调用。
 * 保留策略：最多 20 份，超出按文件名时间戳删除最旧；避免长期故障把磁盘写满。
 */
import { mkdirSync, readFileSync, readdirSync, unlinkSync } from 'fs'
import { writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { resolveNodeExe } from '../utils/node-runtime'
import type { HealthCheckKey } from './health-config'

/**
 * 完整输出落盘上限：8MB。
 * 依据：本仓全量 vitest 失败输出通常 <1MB；8MB 覆盖 worker 崩溃 + 长堆栈，
 * 同时把单文件最坏磁盘占用限制在命令双流上限（64MB）的 1/8。
 */
const MAX_DUMP_OUTPUT_CHARS = 8_000_000
/**
 * 完整输出日志保留份数：20。
 * 依据：单份上限 8MB → 最坏 160MB，典型 <1MB → 约 20MB；20 份覆盖最近约 10 小时的
 * 反复失败（默认 30 分钟一轮 + 冷却），不会无限增长。
 */
const MAX_DUMP_LOG_FILES = 20

export interface DumpHealthOutputOptions {
  key: HealthCheckKey
  output: string
  /** 打包态：写入 dataRoot/.health-check/logs；开发态写入 workDir/data/userdata/logs */
  packaged: boolean
  workDir: string
  dataRoot: string
}

/**
 * 落盘完整输出 + 关键环境变量。
 * @returns 落盘文件绝对路径；失败返回 null（调用方把路径带进报错消息）。
 */
export async function dumpHealthOutput(opts: DumpHealthOutputOptions): Promise<string | null> {
  const { key, output, packaged, workDir, dataRoot } = opts
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const logRoot = packaged
      ? join(dataRoot, '.health-check', 'logs')
      : join(workDir, 'data', 'userdata', 'logs')
    const file = join(logRoot, `health-check-full-${key}-${ts}.log`)
    mkdirSync(dirname(file), { recursive: true })

    // 带密钥语义的变量绝不落盘（dump 路径会交给 AI 读取）
    const envDump = Object.entries(process.env)
      .filter(([k]) => !/TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTH/i.test(k))
      .filter(([k]) => /NODE|PATH|ELECTRON|VITE|VITEST|npm_|CI|COREPACK/i.test(k))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')

    let extra = `nodeExe=${resolveNodeExe(workDir)}\n`
    extra += `mainProcessExecPath=${process.execPath}\nmainProcessExecArgv=${JSON.stringify(process.execArgv)}\n`
    try {
      const vp = join(workDir, 'node_modules', 'vitest', 'package.json')
      extra += `vitestVersion=${JSON.parse(readFileSync(vp, 'utf-8')).version}\n`
    } catch {
      /* vitest 不存在（分发包）属正常 */
    }

    const capped =
      output.length > MAX_DUMP_OUTPUT_CHARS
        ? `${output.slice(0, MAX_DUMP_OUTPUT_CHARS / 2)}\n……（落盘截断：原文 ${output.length} 字符）……\n${output.slice(-MAX_DUMP_OUTPUT_CHARS / 2)}`
        : output

    await writeFile(
      file,
      `=== env relevant ===\n${envDump}\n\n=== extra ===\n${extra}\n\n=== output (${output.length} chars) ===\n${capped}`,
      'utf-8'
    )
    pruneDumpLogs(logRoot)
    console.warn(`[health-check] ${key} 失败完整输出已落盘: ${file}`)
    return file
  } catch (e) {
    console.warn('[health-check] dumpFullOutput failed', e)
    return null
  }
}

/** 只保留最近 N 份完整输出日志（按文件名排序；失败静默，不影响检查结果） */
function pruneDumpLogs(logRoot: string): void {
  try {
    const files = readdirSync(logRoot)
      .filter((f) => /^health-check-full-.*\.log$/.test(f))
      .sort()
    for (const f of files.slice(0, Math.max(0, files.length - MAX_DUMP_LOG_FILES))) {
      try {
        unlinkSync(join(logRoot, f))
      } catch {
        /* 被占用则下次再删 */
      }
    }
  } catch {
    /* 目录不存在/无权限：忽略 */
  }
}
