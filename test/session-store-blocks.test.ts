import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionStore } from '../electron/main/api/session-store'

/**
 * 回归：SessionStore.loadAll 只认会话文件。
 * 会话目录里并存块树文件 {id}.blocks.json（无 id 字段）——旧的 `.endsWith('.json')`
 * 过滤器会把块文件也当会话解析，失败即 rename 成 .corrupt-* 隔离，块树持久化每次加载被摧毁。
 */
describe('SessionStore.loadAll 隔离边界', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'session-blocks-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writeSession(id: string): void {
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({ id, title: '探针会话', messages: [], createdAt: Date.now(), updatedAt: Date.now() }),
      'utf-8'
    )
  }

  it('块树文件 {id}.blocks.json 不被隔离，会话正常加载', () => {
    writeSession('s_probe')
    writeFileSync(
      join(dir, 's_probe.blocks.json'),
      JSON.stringify({ sessionId: 's_probe', blocks: [], version: 1 }),
      'utf-8'
    )

    // 构造即触发 loadAll（同步）——旧实现会在此把块文件改名隔离
    const store = new SessionStore(dir)

    expect(store.get('s_probe')?.title).toBe('探针会话')
    expect(existsSync(join(dir, 's_probe.blocks.json'))).toBe(true)
    expect(readdirSync(dir).filter((f) => f.startsWith('.corrupt-'))).toHaveLength(0)
  })

  it('真损坏的会话文件仍被隔离为 .corrupt-*', () => {
    writeFileSync(join(dir, 'broken.json'), '{ not valid json', 'utf-8')

    new SessionStore(dir)

    expect(existsSync(join(dir, 'broken.json'))).toBe(false)
    const quarantined = readdirSync(dir).filter((f) => f.startsWith('.corrupt-') && f.endsWith('broken.json'))
    expect(quarantined).toHaveLength(1)
  })

  it('已隔离的 .corrupt-* 不被二次隔离（不产生嵌套前缀）', () => {
    writeFileSync(join(dir, '.corrupt-111-s_gone.json'), '{ bad', 'utf-8')

    new SessionStore(dir)

    const files = readdirSync(dir)
    expect(files).toContain('.corrupt-111-s_gone.json')
    // 不应出现 .corrupt-{ts}-.corrupt-... 形式（嵌套隔离是旧 bug 的特征）
    expect(files.filter((f) => /^\.corrupt-\d+-\.corrupt-/.test(f))).toHaveLength(0)
  })
})
