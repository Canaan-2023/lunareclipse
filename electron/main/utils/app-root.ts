/**
 * @category 工具
 * @summary 应用锚点唯一真源：所有磁盘路径解析的基点
 *
 * 为什么存在：锚点此前定义在 `startup-helpers.ts`（该文件同时承载 LLM 配置解析、MCP 元数据同步、
 * 缓存清理、重启链），任何只想取锚点的模块都被迫 import 整条子图（mcp / registry / crash-logger）。
 * 锚点是零依赖的纯函数，独立成叶子模块后，「取锚点」不再拖入业务子图。
 *
 * 不删理由：所有相对路径解析（data/、userData、reports/、prompts 等）都以本模块为唯一起点，
 * 锚点漂移会同时破坏写入与读取两侧；`resolveBundledAsset` / `assertInsideAnchor` 的后续接入点
 * 也依赖此处（见 app/SPECS/ADR/ADR-10-app-root-anchor.md）。
 */
import { app } from 'electron'
import { dirname, join, resolve, sep } from 'path'
import { existsSync } from 'fs'

/**
 * 应用锚点目录：所有相对路径的解析基点（打包 = exe 目录 / dev = app 目录）。
 *
 * 与 userData 重定向一致——dev 用 `__dirname` 上溯（`app.getAppPath()` 在 dev 下实测不可靠，
 * 返回工作区根），打包用 `process.execPath`。
 *
 * 关键：NSIS portable 单文件运行时，进程解压到 `%TEMP%\<UNPACK_DIR_NAME>` 临时目录执行，
 * `process.execPath` 指向临时解压目录；electron-builder 会注入 `PORTABLE_EXECUTABLE_DIR`
 * （= 用户双击的 exe 所在目录）。若不识别该环境变量，`data/` 会落在临时目录、退出即被
 * RMDir 清理造成数据丢失，因此打包场景优先取 `PORTABLE_EXECUTABLE_DIR` 作为锚点。
 * 该变量要求目录**真实存在**才采用（否则回落 `dirname(process.execPath)`）：它是进程环境变量，
 * 会被父进程继承，污染时会把锚点静默重定向、`data/` 落错位置。
 *
 * dev 分支为什么不用固定层数的 `join(__dirname,'..','..')`：该写法把锚点**绑死在源文件深度**上。
 * 锚点迁到 `utils/` 后，未打包环境（vitest 按源码路径加载）下 `__dirname` 是模块自身目录，
 * 固定层数会算出 `electron/main` 而非 app 目录（实测：`code-review` 的 reports 根随之漂移，
 * `api-server` 的 /reports 用例由 403 变 404）。
 * 改为「自 `__dirname` 向上找到最近含 `package.json` 的目录」——打包运行态（单文件
 * `out/main/index.js`）与未打包测试态下都收敛到 app 目录，且不再随文件移动而失效。
 * 结果按进程缓存（锚点在一次运行内不变）。
 */
let cachedDevAnchor: string | null = null

export function getAppAnchor(): string {
  // 纯 Node 环境（vitest 单测、CLI 工具）下 `import { app } from 'electron'` 得到 undefined，
  // 直接读 `app.isPackaged` 会抛 "Cannot read properties of undefined"。
  // 用可选链兜底为「非打包」→ 走 dev 分支（与 health-check 的打包判定同一处理原则：
  // 该模块要被不 mock electron 的单测引用，必须保住纯 Node 语义）。
  // 实测触发场景：multi-instance-port.test.ts（经 code-review 的 reports 根间接调用）。
  if (app?.isPackaged) {
    // PORTABLE_EXECUTABLE_DIR 由便携运行器注入，指向用户双击的 exe 目录。
    // 但它是**进程环境变量**：若本进程被携带该变量的父进程拉起（另一 portable 实例 / 脚本 /
    // 快捷方式），锚点会被静默重定向，`data/` 落到错误目录（复审轮 SRE R2）。
    // 故要求该目录真实存在才采用；否则回落到打包态唯一可信的兜底 `dirname(process.execPath)`。
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
    if (portableDir && existsSync(portableDir)) return portableDir
    return dirname(process.execPath)
  }
  if (cachedDevAnchor) return cachedDevAnchor
  let dir = __dirname
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) {
      cachedDevAnchor = dir
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // 兜底：保持历史行为（out/main → app）
  cachedDevAnchor = join(__dirname, '..', '..')
  return cachedDevAnchor
}

