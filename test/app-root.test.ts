/**
 * app-root 单测（ADR-10）：锚点三分支 + 写路径越界守卫。
 *
 * 为什么存在：锚点是所有磁盘路径解析的单点——`data/`、userData、`reports/` 的落位都由它决定。
 * 其中最危险的分支是 **NSIS portable**：进程解压到 `%TEMP%` 执行，若不识别
 * `PORTABLE_EXECUTABLE_DIR`，`data/` 会落在临时目录、退出即被清理造成数据丢失。
 * 本用例把三个分支的选择逻辑与守卫边界固定下来（ADR-10 风险 2 的回归网）。
 *
 * 锚点目录必须**真实存在**：`PORTABLE_EXECUTABLE_DIR` 是进程环境变量，被父进程污染时会
 * 把锚点静默重定向（复审轮 SRE R2），故实现要求该目录真实存在才采用。用例按 R-T2
 * 用 `mkdtempSync` 造真实目录并自清理，不再使用不存在的合成盘符。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { dirname, join } from 'path'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

const appState = vi.hoisted(() => ({ isPackaged: false }))
vi.mock('electron', () => ({ app: appState }))

const { getAppAnchor, assertInsideAnchor, resolveBundledAsset } = await import(
  '../electron/main/utils/app-root'
)

const ORIGINAL_EXEC_PATH = process.execPath

/** 真实存在的临时锚点目录（R-T2：真实 FS 一律 mkdtemp + 自清理） */
let anchorDir: string

beforeEach(() => {
  anchorDir = mkdtempSync(join(tmpdir(), 'le-anchor-'))
})

afterEach(() => {
  appState.isPackaged = false
  delete process.env.PORTABLE_EXECUTABLE_DIR
  rmSync(anchorDir, { recursive: true, force: true })
})

describe('getAppAnchor：三分支选择', () => {
  it('打包 + PORTABLE_EXECUTABLE_DIR（真实存在）→ 取该目录（防 data/ 落 %TEMP% 被清理）', () => {
    appState.isPackaged = true
    process.env.PORTABLE_EXECUTABLE_DIR = anchorDir
    expect(getAppAnchor()).toBe(anchorDir)
  })

  it('打包 + PORTABLE_EXECUTABLE_DIR 指向不存在的目录 → 回落 exe 所在目录（env 污染防护）', () => {
    appState.isPackaged = true
    process.env.PORTABLE_EXECUTABLE_DIR = join(anchorDir, 'not-created-subdir')
    expect(getAppAnchor()).toBe(dirname(ORIGINAL_EXEC_PATH))
  })

  it('打包 + 无 PORTABLE_EXECUTABLE_DIR → 取 exe 所在目录', () => {
    appState.isPackaged = true
    expect(getAppAnchor()).toBe(dirname(ORIGINAL_EXEC_PATH))
  })

  it('dev → 上溯到含 package.json 的目录（不依赖源文件深度）', () => {
    appState.isPackaged = false
    const anchor = getAppAnchor()
    expect(anchor.length).toBeGreaterThan(0)
    expect(anchor).not.toBe(dirname(ORIGINAL_EXEC_PATH))
    // 不变量：dev 锚点是「自 __dirname 向上最近的含 package.json 的目录」。
    // 该不变量在两种形态下都成立——打包运行态（单文件 out/main/index.js → 上溯到 app）
    // 与未打包测试态（electron/main/utils → 上溯到 app）；因此不锁定具体值，
    // 只断言「锚点自身带 package.json」这一可移植判据。
    expect(existsSync(join(anchor, 'package.json'))).toBe(true)
  })
})

describe('assertInsideAnchor：写路径越界守卫', () => {
  beforeEach(() => {
    appState.isPackaged = true
    process.env.PORTABLE_EXECUTABLE_DIR = anchorDir
  })

  it('锚点自身与锚点内路径 → 返回规范化绝对路径', () => {
    expect(assertInsideAnchor(anchorDir)).toBe(anchorDir)
    expect(assertInsideAnchor(join(anchorDir, 'reports'))).toBe(join(anchorDir, 'reports'))
    expect(assertInsideAnchor(join(anchorDir, 'data', 'userdata'))).toBe(join(anchorDir, 'data', 'userdata'))
  })

  it('锚点外路径 → 抛错', () => {
    expect(() => assertInsideAnchor(join(anchorDir, '..', 'sibling'))).toThrow(/路径越界/)
    expect(() => assertInsideAnchor(dirname(anchorDir))).toThrow(/路径越界/)
  })

  it('`..` 折叠后越界同样抛错（防上溯写到锚点之外）', () => {
    // 形如 <anchor>/a/../../escape → 规范化后落到锚点之外
    expect(() => assertInsideAnchor(join(anchorDir, 'a', '..', '..', 'escape'))).toThrow(/路径越界/)
  })

  it('前缀相似但不同目录（anchor 名 + 后缀）不算锚点内', () => {
    expect(() => assertInsideAnchor(`${anchorDir}2`)).toThrow(/路径越界/)
  })
})

describe('resolveBundledAsset：内置资产 dev/packaged 双候选（ADR-10 第 3 步）', () => {
  // 锚点经打包分支固定到真实临时目录；打包候选经 process.resourcesPath 注入真实临时目录。
  let resDir: string

  beforeEach(() => {
    appState.isPackaged = true
    process.env.PORTABLE_EXECUTABLE_DIR = anchorDir
    resDir = mkdtempSync(join(tmpdir(), 'le-res-'))
    Object.defineProperty(process, 'resourcesPath', { value: resDir, configurable: true })
  })

  afterEach(() => {
    delete (process as { resourcesPath?: string }).resourcesPath
    rmSync(resDir, { recursive: true, force: true })
  })

  it('dev 候选存在 → 取源码树内候选（<锚点>/electron/main/<rel>）', () => {
    mkdirSync(join(anchorDir, 'electron', 'main', 'prompts'), { recursive: true })
    expect(resolveBundledAsset('prompts')).toBe(join(anchorDir, 'electron', 'main', 'prompts'))
  })

  it('dev 候选缺失、打包候选存在 → 取 resources/<rel>（extraResources 复制位）', () => {
    mkdirSync(join(resDir, 'prompts'), { recursive: true })
    expect(resolveBundledAsset('prompts')).toBe(join(resDir, 'prompts'))
  })

  it('全部候选缺失 → 默认显式抛错并列出候选（不静默降级）', () => {
    expect(() => resolveBundledAsset('prompts')).toThrow(/内置资产未找到/)
  })

  it('全部候选缺失 + onMissing=dev → 返回 dev 候选（保持调用方自行 existsSync/降级的历史语义）', () => {
    expect(resolveBundledAsset('prompts', { onMissing: 'dev' })).toBe(
      join(anchorDir, 'electron', 'main', 'prompts')
    )
  })

  it('extraDevCandidates 命中 → 优先于打包候选（兼容历史多候选链）', () => {
    const extra = join(anchorDir, 'legacy-prompts')
    mkdirSync(extra, { recursive: true })
    mkdirSync(join(resDir, 'prompts'), { recursive: true })
    expect(resolveBundledAsset('prompts', { extraDevCandidates: [extra] })).toBe(extra)
  })
})
