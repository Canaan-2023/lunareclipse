/**
 * hooks-config-loader 全局根目录注入测试。
 *
 * 【为什么存在】index.ts 启动时调用 setHooksConfigRoot(getAppAnchor()) 把全局
 *   hooks 配置根从"用户 HOME 目录"改为"应用锚点（随项目走、不写系统目录）"；
 *   本文件验证注入生效：注入后 getHooksPaths().global 指向锚点下路径，
 *   且 loadAllHooks 真实从锚点位置读取配置（不只是路径字符串对了）。
 *
 * 覆盖：注入后路径指向锚点（≠ homedir）、锚点下配置可被加载、
 *       注入回退（homedir）时路径回到 HOME（单测隔离语义）。
 * 全部 fs 操作在临时目录完成；getPreviewFile mock 为 null 隔离工作区探测。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { setHooksConfigRoot, getHooksPaths, loadAllHooks } from '../electron/main/hooks/config-loader'

// 隔离工作区探测（真实 getPreviewFile 依赖运行时注入的预览文件路径）
vi.mock('../electron/main/services/workspace-state', () => ({
  getPreviewFile: () => null
}))

describe('hooks 全局根目录注入（随项目走，不写 HOME）', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hooks-root-test-'))
    // 每个用例注入独立锚点，避免跨用例污染模块级状态
    setHooksConfigRoot(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('注入锚点后 getHooksPaths().global 指向锚点下 .lunareclipse/hooks.json', () => {
    const { global } = getHooksPaths()
    expect(global).toBe(join(dir, '.lunareclipse', 'hooks.json'))
    // 关键语义：不再落在 HOME 下的 .lunareclipse（随项目走、不写系统目录）
    expect(global).not.toBe(join(homedir(), '.lunareclipse', 'hooks.json'))
  })

  it('loadAllHooks 真实从注入锚点读取全局配置（路径注入业务生效）', () => {
    // 用户在锚点下配置了全局钩子（command 类型）
    const hooksDir = join(dir, '.lunareclipse')
    mkdirSync(hooksDir, { recursive: true })
    const hooksFile = join(hooksDir, 'hooks.json')
    writeFileSync(
      hooksFile,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo ok' }] }]
        }
      }),
      'utf-8'
    )
    const resolved = loadAllHooks()
    expect(resolved).toHaveLength(1)
    expect(resolved[0].event).toBe('PreToolUse')
    expect(resolved[0].matcher).toBe('Bash')
    expect(resolved[0].scope).toBe('global')
    // sourceFile 必须是注入锚点下的文件（而非 HOME 下）
    expect(resolved[0].sourceFile).toBe(hooksFile)
  })

  it('回退语义：未注入锚点（模拟）时 global 回退 cwd 而非 HOME（分发可移植）', () => {
    // 无 setHooksConfigRoot(null) 的重置入口（setter 只收 string），
    // 显式注入 process.cwd() 验证模块对"兜底根"的路径推导与实现一致；
    // 为什么不是 homedir：旧实现回退 HOME 会把本机用户名带进全局配置，
    // 随项目分发时配置"跟人走"而非"跟项目走"，已按 config-loader 注释改为 cwd。
    setHooksConfigRoot(process.cwd())
    const { global } = getHooksPaths()
    expect(global).toBe(join(process.cwd(), '.lunareclipse', 'hooks.json'))
    // 兜底路径绝不落在用户 HOME 下
    expect(global).not.toBe(join(homedir(), '.lunareclipse', 'hooks.json'))
  })

  it('注入锚点下无配置文件时 loadAllHooks 不炸（返回空/默认审计）', () => {
    // 锚点下没有 hooks.json：全局为空 → 应追加内置默认审计钩子（不删理由见 defaults.ts）
    const resolved = loadAllHooks()
    for (const r of resolved) {
      // 此时没有来自锚点的用户配置（sourceFile 不在注入目录内，即没读到文件）
      expect(r.sourceFile.includes(dir)).toBe(false)
    }
    expect(Array.isArray(resolved)).toBe(true)
  })
})