/**
 * @category 核心
 * @summary 月蚀 CLI 常驻终端界面（TUI）入口：Ink/React 渲染 + WS 流式对话
 *
 * 区别于方案B无头 cli.ts（单次问答后退出），本入口启动一个常驻交互界面：
 * - 同一进程内复用 startApiServer 全链路（上下文组装 → LLM → 工具循环 → 持久化），
 *   不启动 Electron / 不创建 BrowserWindow（electron 由 esbuild alias 到 mock）；
 * - UI 通过 WS 客户端连本机 server（/ws?token=<apiToken>），复用前端同款
 *   token/reasoning/done/error 流式协议实时渲染，而非等最终文本；
 * - 会话历史与桌面版同源（同一 data 目录、同一 sessionStore），可续接、可切会话；
 * - stdout 归 Ink 渲染；模块日志一律转 stderr。
 *
 * 与桌面版并行注意事项：桌面版 API 端口默认 62002，CLI 使用随机端口，
 * 与桌面版并存不会端口冲突。
 */
import { existsSync, mkdirSync } from 'fs'
import { Writable } from 'stream'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { render } from 'ink'
import { jsx } from 'react/jsx-runtime'
import WebSocket from 'ws'

import { DEFAULT_AI_ID } from '@shared/types'

import { ConfigStore } from './api/config-store'
import { SessionStore } from './api/session-store'
import { UserStore } from './models/user-store'
import { ActivationManager } from './api/activation-manager'
import { buildDataPaths, resolveScopePaths } from './models/paths'
import { setPathContext } from './models/path-context'
import { setDefaultWorkspacePath } from './services/workspace-config'
import { setHooksUserDataDir, migrateLegacyGlobalHooks } from './hooks/config-loader'
import { startApiServer, closeApiServer, getMessagingService, getApiToken } from './api/server'
import { CliApp, type SessionHandle, type TuiWs } from './cli-tui/App'

interface CliArgs {
  session?: string
  aiId?: number
  configPath?: string
  dataDir?: string
  autopilot?: string
  help?: boolean
}

/** 轻量参数解析：--key value / --key=value / -缩写（与 cli.ts 同款） */
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
      case '--autopilot':
        args.autopilot = value ?? ''
        break
      case '--help': case '-h':
        args.help = true
        break
      default:
        console.error(`[cli-ui] 未知参数: ${raw}`)
        args.help = true
    }
  }
  return args
}

function printUsage(): void {
  process.stdout.write(`用法: node cli-ui.mjs [选项]
月蚀 CLI 终端界面（TUI）：常驻交互界面 + 流式对话，与桌面版共享会话与数据。

选项:
  -s, --session <id>    起始会话 ID（复用已有会话或创建），缺省新建 cli_<时间戳>
  -a, --ai-id <n>       AI 编号（默认 ${DEFAULT_AI_ID}=月蚀）
  -c, --config <path>   config.json 路径（默认 {app}/data/userdata/config.json）
  -d, --data-dir <dir>  数据根目录（默认 {app}/data，内部取 abyssac_data）
      --autopilot <msg> 自动发送一条消息后输出最终界面帧并退出（验证/脚本用）
  -h, --help            显示帮助

界面快捷键:
  Enter          发送消息
  ↑ / ↓          回填输入历史
  Esc            清空输入
  Ctrl-C         中止当前流；空闲时退出
  /new           新建会话
  /s <id>        切换会话
  /exit          退出

界面状态说明:
  顶部状态区在 AI 回复期间显示活动状态与转圈动画：
    思考中      推理内容到达时显示
    正在调用 xxx  工具执行过程透明可见（青色）
    正在生成    内容流式输出时显示
  消息区按类型着色：用户=绿色，AI=默认，思考/元信息=灰色斜体，
  工具调用=青色（✓ 已完成 / 正在调用…），错误=红色。

注意: 桌面版 API 端口默认 62002；CLI 使用独立随机端口，可与桌面版并存。
`)
}

/** CLI 运行锚点：bundle 到 out/cli/ 时，__dirname 上溯两级 = app 目录（与 cli.ts 一致） */
function cliAnchor(): string {
  const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)))
  return resolve(__dirname, '..', '..')
}

/**
 * TUI 收尾（退出路径统一走这里）：先 unmount Ink（恢复终端光标/清屏），
 * 再按无头 CLI 同款顺序释放：sessionStore.flush() → closeApiServer() →
 * getMessagingService()?.stop() → 强制退出（否则飞书长连接 hold 事件循环）。
 */
async function shutdown(code: number, sessionStore: SessionStore | null): Promise<void> {
  try {
    sessionStore?.flush()
  } catch (err) {
    console.error(`[cli-ui] 会话同步落盘失败: ${(err as Error).message}`)
  }
  try {
    closeApiServer()
  } catch {
    /* ignore */
  }
  try {
    getMessagingService()?.stop()
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 50))
  process.stdout.write('', () => process.exit(code))
}

