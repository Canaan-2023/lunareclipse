/**
 * @category 技能市场
 * @summary manifest.json 的唯一 owner：内存态 manifest + 原子写 persist + 作用域安装记录读写
 *
 * 为什么独立成文件：ADR-05 §2 的根因——`this.manifest` 被 11 个方法读写、`persist()` 是唯一写盘出口，
 * 写盘点分散是**交错写**风险的来源。收敛为单 owner 后，其余四模块**只经 store 句柄**读写。
 * 不删理由：删掉即回到「多模块各自持 manifest 副本 / 各自 persist」的交错覆盖（快速连发
 * uploadSkill → unpublish 时后写覆盖前写，清单整体损坏）。
 * ⚠️ persist 必须保持原子写（`renameFileWithRetry`，CODE-RULES §3.8）：原实现直接 writeFileSync 覆盖，
 * 写到一半崩溃即截断 manifest.json。
 */
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { renameFileWithRetry } from '../../utils/atomic-write'
import { getCurrentAiId, getCurrentUid } from '../../models/path-context'
import { scopeKeyOf, type InstalledSkill, type MarketManifest, type MarketSource } from './market-types'

export interface MarketStore {
  manifest: MarketManifest
  persist(): void
  currentScopeKey(): string
  readScopeInstalled(): Record<string, InstalledSkill>
  writeScopeInstalled(): Record<string, InstalledSkill>
}

/** 建 store：marketDir 下 manifest.json 为唯一真源（内存态一次加载，persist 原子写回） */
export function createManifestStore(marketDir: string): MarketStore {
  const manifestPath = join(marketDir, 'manifest.json')
  const manifest: MarketManifest = loadManifest()

  /** 当前作用域键：scopeKeyOf(uid, aiId)；未登录（uid/aiId 缺失）禁止解析（与 getScopedPath 同守卫） */
function currentScopeKey(): string {
    const uid = getCurrentUid()
    const aiId = getCurrentAiId()
    if (uid === null || aiId === null) {
      throw new Error('[skill-market] 未登录态禁止解析安装记录作用域（uid/aiId 缺失）：系统要求先登录')
    }
    return scopeKeyOf(uid, aiId)
  }

  /** 只读当前作用域记录表（不存在返回空表；不落盘） */
function readScopeInstalled(): Record<string, InstalledSkill> {
    return manifest.installed[currentScopeKey()] ?? {}
  }

  /** 可写当前作用域记录表（不存在则创建，persist 时才落盘） */
function writeScopeInstalled(): Record<string, InstalledSkill> {
    const key = currentScopeKey()
    let table = manifest.installed[key]
    if (!table) {
      table = {}
      manifest.installed[key] = table
    }
    return table
  }

function loadManifest(): MarketManifest {
    try {
      if (existsSync(manifestPath)) {
        const raw = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Partial<MarketManifest>
        // installed 按作用域分表 { scopeKey: { name: InstalledSkill } }。
        // 旧版全局扁平记录（{ name: InstalledSkill }）不再迁移/兜底——读不到即空表，
        // 「已安装」以磁盘存在性为真源（isInstalledOnDisk），下次安装会覆盖记录。
        return {
          sources: Array.isArray(raw.sources) ? (raw.sources as MarketSource[]) : [],
          installed:
            raw.installed && typeof raw.installed === 'object'
              ? (raw.installed as MarketManifest['installed'])
              : {},
          // uploads/removed 为本版本新增：旧 manifest 缺失时按空表处理，不迁移不兜底
          uploads:
            raw.uploads && typeof raw.uploads === 'object'
              ? (raw.uploads as MarketManifest['uploads'])
              : {},
          removed:
            raw.removed && typeof raw.removed === 'object'
              ? (raw.removed as MarketManifest['removed'])
              : {}
        }
      }
    } catch {
      /* 损坏则重建 */
    }
    return { sources: [], installed: {}, uploads: {}, removed: {} }
  }

function persist(): void {
    // 原子写（0.52.11 放行轮补）：原实现直接 writeFileSync 覆盖 manifest.json——写到一半
    // 崩溃/断电即截断，市场清单（sources/installed/uploads/removed）整体损坏（记录型 store
    // 的数据丢失风险），且 Windows 文件锁下直接覆盖无重试余地。
    // 改「写 .tmp → renameFileWithRetry」，与 session-store / mission-store / state-store 等
    // 记录型 store 的原子写口径一致（CODE-RULES §3.8 判定规则第 1~4 条全中）。
    const tmp = `${manifestPath}.tmp`
    writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf-8')
    renameFileWithRetry(tmp, manifestPath)
  }

  return {
    manifest,
    persist: () => persist(),
    currentScopeKey: () => currentScopeKey(),
    readScopeInstalled: () => readScopeInstalled(),
    writeScopeInstalled: () => writeScopeInstalled()
  }
}

/** 获取市场根目录（用户数据下） */
export function getMarketRoot(dataRoot: string): string {
  return join(dataRoot, 'skill-market')
}