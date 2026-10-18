import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readdirSync, existsSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  DEFAULT_INSTANCE,
  parseInstanceArg,
  instanceUserData,
  instanceDataDir,
  listInstanceNames,
  removeInstanceDirs,
  renameInstanceDirs
} from '../electron/main/multi-instance/instance-args'

describe('instance-args（多实例 --instance 解析与路径布局）', () => {
  it('未传 --instance → default 实例（isDefault=true）', () => {
    const r = parseInstanceArg(['electron', 'app'])
    expect(r).toEqual({ name: DEFAULT_INSTANCE, isDefault: true })
  })

  it('--instance=work 等号形态 → work 具名实例', () => {
    const r = parseInstanceArg(['--instance=work'])
    expect(r).toEqual({ name: 'work', isDefault: false })
  })

  it('--instance work 空格形态 → work 具名实例', () => {
    const r = parseInstanceArg(['--instance', 'work'])
    expect(r).toEqual({ name: 'work', isDefault: false })
  })

  it('--instance=default 显式默认 → isDefault=true', () => {
    const r = parseInstanceArg(['--instance=default'])
    expect(r).toEqual({ name: 'default', isDefault: true })
  })

  it('非法实例名（含路径分隔符/中文）→ 回退 default 并给出原因', () => {
    const bad = parseInstanceArg(['--instance=../etc'])
    expect(bad.isDefault).toBe(true)
    expect(bad.invalidReason).toBeTruthy()

    const chinese = parseInstanceArg(['--instance=测试'])
    expect(chinese.isDefault).toBe(true)
    expect(chinese.invalidReason).toBeTruthy()
  })

  it('实例名校验：合法集合（字母/数字/下划线/连字符，1-32 位）', () => {
    for (const ok of ['a', 'work2', 'My_Instance', 'my-instance-01']) {
      expect(parseInstanceArg([`--instance=${ok}`]).isDefault).toBe(false)
    }
  })

  it('userData 布局：{base}/instances/{name}', () => {
    expect(instanceUserData('C:/base', 'work')).toBe(join('C:/base', 'instances', 'work'))
  })

  it('dataDir 布局：{base}/instances/{name}', () => {
    expect(instanceDataDir('C:/data', 'work')).toBe(join('C:/data', 'instances', 'work'))
  })

  it('listInstanceNames：扫描 instances/ 下合法目录，字典序，忽略非法目录', () => {
    const base = mkdtempSync(join(tmpdir(), 'inst-args-'))
    try {
      mkdirSync(join(base, 'instances', 'b'), { recursive: true })
      mkdirSync(join(base, 'instances', 'a'), { recursive: true })
      // 非法目录名（非实例）应被忽略；普通文件忽略
      mkdirSync(join(base, 'instances', '..weird'), { recursive: true })
      const names = listInstanceNames(base)
      expect(names).toEqual(['a', 'b'])
      expect(readdirSync(join(base, 'instances'))).toContain('..weird')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('listInstanceNames：instances/ 不存在 → 空数组', () => {
    const base = mkdtempSync(join(tmpdir(), 'inst-args-'))
    try {
      expect(listInstanceNames(base)).toEqual([])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('removeInstanceDirs / renameInstanceDirs（实例删除与改名）', () => {
  it('removeInstanceDirs：同时移除 userData 与 dataDir，目录不存在则跳过', () => {
    const baseUser = mkdtempSync(join(tmpdir(), 'inst-del-user-'))
    const baseData = mkdtempSync(join(tmpdir(), 'inst-del-data-'))
    try {
      mkdirSync(join(baseUser, 'instances', 'work'), { recursive: true })
      writeFileSync(join(baseUser, 'instances', 'work', 'config.json'), '{}')
      mkdirSync(join(baseData, 'instances', 'work'), { recursive: true })
      writeFileSync(join(baseData, 'instances', 'work', 'data.db'), 'x')

      const r = removeInstanceDirs(baseUser, baseData, 'work')
      expect(r.ok).toBe(true)
      expect(existsSync(join(baseUser, 'instances', 'work'))).toBe(false)
      expect(existsSync(join(baseData, 'instances', 'work'))).toBe(false)

      // 再删一次（目录已不存在）应依然 ok
      expect(removeInstanceDirs(baseUser, baseData, 'work').ok).toBe(true)
    } finally {
      rmSync(baseUser, { recursive: true, force: true })
      rmSync(baseData, { recursive: true, force: true })
    }
  })

  it('renameInstanceDirs：userData 与 dataDir 两目录同步改名（含隐藏内容）', () => {
    const baseUser = mkdtempSync(join(tmpdir(), 'inst-ren-user-'))
    const baseData = mkdtempSync(join(tmpdir(), 'inst-ren-data-'))
    try {
      mkdirSync(join(baseUser, 'instances', 'work', 'sub'), { recursive: true })
      writeFileSync(join(baseUser, 'instances', 'work', 'sub', 'inner.txt'), 'a')
      mkdirSync(join(baseData, 'instances', 'work'), { recursive: true })
      writeFileSync(join(baseData, 'instances', 'work', 'data.db'), 'b')

      const r = renameInstanceDirs(baseUser, baseData, 'work', 'office')
      expect(r.ok).toBe(true)
      expect(existsSync(join(baseUser, 'instances', 'work'))).toBe(false)
      expect(existsSync(join(baseData, 'instances', 'work'))).toBe(false)
      expect(readFileSync(join(baseUser, 'instances', 'office', 'sub', 'inner.txt'), 'utf8')).toBe('a')
      expect(existsSync(join(baseData, 'instances', 'office', 'data.db'))).toBe(true)
      // 改名后列表反映新名
      expect(listInstanceNames(baseUser)).toEqual(['office'])
    } finally {
      rmSync(baseUser, { recursive: true, force: true })
      rmSync(baseData, { recursive: true, force: true })
    }
  })

  it('renameInstanceDirs：dataDir 未创建（实例未启动过）→ 仅迁 userData', () => {
    const baseUser = mkdtempSync(join(tmpdir(), 'inst-ren2-user-'))
    const baseData = mkdtempSync(join(tmpdir(), 'inst-ren2-data-'))
    try {
      mkdirSync(join(baseUser, 'instances', 'only-user'), { recursive: true })
      writeFileSync(join(baseUser, 'instances', 'only-user', 'seed.txt'), 's')

      const r = renameInstanceDirs(baseUser, baseData, 'only-user', 'renamed')
      expect(r.ok).toBe(true)
      expect(existsSync(join(baseUser, 'instances', 'renamed', 'seed.txt'))).toBe(true)
      expect(existsSync(join(baseUser, 'instances', 'only-user'))).toBe(false)
    } finally {
      rmSync(baseUser, { recursive: true, force: true })
      rmSync(baseData, { recursive: true, force: true })
    }
  })

  it('renameInstanceDirs：旧实例不存在 → 报错；新名已存在 → 报错且不破坏目标', () => {
    const baseUser = mkdtempSync(join(tmpdir(), 'inst-ren3-user-'))
    const baseData = mkdtempSync(join(tmpdir(), 'inst-ren3-data-'))
    try {
      mkdirSync(join(baseUser, 'instances', 'a'), { recursive: true })
      mkdirSync(join(baseUser, 'instances', 'b'), { recursive: true })
      writeFileSync(join(baseUser, 'instances', 'b', 'keep.txt'), 'k')

      const notFound = renameInstanceDirs(baseUser, baseData, 'ghost', 'b')
      expect(notFound.ok).toBe(false)

      const conflict = renameInstanceDirs(baseUser, baseData, 'a', 'b')
      expect(conflict.ok).toBe(false)
      // 目标 b 未被破坏，a 仍在
      expect(existsSync(join(baseUser, 'instances', 'b', 'keep.txt'))).toBe(true)
      expect(existsSync(join(baseUser, 'instances', 'a'))).toBe(true)
    } finally {
      rmSync(baseUser, { recursive: true, force: true })
      rmSync(baseData, { recursive: true, force: true })
    }
  })
})