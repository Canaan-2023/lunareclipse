import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { UserStore } from '../electron/main/models/user-store'

describe('UserStore.renameUser：修改用户名并同步账号表', () => {
  let root: string
  let store: UserStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'as-rename-'))
    store = new UserStore(join(root, 'users.json'))
    store.register('小白', 'pass-1')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('UID 不变，users.json 账号表同步新用户名', () => {
    const uid = store.listUsers()[0].UID
    const r = store.renameUser(uid, '新小白')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.user.UID).toBe(uid)
    expect(r.user.用户名).toBe('新小白')
    const saved = JSON.parse(readFileSync(join(root, 'users.json'), 'utf-8'))
    const rec = saved.users.find((u: { UID: number }) => u.UID === uid)
    expect(rec.用户名).toBe('新小白')
  })

  it('当前登录用户改名后 getCurrentUser 同步新用户名', () => {
    const acc = store.listUsers()[0]
    expect(store.login(acc.用户名, 'pass-1').ok).toBe(true)
    expect(store.getCurrentUser()?.用户名).toBe('小白')
    const r = store.renameUser(acc.UID, '改名后')
    expect(r.ok).toBe(true)
    expect(store.getCurrentUser()?.用户名).toBe('改名后')
  })

  it('改名后新用户名可正常登录，旧用户名失效', () => {
    const acc = store.listUsers()[0]
    store.renameUser(acc.UID, '新小白')
    expect(store.login('新小白', 'pass-1').ok).toBe(true)
    const old = store.login('小白', 'pass-1')
    expect(old.ok).toBe(false)
  })

  it('空名 / 非法字符 / 与其他账号重名均拒绝', () => {
    const uid = store.listUsers()[0].UID
    store.register('别人', 'pass-2')
    expect(store.renameUser(uid, '   ').ok).toBe(false)
    expect(store.renameUser(uid, 'a/b').ok).toBe(false)
    const dup = store.renameUser(uid, '别人')
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.error).toContain('已存在')
  })

  it('改回原名（唯一性排除自身）允许', () => {
    const uid = store.listUsers()[0].UID
    store.renameUser(uid, '新小白')
    expect(store.renameUser(uid, '小白').ok).toBe(true)
  })
})