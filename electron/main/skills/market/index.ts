/**
 * Skill 市场：让用户从内置清单 / 本地目录安装第三方技能，
 * 是技能生态扩张的入口。负责市场源管理、安装/更新/卸载/同步全生命周期，
 * 安装时经 frontmatter 校验、工具名适配与来源锁定后，按「文件夹即领域」落位：
 * 技能在领域级目录树中的父路径即领域（skills_domains/{领域路径}/），平铺/用户级落用户级。
 */
import { mkdirSync } from 'fs'
import { join } from 'path'
import type { LanEnvelope } from '../../multi-instance/lan/lan-types'
import { getDomainSkillsDir, getUserSkillsDir, type SkillLoader } from '../loader'
import { createManifestStore, type MarketStore } from './manifest-store'
import type { MarketHost, MarketSkillListEntry } from './market-host'
import type { MarketProgress, MarketSource, SkillMarketLanDeps } from './market-types'
import {
  addSource as addSourceFn,
  domainOfSubdir as domainOfSubdirFn,
  ensureBuiltinSource as ensureBuiltinSourceFn,
  fetchJsonList as fetchJsonListFn,
  findEntry as findEntryFn,
  listMarketSkills as listMarketSkillsFn,
  listSources as listSourcesFn,
  removeSource as removeSourceFn,
  resolveDirSourceUrl as resolveDirSourceUrlFn,
  resolveSkillDir as resolveSkillDirFn,
  scanRepoForSkills as scanRepoForSkillsFn,
  scanSkillTree as scanSkillTreeFn
} from './source-repo'
import {
  copySkillTree as copySkillTreeFn,
  getDomainSkillsDir as getDomainSkillsDirFn,
  getInstalled as getInstalledFn,
  getUserSkillsDir as getUserSkillsDirFn,
  install as installFn,
  isInstalledOnDisk as isInstalledOnDiskFn,
  listSkillFiles as listSkillFilesFn,
  markUserModified as markUserModifiedFn,
  remove as removeFn,
  resolveInstalledDir as resolveInstalledDirFn,
  syncAll as syncAllFn,
  update as updateFn
} from './installer'
import {
  applyReplay as applyReplayFn,
  applyTombstone as applyTombstoneFn,
  applyUpload as applyUploadFn,
  broadcastToPeers as broadcastToPeersFn,
  canDeleteEntry as canDeleteEntryFn,
  collectLanFiles as collectLanFilesFn,
  domainOfUploadDir as domainOfUploadDirFn,
  handleLanEnvelope as handleLanEnvelopeFn,
  handlePeerStatus as handlePeerStatusFn,
  isSafeRelPath as isSafeRelPathFn,
  marketRepoSkillDir as marketRepoSkillDirFn,
  migrateRetiredUploadsLayer as migrateRetiredUploadsLayerFn,
  readUploadBody as readUploadBodyFn,
  readUploadLanFiles as readUploadLanFilesFn,
  respondSyncWant as respondSyncWantFn,
  scanSkillTreeForThreats as scanSkillTreeForThreatsFn,
  unpublish as unpublishFn,
  uploadSkill as uploadSkillFn
} from './upload-sync'
export { getMarketRoot } from './manifest-store'
export type { MarketStore } from './manifest-store'
export { BUILTIN_SOURCE_URL, isStructuralContainerDir, scopeKeyOf } from './market-types'
export type {
  InstalledSkill,
  MarketManifest,
  MarketProgress,
  MarketSkillEntry,
  MarketSource,
  RemovedSkillRecord,
  SkillMarketLanDeps,
  SkillMarketRemovePayload,
  SkillMarketReplayPayload,
  SkillMarketSyncWantPayload,
  SkillMarketTombstonePayload,
  SkillMarketUploadPayload,
  UploadedSkillRecord
} from './market-types'

