/**
 * @category 核心
 * @summary 主进程启动辅助函数：路径锚点、缓存清理、LLM 配置解析、MCP 元数据同步、应用重启
 */
import { app } from 'electron'
import { spawn, spawnSync } from 'child_process'
import { basename, join, dirname } from 'path'
import { existsSync, rmSync } from 'fs'
import type { McpClientManager } from './mcp/client-manager'
import { adaptMcpToolMeta } from './mcp/tool-adapter'
import { registerMcpToolMetas, unregisterAllMcpTools } from '@shared/tools/registry'
import { logError } from './services/crash-logger'
import type { LLMConfig } from '@shared/types'

/**
 * LLM 配置解析（前端/后端配置通用）：
 * followMain=true → 直接用前端 AI 配置（接入方式/模型/Key 全跟随，切换自动同步）；
 * 否则用本套独立配置（dmnLlm model 留空 = 不运行）。
 */
export function resolveLlmConfig(cfg: LLMConfig, main: LLMConfig, _implicitFallback = false): LLMConfig {
  if (cfg?.followMain) return main
  return cfg
}

/**
 * 同步 MCP 工具元数据到 shared registry

 * 全量同步策略：先清空所有 MCP 动态工具元数据，再从 mcpClientManager 获取
 * 所有已连接 server 的工具重新注册。保证 registry 始终反映 MCP 最新状态。
 */
export function syncMcpToolMetas(manager: McpClientManager): void {
  const allTools = manager.getAllTools()
  const metas = allTools.map(({ serverName, tool }) => adaptMcpToolMeta(serverName, tool))
  unregisterAllMcpTools()
  registerMcpToolMetas(metas)
}

/** 应用锚点目录：所有相对路径的解析基点（打包=exe 目录 / dev=app 目录）。
 * 与 userData 重定向一致——dev 用 __dirname（out/main → app 目录，app.getAppPath() 在 dev 下不可靠，
 * 实测返回工作区根），打包用 process.execPath。
 * 关键：NSIS portable 单文件运行时，进程解压到 %TEMP%\<UNPACK_DIR_NAME> 临时目录执行，
 * process.execPath 指向临时解压目录；electron-builder 会注入 PORTABLE_EXECUTABLE_DIR
 * （= 用户双击的 exe 所在目录）。若不识别该环境变量，dataDir（./data）会落在临时目录，
 * 退出即被 RMDir 清理造成数据丢失，因此打包场景优先取 PORTABLE_EXECUTABLE_DIR 作为锚点，
 * 保证数据落在 exe 旁、可随迁。 */
export function getAppAnchor(): string {
  if (app.isPackaged) {
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
    return portableDir ? portableDir : dirname(process.execPath)
  }
  return join(__dirname, '..', '..')
}

/**
 * 清理残留缓存目录，避免 Windows 下"拒绝访问 (0x5)"
 *
 * 包括 GPU 缓存（GPUCache/Dawn*）和网络服务缓存（Network/Cache/Shared Dictionary）。
 * 上次运行残留的锁定文件会导致 Chromium 沙箱无法设置 ACL 权限，
 * 报 network_sandbox.cc "Failed to grant sandbox access" 错误。
 */
export function cleanStaleCaches(userDataDir: string): void {
  const cacheDirs = [
    'GPUCache',
    'DawnGraphiteCache',
    'DawnWebGPUCache',
    'CodeCache',
    'Code Cache js',
    'Network',
    'Cache',
    'Shared Dictionary'
  ]
  for (const dir of cacheDirs) {
    const cachePath = join(userDataDir, dir)
    try {
      if (existsSync(cachePath)) {
        rmSync(cachePath, { recursive: true, force: true })
      }
    } catch (err) {
      // 清理是 best-effort：目录正被本进程/残留进程占用（EBUSY/EPERM）或文件缺失等
      // 一律跳过，绝不因缓存清理失败中断启动（否则主进程早期抛异常 → 应用打不开）
      logError('clean_stale_caches', `清理缓存目录失败，跳过: ${basename(cachePath)} - ${(err as Error)?.message ?? String(err)}`)
    }
  }
}

