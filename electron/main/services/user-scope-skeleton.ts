/**
 * 用户作用域目录骨架创建（多 AI 场景共享入口）。
 *
 * 为什么存在——自定义 AI 是运行时按注册表（ai-registry.json）动态注册/顺延编号的，
 * 数量未来会持续增长。路径解析（resolveScopePaths / scopedDomainPath）本身参数化、
 * 对任意 aiId 都成立，但 `目录骨架` 不能只依赖"登录时的那次遍历"：
 * - 登录/注册时：index.ts 的 scopeInitializer 遍历**当时**注册表所有 AI 建目录；
 * - 运行期新增 AI：ai:register / create_ai 创建成功后才写入注册表，登录时的遍历
 * 不会覆盖到它——若不在创建时补建骨架，新 AI 立即切会话/装技能/写 config 会
 * 因目录不存在而失败（或静默丢配置）。
 *
 * 本模块收敛"为一个用户建全部已注册 AI 骨架"的唯一实现，供以下三处复用：
 * 1. index.ts scopeInitializer（登录/注册骨架）；
 * 2. ai:register IPC（面板新建 AI 后补建）；
 * 3. create_ai 工具（AI 自建 AI 后补建）。
 *
 * 幂等：mkdirSync recursive + 存在性判断，重复调用安全。
 */
import { existsSync, mkdirSync, renameSync, rmdirSync } from 'fs'
import { dirname, join } from 'path'
import { readAiRegistry } from '../models/ai-registry'
import { writeNngRoot, writeCacheIndex } from '../models/index-files'
import { resolveScopePaths, scopedDomainPath, type BaseDataPaths, type MemoryScope } from '../models/paths'

/**
 * sessions 旧裸数字分层 {root}/sessions/{uid}/{aiId} → U/AI 字面前缀 {root}/sessions/U{uid}/AI{aiId}。
 * 为什么存在——sessions 曾是唯一保留裸数字的作用域（与 memory/NNG/cache 的 U/AI 前缀不一致，
 * 属历史欠账）；本函数幂等迁移：目标已存在（新数据）或源不存在时跳过，不覆盖不重复搬。
 * 收敛在本骨架入口的意义：登录/注册/运行期建新 AI 都会经过 ensureUserScopeSkeleton，
 * 一次进入即可顺带迁移该 uid 全部已注册 AI 的 sessions 旧目录。
 */
function migrateLegacySessions(dataPaths: BaseDataPaths, scope: MemoryScope): void {
  const { uid, aiId } = scope
  const legacy = join(dataPaths.root, 'sessions', String(uid), String(aiId))
  const target = join(dataPaths.root, 'sessions', `U${uid}`, `AI${aiId}`)
  if (existsSync(target) || !existsSync(legacy)) return
  try {
    // rename 要求目标父目录存在：先补建 U{uid} 骨架，再整目录搬移
    mkdirSync(dirname(target), { recursive: true })
    renameSync(legacy, target)
    // 迁移成功后清理遗留空父目录 {root}/sessions/{uid}（非空说明仍有其它 AI 残留，跳过）
    try {
      rmdirSync(dirname(legacy))
    } catch {
      /* 父目录非空或已不存在，忽略 */
    }
  } catch (err) {
    console.error(`[scope-skeleton] sessions 旧分层迁移失败 (uid=${uid}, aiId=${aiId}):`, err)
  }
}

/** 为一个用户补建全部已注册 AI 的作用域目录骨架（幂等，失败逐 AI 隔离不中断） */
export function ensureUserScopeSkeleton(dataPaths: BaseDataPaths, uid: number): void {
  let registry
  try {
    registry = readAiRegistry(dataPaths.aiRegistryJson)
  } catch (err) {
    console.error(`[scope-skeleton] 读取 AI 注册表失败 (uid=${uid}):`, err)
    return
  }
  for (const ai of registry.ais) {
    try {
      const scoped = resolveScopePaths(dataPaths, { uid, aiId: ai.id })
      // sessions 旧裸数字分层 → U/AI 前缀迁移（幂等；登录/注册/建新 AI 均经此入口）
      migrateLegacySessions(dataPaths, { uid, aiId: ai.id })
      mkdirSync(scoped.sessions, { recursive: true })
      mkdirSync(scoped.rawMemory, { recursive: true })
      mkdirSync(scoped.memoryNormal, { recursive: true })
      mkdirSync(scoped.memoryMeta, { recursive: true })
      mkdirSync(scoped.memoryHigh, { recursive: true })
      mkdirSync(scoped.calendar ?? join(scoped.memoryScope!, 'calendar'), { recursive: true })
      mkdirSync(scoped.diary ?? join(scoped.memoryScope!, 'diary'), { recursive: true })
      // NNG 工作域骨架（ROOT 索引 + 一级节点目录）：create_nng/nng_graph 的根，
      // 缺失则 nng_graph 报"起点不存在"、create_nng 的 readdirSync 抛 ENOENT → 子 agent 全线建不了 NNG
      mkdirSync(scoped.nngLevel1Dir, { recursive: true })
      if (!existsSync(scoped.nngRootJson)) {
        writeNngRoot(scoped.nngRootJson, { version: '1.0', updated_at: '', total_nodes: 0, nodes: [] })
      }
      // cache 工作域骨架（与 NNG 同构：索引 + 一级目录 + 注入区）
      mkdirSync(scoped.cacheLevel1Dir, { recursive: true })
      mkdirSync(scoped.cacheInjectionRoot, { recursive: true })
      if (!existsSync(scoped.cacheIndexJson)) {
        writeCacheIndex(scoped.cacheIndexJson, { version: '1.0', updated_at: '', total_entries: 0, cache_list: [] })
      }
      // skills/config 工作域骨架：按 U{uid}/AI{aiId} 前缀分层（与 memory/NNG/cache 语义一致，真源 scopedDomainPath）
      mkdirSync(scopedDomainPath(dataPaths.root, 'skills', uid, ai.id), { recursive: true })
      mkdirSync(scopedDomainPath(dataPaths.root, 'skills_domains', uid, ai.id), { recursive: true })
      mkdirSync(scopedDomainPath(dataPaths.root, 'config', uid, ai.id), { recursive: true })
    } catch (err) {
      console.error(`[scope-skeleton] 用户目录骨架创建失败 (uid=${uid}, aiId=${ai.id}):`, err)
    }
  }
}