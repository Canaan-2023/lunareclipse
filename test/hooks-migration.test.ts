/**
 * migrateLegacyGlobalHooks 迁移测试。
 *
 * 【为什么存在】0.53 起全局 hooks 配置从 {anchor}/.lunareclipse/hooks.json 迁到
 *   {userData}/hooks.json；本文件覆盖迁移四场景，防止老用户升级后全局配置静默失效、
 *   或新位置文件被误覆盖。
 *
 * 覆盖：旧存在+新不存在 → 复制且旧文件改名 .migrated；新文件已存在 → 不覆盖且旧文件保留；
 *       迁移失败 → 仅告警不抛出、旧文件保留；旧文件不存在 → 跳过。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { migrateLegacyGlobalHooks } from '../electron/main/hooks/config-loader'

describe('migrateLegacyGlobalHooks 旧全局 hooks 配置迁移', () => {
  let anchor: string
  let userData: string
  const legacyContent = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo legacy' }] }] } }, null, 2)

  beforeEach(() => {
    anchor = mkdtempSync(join(tmpdir(), 'hooks-migrate-anchor-'))
    userData = mkdtempSync(join(tmpdir(), 'hooks-migrate-userdata-'))
  })

  afterEach(() => {
    rmSync(anchor, { recursive: true, force: true })
    rmSync(userData, { recursive: true, force: true })
  })

  it('旧文件存在且新文件不存在：复制到新位置，旧文件改名 hooks.json.migrated 保留', () => {
    const legacyDir = join(anchor, '.lunareclipse')
    mkdirSync(legacyDir, { recursive: true })
    const legacyPath = join(legacyDir, 'hooks.json')
    writeFileSync(legacyPath, legacyContent, 'utf-8')

    migrateLegacyGlobalHooks(anchor, userData)

    const newPath = join(userData, 'hooks.json')
    expect(existsSync(newPath)).toBe(true)
    expect(readFileSync(newPath, 'utf-8')).toBe(legacyContent)
    // 旧文件已改名保留（不删除），原 hooks.json 不再存在
    expect(existsSync(join(legacyDir, 'hooks.json.migrated'))).toBe(true)
    expect(existsSync(legacyPath)).toBe(false)
  })

  it('新文件已存在：不覆盖已有新配置，旧文件原样保留', () => {
    const legacyDir = join(anchor, '.lunareclipse')
    mkdirSync(legacyDir, { recursive: true })
    const legacyPath = join(legacyDir, 'hooks.json')
    writeFileSync(legacyPath, legacyContent, 'utf-8')
    const newContent = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo new' }] }] } })
    const newPath = join(userData, 'hooks.json')
    writeFileSync(newPath, newContent, 'utf-8')

    migrateLegacyGlobalHooks(anchor, userData)

    // 新文件内容保持原样（未被旧配置覆盖）
    expect(readFileSync(newPath, 'utf-8')).toBe(newContent)
    // 旧文件仍留在原处（不强制改名，避免打扰用户）
    expect(existsSync(legacyPath)).toBe(true)
    expect(existsSync(join(legacyDir, 'hooks.json.migrated'))).toBe(false)
  })

  it('迁移失败（新位置不可写）：仅告警不抛出，旧文件保留原处', () => {
    const legacyDir = join(anchor, '.lunareclipse')
    mkdirSync(legacyDir, { recursive: true })
    const legacyPath = join(legacyDir, 'hooks.json')
    writeFileSync(legacyPath, legacyContent, 'utf-8')
    // 用"userData 路径本身是文件"构造不可写目录：mkdirSync(userData/hooks.json 的父目录) 将失败
    const blockedUserData = join(userData, 'occupied')
    writeFileSync(blockedUserData, 'i am a file, not a dir', 'utf-8')

    // 必须不抛出（迁移失败不阻断启动）；捕获 console.warn 确认走了告警分支
    const spy = spyOnWarn()
    expect(() => migrateLegacyGlobalHooks(anchor, blockedUserData)).not.toThrow()
    expect(spy.calls.length).toBeGreaterThan(0)
    spy.restore()
    // 旧文件保留原处（未改名），新位置无 hooks.json
    expect(existsSync(legacyPath)).toBe(true)
    expect(existsSync(join(blockedUserData, 'hooks.json'))).toBe(false)
  })

  it('旧文件不存在：跳过（首次安装/已迁移），不产生任何文件', () => {
    migrateLegacyGlobalHooks(anchor, userData)
    expect(existsSync(join(userData, 'hooks.json'))).toBe(false)
  })
})

/** 简易 console.warn 间谍（vitest 未在全局注入时自备） */
function spyOnWarn(): { calls: unknown[][]; restore: () => void } {
  const calls: unknown[][] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => { calls.push(args) }
  return { calls, restore: () => { console.warn = original } }
}