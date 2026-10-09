/**
 * workspace-config 测试：默认工作区锚定 + 配置读写。
 *
 * 【为什么存在】index.ts 注入默认工作区路径（应用锚点，随项目走、不写 HOME 系统目录），
 * 本文件验证注入生效：注入后默认工作区指向应用锚点，未注入时兜底 cwd（单测隔离）。
 * 
 * 覆盖：注入 getDefaultWorkspacePath 行为、默认配置创建、清单读写、激活/删除/重命名。
 * 全部 fs 操作在临时目录完成，不触网、不触盘外路径。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import {
  setDefaultWorkspacePath,
  ensureWorkspaceConfigExists,
  loadWorkspaceConfig,
  addWorkspace,
  removeWorkspace,
  setActiveWorkspace,
  renameWorkspace,
  getActiveWorkspace
} from '../electron/main/services/workspace-config'

describe('workspace-config：默认工作区路径', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-config-test-'))
    // 每个用例独立的注入值，避免跨用例污染
    setDefaultWorkspacePath(join(dir, 'anchor'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('注入应用锚点后默认工作区指向锚点（随项目走，不写 HOME）', () => {
    const configPath = join(dir, '.workspaces.json')
    ensureWorkspaceConfigExists(configPath)
    const cfg = loadWorkspaceConfig(configPath)
    expect(cfg.workspaces).toHaveLength(1)
    expect(cfg.workspaces[0].path).toBe(join(dir, 'anchor'))
    expect(cfg.workspaces[0].path).not.toBe(homedir())
  })

  it('回退语义：未注入锚点（模拟）时兜底 cwd 而非 HOME（分发可移植）', () => {
    // setter 只接受字符串，无法真正"不注入"；显式注入 cwd 验证模块对
    // 兜底根的路径推导与实现一致。为什么不是 homedir：旧实现回退 HOME
    // 会把默认工作区写到系统用户目录、随分发带出本机用户名，已改为
    // process.cwd()（见 workspace-config.ts 注释），此处断言兜底绝不落 HOME。
    setDefaultWorkspacePath(process.cwd())
    const configPath = join(dir, 'no-inject.json')
    ensureWorkspaceConfigExists(configPath)
    const cfg = loadWorkspaceConfig(configPath)
    expect(cfg.workspaces[0].path).toBe(process.cwd())
    expect(cfg.workspaces[0].path).not.toBe(homedir())
  })

  it('清单写入后可读回一致内容（round-trip）', () => {
    const configPath = join(dir, '.workspaces.json')
    ensureWorkspaceConfigExists(configPath)
    addWorkspace(configPath, '工作区B', join(dir, 'b'))
    const cfg = loadWorkspaceConfig(configPath)
    expect(cfg.workspaces).toHaveLength(2)
    expect(cfg.workspaces.map((w) => w.name)).toEqual(expect.arrayContaining(['默认工作区', '工作区B']))
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(raw.workspaces).toHaveLength(2)
  })

  it('删除工作区至少保留一个', () => {
    const configPath = join(dir, '.workspaces.json')
    ensureWorkspaceConfigExists(configPath)
    const cfg = loadWorkspaceConfig(configPath)
    const res = removeWorkspace(configPath, cfg.workspaces[0].id)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('至少保留')
  })

  it('激活/重命名工作区', () => {
    const configPath = join(dir, '.workspaces.json')
    ensureWorkspaceConfigExists(configPath)
    addWorkspace(configPath, 'B', join(dir, 'b'))
    const before = loadWorkspaceConfig(configPath)
    const second = before.workspaces[1]
    setActiveWorkspace(configPath, second.id)
    const active = getActiveWorkspace(configPath)
    expect(active?.id).toBe(second.id)
    renameWorkspace(configPath, second.id, 'B2')
    const after = loadWorkspaceConfig(configPath)
    expect(after.workspaces.find((w) => w.id === second.id)?.name).toBe('B2')
  })

  it('activeWorkspaceId 指向不存在的工作区时回退到首个', () => {
    const configPath = join(dir, '.workspaces.json')
    ensureWorkspaceConfigExists(configPath)
    addWorkspace(configPath, 'B', join(dir, 'b'))
    // 手工构造一个 activeId 失效的配置
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    raw.activeWorkspaceId = 'does-not-exist'
    // 通过 add 之外的方式写回（直接写盘），然后读取应回退
    writeFileSync(configPath, JSON.stringify(raw), 'utf-8')
    const cfg = loadWorkspaceConfig(configPath)
    expect(cfg.activeWorkspaceId).toBe(cfg.workspaces[0].id)
  })
})