/**
 * SessionStore 0.53 兼容：老字段 continuousActivation → codeReview 读取映射。
 * 覆盖：老 meta.json 只有 continuousActivation 时映射为 codeReview；新旧字段并存时新字段优先。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionStore } from '../electron/main/api/session-store'

describe('SessionStore 0.53 兼容：老字段 continuousActivation → codeReview', () => {
  let dir: string
  const legacyMeta = {
    id: 'compat-s1',
    title: '旧会话',
    createdAt: 1,
    updatedAt: 1,
    shardCount: 0,
    continuousActivation: true
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'session-compat-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('老 meta 只有 continuousActivation 时读取映射为 codeReview', () => {
    const udir = join(dir, legacyMeta.id, 'user')
    mkdirSync(udir, { recursive: true })
    writeFileSync(join(udir, 'meta.json'), JSON.stringify(legacyMeta), 'utf-8')
    const store = new SessionStore(dir)
    const session = store.get(legacyMeta.id)
    expect(session?.codeReview).toBe(true)
  })

  it('新旧字段并存时 codeReview 优先', () => {
    const id = 'compat-s2'
    const udir = join(dir, id, 'user')
    mkdirSync(udir, { recursive: true })
    writeFileSync(
      join(udir, 'meta.json'),
      JSON.stringify({
        id,
        title: '新旧混用',
        createdAt: 1,
        updatedAt: 1,
        shardCount: 0,
        codeReview: false,
        continuousActivation: true
      }),
      'utf-8'
    )
    const store = new SessionStore(dir)
    expect(store.get(id)?.codeReview).toBe(false)
  })
})