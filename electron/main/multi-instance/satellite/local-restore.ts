/**
 * 为什么存在：分系统重装/迁移后需从主系统恢复完整本地记忆，恢复前须清空对应 uid 的各作用域以免新旧混杂。
 * 作用：restoreLocalScope 校验目标路径安全后，从备份 zip 解压还原 memory/NNG/cache 各域，返回恢复条目数。
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import JSZip from 'jszip'

/**
 * 分系统本机备份恢复（账号自助）：把从主系统提取的备份 zip
 * 完全覆盖重建到本机该账号工作域。zip 条目 key 为主系统侧备份日期根下
 * 带完整域前缀的路径（与真实工作域一字不差）：
 * memory/U{uid}/AI{aiId}/... → memory/U{uid}/AI{aiId}/...
 * NNG/AI{aiId}/U{uid}/... → NNG/AI{aiId}/U{uid}/...
 * cache/AI{aiId}/U{uid}/... → cache/AI{aiId}/U{uid}/...
 * ABYSS/U{uid}/... → ABYSS/U{uid}/...（USER.md / AI{aiId}/AI.md）
 * 先清空该 uid 的 memory/NNG/cache/ABYSS 域全部子树，恢复期间调用方暂停同步防 oplog 回流。
 */
export async function restoreLocalScope(root: string, uid: number, zipBytes: Uint8Array): Promise<number> {
  const zip = await JSZip.loadAsync(zipBytes)
  const memReal = join(root, 'memory', `U${uid}`)
  rmSync(memReal, { recursive: true, force: true })
  const nngBase = join(root, 'NNG')
  if (existsSync(nngBase)) {
    for (const aiName of readdirSync(nngBase, { withFileTypes: true })) {
      if (!aiName.isDirectory()) continue
      rmSync(join(nngBase, aiName.name, `U${uid}`), { recursive: true, force: true })
    }
  }
  const cacheBase = join(root, 'cache')
  if (existsSync(cacheBase)) {
    for (const aiName of readdirSync(cacheBase, { withFileTypes: true })) {
      if (!aiName.isDirectory()) continue
      rmSync(join(cacheBase, aiName.name, `U${uid}`), { recursive: true, force: true })
    }
  }
  const abyssReal = join(root, 'ABYSS', `U${uid}`)
  rmSync(abyssReal, { recursive: true, force: true })
  let restored = 0
  const absMemBase = resolve(join(root, 'memory'))
  const absNngBase = resolve(nngBase)
  const absCacheBase = resolve(cacheBase)
  const absAbyssBase = resolve(join(root, 'ABYSS'))
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue
    const key = entry.name.replace(/\\/g, '/')
    if (key.length === 0) continue
    let target: string
    let absBase: string
    if (key.startsWith(`memory/U${uid}/`)) {
      target = resolve(join(root, 'memory', key.slice('memory/'.length)))
      absBase = absMemBase
    } else if (key.startsWith('NNG/')) {
      const nngRest = key.slice('NNG/'.length)
      const seg = nngRest.split('/')
      if (seg.length < 2 || !/^AI\d+$/.test(seg[0] ?? '') || seg[1] !== `U${uid}`) continue
      target = resolve(join(root, 'NNG', nngRest))
      absBase = absNngBase
    } else if (key.startsWith('cache/')) {
      const cacheRest = key.slice('cache/'.length)
      const seg = cacheRest.split('/')
      if (seg.length < 2 || !/^AI\d+$/.test(seg[0] ?? '') || seg[1] !== `U${uid}`) continue
      target = resolve(join(root, 'cache', cacheRest))
      absBase = absCacheBase
    } else if (key.startsWith('ABYSS/')) {
      const abyssRest = key.slice('ABYSS/'.length)
      const seg = abyssRest.split('/')
      // ABYSS/U{uid}/USER.md 或 ABYSS/U{uid}/AI{aiId}/AI.md
      if (seg.length < 2 || seg[0] !== `U${uid}`) continue
      const ok = (seg.length === 2 && seg[1] === 'USER.md') || (seg.length === 3 && /^AI\d+$/.test(seg[1] ?? '') && seg[2] === 'AI.md')
      if (!ok) continue
      target = resolve(join(root, 'ABYSS', abyssRest))
      absBase = absAbyssBase
    } else {
      continue // 未知域不应出现，直接跳过
    }
    if (target !== absBase && !target.startsWith(absBase + sep)) continue
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, Buffer.from(await entry.async('uint8array')))
    restored += 1
  }
  return restored
}