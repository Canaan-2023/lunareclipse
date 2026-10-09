import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'
import { resolveNodeExe, ensureNodeOnPath } from '../electron/main/utils/node-runtime'

/**
 * Node 运行时定位测试。
 * 回归背景：无全局 Node 的机器上，Hook 命令 / run_command 裸调 node|npm 会 ENOENT，
 * 且连续 5 次 error 后 hooks 会被自动禁用——启动时须把自备 node 目录并入 PATH。
 */
describe('Node 运行时定位（子进程 PATH 兜底）', () => {
  it('打包环境下优先返回自带的 node 垫片（resources/tools/node.cmd）', () => {
    const root = mkdtempSync(join(tmpdir(), 'node-rt-'))
    const resources = join(root, 'resources')
    mkdirSync(join(resources, 'tools'), { recursive: true })
    writeFileSync(join(resources, 'tools', 'node.cmd'), '')
    // 同时放一份项目自备的：打包分支必须赢（安装目录下没有 .tools）
    const appDir = join(root, 'app')
    mkdirSync(join(appDir, '.tools'), { recursive: true })
    writeFileSync(join(appDir, '.tools', 'node.exe'), '')
    const desc = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
    try {
      expect(resolveNodeExe(appDir)).toBe(join(resources, 'tools', 'node.cmd'))
    } finally {
      if (desc) Object.defineProperty(process, 'resourcesPath', desc)
      else delete (process as { resourcesPath?: string }).resourcesPath
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('打包环境缺垫片时回退 .tools/node.exe，不再认已废弃的 resources/tools/node.exe', () => {
    const root = mkdtempSync(join(tmpdir(), 'node-rt-'))
    const resources = join(root, 'resources')
    mkdirSync(join(resources, 'tools'), { recursive: true })
    // 0.45 之前的旧包才有 node.exe；垫片缺失时不得再认它（否则升级后遗留的
    // 88.26 MB node.exe 会静默继续生效，看不出它已是死重量）
    writeFileSync(join(resources, 'tools', 'node.exe'), '')
    const appDir = join(root, 'app')
    mkdirSync(join(appDir, '.tools'), { recursive: true })
    writeFileSync(join(appDir, '.tools', 'node.exe'), '')
    const desc = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
    try {
      expect(resolveNodeExe(appDir)).toBe(join(appDir, '.tools', 'node.exe'))
    } finally {
      if (desc) Object.defineProperty(process, 'resourcesPath', desc)
      else delete (process as { resourcesPath?: string }).resourcesPath
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('优先返回项目自备 .tools/node.exe', () => {
    const root = mkdtempSync(join(tmpdir(), 'node-rt-'))
    mkdirSync(join(root, '.tools'), { recursive: true })
    writeFileSync(join(root, '.tools', 'node.exe'), '')
    try {
      expect(resolveNodeExe(root)).toBe(join(root, '.tools', 'node.exe'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('无自备运行时时回退字面量 node（依赖系统 PATH）', () => {
    const root = mkdtempSync(join(tmpdir(), 'node-rt-'))
    try {
      expect(resolveNodeExe(root)).toBe('node')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ensureNodeOnPath 把自备 node 目录并入 PATH，且重复调用幂等', () => {
    const root = mkdtempSync(join(tmpdir(), 'node-rt-'))
    mkdirSync(join(root, '.tools'), { recursive: true })
    writeFileSync(join(root, '.tools', 'node.exe'), '')
    const original = process.env.PATH
    const nodeDir = join(root, '.tools')
    try {
      expect(ensureNodeOnPath(root)).toBe(join(root, '.tools', 'node.exe'))
      expect(process.env.PATH!.split(delimiter).filter((p) => p === nodeDir)).toHaveLength(1)
      // 幂等：再次调用不重复插入
      ensureNodeOnPath(root)
      expect(process.env.PATH!.split(delimiter).filter((p) => p === nodeDir)).toHaveLength(1)
    } finally {
      process.env.PATH = original
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('无自备运行时时不改动 PATH', () => {
    const root = mkdtempSync(join(tmpdir(), 'node-rt-'))
    const original = process.env.PATH
    try {
      expect(ensureNodeOnPath(root)).toBe('node')
      expect(process.env.PATH).toBe(original)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