/**
 * 写路径越界守卫：确认 `p` 落在应用锚点之内，返回规范化后的绝对路径；越界即抛错。
 *
 * 何时用：任何「写项目根」（数据目录、报告目录、生成产物）的调用点，在 mkdir / write 之前调用。
 * 它防的是 CODE-RULES §1.2 禁止清单第 5 条（`..` 上溯假定兄弟目录）与第 2 条（盘符绝对路径）
 * 造成的「写到锚点之外」——越界写入在分发后可能落到用户机器的任意位置。
 *
 * 判据：`p === anchor` 或 `p` 以 `anchor + 分隔符` 开头。路径先经 `resolve` 规范化，
 * 因此 `..` 折叠后再判定（`<anchor>/a/../../x` 会被判越界）。
 */
export function assertInsideAnchor(p: string): string {
  const anchor = resolve(getAppAnchor())
  const target = resolve(p)
  if (target === anchor || target.startsWith(anchor + sep)) return target
  throw new Error(`路径越界：${target} 不在应用锚点 ${anchor} 之内（写路径必须落在锚点内）`)
}

/**
 * 内置资产路径解析：`electron/main/<rel>`（dev）→ `resources/<rel>`（打包）双候选探测。
 *
 * 为什么存在：同一套「dev 在源码树 / 打包在 resources（extraResources 复制位）」形状在
 * 至少 4 处被各写一遍（prompts、plugins/bundled、skills/market-repo、prompts loader），
 * 新增内置资产时每处都要重新推导一次，任一处写错只在对应场景（多半是打包态）才暴露。
 * 本函数是这条形状的唯一实现（ADR-10 第 3 步）。
 *
 * 候选顺序（先 dev 后 packaged）：dev 候选由 `getAppAnchor()` 派生（dev=app 目录 / 打包=exe 目录，
 * 打包态下该候选天然不存在）→ 打包候选 `process.resourcesPath/<rel>`（纯 Node 下该属性为 undefined，
 * 自动跳过）。**顺序与原各站实现一致**（原 `isPackaged` 三元在打包态等价于「dev 候选不存在则取 resources」）。
 *
 * @param rel 相对 `electron/main/`（dev）与 `resources/`（打包）的资产相对路径，如 `'prompts'`、`'plugins/bundled'`。
 * @param opts.extraDevCandidates 额外 dev 候选（在默认 dev 候选之后、打包候选之前按序探测）——
 *   兼容历史上的多候选链（如 prompts loader 的 `__dirname` 相对候选 / `process.cwd()` 候选）。
 * @param opts.onMissing 全部候选都不存在时：`'throw'`（默认，列出候选显式报错）|
 *   `'dev'`（返回 dev 候选，保持调用方「拿到路径后自行 existsSync / 降级」的历史语义）。
 *   注意：该分支只在**全部候选都缺失**时生效（资产整体缺失 = 安装损坏），此时两种取值给出的是
 *   同一个「不可用路径」，差异仅在报错文案/后续判空方式。
 *
 * 不删理由：删掉即上述 4 处重新各自推导 dev/packaged 形状，新增资产时再次漂移。
 */
export interface BundledAssetOptions {
  extraDevCandidates?: string[]
  onMissing?: 'throw' | 'dev'
}

export function resolveBundledAsset(rel: string, opts: BundledAssetOptions = {}): string {
  const devCandidate = join(getAppAnchor(), 'electron', 'main', rel)
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  const candidates = [
    devCandidate,
    ...(opts.extraDevCandidates ?? []),
    ...(resourcesPath ? [join(resourcesPath, rel)] : [])
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  if (opts.onMissing === 'dev') return devCandidate
  throw new Error(`内置资产未找到：${rel}（候选：${candidates.join(' | ')}）`)
}
