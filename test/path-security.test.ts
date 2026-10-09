/**
 * path-security.test.ts — path-security.ts 单测（T6D）
 * 覆盖：validateWithinDir 越界拦截/安全放行、hasTraversalComponent 快速预检。
 */
import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { validateWithinDir, hasTraversalComponent } from '../electron/main/tools/security-engine/path-security'

describe('validateWithinDir', () => {
  it('安全路径放行（root 内）', () => {
    const root = tmpdir()
    expect(validateWithinDir(join(root, 'a.txt'), root)).toBe(null)
    expect(validateWithinDir(join(root, 'sub', 'b.txt'), root)).toBe(null)
    expect(validateWithinDir(root, root)).toBe(null) // 等于 root 本身
  })

  it('拦截 .. 穿越', () => {
    const root = join(tmpdir(), 'allowed-root')
    mkdirSync(root, { recursive: true })
    expect(validateWithinDir(join(root, '..', 'evil.txt'), root)).not.toBe(null)
    expect(validateWithinDir(join(root, '..', '..', 'etc', 'passwd'), root)).not.toBe(null)
    expect(validateWithinDir(join(root, 'sub', '..', '..', 'evil'), root)).not.toBe(null)
  })

  it('拦截绝对路径逃逸到 root 外', () => {
    const root = join(tmpdir(), 'allowed-root-2')
    mkdirSync(root, { recursive: true })
    expect(validateWithinDir(join(tmpdir(), 'outside.txt'), root)).not.toBe(null)
    expect(validateWithinDir('C:\\Windows\\system32', root)).not.toBe(null)
  })

  it('处理不存在的路径（写操作目标）不抛错', () => {
    const root = join(tmpdir(), 'allowed-root-3')
    mkdirSync(root, { recursive: true })
    const nonexist = join(root, 'not-yet-created', 'file.txt')
    expect(validateWithinDir(nonexist, root)).toBe(null)
  })

  it('相对路径按 root 解析', () => {
    const root = join(tmpdir(), 'allowed-root-4')
    mkdirSync(root, { recursive: true })
    expect(validateWithinDir(join(root, 'x'), root)).toBe(null)
  })
})

describe('hasTraversalComponent', () => {
  it('检出 .. 组件（正斜杠与反斜杠）', () => {
    expect(hasTraversalComponent('../etc/passwd')).toBe(true)
    expect(hasTraversalComponent('..\\..\\windows')).toBe(true)
    expect(hasTraversalComponent('a/../b')).toBe(true)
    expect(hasTraversalComponent('a\\..\\b')).toBe(true)
  })

  it('放行无穿越的路径', () => {
    expect(hasTraversalComponent('a/b/c.txt')).toBe(false)
    expect(hasTraversalComponent('a\\b\\c.txt')).toBe(false)
    expect(hasTraversalComponent('C:\\Users\\x\\file.txt')).toBe(false)
    expect(hasTraversalComponent('/usr/local/bin')).toBe(false)
    expect(hasTraversalComponent('')).toBe(false)
    expect(hasTraversalComponent('.../x')).toBe(false) // 段是 ... 不是 ..，不算穿越
    expect(hasTraversalComponent('..hidden')).toBe(false) // 文件名以 .. 开头不算穿越
  })
})