/**
 * Skill 市场（技能市场本土化）：
 * - 源管理：内置官方清单 URL + 用户 addSource（清单 JSON / 本地目录）
 * - 安装：从来源目录复制 → frontmatter 校验 + 工具名适配 → 按目录领域落位复制
 * （领域级 skills_domains/{领域路径}/{name} 或用户级）→ 来源锁定 → 热重载
 * - 更新：sha/version 对比，userModified 跳过
 * - 卸载：按安装记录 domain 定位删除 + 清记录（内置/领域级拒绝）
 * - 同步：批量检查已装 skill 更新
 * - 上传：本机技能发布进内置市场仓库（用户级 skills/{name}、领域级
 *   skills_domains/{领域}/{name}），并经局域网广播同步——上传即分发，
 *   仓库内容随包分发、属月蚀系统的一部分

 * 数据：{userData}/skill-market/manifest.json
 * { sources: [{id, name, url, type}], installed: {name: {source, version, sha, installedAt, userModified, synced, domain}} }
 */


export class SkillMarket {
  private marketDir: string
  private cacheDir: string
  private loader: SkillLoader
  private onProgress?: (p: MarketProgress) => void
  /** 市场内容变更回调（index.ts 接线为广播 skills:changed；上传/下架/局域网收端后触发） */
  private onChange?: (() => void) | null
  /** 市场 × 局域网依赖（主分系统共享市场；未注入时本地上传/下架仍可用） */
  private lan?: SkillMarketLanDeps
  /** 用户级 skills 目录 provider（默认 getUserSkillsDir()，测试可注入字符串） */
  private userSkillsDirProvider: () => string
  /** 领域级 skills 目录 provider（默认 getDomainSkillsDir()，测试可注入字符串）。
   * 领域级按 skills_domains/{domain}/{name} 落位，不跟用户级混放。 */
  private domainSkillsDirProvider: () => string
  /** 内置市场仓库目录（随包分发，resources/skills/market-repo）；为空则不自动注册 */
  private builtinRepoDir: string
  /** manifest.json 唯一 owner（ADR-05）：内存态 + 原子写 + 作用域安装记录 */
  private readonly store: MarketStore
  /** 五模块宿主句柄（闭包引用本实例成员，见 buildHost） */
  private readonly host: MarketHost

  constructor(
    marketDir: string,
    loader: SkillLoader,
    userSkillsDir?: string | (() => string),
    builtinRepoDir?: string,
    domainSkillsDir?: string | (() => string)
  ) {
    this.marketDir = marketDir
    this.cacheDir = join(marketDir, '.cache')
    this.loader = loader
    /**
     * userSkillsDir 动态求值而不是构造时固化：
     * 为什么存在——SkillMarket 常在启动早期（未登录）构造，若此时固化
     * getUserSkillsDir() 会得到顶层 {root}/skills；登录后 install/remove
     * 也写这个固化路径，而 SkillLoader 登录后按 U{uid}/AI{aiId} 前缀分层扫描，
     * 安装即不可见（已装技能列表不显示的直接原因）；
     * 什么作用——install/remove 每次经 provider 按当前 uid/aiId 解析目标目录，
     * 与 loader 扫描路径始终一致；测试传字符串仍兼容（包一层 () => string）。
     */
    this.userSkillsDirProvider =
      typeof userSkillsDir === 'function'
        ? userSkillsDir
        : userSkillsDir
          ? () => userSkillsDir
          : () => getUserSkillsDir()
    // domainSkillsDirProvider 与 userSkillsDirProvider 同型：
    // 登录后 install/remove 按当前 uid/aiId 动态解析领域级目录（skills_domains 域），
    // 与 loader 的 getDomainSkillsDir() 扫描路径保持一致，测试可传字符串覆盖。
    this.domainSkillsDirProvider =
      typeof domainSkillsDir === 'function'
        ? domainSkillsDir
        : domainSkillsDir
          ? () => domainSkillsDir
          : () => getDomainSkillsDir()
    this.builtinRepoDir = builtinRepoDir ?? ''
    mkdirSync(marketDir, { recursive: true })
    mkdirSync(this.cacheDir, { recursive: true })
    this.store = createManifestStore(marketDir)
    // 退役 local://uploads 层的一次性迁移/清理：必须在 ensureBuiltinSource 之前，
    // 保证任何消费方（listSources/listMarketSkills）读到的是归一化后的源清单。
    this.host = this.buildHost()
    this.host.migrateRetiredUploadsLayer()
    // 首次启动自动注册内置市场源：
    // 为什么存在——内置市场仓库随安装包分发，若首启不自动注册，用户看到空市场
    // 还要手动去设置页添加本地目录源，分发价值打折；
    // 什么作用——manifest 为空（从未建过源）且有内置仓库时，以 dir 源形式注册一次，
    // 用户打开技能市场即可直接浏览/安装 10 个内置技能；
    // 留存理由——仅当 manifest 无源且仓库目录真实存在时注册（幂等：已建过源或
    // 仓库缺失都不触发），用户后续可自行增删源，不影响现有源管理流程。
    this.host.ensureBuiltinSource()
  }









