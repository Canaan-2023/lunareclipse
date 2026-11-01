/**
 * 会话目录落盘器（SessionStore 的写侧外移）。
 *
 * 为什么存在：会话写盘逻辑（分片 tmp → rename → meta 原子写 → 清旧片 → 删旧单文件）
 * 与 flush 代数机制在被加入 0.53.20 的退出竞态修复后，把 `session-store.ts` 顶过 800 行
 * 硬红线。本模块只承载「写目录 / 原子写 / flush 代数比对」这一组职责，SessionStore 保留
 * 缓存、写队列、flush 编排与读侧；依赖（目录推导 / 分片上限 / legacy 路径 / 代数读取）全部注入。
 *
 * 不删理由：写盘顺序是会话数据完整性的提交协议（meta 为提交点）；实现与注释必须同址可读，
 * 拆散会重演「async 路径未原子化 → 半截 meta → 会话不可见」事故。
 *
 * 写盘协议（与 session-store.ts 文件头一致）：
 * 分片 tmp → rename 逐片覆盖 → meta 原子写（提交点，新 shardCount 生效）→ 清多余旧片 → 删旧单文件。
 */
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'fs'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import type { ChatMessage, Session } from '@shared/types'
import { renameFileWithRetry } from '../utils/atomic-write'
import type { SessionMeta } from './session-store'

export interface SessionFileWriterDeps {
  /** 会话用户层目录：{store.dir}/{id}/user */
  userDir: (id: string) => string
  /** 旧单文件形态路径（写新形态后删除） */
  legacyPath: (id: string) => string
  /** 当前分片字节上限（设置页可改） */
  shardMaxBytes: () => number
  /** 当前 flush 代数：同步 flush 递增，异步写在提交点比对并放弃旧快照 */
  flushEpoch: () => number
}

/** 写会话文件夹（同步）：flush / 旧数据迁移用 */
export function writeSessionFilesSync(deps: SessionFileWriterDeps, id: string, session: Session): void {
  const udir = deps.userDir(id)
  mkdirSync(udir, { recursive: true })
  const shards = splitShards(session.messages ?? [], deps.shardMaxBytes())
  const pairs: Array<{ tmp: string; final: string }> = []
  for (let i = 0; i < shards.length; i++) {
    const final = join(udir, `${i + 1}.json`)
    // 独立后缀：可能与被 flush 打断的在飞异步写同时命中同一目录，不能共用 `<final>.tmp`
    const tmp = final + '.flush.tmp'
    writeFileSync(tmp, shards[i], 'utf-8')
    pairs.push({ tmp, final })
  }
  for (const { tmp, final } of pairs) renameFileWithRetry(tmp, final)
  atomicWriteSync(join(udir, 'meta.json'), JSON.stringify(buildMeta(session, shards.length)))
  pruneShards(udir, shards.length)
  removeLegacy(deps, id)
}

/** 写会话文件夹（异步）：flushQueue 用，tmp 写不阻塞事件循环 */
export async function writeSessionFilesAsync(
  deps: SessionFileWriterDeps,
  id: string,
  session: Session,
  epoch: number
): Promise<void> {
  const udir = deps.userDir(id)
  mkdirSync(udir, { recursive: true })
  const shards = splitShards(session.messages ?? [], deps.shardMaxBytes())
  const pairs: Array<{ tmp: string; final: string }> = []
  for (let i = 0; i < shards.length; i++) {
    const final = join(udir, `${i + 1}.json`)
    const tmp = final + '.tmp'
    await writeFile(tmp, shards[i], 'utf-8')
    pairs.push({ tmp, final })
  }
  // 提交前比对 flush 代数：同步 flush 已写入更新快照时，放弃本次旧快照（并清理 tmp）
  if (epoch !== deps.flushEpoch()) {
    for (const { tmp } of pairs) {
      try {
        unlinkSync(tmp)
      } catch {
        /* 已被 flush 覆盖或清理，忽略 */
      }
    }
    return
  }
  for (const { tmp, final } of pairs) renameFileWithRetry(tmp, final)
  // meta 是提交点：同步路径用 atomicWriteSync(tmp+rename) 保证原子性，
  // 异步路径原先直接 writeFile 未原子化——崩溃可能留下半截 meta → 会话用户层整体不可见。
  await atomicWrite(
    join(udir, 'meta.json'),
    JSON.stringify(buildMeta(session, shards.length)),
    epoch,
    deps.flushEpoch
  )
  pruneShards(udir, shards.length)
  removeLegacy(deps, id)
}

function pruneShards(udir: string, shardCount: number): void {
  for (const f of readdirSync(udir)) {
    if (/^\d+\.json$/.test(f) && parseInt(f, 10) > shardCount) {
      try {
        unlinkSync(join(udir, f))
      } catch {
        /* 残留旧片清理失败不影响正确性（读取按 shardCount 截断） */
      }
    }
  }
}

function removeLegacy(deps: SessionFileWriterDeps, id: string): void {
  const legacy = deps.legacyPath(id)
  if (!existsSync(legacy)) return
  try {
    unlinkSync(legacy)
  } catch (err) {
    console.error(`Failed to remove legacy session file ${legacy}:`, err)
  }
}

/** 原子写（同步）：tmp 用独立后缀（见 sync 写注释），rename 是提交点 */
function atomicWriteSync(path: string, data: string): void {
  const tmp = path + '.flush.tmp'
  writeFileSync(tmp, data, 'utf-8')
  renameFileWithRetry(tmp, path)
}

/** 原子写（异步）：epoch 为 flush 代数，提交前若已被同步 flush 超越则丢弃旧快照 */
async function atomicWrite(
  path: string,
  data: string,
  epoch: number,
  flushEpoch: () => number
): Promise<void> {
  const tmp = path + '.tmp'
  await writeFile(tmp, data, 'utf-8')
  if (epoch !== flushEpoch()) {
    try {
      unlinkSync(tmp)
    } catch {
      /* 忽略 */
    }
    return
  }
  renameFileWithRetry(tmp, path)
}

function buildMeta(session: Session, shardCount: number): SessionMeta {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.aiId !== undefined ? { aiId: session.aiId } : {}),
    ...(session.model !== undefined ? { model: session.model } : {}),
    // 0.53 改名：写入新字段 codeReview（旧字段只由读取层兼容，不再写盘）
    ...(session.codeReview !== undefined ? { codeReview: session.codeReview } : {}),
    ...(session.summary !== undefined ? { summary: session.summary } : {}),
    ...(session.summaryCursorAt !== undefined ? { summaryCursorAt: session.summaryCursorAt } : {}),
    shardCount
  }
}

/**
 * 消息切分片：按 UTF-8 序列化字节（精确增量计数：数组 = [ + 元素以 , 分隔 + ]）。
 * 超限时开新片；单条消息超限独立成片（消息不跨片）。
 */
function splitShards(messages: ChatMessage[], maxBytes: number): string[] {
  const shards: string[] = []
  let current: ChatMessage[] = []
  let currentBytes = 0
  for (const m of messages) {
    const mJson = JSON.stringify(m)
    const mBytes = Buffer.byteLength(mJson, 'utf-8')
    const projected = current.length === 0 ? mBytes + 2 : currentBytes + 1 + mBytes
    if (current.length > 0 && projected > maxBytes) {
      shards.push(JSON.stringify(current))
      current = []
      currentBytes = 0
    }
    current.push(m)
    currentBytes = current.length === 1 ? mBytes + 2 : currentBytes + 1 + mBytes
  }
  if (current.length > 0) shards.push(JSON.stringify(current))
  return shards
}