async function main(): Promise<number> {
  // TUI 契约：stdout 归 Ink 渲染（终端界面帧）；模块日志一律转 stderr，避免污染界面
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
    console.error(`[cli-ui] config.json 不存在: ${configPath}`)
    console.error('[cli-ui] 请先运行主程序完成配置，或用 -c 指定 config 路径。')
    return 1
  }

  // 全局路径锚定（与 cli.ts / index.ts initRuntime 一致）
  setDefaultWorkspacePath(anchor)
  // 0.53 一次性迁移：旧位置 {anchor}/.lunareclipse/hooks.json → 新位置 {userData}/hooks.json
  // CLI 与 default 实例共享 data/userdata，故与桌面版执行同一迁移（具名实例不适用；旧文件不存在/新文件已存在时跳过）
  migrateLegacyGlobalHooks(anchor, userDataDir)
  setHooksUserDataDir(userDataDir)

  const configStore = new ConfigStore(configPath)
  const dataPaths = buildDataPaths(dataDir)

  const userStore = new UserStore(dataPaths.usersJson)
  const currentUser = userStore.getCurrentUser()
  if (!currentUser) {
    console.error('[cli-ui] 未检测到登录用户（users.json 无 last_login_uid）。')
    console.error('[cli-ui] 请在主程序中先登录一次，再使用 CLI。')
    return 1
  }
  const uid = currentUser.UID

  mkdirSync(userDataDir, { recursive: true })
  const sessionStore = new SessionStore(join(userDataDir, 'sessions'))
  const scoped = resolveScopePaths(dataPaths, { uid, aiId: DEFAULT_AI_ID })
  await sessionStore.switchUser(scoped.sessions)

  setPathContext(dataPaths.root, () => userStore.getCurrentUser()?.UID ?? null, () => DEFAULT_AI_ID)

  const activationManager = new ActivationManager(join(dataPaths.root, '.activation'))
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
    0 // preferredPort=0 → 随机端口意图
  )

  const aiId = args.aiId && Number.isInteger(args.aiId) && args.aiId >= 1 ? args.aiId : DEFAULT_AI_ID
  const freshSessionId = () => `cli_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  const handleNewSession = (): SessionHandle => {
    const id = freshSessionId()
    const s = sessionStore.getOrCreate(id, undefined, aiId)
    return { id, messages: s.messages ?? [] }
  }
  const handleSwitchSession = (id: string): SessionHandle | null => {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null
    try {
      const s = sessionStore.getOrCreate(id, undefined, aiId)
      return { id, messages: s.messages ?? [] }
    } catch {
      return null
    }
  }

  const session = sessionStore.getOrCreate(args.session ?? freshSessionId(), undefined, aiId)
  console.error(`[cli-ui] server=localhost:${port} session=${session.id} ai=${aiId} data=${dataDir}`)

  const token = getApiToken()
  const wsUrl = `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`
  const ws = new WebSocket(wsUrl)

  /**
   * autopilot（非 tty 自动化）模式专用渲染 stdout：
   * Ink 的 render() 在挂载/卸载时会向传入的 stdout 写帧；传入真实 process.stdout 会
   * 与 onAutopilotDone 显式写出的最终帧重复。这里用只保留 columns/rows 布局信息的
   * 静默流接住 Ink 内部帧，最终帧统一由 onAutopilotDone 显式写出（stdout 只此一帧）。
   */
  const silentStdout = (() => {
    const s = new Writable({
      write: (_chunk, _enc, cb) => {
        cb()
      }
    }) as NodeJS.WriteStream & { columns: number; rows: number }
    s.columns = 100
    s.rows = 24
    return s
  })()

  let unmountFn: (() => void) | null = null
  // CLI 入口本身是 .ts：JSX 需要 .tsx 才能被 esbuild 解析，这里用 react/jsx-runtime 显式创建元素
  // patchConsole:false —— 关闭 Ink 对 console 的劫持，避免 llm/logInfo 日志被改道写进 stdout 污染帧；
  // 本入口已自行把 console.log/info 重定向到 stderr。
  const app = render(
    jsx(CliApp, {
      ws: ws as unknown as TuiWs,
      initialSessionId: session.id,
      initialMessages: session.messages ?? [],
      port,
      autopilot: args.autopilot,
      onAutopilotDone: (frame: string) => {
        // autopilot：主回复完成后把最终界面帧输出到 stdout（验证/展示用），然后干净退出
        console.error('[cli-ui] autopilot 完成，输出界面帧')
        process.stdout.write(frame + '\n')
        unmountFn?.()
        void shutdown(0, sessionStore)
      },
      onExit: (code: number) => {
        unmountFn?.()
        void shutdown(code, sessionStore)
      },
      newSession: handleNewSession,
      switchSession: handleSwitchSession
    }),
    { patchConsole: false, stdout: args.autopilot != null ? silentStdout : undefined }
  )
  unmountFn = app.unmount

  // 常驻：进程由用户退出（Ctrl-C / /exit）或 onExit 收尾，这里不返回
  return new Promise<number>(() => {
    /* never resolve */
  })
}

void main()
  .then((code) => {
    process.stdout.write('', () => process.exit(code))
  })
  .catch((err) => {
    console.error(`[cli-ui] 致命错误: ${(err as Error).message}`)
    process.stdout.write('', () => process.exit(1))
  })