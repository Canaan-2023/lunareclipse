/**
 * 随包素材落盘：**只增不改 + 我们自己的旧素材可升级**。
 *
 * 为什么测：分发版首次启动会把月蚀背景两档（房间 / 工作间）写进用户数据目录；
 * 如果复制逻辑写成「整目录覆盖」，用户改过的外观/背景会被静默抹掉——这类错误
 * 没有报错，只会「设置又变回去了」。0.53.11 起还要能把 0.53.8~0.53.10 的旧背景
 * 替换成新美术，所以用 `.room-seed.json` 记账区分「我们写的」与「用户改的」。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { copyTreeMissing, copyTreeSeeded, seedRoomAssets, SEED_MANIFEST_FILE } from '../electron/main/room/seed-assets'

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

describe('copyTreeSeeded：只增不改 + 允许升级我们自己的旧素材', () => {
  const setup = (): { src: string; dst: string } => {
    const dir = mk()
    const src = join(dir, 'seed')
    const dst = join(dir, 'data')
    mkdirSync(join(src, 'scenes'), { recursive: true })
    writeFileSync(join(src, 'scenes', 'home.jpg'), 'NEW-HOME')
    mkdirSync(join(src, 'AI1'), { recursive: true })
    writeFileSync(join(src, 'AI1', 'appearance.json'), '{}')
    return { src, dst }
  }

  it('首次：复制全部文件并写记账；第二次幂等', () => {
    const { src, dst } = setup()
    expect(copyTreeSeeded(src, dst)).toBe(2)
    expect(readFileSync(join(dst, 'scenes', 'home.jpg'), 'utf-8')).toBe('NEW-HOME')
    expect(existsSync(join(dst, SEED_MANIFEST_FILE))).toBe(true)
    expect(copyTreeSeeded(src, dst)).toBe(0)
  })

  it('用户改过的目标文件 → 不覆盖（哈希不在记账里）', () => {
    const { src, dst } = setup()
    copyTreeSeeded(src, dst)
    writeFileSync(join(dst, 'scenes', 'home.jpg'), 'USER-HOME')
    expect(copyTreeSeeded(src, dst)).toBe(0)
    expect(readFileSync(join(dst, 'scenes', 'home.jpg'), 'utf-8')).toBe('USER-HOME')
  })

  it('我们上次写入的目标 → 新素材到达时允许覆盖', () => {
    const { src, dst } = setup()
    copyTreeSeeded(src, dst)
    writeFileSync(join(src, 'scenes', 'home.jpg'), 'NEW-HOME-2')
    expect(copyTreeSeeded(src, dst)).toBe(1)
    expect(readFileSync(join(dst, 'scenes', 'home.jpg'), 'utf-8')).toBe('NEW-HOME-2')
  })

  it('新包不再提供的旧场景 → 删除；用户改过的同名旧场景 → 保留', () => {
    const { src, dst } = setup()
    writeFileSync(join(src, 'scenes', 'work.jpg'), 'NEW-WORK')
    copyTreeSeeded(src, dst)
    // 模拟 0.53.12 收敛为两张：源里只剩 home，work 变回我们写过的孤儿
    rmSync(join(src, 'scenes', 'work.jpg'))
    expect(copyTreeSeeded(src, dst)).toBe(1)
    expect(existsSync(join(dst, 'scenes', 'work.jpg'))).toBe(false)

    // 用户改过的文件哈希已不在记账里 → 视为用户素材，必须保留
    writeFileSync(join(src, 'scenes', 'plan.jpg'), 'NEW-PLAN')
    copyTreeSeeded(src, dst)
    writeFileSync(join(dst, 'scenes', 'plan.jpg'), 'USER-PLAN')
    rmSync(join(src, 'scenes', 'plan.jpg'))
    copyTreeSeeded(src, dst)
    expect(readFileSync(join(dst, 'scenes', 'plan.jpg'), 'utf-8')).toBe('USER-PLAN')
  })
})