  setProgressCallback(cb: (p: MarketProgress) => void): void {
    this.onProgress = cb
  }

  /** 注入市场 × 局域网依赖（index.ts 在 startLan 后接线；未注入则上传/下架仅本机生效） */
  setLanDeps(deps: SkillMarketLanDeps): void {
    this.lan = deps
  }

  /**
   * 注入「市场内容变更」回调（index.ts 接线为广播 skills:changed）。
   * 为什么存在——上传/下架/局域网收到上传或墓碑都会改变市场列表内容，但落点
   * 不在 SkillLoader 监听目录内，loader 的变更回调不会触发；此前已打开的市场
   * 视图因此不自动刷新（列表内上传后要手动重载）。
   * 什么作用——上述写盘动作成功后调用 onChange，渲染侧据此重拉市场与已装列表；
   * 留存理由——与 loader.setChangeCallback 同型，是市场侧唯一的刷新触发源，
   * 删除会退回「上传后市场不刷新」的缺陷。
   */
  setChangeCallback(cb: (() => void) | null): void {
    this.onChange = cb
  }


  // ===== 源管理 =====





  // ===== 安装 =====


  // ===== 更新 =====


  // ===== 卸载 =====






















  // ===== 内部实现 =====













  // ===== 五模块委托（ADR-05）：实现已外移 ./market/*，宿主只保留编排、回调注入与协议锚点 =====

  listSources(): MarketSource[] {
    return listSourcesFn(this.host)
  }
  addSource(name: string, url: string): { ok: boolean; error?: string } {
    return addSourceFn(this.host, name, url)
  }
  removeSource(id: string): { ok: boolean; error?: string } {
    return removeSourceFn(this.host, id)
  }
  listMarketSkills(): Promise<MarketSkillListEntry[]> {
    return listMarketSkillsFn(this.host)
  }
  install(name: string): ReturnType<typeof installFn> {
    return installFn(this.host, name)
  }
  update(name: string): Promise<{ ok: boolean; error?: string }> {
    return updateFn(this.host, name)
  }
  remove(name: string): { ok: boolean; error?: string } {
    return removeFn(this.host, name)
  }
  syncAll(): Promise<{ ok: boolean; updated: string[]; errors: string[] }> {
    return syncAllFn(this.host)
  }
  markUserModified(name: string): void {
    markUserModifiedFn(this.host, name)
  }
  uploadSkill(skillDir: string): ReturnType<typeof uploadSkillFn> {
    return uploadSkillFn(this.host, skillDir)
  }
  unpublish(name: string): Promise<{ ok: boolean; error?: string }> {
    return unpublishFn(this.host, name)
  }
  handleLanEnvelope(env: LanEnvelope): void {
    handleLanEnvelopeFn(this.host, env)
  }
  handlePeerStatus(ev: import('../../multi-instance/lan/lan-types').LanPeerStatusEvent): void {
    handlePeerStatusFn(this.host, ev)
  }

