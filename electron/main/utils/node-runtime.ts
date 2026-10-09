/**
 * Node 运行时定位（主进程共用）。

 * 背景：机器可能没有全局 node/npm——开发机自备 `.tools/node.exe`（开发专用、不入库），
 * 但不进系统 PATH。主进程 exec 出的子进程继承系统 PATH，裸调 `node` 会 ENOENT。
 * 这曾导致 health-check 报 'npm' is not recognized，也让用户自定义 command Hook
 * 直接失败（连续 5 次 error 后 hooks 被自动禁用）。

 * 打包分发（0.45 起改为垫片，不再随包分发 node.exe）：
 * - 0.45 之前 electron-builder 把 `.tools/node.exe` 复制到 `resources/tools/node.exe`，
 * 未压缩 88.26 MB / 压缩交付 20.28 MB。
 * - 但 Electron 主程序本身自带同一大版本的 Node——设 ELECTRON_RUN_AS_NODE=1 即以纯
 * Node 模式运行（实测 node 24.21.0，`.tools/node.exe` 是 24.18.0），包内两份 Node
 * 属纯冗余。两组 portable 实测：含 node.exe 114.89 MB / 不含 94.61 MB。
 * - 0.45 起改为随包分发 `resources/tools/node.cmd` 垫片（约 2 KB），垫片设
 * ELECTRON_RUN_AS_NODE=1 后调用同级安装目录的 LunarEclipse.exe。实测退出码
 * （0/1/2，hook 的 continue/error/block 语义依赖）与 stdin/stdout/stderr 均原样继承。
 * - 垫片必须 ASCII-only：cmd.exe 按 OEM 代码页解析批处理，UTF-8 中文注释会被当成
 * 命令执行（已实测复现：满屏 'is not recognized'、退出码 255）。这也是为什么垫片
 * 里的说明用英文，中文来龙去脉留在这里。
 * - 垫片里的 SETLOCAL 是硬约束：ELECTRON_RUN_AS_NODE 绝不能泄漏回主进程，否则
 * instance.ts 的多实例自启 spawn(process.execPath) 会以 Node 模式起来而不是 GUI。
 */
import { existsSync } from 'fs'
import { delimiter, dirname, join } from 'path'

/**
 * 定位 Node 可执行文件。
 * 与启动-Dev.bat 同思路：优先打包自带运行时，其次项目自备 .tools\node.exe，
 * 最后回退 PATH 里的 node（有全局安装的机器仍然能用）。

 * @param workDir 工作区目录（主进程传 app.getAppPath()）
 * @returns 打包态返回 `resources/tools/node.cmd` 垫片路径（是批处理，调用方不能
 * 直接 execFile，须经 resolveExternalCommand 或 shell 解析）；开发态返回
 * `.tools\node.exe`；都没有时返回字面量 'node'（依赖系统 PATH）
 */
export function resolveNodeExe(workDir: string): string {
  // 优先级 1：打包自带的 node 垫片（extraResources: electron/main/runtime-shim
  // → resources/tools/node.cmd）。process.resourcesPath 只在 Electron 主进程存在，
  // vitest 纯 Node 环境下为 undefined，跳过。
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  if (resourcesPath) {
    const shim = join(resourcesPath, 'tools', 'node.cmd')
    if (existsSync(shim)) return shim
  }
  // 优先级 2：项目自备运行时（开发专用、不入库，typecheck/test 与 dev 同源）
  const local = join(workDir, '.tools', 'node.exe')
  if (existsSync(local)) return local
  // 优先级 3：PATH（全局安装环境）
  return 'node'
}

/**
 * 把自备 Node 所在目录并入 process.env.PATH（幂等）。
 *
 * 子进程默认继承 process.env，因此启动时调用一次即可让 HookExecutor、run_command
 * 等所有后续子进程都能解析到 node，无需各自重复处理。
 * 打包态并入的是垫片目录，`node` 经 PATHEXT 解析到 node.cmd（cmd.exe 自动经
 * cmd.exe /d /s /c 执行，见 utils/external-command.ts）。
 *
 * @returns 解析到的 node 路径；返回 'node' 时表示未找到自备运行时（未改动 PATH）
 */
export function ensureNodeOnPath(workDir: string): string {
  const node = resolveNodeExe(workDir)
  if (node === 'node') return node
  const nodeDir = dirname(node)
  const current = process.env.PATH ?? ''
  const parts = current.split(delimiter)
  if (!parts.includes(nodeDir)) {
    process.env.PATH = current ? `${nodeDir}${delimiter}${current}` : nodeDir
  }
  return node
}
