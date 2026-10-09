/**
 * @category 核心
 * @summary 主窗口管理：BrowserWindow 创建、渲染进程加载与崩溃恢复
 * 为什么存在：主进程必须持有唯一的 BrowserWindow 生命周期入口——窗口创建时机、
 * 渲染进程加载路径（preload 桥）、崩溃自动重建都在这里统一定义；
 * 无本模块则各调用点各自 new BrowserWindow，窗口状态/崩溃恢复行为失控，且外链协议
 * 校验（isSafeExternalUrl）缺少单一权威实现，渲染进程可借 AI 可控内容触发系统程序。
 */
import { BrowserWindow, shell, screen } from 'electron'
import { basename, join } from 'path'
import { existsSync } from 'fs'
// 窗口图标：开发态（npm run dev 跑的是 electron.exe，宿主图标改不了）必须显式指定，
// 否则任务栏显示 Electron 默认图标；打包态该函数返回 undefined，系统自动沿用 exe 内嵌图标。
import { resolveWindowIcon } from './app-icon'

// 外链协议白名单：window.open / target=_blank 只允许网页与邮件协议打开系统浏览器，
// 其余协议（file://、ms-settings:、自定义 scheme 等）一律拒绝——任意放行会让 AI 可控的
// 链接内容触发系统程序，这是 Electron 官方安全清单明令的越权路径，此白名单不可删。
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** 校验外链是否可安全交给系统浏览器打开（协议白名单 + URL 可解析） */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)
  } catch {
    return false
  }
}

export function createWindow(): BrowserWindow {
  // electron-vite 输出 preload 为 .mjs，兜底 .js；找不到时必须抛错而不是静默无桥运行，
  // 否则渲染进程 window.lunareclipse 缺失 → 整个界面不可用却无报错（曾因此排查数小时）
  const preloadCandidates = [
    join(__dirname, '../preload/index.mjs'),
    join(__dirname, '../preload/index.js')
  ]
  const found = preloadCandidates.find((p) => existsSync(p))
  if (!found) throw new Error('preload script not found in candidates: ' + preloadCandidates.join(', '))
  const preloadPath = found

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    transparent: false,
    icon: resolveWindowIcon(),
    backgroundColor: '#1A1816',
    titleBarStyle: 'hidden',
    roundedCorners: true,
    webPreferences: {
      preload: preloadPath,
      // 关沙箱的真实原因：工程 package.json 是 "type": "module"，electron-vite 把
      // preload 输出为 ESM（out/preload/index.mjs，即上方候选首个），而 Electron 的
      // 沙箱化 preload 只支持 CommonJS、不能以 ESM 加载；因此必须 sandbox: false 才能
      // 加载 .mjs 桥。配合 contextIsolation: true + nodeIntegration: false 保持安全边界。
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 修复：切窗时主窗口被遮挡 → Chromium 后台节流渲染进程
      // （定时器限频 1s、rAF 停止）→ 流式输出冻结。
      backgroundThrottling: false
      // 硬件加速已恢复（index.ts GPU 策略），主窗口 webgl 保持默认（true）
    }
  })

  win.on('ready-to-show', () => {
    win.show()
  })

  // Windows frameless 最大化溢出修复：
  // frame: false 窗口最大化时，系统保留 ~8px 隐形边框导致窗口超出屏幕边界。
  // 在 maximize 事件中约束到当前显示器工作区。
  if (process.platform === 'win32') {
    win.on('maximize', () => {
      const display = screen.getDisplayMatching(win.getBounds())
      const { x, y, width, height } = display.workArea
      win.setBounds({ x, y, width, height })
    })
  }

  // 转发渲染进程 console 日志到 main 进程 stdout，方便 dev 调试
  // 用新式 details 对象签名（Electron 32+ 起旧式 (level, message, line, sourceId) 参数弃用，
  // Electron 44 中若继续按数组下标映射 level 会错乱：旧 level=3(error) 越界取到 undefined → 标成 LOG）
  win.webContents.on('console-message', (details) => {
    const tag = typeof details.level === 'string' ? details.level.toUpperCase() : 'LOG'
    const loc = details.sourceId ? ` (${basename(details.sourceId).split('?')[0]}:${details.lineNumber})` : ''
    console.log(`[renderer:${tag}] ${details.message}${loc}`)
  })

  // window.open / target=_blank 外链统一转系统浏览器，但必须先过协议白名单：
  // AI 生成的回复内容可能含 file://、ms-settings:、自定义协议等链接，
  // 若直接 openExternal 会触发系统程序（资源管理器/设置页），是 Electron 安全清单明令的越权路径。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url)
    } else {
      console.warn(`[window] 已拦截非白名单协议的外链打开请求: ${url.slice(0, 200)}`)
    }
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}
