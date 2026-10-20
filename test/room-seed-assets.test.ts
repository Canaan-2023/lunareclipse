/**
 * 随包素材落盘：**只增不改**。
 *
 * 为什么测：分发版首次启动会把 Live2D 模型 + 背景写进用户数据目录；如果复制逻辑写成
 * 「整目录覆盖」，用户改过的外观/背景会被静默抹掉——这类错误没有报错，只会「设置又变回去了」。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { copyTreeMissing, seedRoomAssets } from '../electron/main/room/seed-assets'

let root = ''
const mk = (): string => {
  root = mkdtempSync(join(tmpdir(), 'room-seed-'))
  return root
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('copyTreeMissing：只复制目标不存在的文件', () => {
  it('递归复制嵌套目录，返回复制数量', () => {
    const dir = mk()
    const src = join(dir, 'seed')
    const dst = join(dir, 'data')
    mkdirSync(join(src, 'live2d', 'model'), { recursive: true })
    writeFileSync(join(src, 'live2d', 'core.js'), 'CORE')
    writeFileSync(join(src, 'live2d', 'model', 'a.model3.json'), '{}')
    expect(copyTreeMissing(src, dst)).toBe(2)
    expect(readFileSync(join(dst, 'live2d', 'core.js'), 'utf-8')).toBe('CORE')
    expect(readFileSync(join(dst, 'live2d', 'model', 'a.model3.json'), 'utf-8')).toBe('{}')
  })

  it('目标已存在 → 跳过，不覆盖用户改过的文件', () => {
    const dir = mk()
    const src = join(dir, 'seed')
    const dst = join(dir, 'data')
    mkdirSync(src, { recursive: true })
    mkdirSync(dst, { recursive: true })
    writeFileSync(join(src, 'appearance.json'), '{"seed":true}')
    writeFileSync(join(dst, 'appearance.json'), '{"user":true}')
    expect(copyTreeMissing(src, dst)).toBe(0)
    expect(readFileSync(join(dst, 'appearance.json'), 'utf-8')).toBe('{"user":true}')
  })

  it('第二次执行是幂等的（全部已存在 → 0）', () => {
    const dir = mk()
    const src = join(dir, 'seed')
    const dst = join(dir, 'data')
    mkdirSync(join(src, 'scenes'), { recursive: true })
    writeFileSync(join(src, 'scenes', 'home.jpg'), 'JPG')
    expect(copyTreeMissing(src, dst)).toBe(1)
    expect(copyTreeMissing(src, dst)).toBe(0)
  })

  it('源目录不存在 → 0（不抛错，不阻断启动）', () => {
    const dir = mk()
    expect(copyTreeMissing(join(dir, 'missing'), join(dir, 'data'))).toBe(0)
  })
})

describe('seedRoomAssets：非打包态不写入', () => {
  it('dev / 单测环境（electron.app 为空）→ null', () => {
    const dir = mk()
    expect(seedRoomAssets({ root: dir } as never)).toBeNull()
  })
})
