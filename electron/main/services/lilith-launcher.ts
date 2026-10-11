/**
 * 为什么存在：莉莉丝集成的先决条件是本机安装游戏且已装 LilithMod，启动前必须探测环境、给出可操作的缺失提示。
 * 作用：在常见 Steam 目录与进程目录探测 Lilith.exe 与 mod（BepInEx），具备时拉起游戏并回报结果。
 */

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join, dirname, basename } from 'path'
import { execFile, spawn, execFileSync } from 'child_process'
import { shell } from 'electron'

/**
 * 莉莉丝启动器服务：检测游戏本体 / MOD 完整性 / 运行状态 / 拉起游戏。

 * 职责：
 * - detectGame()：扫描常见路径找 Lilith.exe（Steam 默认库 + 根目录副本）
 * - hasMod(dir)：校验 BepInEx/plugins/LilithMod.dll + companion 存在
 * - getStatus()：游戏进程 + companion 进程 + MOD 状态汇总（设置页状态灯；async——进程探测走子进程）
 * - resolveSteamAppId()：反查 Steam AppID（判断游戏是不是 Steam 安装）
 * - launch()：优先由 Steam 拉起（steam://rungameid）；非 Steam 副本才直接 spawn exe
 */

/** 游戏可执行文件名 */
const GAME_EXE = 'Lilith.exe'
/** MOD 关键文件（相对游戏根目录） */
const MOD_PLUGIN = join('BepInEx', 'plugins', 'LilithMod.dll')
const MOD_COMPANION = join('BepInEx', 'plugins', 'companion', 'src', 'server.js')

/** 常见检测路径：Steam 默认库 + 工作区根目录副本 */
function candidateDirs(): string[] {
  const candidates: string[] = []
  // Steam 默认库（C 盘 + D 盘 + E 盘常见位置）
  for (const drive of ['C', 'D', 'E', 'F']) {
    candidates.push(
      join(`${drive}:\\Program Files (x86)\\Steam\\steamapps\\common\\The NOexistenceN of Lilith`),
      join(`${drive}:\\SteamLibrary\\steamapps\\common\\The NOexistenceN of Lilith`),
      join(`${drive}:\\Steam\\steamapps\\common\\The NOexistenceN of Lilith`)
    )
  }
  // 游戏副本（相对应用根目录——用户把游戏放在应用旁边）
  candidates.push(
    join(process.cwd(), '..', 'The NOexistenceN of Lilith')
  )
  return candidates
}

/** 检测游戏本体：返回 Lilith.exe 所在目录（优先 MOD 副本——桌宠模式需要 MOD） */
export function detectGame(): { found: boolean; dir: string; hasMod: boolean; path: string } {
  let fallback: { found: boolean; dir: string; hasMod: boolean; path: string } | null = null
  // 两轮扫描：第一轮找有 MOD 的（桌宠模式最优）；第二轮找任意本体（Steam 原版兜底）
  for (const dir of candidateDirs()) {
    const exe = join(dir, GAME_EXE)
    if (existsSync(exe)) {
      const mod = hasMod(dir)
      if (mod) {
        return { found: true, dir, hasMod: true, path: exe }
      }
      if (!fallback) {
        fallback = { found: true, dir, hasMod: false, path: exe }
      }
    }
  }
  return fallback ?? { found: false, dir: '', hasMod: false, path: '' }
}

/** 校验指定目录是否有完整 MOD（LilithMod.dll + companion server.js） */
export function hasMod(gameDir: string): boolean {
  if (!gameDir) return false
  return existsSync(join(gameDir, MOD_PLUGIN)) && existsSync(join(gameDir, MOD_COMPANION))
}

/** 游戏进程探测结果缓存：设置页/莉莉丝窗口 5s 轮询每 tick 都跑一次进程扫描（子进程）
 * → 开着设置页一天上万次扫描。缓存 5s 去重。 */
let _gameProcCache: { running: boolean; pid: number | undefined; at: number } | null = null
const GAME_PROC_CACHE_TTL = 5000
/** tasklist 子进程超时（毫秒） */
const TASKLIST_TIMEOUT_MS = 3000

/**
 * 探测 Lilith.exe 进程（带 5s 结果缓存），一次 tasklist 同时拿 running + pid。
 *
 * 为什么是 async 而不是 execFileSync（本函数是本文件唯一的「非阻塞改造点」）：
 * 本机实测一次 tasklist 耗时 342 / 349 / 395ms，而状态轮询间隔与缓存 TTL 同为 5s、
 * 命中率≈0——用同步版等于「设置页开着时每 5 秒把主进程事件循环卡住三分之一秒」，
 * 被卡期间所有 IPC 与窗口交互一起排队。改 execFile 后扫描在子进程完成、主进程只等回调。
 * 顺带收紧错误语义：原同步版在 tasklist 缺失/超时时会直接抛出并冒泡出 `getStatus()`，
 * 整个 `lilith:status` 变成一次失败调用；现在按「当前查不到该进程」处理（running=false），
 * 状态灯回落为未运行而不是报错。
 */
