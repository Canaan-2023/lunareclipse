/**
 * @category 核心
 * @summary 方案B CLI：纯 Node 复用处蚀后端核心的无头问答入口
 *
 * 目标：不启动 Electron / 不创建 BrowserWindow，在纯 Node 进程中复用
 * startApiServer 全链路（上下文组装 → LLM → 工具循环 → 持久化），经
 * getHeadlessChatRunner 完成单次问答后输出最终回复文本并退出。
 *
 * 装配依据：
 * - api-server.test.ts 的纯 Node 装配模板（setPathContext + ConfigStore +
 *   SessionStore + UserStore 登录 + ActivationManager + buildDataPaths +
 *   startApiServer 空 toolCtx）。
 * - index.ts 启动编排原子 ①/⑩：userData 重定向到 {anchor}/data/userdata，
 *   sessions 初始化到 {userData}/sessions 后 switchUser 到
 *   {root}/sessions/U{uid}/AI{aiId}。
 * - electron 模块由 esbuild alias 解析到 cli-electron-mock.ts（纯 Node 无 electron）。
 *
 * 安全约束：只输出最终回复文本；配置中的 apiKey 等敏感信息一律不打印。
 */

import { existsSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { createInterface } from 'readline'

import { DEFAULT_AI_ID } from '@shared/types'

import { ConfigStore } from './api/config-store'
import { SessionStore } from './api/session-store'
import { UserStore } from './models/user-store'
import { ActivationManager } from './api/activation-manager'
import { buildDataPaths, resolveScopePaths } from './models/paths'
import { setPathContext } from './models/path-context'
import { setDefaultWorkspacePath } from './services/workspace-config'
import { setHooksUserDataDir, migrateLegacyGlobalHooks } from './hooks/config-loader'
import { startApiServer, closeApiServer, getHeadlessChatRunner, getMessagingService } from './api/server'

interface CliArgs {
  prompt?: string
  session?: string
  aiId?: number
  configPath?: string
  dataDir?: string
  help?: boolean
}

/** 轻量参数解析：--key value / --key=value / -缩写 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {}
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    let key = raw
    let value: string | undefined
    const eq = raw.indexOf('=')
    if (raw.startsWith('--') && eq > 0) {
      key = raw.slice(0, eq)
      value = raw.slice(eq + 1)
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
      value = argv[++i]
    }
    switch (key) {
      case '--prompt': case '-p':
        args.prompt = value ?? ''
        break
      case '--session': case '-s':
        args.session = value
        break
      case '--ai-id': case '-a':
        args.aiId = value ? Number(value) : undefined
        break
      case '--config': case '-c':
        args.configPath = value
        break
      case '--data-dir': case '-d':
        args.dataDir = value
        break
      case '--help': case '-h':
        args.help = true
        break
      default:
        console.error(`[cli] 未知参数: ${raw}`)
        args.help = true
    }
  }
  return args
}

function printUsage(): void {
  process.stdout.write(`用法: node cli.mjs [选项]
方案B CLI：在纯 Node 进程中复用月蚀后端核心（startApiServer + headless 问答），不启动 Electron 窗口。

选项:
  -p, --prompt <文本>   问题文本；缺省时从 stdin 读取
  -s, --session <id>    会话 ID（复用已有会话或创建），缺省新建 cli_<时间戳>
  -a, --ai-id <n>       AI 编号（默认 ${DEFAULT_AI_ID}=月蚀）
  -c, --config <path>   config.json 路径（默认 {app}/data/userdata/config.json）
  -d, --data-dir <dir>  数据根目录（默认 {app}/data，内部取 abyssac_data）
  -h, --help            显示帮助

示例:
  node cli.mjs -p "今天做了什么"                          # 新建会话单次问答
  node cli.mjs -s s_1792067703845_4mc18f -p "继续"        # 续接某会话
  echo "你好" | node cli.mjs                              # 从 stdin 读取问题
`)
}

/** CLI 运行锚点：bundle 到 out/cli/cli.mjs 时，__dirname 上溯两级 = app 目录（与 out/main 行为一致） */
function cliAnchor(): string {
  const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)))
  return resolve(__dirname, '..', '..')
}

async function readStdin(): Promise<string> {
  return new Promise((resolvePromise) => {
    const rl = createInterface({ input: process.stdin })
    const lines: string[] = []
    rl.on('line', (l) => lines.push(l))
    rl.on('close', () => resolvePromise(lines.join('\n').trim()))
  })
}

/**
 * CLI 收尾（server 已启动后的所有退出路径统一走这里）：
 * 1. sessionStore.flush() 同步补写会话——saveMessages 是 300ms 去抖异步写，
 *    直接 process.exit 会截断写盘导致会话 JSON 丢失（raw_memory 同步写不受影响）；
 * 2. closeApiServer() 释放 HTTP/WS 端口；
 * 3. getMessagingService()?.stop() 停止飞书长连接——closeApiServer 不关它，
 *    它持有的 WSClient 会让进程挂起不退出；
 * 4. 给异步写盘/关闭回调一个事件循环机会后，flush stdout 并强制退出。
 */
