/**
 * @category 核心
 * @summary 窗口图标解析：开发态各窗口统一使用 build/icon.ico
 * 为什么存在：打包态的图标由出包本机侧的后处理脚本经 rcedit 写进 LunarEclipse.exe 的资源段
 * （源文件同样是 build/icon.ico），所以双击启动的 exe 自带正确图标；而 `npm run dev` 跑的是
 * node_modules 里的 electron.exe —— 宿主二进制的图标不属于本工程、改不了，窗口若不再显式指定
 * icon，任务栏与 Alt-Tab 显示的就是 Electron 默认图标，与分发版观感不一致。
 * 作用：给出唯一的图标路径口径，四个窗口创建点（主窗口 / 安全模式窗口 / 面板窗口 / 悬浮聊天窗）共用。
 * 不删理由：删掉则开发态窗口图标回落 Electron 默认；若各窗口各自硬编码路径，一旦 build/ 位置调整
 * 就会各自漂移，且没有任何编译期保护能发现漂移。
 */
import { existsSync } from 'fs'
import { join } from 'path'

/**
 * 解析窗口图标（找不到返回 undefined，调用方直接把它当 icon 选项传入即可）。
 *
 * 为什么是「相对 __dirname 往上两级」：主进程全部模块由 electron-vite/rollup 打进单一产物
 * `out/main/index.js`（electron.vite.config.ts 的 main.build.rollupOptions.input 只声明了 index 一项），
 * 因此无论哪个主进程模块里取 __dirname 都是 `app/out/main`，`../../build/icon.ico` 即 `app/build/icon.ico`。
 *
 * 为什么打包态返回 undefined 是有意的：asar 包内不含 build/（electron-builder.config.cjs 的 files
 * 只有 out/**、public/**、package.json），找不到文件时返回 undefined，窗口不设 icon，系统自动沿用
 * exe 自身图标——这正是打包态想要的结果。故此处「找不到就静默返回 undefined」与 window.ts 里
 * preload 路径缺失必须抛错的处置不同：preload 缺失会让界面完全不可用，而图标缺失只是观感回落。
 */
export function resolveWindowIcon(): string | undefined {
  const iconPath = join(__dirname, '../../build/icon.ico')
  return existsSync(iconPath) ? iconPath : undefined
}
