/**
 * 外部命令解析（主进程共用）。

 * 背景：Windows 上 npm / npx / tsc / vitest / eslint 等命令实际是 `.cmd` 批处理，
 * 而 Node 的 execFile/spawn 在 shell:false 下不做 PATHEXT 匹配（CreateProcess 只会
 * 自动补 `.exe`）。实测：`execFile('node')` 正常，`execFile('npm')` → ENOENT，
 * 即使 npm 就在 PATH 里。用户 command Hook 里写 `npm test` 会直接失败，
 * 连续 5 次 error 后 hooks 被自动禁用（静默失效）。

 * 因此所有「执行用户/配置给定的命令」的地方统一走这里，而不是各自 execFile：
 * - 裸命令名 → 按 PATHEXT 在 PATH 中找真实文件（PATH 已由 ensureNodeOnPath 并入自备 node 目录）
 * - 解析到 .cmd/.bat → 交给 `cmd.exe /d /s /c` 执行（Node 官方推荐的 Windows 做法）
 * - 带路径分隔符的（绝对/相对路径）→ 原样使用，不做猜测
 */
import { existsSync } from 'fs'
import { delimiter, extname, join } from 'path'

const IS_WINDOWS = process.platform === 'win32'
/** Windows 批处理扩展名：这些文件不能直接 spawn，必须经 cmd.exe */
const BATCH_EXTS = new Set(['.cmd', '.bat'])

export interface ResolvedCommand {
  /** 实际要启动的可执行文件 */
  file: string
  /** 实际参数（.cmd/.bat 时会前置 cmd.exe 的开关与目标文件） */
  args: string[]
}

/** 按 PATHEXT 在 PATH 中查找裸命令名对应的真实文件；找不到返回 null */
function searchPath(name: string): string | null {
  const exts = IS_WINDOWS
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * 把「用户写的命令」解析成「实际能启动的进程」。
 *
 * @param cmd 用户配置里的命令（可能是裸名 node/npm，也可能是完整路径）
 * @param args 参数
 * @returns 可直接交给 execFile/spawn 的 file + args
 */
export function resolveExternalCommand(cmd: string, args: string[] = []): ResolvedCommand {
  // 带路径分隔符 = 调用方自己指定了位置，不猜
  if (cmd.includes('/') || cmd.includes('\\')) return { file: cmd, args }
  const found = searchPath(cmd)
  if (!found) return { file: cmd, args }
  if (IS_WINDOWS && BATCH_EXTS.has(extname(found).toLowerCase())) {
    // 批处理必须经 cmd.exe；`/d` 跳过 AutoRun，`/s` 保留后续引号原义
    return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', found, ...args] }
  }
  return { file: found, args }
}
