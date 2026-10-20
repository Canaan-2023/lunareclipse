#!/usr/bin/env node
/**
 * 从官方锁生成镜像锁：`package-lock.json` → `package-lock.npmmirror.json`
 *
 * 为什么存在：国内开发机常用 npmmirror 镜像，但锁文件必须有一份**官方源**版本作为唯一真源
 * （CI / 海外用户 / 审计都以官方源为准）。两份锁若靠手改必然漂移——本脚本把镜像版变成
 * **纯派生物**：随时可由官方版重新生成，不需要也不允许手工维护。
 *
 * 唯一改动：把每条 `resolved` 的**主机**从 `registry.npmjs.org` 换成 `registry.npmmirror.com`。
 * `integrity` / `version` / 依赖树**一律不动**——integrity 是 tarball 内容哈希，与下载源无关，
 * 所以换源不需要（也不应该）重新生成哈希，改了反而会让 npm 校验失败。
 *
 * 用法：
 *   node scripts/sync-mirror-lock.mjs          生成/覆盖 `package-lock.npmmirror.json`（幂等）
 *   node scripts/sync-mirror-lock.mjs --check  只校验镜像锁与官方锁是否同步；漂移则 exit 1（不写盘）
 *
 * 纪律（防漂移的唯一手段）：**以 `package-lock.json` 为唯一源**。镜像版不要手改——
 * 手改会在下一次运行本脚本时被覆盖，而 `--check` 会立刻报出漂移。
 *
 * 不删理由：删掉即镜像用户只能手改锁文件，两份必然漂移且无人能判「哪份对」。
 */
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/** 本脚本所在目录的上一级 = `app/`（锁文件所在处），不依赖 cwd。 */
const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OFFICIAL = join(APP_ROOT, 'package-lock.json')
const MIRROR = join(APP_ROOT, 'package-lock.npmmirror.json')

const FROM = 'https://registry.npmjs.org/'
const TO = 'https://registry.npmmirror.com/'

/** 就地改写 lock 的 resolved 主机，返回替换条数。 */
function toMirrorLock(lock) {
  let count = 0
  for (const pkg of Object.values(lock.packages ?? {})) {
    const resolved = pkg && pkg.resolved
    if (typeof resolved === 'string' && resolved.startsWith(FROM)) {
      pkg.resolved = TO + resolved.slice(FROM.length)
      count += 1
    }
  }
  return count
}

const lock = JSON.parse(readFileSync(OFFICIAL, 'utf-8'))
const count = toMirrorLock(lock)
// npm 的锁文件格式 = 2 空格缩进 + 尾随换行；用同样的序列化方式，保证两份文件**只差主机名**，
// diff 干净可读（否则每次生成时都会产生整文件重排的噪声 diff）。
const out = `${JSON.stringify(lock, null, 2)}\n`

if (process.argv.includes('--check')) {
  if (!existsSync(MIRROR)) {
    console.error(`[sync-mirror-lock] FAIL：缺少 ${MIRROR}（先跑一次 node scripts/sync-mirror-lock.mjs 生成）`)
    process.exit(1)
  }
  if (readFileSync(MIRROR, 'utf-8') !== out) {
    console.error('[sync-mirror-lock] FAIL：镜像锁与官方锁已漂移——重跑本脚本覆盖，勿手改镜像版')
    process.exit(1)
  }
  console.log(`[sync-mirror-lock] PASS：镜像锁与官方锁一致（应为 ${count} 条 resolved 指向镜像）`)
  process.exit(0)
}

writeFileSync(MIRROR, out, 'utf-8')
console.log(`[sync-mirror-lock] OK：已生成 ${MIRROR}；替换 ${count} 条 resolved 主机（registry.npmjs.org → registry.npmmirror.com）`)
