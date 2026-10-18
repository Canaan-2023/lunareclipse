/**
 * CLI（纯 Node）electron 模块替身。
 *
 * 用途：方案B CLI 在纯 Node 进程复用 startApiServer / getHeadlessChatRunner 全链路，
 * 但 server.ts 传递依赖链（browser-view-manager / system-input / system-position / startup-helpers 等）
 * 顶层 `import { ... } from 'electron'` 在 Node 下无法解析。本文件是 esbuild alias 的着陆点：
 * 构建 CLI 时把 `electron` 解析到本文件，模块加载即可通过。
 *
 * 边界：CLI 只跑 headless 问答，不创建窗口、不操作真实桌面、不截屏，
 * 这些 electron API 全部惰性调用（在工具方法内），因此本替身只需保证：
 *   1. 命名导出齐全（模块加载不抛错）
 *   2. 基础字段/方法返回安全默认值（模块顶层恰好触碰时不崩）
 * 不实现真实 BrowserWindow 等语义。
 */

function noop(): void {
  /* 替身占位 */
}

function defaultObj(): Record<string, unknown> {
  return {}
}

/**
 * 替身值：可调用函数 + 可挂任意属性的全能 Proxy（electron API 形状无法静态穷举，
 * 运行时惰性返回安全默认值，见文件头「边界」说明）。
 */
interface StubValue extends CallableFunction {
  [key: string]: unknown
  [key: symbol]: unknown
}

/** 可调用函数 + 可挂载属性的全能替身对象 */
function stub(): StubValue {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return undefined
      if (prop === Symbol.toStringTag) return 'electron-stub'
      if (prop === 'length') return 0
      if (prop === 'name') return 'electronStub'
      return stub()
    },
    apply() {
      return stub()
    },
    construct() {
      return stub()
    }
  }) as unknown as StubValue
}

/** 类替身：可 new、可静态调用、实例可挂任意属性 */
function stubClass(): StubValue {
  return new Proxy(
    class {
      constructor(..._args: unknown[]) {
        /* 替身 */
      }
    },
    {
      get(t, prop) {
        if (prop === 'then') return undefined
        if (prop in t) return (t as unknown as Record<string | symbol, unknown>)[prop]
        return stub()
      },
      apply() {
        return stub()
      }
    }
  ) as unknown as StubValue
}

/** 事件发射器形态：on/once/off/addListener/removeListener 合理默认 */
function makeEmitter(): { on: (...a: unknown[]) => unknown; once: (...a: unknown[]) => unknown; off: (...a: unknown[]) => unknown; removeAllListeners: () => void } {
  return {
    on: () => stub(),
    once: () => stub(),
    off: () => stub(),
    removeAllListeners: noop
  }
}

/** app 替身：isPackaged 必须为 false（startup-helpers getAppAnchor 走 dev 分支，返回 __dirname 上溯两级 = app 目录） */
const app = {
  ...makeEmitter(),
  isPackaged: false,
  getPath: (_name: string) => stub(),
  setPath: noop,
  getAppPath: () => stub(),
  getVersion: () => '0.0.0',
  exit: noop,
  relaunch: noop,
  quit: noop,
  whenReady: () => Promise.resolve(),
  on: () => stub(),
  once: () => stub()
}

/** screen 替身：getPrimaryDisplay 是浏览器管理里常见惰性调用，给安全默认 */
const screen = {
  getPrimaryDisplay: () => ({
    id: 0,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1,
    rotation: 0,
    internal: false,
    touchSupport: 'unknown',
    monochrome: false,
    accelerometerSupport: 'unknown',
    colorSpace: 'srgb',
    depthPerComponent: 8,
    displayFrequency: 60,
    label: 'mock-display'
  }),
  getAllDisplays: () => [{ id: 0, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }],
  on: () => stub(),
  off: () => stub()
}

/** session 替身（browser-view-manager 的 EXTERNAL_WEB_PARTITION 查询等惰性调用） */
const session = {
  fromPartition: () => stubObj(),
  defaultSession: stubObj(),
  on: () => stub(),
  off: () => stub()
}

function stubObj(): Record<string | symbol, StubValue> {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return undefined
        return stub()
      }
    }
  ) as unknown as Record<string | symbol, StubValue>
}

/** 简洁导出集合：覆盖全仓 electron 命名导入清单 */
export const BrowserWindow = stubClass()
export const WebContentsView = stubClass()
export { app }
export const clipboard = stubObj()
export const crashReporter = { start: noop, getLastCrashReport: () => null, getUploadedReports: () => [] }
export const desktopCapturer = { getSources: async () => [] }
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 0, checkboxChecked: false }) }
export const ipcMain = makeEmitter()
export const nativeImage = stubClass()
export const nativeTheme = { themeSource: 'dark', shouldUseDarkColors: true, on: () => stub() }
export const protocol = { registerFileProtocol: noop, registerSchemesAsPrivileged: noop, handle: noop }
export { screen }
export { session }
export const shell = { openExternal: async () => {}, openPath: async () => '', showItemInFolder: noop, trashItem: async () => {} }
export default defaultObj()