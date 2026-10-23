/**
 * @category ROOM
 * @summary 首次启动 / 版本升级时把**随包素材**（月蚀背景两档 + 外观基线）写入用户数据目录
 *
 * 为什么存在（用户 2026-10-20 / 2026-10-23）：
 * - 分发版要「开箱就看到月蚀的房间」，而不是让用户自己往 `<data>/room/` 里拷文件；
 * - 0.53.11 起安装包**不再内置 Live2D 模型与 Cubism Core**，只随包新立绘/背景；
 * - 2026-10-23 起随包背景收敛为**两张**（房间 / 工作间），不再有六分区场景；
 * - 开发态也要能直接看到同一套素材（`npm run dev` 不应是一个没有背景的灰房间）。
 *
 * 复制规则（**只增不改**，但允许升级我们自己的旧素材）：
 * 1. 目标不存在 → 复制；
 * 2. 目标内容与「上次 seed 写入的哈希」一致 → 说明用户没改过，允许覆盖成新素材；
 * 3. 目标内容命中 `LEGACY_SEED_HASHES`（0.53.8~0.53.10 随包的旧背景）→ 允许覆盖/删除；
 * 4. 其余情况 → 视为用户自己的文件，**不动**。
 * 第 2 条靠 `<data>/room/.room-seed.json` 记账；没有它时只靠旧哈希识别旧素材。
 * 这样既不会把用户改过的背景抹掉，也不会让旧背景永远盖住新背景。
 * 另外，**我们写过但新包不再提供的文件**（如已废弃的 plan/memory/device/lan 场景图）
 * 会在内容仍等于记账哈希时删除——否则它们会永久占着数据目录。
 *
 * Live2D：不再 seed。旧数据目录里的模型不删除（用户可能还要用），但渲染侧默认
 * `characterSource=portrait`，不会自动抢占画面（见 `shared/room/appearance.ts`）。
 *
 * 不删理由：删掉即分发版回到「代码房间 + 2D 回落」，与用户要求相反。
 */
import { app } from 'electron'
import { createHash } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, join, relative } from 'path'
import type { BaseDataPaths } from '../models/paths'

/** 资源目录名（electron-builder `extraResources.to = 'room-seed'`） */
export const ROOM_SEED_DIR = 'room-seed'

/** seed 记账文件名（放在 `<data>/room/`；不是外观配置，读取方只认固定文件名） */
export const SEED_MANIFEST_FILE = '.room-seed.json'

/**
 * 0.53.8~0.53.10 随包的旧背景哈希（AI1/AI2 共用同一套图）。
 * 用来把「旧 seed 写入、用户没改过」的文件识别出来并替换掉；用户改过的文件哈希不同，会被保留。
 * 新增/重生成素材时**不要**把这些哈希改成新值——它们描述的是历史包，不是当前包。
 */
export const LEGACY_SEED_HASHES: ReadonlySet<string> = new Set([
  'c68e3cda54f7dfa597968ca2d9d3ee3999c3a5cbd83f5ccce07c0edda41fb08a', // AI1/AI2 appearance.json
  '9edb6c86054c36de405132408c448cc9e10db010f57d536e75b713b3353cb0b1', // background.jpg / home.jpg
  'faf61b2c736e8b56060cd765f7f38bf0e3618cf84c785c1d8e55a9a69261ef61', // plan.jpg
  '7f5f8caa72148292b3b2c81d757609869f2a9b72ecee9edb9d81a70399294430', // work.jpg
  '6b8c7495005042c8a7f0bd2cfbae3d4b8deb0ed5ccd216dba6db9be541371349', // memory.jpg
  '0e32a62838b2a9ac9e8a1df09222a885e9a69190214d2904b28d25684a3b418c', // device.jpg
  'eab2f1cb7acfdcf107e2893d554f616cdf7b2fffd58e1a1b8ef4aa3293ddc519' // lan.jpg
])