async function shutdown(code: number, sessionStore: SessionStore | null): Promise<void> {
  try {
    sessionStore?.flush()
  } catch (err) {
    console.error(`[cli] 会话同步落盘失败: ${(err as Error).message}`)
  }
  try {
    closeApiServer()
  } catch {
    /* 忽略 */
  }
  try {
    getMessagingService()?.stop()
  } catch {
    /* 忽略 */
  }
  await new Promise((r) => setTimeout(r, 50))
  process.stdout.write('', () => process.exit(code))
}

async function main(): Promise<number> {
  // CLI 契约：stdout 只承载最终答案（供管道/脚本消费），模块日志一律转 stderr
  console.log = (...args: unknown[]) => console.error(...args)
  console.info = (...args: unknown[]) => console.error(...args)

  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printUsage()
    return 0
  }

  const anchor = cliAnchor()
  const dataDir = args.dataDir ? resolve(anchor, args.dataDir) : resolve(anchor, 'data')
  const userDataDir = join(dataDir, 'userdata')
  const configPath = args.configPath ? resolve(anchor, args.configPath) : join(userDataDir, 'config.json')

  if (!existsSync(configPath)) {
    console.error(`[cli] config.json 不存在: ${configPath}`)
    console.error('[cli] 请先运行主程序完成配置，或用 -c 指定 config 路径。')
    return 1
  }

  // 全局路径锚定（与 index.ts initRuntime 一致：默认工作区随项目走，hooks 配置随 userData 收纳）
  setDefaultWorkspacePath(anchor)
  // 0.53 一次性迁移：旧位置 {anchor}/.lunareclipse/hooks.json → 新位置 {userData}/hooks.json
  // CLI 与 default 实例共享 data/userdata，故与桌面版执行同一迁移（具名实例不适用；旧文件不存在/新文件已存在时跳过）
  migrateLegacyGlobalHooks(anchor, userDataDir)
  setHooksUserDataDir(userDataDir)

  const configStore = new ConfigStore(configPath)
  const dataPaths = buildDataPaths(dataDir)

  // 路径上下文：技能/config 按 U{uid}/AI{aiId} 分层；uid 来自 UserStore 恢复的登录态
  const userStore = new UserStore(dataPaths.usersJson)
  const currentUser = userStore.getCurrentUser()
  if (!currentUser) {
    console.error('[cli] 未检测到登录用户（users.json 无 last_login_uid）。')
    console.error('[cli] 请在主程序中先登录一次，再使用 CLI。')
    return 1
  }
  const uid = currentUser.UID

  // 会话存储：初始化到 {userData}/sessions，再 switchUser 到 {root}/sessions/U{uid}/AI{aiId}
  mkdirSync(userDataDir, { recursive: true })
  const sessionStore = new SessionStore(join(userDataDir, 'sessions'))
  const scoped = resolveScopePaths(dataPaths, { uid, aiId: DEFAULT_AI_ID })
  await sessionStore.switchUser(scoped.sessions)

  setPathContext(dataPaths.root, () => userStore.getCurrentUser()?.UID ?? null, () => DEFAULT_AI_ID)

  const activationManager = new ActivationManager(join(dataPaths.root, '.activation'))

  // 空 toolCtx：geoService / cron / monitor 全部跳过（与测试模板一致，纯问答不触外设）
  const port = await startApiServer(
    configStore,
    sessionStore,
    userStore,
    activationManager,
    {},
    dataPaths,
    undefined, // mcpClientManager
    undefined, // pluginLoader
    undefined, // ctx
    undefined, // sharedInternalSessionStore
    undefined, // masterRouter
    undefined, // getMasterRouter
    0 // preferredPort=0 → 随机端口，避免占用 62002 与主进程冲突
  )

  const runner = getHeadlessChatRunner()
  if (!runner) {
    console.error('[cli] headless 问答器不可用（startApiServer 未装配完成）。')
    await shutdown(1, sessionStore)
    return 1
  }

  const prompt = args.prompt ?? (await readStdin())
  if (!prompt) {
    console.error('[cli] 问题为空：请用 -p 传入或通过 stdin 提供。')
    await shutdown(1, sessionStore)
    return 1
  }

  const sessionId = args.session ?? `cli_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const aiId = args.aiId && Number.isInteger(args.aiId) && args.aiId >= 1 ? args.aiId : DEFAULT_AI_ID

  console.error(`[cli] server=localhost:${port} session=${sessionId} ai=${aiId} data=${dataDir}`)
  try {
    const output = await runner(prompt, sessionId, aiId, 'cli')
    // stdout 只写答案（console.log 已被重定向到 stderr）
    process.stdout.write(`${output}\n`)
    await shutdown(0, sessionStore)
    return 0
  } catch (err) {
    console.error(`[cli] 问答失败: ${(err as Error).message}`)
    await shutdown(1, sessionStore)
    return 1
  }
}

main()
  .then((code) => {
    // 强制退出：closeApiServer 不关闭消息长连接等句柄，避免 CLI 结束后进程挂起
    process.stdout.write('', () => process.exit(code))
  })
  .catch((err) => {
    console.error(`[cli] 致命错误: ${(err as Error).message}`)
    process.stdout.write('', () => process.exit(1))
  })