/**
 * 剪贴板工具（utils/clipboard.ts）测试
 *
 * 覆盖：
 * 1. 优先走主进程桥 window.lunareclipse.clipboardWriteText（file:// 生产环境主路径）
 * 2. 桥不存在 → 回退 navigator.clipboard.writeText（开发模式 http:// 场景）
 * 3. navigator.clipboard 抛错 → 回退 execCommand 兜底
 * 4. 全链路失败 → 返回 false（调用方据此做 UI 失败提示，不再静默吞错）
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { copyText } from '../src/utils/clipboard'

function stubEnv(env: { bridge?: (t: string) => Promise<boolean>; navWrite?: (t: string) => Promise<void>; execCommand?: () => boolean }) {
  vi.stubGlobal('window', { lunareclipse: env.bridge ? { clipboardWriteText: env.bridge } : undefined } as Window)
  vi.stubGlobal('navigator', { clipboard: env.navWrite ? { writeText: env.navWrite } : undefined } as Navigator)
  const ta = { value: '', style: {}, select: vi.fn() } as unknown as HTMLTextAreaElement
  vi.stubGlobal('document', {
    createElement: () => ta,
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
    execCommand: env.execCommand as unknown as Document['execCommand'],
  })
  return ta
}

describe('utils/clipboard copyText', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('优先走主进程桥 window.lunareclipse.clipboardWriteText', async () => {
    const bridge = vi.fn(async (_t: string) => true)
    stubEnv({ bridge })
    const ok = await copyText('hello')
    expect(ok).toBe(true)
    expect(bridge).toHaveBeenCalledWith('hello')
  })

  it('桥返回 false 时回退 navigator.clipboard', async () => {
    const bridge = vi.fn(async () => false)
    const navWrite = vi.fn(async () => {})
    stubEnv({ bridge, navWrite })
    const ok = await copyText('world')
    expect(ok).toBe(true)
    expect(bridge).toHaveBeenCalledWith('world')
    expect(navWrite).toHaveBeenCalledWith('world')
  })

  it('桥不存在时直接用 navigator.clipboard', async () => {
    const navWrite = vi.fn(async () => {})
    stubEnv({ navWrite })
    const ok = await copyText('direct')
    expect(ok).toBe(true)
    expect(navWrite).toHaveBeenCalledWith('direct')
  })

  it('navigator.clipboard 抛错时回退 execCommand 兜底', async () => {
    const navWrite = vi.fn(async () => { throw new Error('denied') })
    const ta = stubEnv({ navWrite, execCommand: () => true })
    const ok = await copyText('fallback')
    expect(ok).toBe(true)
    expect(navWrite).toHaveBeenCalledWith('fallback')
    expect(ta.select).toHaveBeenCalled()
    expect(ta.value).toBe('fallback')
  })

  it('全链路失败时返回 false（供调用方 UI 提示）', async () => {
    const bridge = vi.fn(async () => false)
    const navWrite = vi.fn(async () => { throw new Error('denied') })
    stubEnv({ bridge, navWrite, execCommand: () => false })
    const ok = await copyText('fail-all')
    expect(ok).toBe(false)
    expect(bridge).toHaveBeenCalledWith('fail-all')
  })
})