/**
 * 配置文件原子写回归（2026-10-31 生命周期收口）。
 *
 * 背景：config.json 曾是全仓唯一直接 `writeFileSync` 覆盖的关键文件——装着 API Key、
 * 工具策略、权限覆写、绿通开关，写到一半崩溃/被杀即"设置全丢"。修复为 `.tmp` + rename
 *（Windows EPERM 重试）。本文件锁定：保存后文件是完整合法 JSON、无 `.tmp` 残留。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ConfigStore } from '../electron/main/api/config-store'

const dirs: string[] = []

function makeStore(): { store: ConfigStore; file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'le-config-atomic-'))
  dirs.push(dir)
  const file = join(dir, 'config.json')
  return { store: new ConfigStore(file), file, dir }
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
})

describe('ConfigStore 原子写', () => {
  it('save 后配置文件是完整合法 JSON，且不残留 .tmp', () => {
    const { store, file, dir } = makeStore()
    const config = store.get()
    store.save({ ...config, aiName: '原子写测试' })

    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { aiName?: string }
    expect(parsed.aiName).toBe('原子写测试')
    // 目录里不应有 .tmp 残留（rename 成功后 tmp 已被移走）
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('连续保存仍保持单文件合法（临时文件被覆盖而非堆积）', () => {
    const { store, file, dir } = makeStore()
    for (let i = 0; i < 5; i++) {
      store.save({ ...store.get(), aiName: `连续保存-${i}` })
    }
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { aiName?: string }
    expect(parsed.aiName).toBe('连续保存-4')
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})