async function probeGameProc(): Promise<{ running: boolean; pid: number | undefined }> {
  const now = Date.now()
  if (_gameProcCache && now - _gameProcCache.at < GAME_PROC_CACHE_TTL) {
    return { running: _gameProcCache.running, pid: _gameProcCache.pid }
  }
  let running = false
  let pid: number | undefined
  if (process.platform === 'win32') {
    const out = await new Promise<string>((resolve) => {
      execFile(
        'tasklist',
        ['/FI', 'IMAGENAME eq Lilith.exe', '/FO', 'CSV', '/NH'],
        { encoding: 'utf8', timeout: TASKLIST_TIMEOUT_MS, windowsHide: true },
        // 出错/超时 → 空串：等价「当前查不到该进程」，不向调用方抛
        (err, stdout) => resolve(err ? '' : stdout)
      )
    })
    running = /"Lilith\.exe","\d+"/i.test(out)
    const m = out.match(/"Lilith\.exe","(\d+)"/i)
    if (m) pid = Number.parseInt(m[1], 10)
  }
  _gameProcCache = { running, pid, at: now }
  return { running, pid }
}

/** 游戏进程是否在运行（tasklist 查 Lilith.exe，5s 缓存；不阻塞主进程） */
export async function isGameRunning(): Promise<boolean> {
  return (await probeGameProc()).running
}

/** 获取游戏进程 PID（无则 undefined，5s 缓存） */
export async function getGamePid(): Promise<number | undefined> {
  return (await probeGameProc()).pid
}

/** companion 运行状态（读 %APPDATA%\LilithAI\runtime.json：月蚀适配器或真 companion 都会写） */
export function getCompanionStatus(appDataDir: string): { running: boolean; port?: number; pid?: number } {
  const runtimePath = join(appDataDir, 'LilithAI', 'runtime.json')
  if (!existsSync(runtimePath)) return { running: false }
  const rt = JSON.parse(readFileSync(runtimePath, 'utf-8')) as { port?: number; pid?: number }
  if (!rt?.port) return { running: false }
  let alive = true
  if (typeof rt.pid === 'number' && rt.pid > 0) {
    if (rt.pid === process.pid) {
      alive = false
    } else {
      try {
        process.kill(rt.pid, 0)
      } catch {
        alive = false
      }
    }
  }
  return { running: alive, port: rt.port, pid: rt.pid }
}

/** 完整状态（设置页状态灯用；async 因为进程探测走子进程，见 probeGameProc） */
export interface LilithStatus {
  gamePath: string
  gameExists: boolean
  modExists: boolean
  gameRunning: boolean
  gamePid?: number
  companionRunning: boolean
  companionPort?: number
  modValid: boolean
}

export async function getStatus(appDataDir: string): Promise<LilithStatus> {
  const detected = detectGame()
  // companion 状态只读一次：原实现为取 running / port 各调一次 getCompanionStatus，
  // 等于同一份 runtime.json 被读两遍、pid 存活探测也做两遍（状态灯 5s 轮询时纯浪费）。
  const companion = getCompanionStatus(appDataDir)
  // 两次调用共用 probeGameProc 的 5s 缓存：第二次必然命中，不会多跑一次 tasklist。
  const gameRunning = await isGameRunning()
  const gamePid = await getGamePid()
  return {
    gamePath: detected.found ? detected.dir : '',
    gameExists: detected.found,
    modExists: detected.hasMod,
    gameRunning,
    gamePid,
    companionRunning: companion.running,
    companionPort: companion.port,
    modValid: detected.hasMod
  }
}

