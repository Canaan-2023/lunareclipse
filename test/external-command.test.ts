import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFile } from 'child_process'
import { resolveExternalCommand } from '../electron/main/utils/external-command'

/**
 * 外部命令解析测试。
 * 回归背景：Windows 上 npm/npx 等是 .cmd，execFile 在 shell:false 下不做 PATHEXT 匹配
 * （实测 execFile('npm') → ENOENT），用户 command Hook 里写 `npm test` 直接失败，
 * 连续 5 次 error 后 hooks 被自动禁用。
 */
const IS_WINDOWS = process.platform === 'win32'

describe('外部命令解析（裸命令名 → 可启动进程）', () => {
  let roots: string[] = []

  function newDir(): string {
    const r = mkdtempSync(join(tmpdir(), 'ext-cmd-'))
    roots.push(r)
    return r
  }

  /** 用临时目录充当 PATH，并锁定 PATHEXT，避免受宿主环境影响 */
  function withPath(dir: string, fn: () => void): void {
    const path0 = process.env.PATH
    const pathext0 = process.env.PATHEXT
    process.env.PATH = dir
    if (IS_WINDOWS) process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD'
    try {
      fn()
    } finally {
      process.env.PATH = path0
      if (pathext0 === undefined) delete process.env.PATHEXT
      else process.env.PATHEXT = pathext0
    }
  }

  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true })
    roots = []
  })

  it('裸命令名解析为绝对路径（node.exe 直接启动，不经 shell）', () => {
    const dir = newDir()
    writeFileSync(join(dir, 'node.exe'), '')
    withPath(dir, () => {
      const r = resolveExternalCommand('node', ['-v'])
      // PATHEXT 里是 .EXE，解析出的路径大小写与磁盘文件名可能不同——Windows 路径大小写不敏感
      expect(r.file.toLowerCase()).toBe(join(dir, 'node.exe').toLowerCase())
      expect(r.args).toEqual(['-v'])
    })
  })

  it('Windows：.cmd 交给 cmd.exe 执行（否则 ENOENT）', () => {
    if (!IS_WINDOWS) return
    const dir = newDir()
    writeFileSync(join(dir, 'npm.cmd'), '@echo off\r\n')
    withPath(dir, () => {
      const r = resolveExternalCommand('npm', ['test'])
      expect(r.file.toLowerCase()).toContain('cmd')
      expect(r.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
      expect(r.args[3].toLowerCase()).toBe(join(dir, 'npm.cmd').toLowerCase())
      expect(r.args.slice(4)).toEqual(['test'])
    })
  })

  it('带路径分隔符的命令原样使用（不猜测、不改写）', () => {
    const dir = newDir()
    const abs = join(dir, 'tool.exe')
    const rel = '.\\tool.exe'
    withPath(dir, () => {
      expect(resolveExternalCommand(abs, ['a'])).toEqual({ file: abs, args: ['a'] })
      expect(resolveExternalCommand(rel, ['a'])).toEqual({ file: rel, args: ['a'] })
    })
  })

  it('PATH 中找不到时原样返回（保留 ENOENT 语义，不吞错）', () => {
    const dir = newDir()
    mkdirSync(join(dir, 'empty'), { recursive: true })
    withPath(join(dir, 'empty'), () => {
      expect(resolveExternalCommand('definitely-not-here', ['x'])).toEqual({
        file: 'definitely-not-here',
        args: ['x']
      })
    })
  })

  it('Windows：解析结果能真正跑通 .cmd（端到端，对应 Hook 实际用法）', async () => {
    if (!IS_WINDOWS) return
    const dir = newDir()
    writeFileSync(join(dir, 'sayhello.cmd'), '@echo off\r\necho hello-from-cmd\r\n')
    const out = await new Promise<string>((resolve, reject) => {
      withPath(dir, () => {
        const { file, args } = resolveExternalCommand('sayhello', [])
        execFile(file, args, {}, (err, stdout) => {
          if (err) reject(err)
          else resolve(stdout)
        })
      })
    })
    expect(out).toContain('hello-from-cmd')
  })
})
