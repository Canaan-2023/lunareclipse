/**
 * 配置存储：应用全局配置（AppConfig，含 LLM / 主题 / 各模块开关）的
 * 载入、校验迁移、分层合并与运行时读写，是全系统配置的单一权威；
 * 设置页与各服务经统一接口读写，插件等 patch 层在此合并生效。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { AppConfig, LLMConfig, ThemeName } from '@shared/types'
import { DEFAULT_CONFIG, inferProvider } from '@shared/types'
import { mergeConfigLayers } from '../kernel/config-layer'

export type ConfigChangeCallback = (newConfig: AppConfig, oldConfig: AppConfig) => void

/**
 * 老主题名 → 新主题名迁移映射。
 * 当前三主题：霜璃（雾白玻璃）/ 素笺（黑黄相间纸质）/ 夜幕（纯黑白边）。
 * 历史主题名（旧三主题 + 藤蔓四主题）统一映射到新三主题，避免落到无效值。
 */
const THEME_MIGRATION: Record<string, ThemeName> = {
  // 旧三主题
  'lunar-eclipse': 'night',          // 旧默认深色 → 夜幕
  'moonlight': 'frost-glass',        // 旧暖白浅色 → 霜璃
  'eclipse-contrast': 'night',       // 旧纯黑高对比 → 夜幕
  // 藤蔓四主题（已废弃）
  'vine-gold': 'parchment',          // 黑金 → 素笺（黑黄）
  'vine-silver': 'night'             // 黑银 → 夜幕
}

function migrateTheme(raw: unknown): ThemeName {
  if (typeof raw !== 'string') return DEFAULT_CONFIG.theme
  if (THEME_MIGRATION[raw]) return THEME_MIGRATION[raw]
  // 已是新主题名之一则原样保留（含紫夜，新增时漏了它导致保存后读回被重置）
  if (raw === 'frost-glass' || raw === 'parchment' || raw === 'night' || raw === 'violet-night' || raw === 'eclipse') {
    return raw as ThemeName
  }
  return DEFAULT_CONFIG.theme
}

/**
 * LLM 接入方式分槽解析/迁移：
 * 老配置（无 profiles）→ 当前扁平值进单槽；新配置 → 保留槽位，active 无效时回退当前 provider 槽。
 * 返回 flat = 当前生效（运行时消费方只读它，零改动）+ profiles = 各接入方式存档（UI 切换恢复用）。
 */
function migrateLlmSlots(
  parsed: Partial<AppConfig>,
  flatKey: 'llm' | 'dmnLlm',
  profilesKey: 'llmProfiles' | 'dmnLlmProfiles',
  activeKey: 'llmActiveProfile' | 'dmnLlmActiveProfile',
  fallback: LLMConfig
): { flat: LLMConfig; profiles: Record<string, LLMConfig>; active: string } {
  const parsedLlm: Partial<LLMConfig> = parsed[flatKey] || {}
  const flat: LLMConfig = { ...fallback, ...parsedLlm }
  // 老配置无 provider 字段时自动推断（⚠️ 必须看 parsed 而非 flat——fallback 的默认
  // provider（openai）会污染判断，导致缺 provider 的网关老配置被归档成 openai 槽）
  if (!parsedLlm.provider) {
    flat.provider = inferProvider(flat.baseURL)
  }
  const rawProfiles = parsed[profilesKey]
  const profiles: Record<string, LLMConfig> =
    rawProfiles && Object.keys(rawProfiles).length > 0 ? { ...rawProfiles } : { [flat.provider]: { ...flat } }
  const remembered = parsed[activeKey]
  const active = remembered && profiles[remembered] ? remembered : flat.provider
  return { flat, profiles, active }
}