/** 旧 seed 曾写过、但新 seed 不再使用的路径；内容命中旧哈希时删除（用户改过的保留） */
const LEGACY_SEED_PATHS = [
  'AI1/background/background.jpg',
  'AI1/scenes/home.jpg',
  'AI1/scenes/plan.jpg',
  'AI1/scenes/work.jpg',
  'AI1/scenes/memory.jpg',
  'AI1/scenes/device.jpg',
  'AI1/scenes/lan.jpg',
  'AI2/background/background.jpg',
  'AI2/scenes/home.jpg',
  'AI2/scenes/plan.jpg',
  'AI2/scenes/work.jpg',
  'AI2/scenes/memory.jpg',
  'AI2/scenes/device.jpg',
  'AI2/scenes/lan.jpg'
] as const

interface SeedManifest {
  version: 2
  files: Record<string, string>
}

function sha256File(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

function readManifest(dst: string): SeedManifest | null {
  try {
    const raw = JSON.parse(readFileSync(join(dst, SEED_MANIFEST_FILE), 'utf-8')) as Partial<SeedManifest>
    if (!raw || typeof raw !== 'object' || !raw.files || typeof raw.files !== 'object') return null
    const files: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw.files)) {
      if (typeof k === 'string' && typeof v === 'string') files[k] = v
    }
    return { version: 2, files }
  } catch {
    return null
  }
}

function writeManifest(dst: string, files: Record<string, string>): void {
  try {
    mkdirSync(dst, { recursive: true })
    const sorted: Record<string, string> = {}
    for (const k of Object.keys(files).sort()) sorted[k] = files[k]
    writeFileSync(join(dst, SEED_MANIFEST_FILE), `${JSON.stringify({ version: 2, files: sorted }, null, 2)}\n`, 'utf-8')
  } catch (err) {
    // 记账失败不影响素材本身；下次会把它当成「用户文件」保守跳过，不会误删
    console.error('[room] seed 记账写入失败：', err)
  }
}

function walkFiles(
  root: string,
  src: string,
  dst: string,
  out: Array<{ rel: string; from: string; to: string }> = []
): Array<{ rel: string; from: string; to: string }> {
  let entries: string[]
  try {
    entries = readdirSync(src)
  } catch {
    return out
  }
  for (const name of entries) {
    const from = join(src, name)
    const to = join(dst, name)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(from)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walkFiles(root, from, to, out)
      continue
    }
    if (!st.isFile()) continue
    out.push({ rel: relative(root, from).replace(/\\/g, '/'), from, to })
  }
  return out
}

/** 清掉因删除而变空的父目录（只往上清到 room 根，不越界） */
function pruneEmptyParents(path: string, dst: string): void {
  let dir = dirname(path)
  while (dir.length > dst.length && existsSync(dir) && readdirSync(dir).length === 0) {
    rmSync(dir, { recursive: true, force: true })
    dir = dirname(dir)
  }
}

/** 删除旧 seed 路径（只在内容与历史哈希一致时）；返回删除数量。 */
function pruneLegacy(dst: string): number {
  let removed = 0
  for (const rel of LEGACY_SEED_PATHS) {
    const path = join(dst, rel)
    if (!existsSync(path)) continue
    const hash = sha256File(path)
    if (!hash || !LEGACY_SEED_HASHES.has(hash)) continue
    try {
      rmSync(path, { force: true })
      removed += 1
      pruneEmptyParents(path, dst)
    } catch (err) {
      console.error(`[room] 旧 seed 文件删除失败：${rel}`, err)
    }
  }
  return removed
}

/**
 * 删除「上次由我们写入、但新包已不再提供」的文件（如废弃的六分区场景图）。
 * 只在内容仍与记账哈希一致时删除；用户改过的文件哈希不同，会被保留。
 */
