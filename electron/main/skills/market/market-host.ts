/**
 * @category 技能市场
 * @summary 五模块的共享契约：宿主句柄 MarketHost
 *
 * 为什么独立成文件：ADR-05 把 SkillMarket 的四类角色逻辑外移后，四个模块需要共同的宿主句柄；
 * 放在本文件（纯类型）可避免「模块 ↔ 宿主」的运行时环。
 * 设计取向（与 ADR-09 同法）：宿主以**闭包**实现（见 index.ts 的 buildHost），故 SkillMarket
 * 的内部成员不必放宽为 public——句柄取值等价于直接 `this.x`。
 */
import type { LanEnvelope, LanPeerStatusEvent } from '../../multi-instance/lan/lan-types'
import type { SkillLoader } from '../loader'
import type { MarketStore } from './manifest-store'
import type {
  InstalledSkill,
  MarketProgress,
  MarketSkillEntry,
  MarketSource,
  SkillMarketLanDeps,
  SkillMarketRemovePayload,
  SkillMarketReplayPayload,
  SkillMarketSyncWantPayload,
  SkillMarketTombstonePayload,
  SkillMarketUploadPayload,
  UploadedSkillRecord
} from './market-types'

/** 市场列表条目（listMarketSkills 的返回元素） */
export type MarketSkillListEntry = MarketSkillEntry & {
  sourceId: string
  installed: boolean
  hasUpdate: boolean
  userModified: boolean
  uploaderUid?: number
  canDelete?: boolean
}

/**
 * 五模块的宿主句柄：只暴露模块真正需要读写的成员（状态切片 + 跨模块能力）。
 * 宿主以**闭包**实现（index.ts 的 buildHost），故「放宽私有成员为 public」不必要。
 */
export interface MarketHost {
  store: MarketStore
  loader: SkillLoader
  lan?: SkillMarketLanDeps
  builtinRepoDir: string
  marketDir: string
  cacheDir: string
  userSkillsDirProvider: () => string
  domainSkillsDirProvider: () => string
  emitProgress(p: MarketProgress): void
  emitChange(): void
  listSources(): MarketSource[]
  addSource(name: string, url: string): { ok: boolean; error?: string }
  removeSource(id: string): { ok: boolean; error?: string }
  listMarketSkills(): Promise<MarketSkillListEntry[]>
  ensureBuiltinSource(): void
  resolveDirSourceUrl(url: string): string
  scanRepoForSkills(dir: string): MarketSkillEntry[]
  scanSkillTree(
    dir: string,
    subdir: string,
    repoRoot: string,
    domainRoot: boolean
  ): Array<{ name: string; description: string; repo: string; subdir: string; sha: string; domain: string | undefined }>
  domainOfSubdir(subdir: string, domainRoot: boolean): string | undefined
  fetchJsonList(url: string): Promise<MarketSkillEntry[]>
  findEntry(name: string): Promise<(MarketSkillEntry & { sourceId: string }) | null>
  resolveSkillDir(source: MarketSource, entry: MarketSkillEntry): Promise<string>
  getUserSkillsDir(): string
  getDomainSkillsDir(): string
  resolveInstalledDir(name: string, domain?: string): string
  getInstalled(name: string): InstalledSkill | null
  isInstalledOnDisk(name: string, domain?: string): boolean
  install(name: string): Promise<{ ok: boolean; error?: string; lint?: unknown; config?: unknown }>
  update(name: string): Promise<{ ok: boolean; error?: string }>
  remove(name: string): { ok: boolean; error?: string }
  syncAll(): Promise<{ ok: boolean; updated: string[]; errors: string[] }>
  markUserModified(name: string): void
  listSkillFiles(dir: string): string[]
  copySkillTree(srcDir: string, destDir: string): void
  marketRepoSkillDir(name: string, domain?: string): string
  canDeleteEntry(rec: UploadedSkillRecord | undefined): boolean
  uploadSkill(skillDir: string): Promise<{ ok: boolean; error?: string; name?: string; lint?: unknown }>
  domainOfUploadDir(skillDir: string): string | undefined
  scanSkillTreeForThreats(skillDir: string): string | null
  collectLanFiles(skillDir: string): Record<string, string>
  isSafeRelPath(rel: string): boolean
  unpublish(name: string): Promise<{ ok: boolean; error?: string }>
  broadcastToPeers(type: string, payload: unknown): void
  handleLanEnvelope(env: LanEnvelope): void
  handlePeerStatus(ev: LanPeerStatusEvent): void
  applyUpload(payload: SkillMarketUploadPayload): void
  applyTombstone(p: SkillMarketRemovePayload | SkillMarketTombstonePayload): void
  respondSyncWant(fromUid: number, want: SkillMarketSyncWantPayload): void
  applyReplay(payload: SkillMarketReplayPayload): void
  readUploadBody(name: string): string
  readUploadLanFiles(name: string): Record<string, string>
  migrateRetiredUploadsLayer(): void
}