/** 按点号路径取嵌套值（'a.b.c'；数组用 'a.0'；支持 'a.0.b'） */
export function getByPath(obj: unknown, path: string): unknown {
  if (path === '' || path === '.') return obj
  const segs = path.split('.')
  let cur: unknown = obj
  for (const seg of segs) {
    if (cur === null || cur === undefined) return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/** 深度相等（JSON 分级比较，足够用于配置值比对；函数/undefined 宽松处理） */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (typeof a !== 'object') return false
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!(k in (b as object))) return false
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}

export class ConfigStore {
  private config: AppConfig = { ...DEFAULT_CONFIG }
  private filePath: string
  private subscribers = new Set<ConfigChangeCallback>()
  /** 键级订阅（对齐 Cordis notify）：path → 订阅者（symbol 唯一 id → 回调+上次值） */
  private keySubs = new Map<string, Map<symbol, { cb: (newVal: unknown, oldVal: unknown) => void; last: unknown }>>()
  /** load 失败标记：文件损坏时内存回退默认，但禁止启动初始化把默认值写回覆盖原文件 */
  private loadFailed = false
  /** 配置覆盖层提供者（patch 文件 + 插件 config.patch，返回有序 patch 列表） */
  private patchProvider: (() => Array<Record<string, unknown>>) | null = null

  constructor(filePath: string, patchProvider?: () => Array<Record<string, unknown>>) {
    this.filePath = filePath
    this.patchProvider = patchProvider ?? null
    this.load()
  }

  /** 注入覆盖层提供者（dataPaths 初始化后可调用） */
  setPatchProvider(provider: () => Array<Record<string, unknown>>): void {
    this.patchProvider = provider
  }

  /** 配置加载是否失败（文件损坏/解析异常时 true——调用方应避免用默认值覆盖磁盘原文件） */
  isLoadFailed(): boolean {
    return this.loadFailed
  }