// dev 重启清理旧链：查询旧 dev 链 BAT 根 cmd 的 PID（命令行含 Dev.bat 的 cmd.exe）
// 实测：双击 启动-Dev.bat 由 explorer 直接拉起经典 conhost 窗口
// （explorer → cmd(BAT) → conhost + npm/node/electron 链），taskkill /T 从该 cmd 杀整树
// 会连带关闭 conhost 终端窗口；若用户改从 Windows Terminal 启动，杀 dev cmd 后
// Windows Terminal 的空 tab 会自动关窗，同样不残留。用 ASCII 子串 'Dev.bat' 匹配避免中文编码坑。
export function queryOldDevChainPids(): number[] {
  const script =
    "$cmds = @(Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -like '*Dev.bat*' }); " +
    '$cmds | ForEach-Object { $_.ProcessId }'
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    timeout: 8000,
    windowsHide: true
  })
  return (ps.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .map(Number)
}

// 统一重启入口：AI 自我重启（app_restart 工具）+ 渲染进程连续崩溃自动重启共用
// dev 模式（electron-vite）下 electron 是 npm 链的子进程，裸 app.relaunch() 拉起的新 electron
// 因 dev server 生命周期挂在 electron-vite 主进程上、旧链退出即死，应用起不来
// → dev 模式改走用户启动入口（启动-Dev.bat），重新拉起完整 dev 链；打包模式 relaunch 安全保持原逻辑
export function restartApp(reason: string): { ok: boolean; error?: string } {
  try {
    if (!app.isPackaged) {
      // dev 模式：BAT 在 app 目录（getAppAnchor() 基于 __dirname，app.getAppPath() 在 dev 下不可靠
      // 实测返回工作区根，join 出根目录的 BAT 不存在 → 降级 relaunch → 重启链路失效。跟随 app 目录。
      const batPath = join(getAppAnchor(), '启动-Dev.bat')
      if (existsSync(batPath)) {
        // 隐私：不输出 BAT 的绝对路径（本机开发目录），只记录走了 dev 重启通道
        logError('app_restart', `[dev] 重启走 BAT（${reason}）`)
        console.log(`[app_restart] [dev] 重启走 BAT（${reason}）`)
        // 新开 cmd 窗口执行 BAT（与用户手动双击行为一致），detached 脱离本进程生命周期
        // 注意：不要手动给参数加引号——Node spawn 会把参数内引号转义成 \"，而 cmd 不认这种转义，
        // 会把 \" 拆成 \ + "，导致路径首尾多反斜杠（实测报错「找不到文件 '\d:\...\bat\'」）
        // batPath 不含空格，Node 自动原样传递；start 第一个参数用空字符串占位窗口标题
        // 先查旧 dev 链 PID（必须在 spawn 新 BAT 之前查：新链命令行也含 Dev.bat，延迟查询会把新链误杀）
        const oldPids = queryOldDevChainPids()
        const child = spawn('cmd.exe', ['/c', 'start', '', batPath], {
          detached: true,
          stdio: 'ignore'
        })
        child.unref()
        // 再清旧 dev 链整树（BAT 根 cmd → npm/node/electron-vite/electron → WindowsTerminal 宿主），
        // 防止旧终端面板残留成孤魂窗口（实测旧链退出后 WindowsTerminal 不自动关窗口）
        // 注意：taskkill /T 会杀掉当前进程本身，后续 app.exit(0) 可能不执行——但新链已起、无副作用
        for (const pid of oldPids) {
          spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], {
            stdio: 'ignore',
            timeout: 5000,
            windowsHide: true
          })
        }
        // 立即退出当前进程：不依赖 before-quit 异步清理链（避免清理卡住导致旧进程不退、
        // dev server 端口不释放，新进程起不来）
        app.exit(0)
        return { ok: true }
      }
      logError('app_restart', `[dev] 启动 BAT 不存在 ${basename(batPath)}，降级 app.relaunch()`)
    }
    app.relaunch()
    app.exit(0)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `重启失败: ${(err as Error).message}` }
  }
}