  /**
   * 五模块宿主句柄：以闭包转接本实例成员与四模块函数（读时取当前值，与直接 `this.x` 等价）。
   * 为什么用闭包而不把 this 传出去：直接传 this 要求全部内部成员放宽为 public
   * （TS 私有成员不满足接口）；闭包方案零可见性放宽，模块只依赖它真正需要的成员。
   */
  private buildHost(): MarketHost {
    // ⚠️ lan 由 setLanDeps 在**构造之后**注入，故必须惰性读取；且对象字面量 getter 里的 `this`
    // 指向字面量自身，因此用「读函数」闭包捕获实例（与 ADR-09 relay-service 的 buildHost 同法）。
    const readLan = (): SkillMarketLanDeps | undefined => this.lan
    return {
      store: this.store,
      loader: this.loader,
      get lan() {
        return readLan()
      },
      builtinRepoDir: this.builtinRepoDir,
      marketDir: this.marketDir,
      cacheDir: this.cacheDir,
      userSkillsDirProvider: () => this.userSkillsDirProvider(),
      domainSkillsDirProvider: () => this.domainSkillsDirProvider(),
      emitProgress: (p) => this.onProgress?.(p),
      emitChange: () => this.onChange?.(),
      listSources: () => listSourcesFn(this.host),
      addSource: (n, u) => addSourceFn(this.host, n, u),
      removeSource: (id) => removeSourceFn(this.host, id),
      listMarketSkills: () => listMarketSkillsFn(this.host),
      ensureBuiltinSource: () => ensureBuiltinSourceFn(this.host),
      resolveDirSourceUrl: (u) => resolveDirSourceUrlFn(this.host, u),
      scanRepoForSkills: (d) => scanRepoForSkillsFn(this.host, d),
      scanSkillTree: (r, rel, root, dr) => scanSkillTreeFn(this.host, r, rel, root, dr),
      domainOfSubdir: (sub, dr) => domainOfSubdirFn(this.host, sub, dr),
      fetchJsonList: (u) => fetchJsonListFn(this.host, u),
      findEntry: (n) => findEntryFn(this.host, n),
      resolveSkillDir: (src, e) => resolveSkillDirFn(this.host, src, e),
      getUserSkillsDir: () => getUserSkillsDirFn(this.host),
      getDomainSkillsDir: () => getDomainSkillsDirFn(this.host),
      resolveInstalledDir: (n, d) => resolveInstalledDirFn(this.host, n, d),
      getInstalled: (n) => getInstalledFn(this.host, n),
      isInstalledOnDisk: (n, d) => isInstalledOnDiskFn(this.host, n, d),
      install: (n) => installFn(this.host, n),
      update: (n) => updateFn(this.host, n),
      remove: (n) => removeFn(this.host, n),
      syncAll: () => syncAllFn(this.host),
      markUserModified: (n) => markUserModifiedFn(this.host, n),
      listSkillFiles: (d) => listSkillFilesFn(this.host, d),
      copySkillTree: (a, b) => copySkillTreeFn(this.host, a, b),
      marketRepoSkillDir: (n, d) => marketRepoSkillDirFn(this.host, n, d),
      canDeleteEntry: (r) => canDeleteEntryFn(this.host, r),
      uploadSkill: (d) => uploadSkillFn(this.host, d),
      domainOfUploadDir: (d) => domainOfUploadDirFn(this.host, d),
      scanSkillTreeForThreats: (d) => scanSkillTreeForThreatsFn(this.host, d),
      collectLanFiles: (d) => collectLanFilesFn(this.host, d),
      isSafeRelPath: (r) => isSafeRelPathFn(this.host, r),
      unpublish: (n) => unpublishFn(this.host, n),
      broadcastToPeers: (t, p) => broadcastToPeersFn(this.host, t, p),
      handleLanEnvelope: (e) => handleLanEnvelopeFn(this.host, e),
      handlePeerStatus: (e) => handlePeerStatusFn(this.host, e),
      applyUpload: (p) => applyUploadFn(this.host, p),
      applyTombstone: (p) => applyTombstoneFn(this.host, p),
      respondSyncWant: (f, w) => respondSyncWantFn(this.host, f, w),
      applyReplay: (p) => applyReplayFn(this.host, p),
      readUploadBody: (n) => readUploadBodyFn(this.host, n),
      readUploadLanFiles: (n) => readUploadLanFilesFn(this.host, n),
      migrateRetiredUploadsLayer: () => migrateRetiredUploadsLayerFn(this.host)
    }
  }
}

export { isSafeUrl, isPrivateHost } from '../url-safety'
export { TOOL_NAME_MAP, adaptToolNames } from '../tool-name-adapt'