/**
 * 反查 Steam AppID：由游戏目录反推 steamapps，读 appmanifest_*.acf 里 installdir 与游戏目录同名的那份。
 *
 * 为什么需要（这是「莉莉丝启动慢」的根因修复）：
 * 这游戏带 Steam DRM（Lilith_Data/Plugins/x86_64/steam_api64.dll），启动时 Steamworks.NET 会调
 * SteamAPI.RestartAppIfNecessary —— 一旦发现「不是由 Steam 拉起的」，就当场自杀并让 Steam 重开一份。
 * 于是直接 spawn exe 的后果是白白冷启动一轮 Unity 再丢掉（实测 2026-09-30：22:45:14 起的那份
 * 22:45:45 自杀，22:45:46 Steam 才拉起真正干活的那份，用户白等约 30 秒）。
 * 改由 steam://rungameid/<appid> 拉起，Steam 直接启动游戏，全程只启动一次。
 *
 * 返回 null 的三种情形，一律回落直接 spawn exe 的旧行为：
 * ① 目录不是 `<Steam 根>\steamapps\common\<installdir>` 形态（绿色版 / 自行复制的副本）；
 * ② 该 steamapps 下没有 installdir 与目录名一致的那份 manifest；
 * ③ manifest 不可读。
 * 注意 ② 的真实边界（2026-10-01 对本机两个 Steam 库实测）：本函数按「**目录名 == installdir**」
 * 精确匹配，实测莉莉丝命中（目录名与 installdir 同为 `The NOexistenceN of Lilith` → AppID 4643090），
 * 而 Wallpaper Engine 未命中（目录名 `Wallpaper Engine`、installdir 写作 `wallpaper_engine`）。
 * 这不是缺陷而是刻意保守：匹配不上就回落 launchDirect，不会拿另一个游戏的 AppID 去拉起；
 * 若要覆盖「下划线/空格差异」一类命名，须另开判定，不在本函数内放宽。
 * 不删理由：删掉它就只能猜 AppID 或写死，换一台机器/换一个游戏就失效。
 */
export function resolveSteamAppId(gameDir: string): string | null {
  if (!gameDir) return null
  // 期望形态：<Steam 根>\steamapps\common\<installdir>
  const steamapps = dirname(dirname(gameDir))
  if (basename(steamapps).toLowerCase() !== 'steamapps') return null
  if (!existsSync(steamapps)) return null
  const installdir = basename(gameDir).trim().toLowerCase()
  let entries: string[]
  try {
    entries = readdirSync(steamapps)
  } catch {
    return null
  }
  for (const name of entries) {
    if (!/^appmanifest_\d+\.acf$/i.test(name)) continue
    try {
      const raw = readFileSync(join(steamapps, name), 'utf8')
      const m = raw.match(/"installdir"\s+"([^"]*)"/i)
      if (m && m[1].trim().toLowerCase() === installdir) {
        const id = name.match(/(\d+)/)
        if (id) return id[1]
      }
    } catch {
      // 单个 manifest 读不动不影响其它候选，继续找
    }
  }
  return null
}

/**
 * 启动莉莉丝桌宠。
 * Steam 安装 → 交给 Steam 拉起（只启动一次）；否则 → 直接 spawn exe（旧行为）。
 */
export function launch(gameDir: string): Promise<{ ok: boolean; alreadyRunning?: boolean; error?: string }> {
  const appId = resolveSteamAppId(gameDir)
  if (appId) {
    // Steam 卸载/未安装客户端时 openExternal 会 reject —— 那时按旧路径直接起 exe（虽然会被 DRM 要求重启，
    // 但总比什么都不做好）。
    return shell
      .openExternal(`steam://rungameid/${appId}`)
      .then(() => ({ ok: true }))
      .catch(() => launchDirect(gameDir))
  }
  return launchDirect(gameDir)
}

/** 直接拉起 exe（非 Steam 副本，或 Steam 协议不可用时的兜底） */
async function launchDirect(
  gameDir: string
): Promise<{ ok: boolean; alreadyRunning?: boolean; error?: string }> {
  if (await isGameRunning()) {
    return { ok: true, alreadyRunning: true }
  }
  return new Promise((resolve) => {
    const exe = join(gameDir, GAME_EXE)
    if (!existsSync(exe)) {
      resolve({ ok: false, error: `Lilith.exe 不存在：${exe}` })
      return
    }
    if (!hasMod(gameDir)) {
      resolve({ ok: false, error: 'MOD 缺失（BepInEx/plugins/LilithMod.dll 或 companion 不存在），无法以桌宠模式启动' })
      return
    }
    try {
      // detached + 独立进程组：不随月蚀退出而退出，也不被 Steam 追踪
      const child = spawn(exe, [], {
        cwd: dirname(exe),
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      })
      child.unref()
      // spawn 的 ENOENT/EACCES 等错误是异步的（error 事件），
      // 直接 resolve({ok:true}) 会误报成功——监听 error 事件拒绝。
      child.once('error', (err) => {
        resolve({ ok: false, error: `启动失败: ${err.message}` })
      })
      resolve({ ok: true })
    } catch (err) {
      resolve({ ok: false, error: (err as Error).message })
    }
  })
}

/** 探测可执行文件是否存在（execFile 包装，供测试/诊断） */
export function executableExists(cmd: string): boolean {
  execFileSync(cmd, [], { timeout: 1000, windowsHide: true, stdio: 'ignore' })
  return true
}

/** 导出 execFile 供外部（保留引用避免 tree-shake） */
export const _execFile = execFile