  load(): AppConfig {
    if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8')
        const parsed = JSON.parse(raw) as Partial<AppConfig>
        // LLM 接入方式分槽：老配置（无 profiles）→ 单槽归档；新配置 → 保留槽位。
        // flat = 当前生效（运行时消费方读它，兼容全部旧代码）；profiles = 各接入方式存档（UI 切换用）。
        const llmSlots = migrateLlmSlots(parsed, 'llm', 'llmProfiles', 'llmActiveProfile', DEFAULT_CONFIG.llm)
        const llm = llmSlots.flat
        // DMN LLM 配置：兼容老配置（无 dmnLlm 字段时用默认空 model）
        const dmnLlmSlots = migrateLlmSlots(parsed, 'dmnLlm', 'dmnLlmProfiles', 'dmnLlmActiveProfile', DEFAULT_CONFIG.dmnLlm)
        const dmnLlm = dmnLlmSlots.flat
        // 上下文窗口配置：兼容老配置（无 contextWindow 字段时用默认值）
        // chars 模式从字符数迁移到 token 估算
        // 旧配置 tokensMode=false/undefined 且 mode=chars 时，chars *= 1.6 补偿中文密度差异
        // （中文 1.6 字符/token，旧 8000 字符 ≈ 新 5000 token，×1.6 后 8000 字符 → 12800 token，约等于旧 8000 字符的中文容量）
        const contextWindow = parsed.contextWindow
          ? { ...DEFAULT_CONFIG.contextWindow, ...parsed.contextWindow }
          : { ...DEFAULT_CONFIG.contextWindow }
        if (contextWindow.mode === 'chars' && !contextWindow.tokensMode) {
          // 旧字符模式迁移到 token 模式：chars ×1.6 补偿中文密度
          contextWindow.chars = Math.round(contextWindow.chars * 1.6)
          contextWindow.tokensMode = true
        }
        // 工具策略：兼容老配置（无 frontendToolPolicy 字段时用默认值）
        const frontendToolPolicy = parsed.frontendToolPolicy
          ? {
              tools: parsed.frontendToolPolicy.tools ?? {}
            }
          : { ...DEFAULT_CONFIG.frontendToolPolicy }
        // DMN 配置：保留空对象以兼容老配置读取（旧 DMN 已迁移到记忆工作流）
        const dmn = {}
        // eval 配置兼容老配置（无 eval 字段时用默认值，有则合并默认值补全缺失字段）
        const evalConfig = parsed.eval
          ? {
              judge: { ...DEFAULT_CONFIG.eval!.judge, ...parsed.eval.judge },
              costThresholds: { ...DEFAULT_CONFIG.eval!.costThresholds, ...parsed.eval.costThresholds },
              ciEnabled: parsed.eval.ciEnabled ?? DEFAULT_CONFIG.eval!.ciEnabled,
              regressionGate: parsed.eval.regressionGate ?? DEFAULT_CONFIG.eval!.regressionGate
            }
          : { ...DEFAULT_CONFIG.eval! }
        this.config = {
          ...DEFAULT_CONFIG,
          ...parsed,
          llm,
          dmnLlm,
          llmProfiles: llmSlots.profiles,
          llmActiveProfile: llmSlots.active,
          dmnLlmProfiles: dmnLlmSlots.profiles,
          dmnLlmActiveProfile: dmnLlmSlots.active,
          contextWindow,
          frontendToolPolicy,
          dmn,
          eval: evalConfig,
          // 消息接入：兼容老配置（无 messaging 字段时用默认值，有则合并默认补全缺失字段）
          messaging: parsed.messaging
            ? {
                enabled: parsed.messaging.enabled ?? DEFAULT_CONFIG.messaging!.enabled,
                feishu: {
                  appId: parsed.messaging.feishu?.appId ?? DEFAULT_CONFIG.messaging!.feishu?.appId ?? '',
                  appSecret: parsed.messaging.feishu?.appSecret ?? DEFAULT_CONFIG.messaging!.feishu?.appSecret ?? ''
                },
                allowFrom: parsed.messaging.allowFrom ?? [],
                contacts: parsed.messaging.contacts ?? []
              }
            : { ...DEFAULT_CONFIG.messaging! },
          // RAW 记忆字符上限：缺省回退默认（20000）
          rawMaxChars: parsed.rawMaxChars ?? DEFAULT_CONFIG.rawMaxChars,
          // contextMdManualEdited 兼容老配置（undefined 时用默认 false）
          contextMdManualEdited: parsed.contextMdManualEdited ?? false,
          // theme 单独迁移：老主题名映射到新主题，避免 parsed.theme 落到无效值
          theme: migrateTheme(parsed.theme),
          // 中继异步传输：兼容老配置（无 relay 字段时用默认值，有则合并默认补全缺失字段；
          // 下载位置留空 = 运行时解析默认 {root}/relay/downloads，保留天数缺省 7）
          relay: parsed.relay
            ? {
                downloadDir: parsed.relay.downloadDir ?? DEFAULT_CONFIG.relay!.downloadDir,
                retentionDays: parsed.relay.retentionDays ?? DEFAULT_CONFIG.relay!.retentionDays
              }
            : { ...DEFAULT_CONFIG.relay! }
        }
        // 若主题被迁移，立即回写文件，避免下次再走迁移逻辑
        if (parsed.theme && parsed.theme !== this.config.theme) {
          setImmediate(() => {
            try {
              mkdirSync(dirname(this.filePath), { recursive: true })
              writeFileSync(this.filePath, JSON.stringify(this.config, null, 2), 'utf-8')
            } catch {
              // 回写失败不影响加载，下次启动会再次迁移
            }
          })
        }
      }
    return this.config
  }

  save(config: AppConfig): void {
    const oldConfig = this.config
    // LLM 接入方式分槽归档：落盘前把当前生效配置按 provider 名归档进对应槽。
    // AI 工具/后端改扁平 llm 也自动落槽（如插件内一键接入改 llm.provider/model）；UI 切换槽位从存档恢复。
    const normalized: AppConfig = { ...config }
    const llmSlot = config.llm?.provider ?? 'custom'
    normalized.llmProfiles = { ...(config.llmProfiles ?? {}), [llmSlot]: config.llm }
    normalized.llmActiveProfile = llmSlot
    const dmnSlot = config.dmnLlm?.provider ?? 'custom'
    normalized.dmnLlmProfiles = { ...(config.dmnLlmProfiles ?? {}), [dmnSlot]: config.dmnLlm }
    normalized.dmnLlmActiveProfile = dmnSlot
    this.config = normalized
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(normalized, null, 2), 'utf-8')
    if (!deepEqual(oldConfig, config)) {
      for (const cb of this.subscribers) {
        try {
          cb(normalized, oldConfig)
        } catch (err) {
          console.error('[ConfigStore] subscriber error:', err)
        }
      }
      // 键级订阅：只通知各自 path 处值真正变化的订阅者
      this.notifyKeySubs()
    }
  }

  /** 键级订阅通知：对比每个 path 的当前值 vs 上次值，变化才回调并更新 last */
  private notifyKeySubs(): void {
    if (this.keySubs.size === 0) return
    const effective = this.getEffective()
    for (const [path, subs] of this.keySubs) {
      if (subs.size === 0) continue
      const newVal = getByPath(effective, path)
      for (const [id, entry] of subs) {
        try {
          if (!deepEqual(entry.last, newVal)) {
            const oldVal = entry.last
            entry.last = newVal
            entry.cb(newVal, oldVal)
          }
        } catch (err) {
          console.error(`[ConfigStore] keySub error @${path}:`, err)
          void id
        }
      }
    }
  }

  /**
   * 键级订阅（对齐 Cordis notify）：只监听某配置路径（如 'capabilityPolicy'、
   * 'browser.useSystemBrowser'）的值变化（深度比较），变化才回调 (newVal, oldVal)；返回退订函数。
   */
  subscribeKey(
    path: string,
    cb: (newVal: unknown, oldVal: unknown) => void
  ): () => void {
    const id = Symbol('keySub')
    if (!this.keySubs.has(path)) this.keySubs.set(path, new Map())
    const entry = { cb, last: getByPath(this.getEffective(), path) }
    this.keySubs.get(path)!.set(id, entry)
    return () => {
      const subs = this.keySubs.get(path)
      if (subs) {
        subs.delete(id)
        if (subs.size === 0) this.keySubs.delete(path)
      }
    }
  }


  get(): AppConfig {
    return this.config
  }

  /**
   * 生效配置 = 核心配置 + 覆盖层（patch 文件 + 插件 config.patch）。

   * 语义：get() 返回核心真相（save 写回不污染），getEffective() 给消费方
   * （工具策略/prompt 装配等 AI 可覆盖的读取点）。每次调用重新合并，
   * 插件启用/停用、patch 文件变更后无需重启即生效。
   */
  getEffective(): AppConfig {
    if (!this.patchProvider) return this.config
    const patches = this.patchProvider()
    if (patches.length === 0) return this.config
    return mergeConfigLayers(this.config, patches)
  }

  /**
   * 重置工具策略到默认状态（前端 AI：tools={}，按 registry defaultEnabled 兜底）。
   * 用户调整工具配置后出错时，可一键恢复到此默认状态。
   * 与 ToolConfigPanel.resetDefaults 保持口径一致。
   */
  resetToolPolicy(): AppConfig {
    const newConfig: AppConfig = {
      ...this.config,
      frontendToolPolicy: {
        tools: {}
      },
      dmn: {}
    }
    this.save(newConfig)
    return newConfig
  }

  /** 获取配置文件路径（UI 跳转用） */
  getFilePath(): string {
    return this.filePath
  }

  /**
   * 订阅配置变更。save() 时若配置实际变化则触发回调。
   * 返回取消订阅函数，在组件销毁/清理时调用。
   */
  subscribe(callback: ConfigChangeCallback): () => void {
    this.subscribers.add(callback)
    return () => {
      this.subscribers.delete(callback)
    }
  }
}