function pruneOrphans(dst: string, owned: Record<string, string>, shipped: ReadonlySet<string>): number {
  let removed = 0
  for (const [rel, hash] of Object.entries(owned)) {
    if (shipped.has(rel)) continue
    const path = join(dst, rel)
    if (!existsSync(path)) continue
    if (sha256File(path) !== hash) continue
    try {
      rmSync(path, { force: true })
      removed += 1
      pruneEmptyParents(path, dst)
    } catch (err) {
      console.error(`[room] 停用 seed 文件删除失败：${rel}`, err)
    }
  }
  return removed
}

/**
 * 递归复制「目标不存在的文件」，返回复制数量。
 * 保留给旧调用方/测试；新 seed 逻辑用 `copyTreeSeeded`（带哈希记账与升级）。
 */
export function copyTreeMissing(src: string, dst: string): number {
  let copied = 0
  let entries: string[]
  try {
    entries = readdirSync(src)
  } catch {
    return 0
  }
  for (const name of entries) {
    const from = join(src, name)
    const to = join(dst, name)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(from)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      copied += copyTreeMissing(from, to)
      continue
    }
    if (existsSync(to)) continue
    try {
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
      copied += 1
    } catch {
      // 单个文件失败（占用/权限）不阻断其余素材
    }
  }
  return copied
}

/**
 * 带记账的 seed 复制：见文件头 1~4 条规则。返回「复制 + 删除」的文件数。
 * 导出是为了单测能直接喂临时目录，不必启动 Electron。
 */
export function copyTreeSeeded(src: string, dst: string): number {
  const manifest = readManifest(dst)
  const owned = manifest?.files ?? {}
  const nextFiles: Record<string, string> = {}
  let changed = 0
  const entries = walkFiles(src, src, dst)
  const shipped = new Set(entries.map((e) => e.rel))

  for (const { rel, from, to } of entries) {
    const srcHash = sha256File(from)
    if (!srcHash) continue
    if (!existsSync(to)) {
      try {
        mkdirSync(dirname(to), { recursive: true })
        copyFileSync(from, to)
        nextFiles[rel] = srcHash
        changed += 1
      } catch (err) {
        console.error(`[room] seed 写入失败：${rel}`, err)
      }
      continue
    }
    const targetHash = sha256File(to)
    if (!targetHash) continue
    if (targetHash === srcHash) {
      // 已经是当前素材：记下来，下次仍视为我们拥有
      nextFiles[rel] = targetHash
      continue
    }
    const wasOurs = owned[rel] === targetHash || LEGACY_SEED_HASHES.has(targetHash)
    if (!wasOurs) continue // 用户自己的文件：不动、不记账
    try {
      copyFileSync(from, to)
      nextFiles[rel] = srcHash
      changed += 1
    } catch (err) {
      console.error(`[room] seed 覆盖失败：${rel}`, err)
      // 覆盖失败时保留旧文件；不记入 nextFiles，避免下次误判为我们拥有
    }
  }

  changed += pruneLegacy(dst)
  changed += pruneOrphans(dst, owned, shipped)
  writeManifest(dst, nextFiles)
  return changed
}

/**
 * 解析 seed 源目录：打包态读 `resources/room-seed`，开发态读 `app/assets/room-seed`。
 * 单测 / 非 Electron 环境（没有 `app.getAppPath`）返回 null。
 */
export function resolveSeedRoot(): string | null {
  if (!app || typeof app.getAppPath !== 'function') return null
  const root = app.isPackaged ? join(process.resourcesPath, ROOM_SEED_DIR) : join(app.getAppPath(), 'assets', ROOM_SEED_DIR)
  return existsSync(root) ? root : null
}

/**
 * 启动时写入随包素材；返回「复制 + 删除」的文件数，未就绪 / 无素材目录返回 null。
 * 失败不阻断启动：单个文件复制失败只跳过，整体异常由调用方记日志。
 */
export function seedRoomAssets(paths: BaseDataPaths): number | null {
  const src = resolveSeedRoot()
  if (!src) return null
  return copyTreeSeeded(src, join(paths.root, 'room'))
}
