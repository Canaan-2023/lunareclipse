/**
 * 配置 IPC：设置页读写 AppConfig 的通道——读时对 apiKey 等敏感字段
 * 脱敏、写时按白名单 key 校验并走钳制规则收敛，兼顾功能与安全。
 */
import { ipcMain, BrowserWindow } from 'electron'
import type { ConfigStore } from '../../api/config-store'
import type { AppConfig, LLMConfig, ModelInfo } from '@shared/types'
import { LLMClient } from '../../api/llm'
import {
  clampTokenBudget,
  clampContextChars,
  clampMaxTokens,
  resolveModelCapability
} from '../../api/model-capability'
import { safeHandle } from './safe-handle'

/** 敏感字段脱敏：apiKey 等凭证只返回是否已配置，不返回明文 */
function maskSecret(key?: string): string {
  return key ? '***' : ''
}

/** 对 config 中的敏感字段脱敏，返回安全副本给渲染进程 */
function sanitizeConfig(cfg: AppConfig): AppConfig {
  return {
    ...cfg,
    llm: { ...cfg.llm, apiKey: maskSecret(cfg.llm?.apiKey) },
    dmnLlm: cfg.dmnLlm ? { ...cfg.dmnLlm, apiKey: maskSecret(cfg.dmnLlm.apiKey) } : cfg.dmnLlm,
    llmProfiles: cfg.llmProfiles
      ? Object.fromEntries(
          Object.entries(cfg.llmProfiles).map(([k, v]) => [k, { ...v, apiKey: maskSecret(v?.apiKey) }])
        )
      : cfg.llmProfiles,
    bochaApiKey: maskSecret(cfg.bochaApiKey)
  }
}

/** config:set 允许修改的配置 key 白名单（防止任意 key 注入） */
const ALLOWED_CONFIG_KEYS = new Set<string>([
  'llm', 'dmnLlm',
  'llmProfiles', 'llmActiveProfile',
  'dmnLlmProfiles', 'dmnLlmActiveProfile',
  'theme', 'webSearchEnabled', 'rawMaxChars',
  'bochaApiKey', 'tokenBudget', 'dataDir',
  'availableModels', 'dmnAvailableModels',
'aiName', 'persona', 'aiMode',
  'aiNameManualEdited',
  'userProfileManualEdited', 'liteMemoryManualEdited',
  'contextMdManualEdited', 'contextWindow', 'messageWidth',
  'frontendToolPolicy', 'dmn', 'eval',
'permissionGreenlight', 'lilith', 'messaging',
  'imageGen', 'aiAssist', 'continuousActivation',
  'governance', 'browser', 'uiZoom',
  // 多模态生成与工具结果蒸馏：设置页 GenerationSection/CharacterSection 走通用
  // saveConfig → config:set 链路持久化；缺这两个键会导致「UI 保存成功、磁盘从未落盘、
  // config:changed 回推后设置回滚」的双重状态 bug（permissionGreenlight 同类教训，见下）
  'generation', 'toolResultDistill'
])

/** 深合并：嵌套对象递归合并，数组整体替换 */
function deepMerge<T extends Record<string, unknown>>(base: T, incoming: Partial<T>): T {
  const result: Record<string, unknown> = { ...base }
  for (const key of Object.keys(incoming)) {
    const baseVal = (base as Record<string, unknown>)[key]
    const incVal = (incoming as Record<string, unknown>)[key]
    if (
      baseVal != null && typeof baseVal === 'object' && !Array.isArray(baseVal) &&
      incVal != null && typeof incVal === 'object' && !Array.isArray(incVal)
    ) {
      result[key] = deepMerge(baseVal as Record<string, unknown>, incVal as Partial<Record<string, unknown>>)
    } else if (incVal !== undefined) {
      result[key] = incVal
    }
  }
  return result as T
}

/**
 * 安全敏感字段：不允许通过 config:set 覆盖。
 * permissionGreenlight 曾在此名单内，导致 InputArea 的绿通开关（走通用 saveConfig → config:set）
 * 被强制回滚、永远写不进主进程——「界面显示已开、实际仍为关」的双重状态 bug。
 * 它已在 ALLOWED_CONFIG_KEYS 白名单内（设计上允许切换），故移出保护名单。
 */
const PROTECTED_FIELDS = ['dataDir'] as const

/**
 * clamp 校验层（阶段 A，写入侧强制，前端防呆）：
 * 对合并后配置按当前生效模型窗口限幅 tokenBudget / contextWindow.chars / 各 maxTokens。
 * clamp 语义：写入被安全截断并返回生效值（用户设 10M 落到 window），而非报错拒绝——
 * 避免「设置了没用还不自知」；返回被截断的字段摘要供 config:set 回传。
 * 兜底原则：模型未知时窗口按 128000 处理；null 保留（未显式配置）。
 */
function clampConfigLimits(cfg: AppConfig): string[] {
  const clamped: string[] = []
  const clampSlot = (slot: LLMConfig | undefined, label: string): void => {
    if (!slot || slot.maxTokens == null) return
    const cap = resolveModelCapability(slot.model)
    const v = clampMaxTokens(slot.maxTokens, cap.contextWindow, cap.maxOutputTokens)
    if (v !== slot.maxTokens) {
      slot.maxTokens = v
      clamped.push(`${label}.maxTokens=${v}`)
    }
  }
  // tokenBudget / contextWindow.chars 跟随前端 AI 槽位（llm）的模型窗口
  const mainCap = resolveModelCapability(cfg.llm?.model)
  if (cfg.tokenBudget != null) {
    const v = clampTokenBudget(cfg.tokenBudget, mainCap.contextWindow)
    if (v !== cfg.tokenBudget) {
      cfg.tokenBudget = v
      clamped.push(`tokenBudget=${v}`)
    }
  }
  if (cfg.contextWindow && cfg.contextWindow.mode !== 'off') {
    const v = clampContextChars(cfg.contextWindow.chars, mainCap.contextWindow)
    if (v != null && v !== cfg.contextWindow.chars) {
      cfg.contextWindow.chars = v
      clamped.push(`contextWindow.chars=${v}`)
    }
  }
  // 各 LLM 槽位的 maxTokens 按各自模型窗口限幅
  if (cfg.llm) clampSlot(cfg.llm, 'llm')
  if (cfg.dmnLlm) clampSlot(cfg.dmnLlm, 'dmnLlm')
  for (const [k, v] of Object.entries(cfg.llmProfiles ?? {})) clampSlot(v, `llmProfiles.${k}`)
  for (const [k, v] of Object.entries(cfg.dmnLlmProfiles ?? {})) clampSlot(v, `dmnLlmProfiles.${k}`)
  return clamped
}

export function registerConfigHandlers(
  ipc: typeof ipcMain,
  configStore: ConfigStore,
  mainWindow: BrowserWindow | null
): void {
  safeHandle(
    ipc, 'config:get',
    () => {
      const cfg = configStore.get()
      // 脱敏：apiKey 等凭证只返回 '***' 或空串，防止渲染进程 XSS 窃取密钥
      return sanitizeConfig(cfg)
    },
    null // 读取失败返回 null，前端 appStore 有 DEFAULT_CONFIG 兜底
  )

  /** 返回 config.json 文件路径（UI 跳转用） */
  safeHandle(
    ipc, 'config:getFilePath',
    () => configStore.getFilePath(),
    null
  )

safeHandle<{ ok: boolean; error?: string; clamped?: string[] }>(
    ipc, 'config:set',
    (_event, config: unknown) => {
      if (!config || typeof config !== 'object') {
        return { ok: false, error: '配置格式无效' }
      }
      const current = configStore.get()
      const incoming = config as Record<string, unknown>
      const filtered: Record<string, unknown> = {}
      for (const key of Object.keys(incoming)) {
        if (ALLOWED_CONFIG_KEYS.has(key)) {
          filtered[key] = incoming[key]
        }
      }
      const cfg = deepMerge({ ...current } as Record<string, unknown>, filtered) as unknown as AppConfig
      const cfgRecord = cfg as unknown as Record<string, unknown>
      const currentRecord = current as unknown as Record<string, unknown>
      // 安全敏感字段保护：不允许通过 config:set 修改
      for (const field of PROTECTED_FIELDS) {
        if (field in incoming) {
          cfgRecord[field] = currentRecord[field]
        }
      }
// 如果前端传回的 apiKey 是 '***'（脱敏值），保留原值
      const origCfg = current
      if (cfg.llm?.apiKey === '***' && origCfg.llm) cfg.llm.apiKey = origCfg.llm.apiKey
      if (cfg.dmnLlm?.apiKey === '***' && origCfg.dmnLlm) cfg.dmnLlm.apiKey = origCfg.dmnLlm.apiKey
      if (cfg.bochaApiKey === '***') cfg.bochaApiKey = origCfg.bochaApiKey
      if (cfg.llmProfiles && origCfg.llmProfiles) {
        for (const [k, v] of Object.entries(cfg.llmProfiles)) {
          if (v?.apiKey === '***' && origCfg.llmProfiles[k]) {
            cfg.llmProfiles[k].apiKey = origCfg.llmProfiles[k].apiKey
          }
        }
      }
      // clamp 校验层（阶段 A）：写入被安全截断并回传生效值，而非报错拒绝。
      // 兜底原则：模型未知时按 128000 默认窗口限制；null 保留（未显式配置）。
      const clamped = clampConfigLimits(cfg)
      configStore.save(cfg)
      return { ok: true, ...(clamped.length > 0 ? { clamped } : {}) }
    },
    { ok: false, error: '保存配置失败，请查看日志' }
  )

  /** 一键重置全部工具策略（前端 AI + 各 DMN）到优化后的默认状态 */
  safeHandle<{ ok: boolean; config?: AppConfig; error?: string }>(
    ipc, 'config:resetToolPolicy',
    () => {
      const newConfig = configStore.resetToolPolicy()
      // 通知前端配置已变更（appStore 订阅 'config:changed' 会自动刷新）
      mainWindow?.webContents.send('config:changed', newConfig)
      return { ok: true, config: newConfig }
    },
    { ok: false, error: '重置工具策略失败，请查看日志' }
  )

/**
 * 测试/拉模型时还原脱敏占位符：前端回传的 apiKey === '***' 表示"沿用已保存密钥"，
 * 这里按 baseURL 匹配已存槽位（llmProfiles → dmnLlmProfiles → llm → dmnLlm）
 * 取回真实 key（与 config:set 的还原语义一致），避免把 '***' 当真 key 发给服务端。
 * baseURL 无匹配时兜底回退 llm 的 key（dmnLlm 默认跟随前端同一密钥）；均无则原样返回。
 */
function resolveSecretForTest(orig: AppConfig, cfg: LLMConfig | undefined): LLMConfig | undefined {
  if (!cfg || cfg.apiKey !== '***') return cfg
  const candidates = [
    ...(orig.llmProfiles ? Object.values(orig.llmProfiles) : []),
    ...(orig.dmnLlmProfiles ? Object.values(orig.dmnLlmProfiles) : []),
    orig.llm,
    orig.dmnLlm
  ]
  const hit =
    candidates.find((c) => c?.baseURL && c.baseURL === cfg.baseURL && c.apiKey) ??
    (orig.llm?.apiKey ? orig.llm : undefined)
  if (!hit?.apiKey) return cfg
  return { ...cfg, apiKey: hit.apiKey }
}

safeHandle<{ ok: boolean; models: string[]; infos?: ModelInfo[]; error?: string }>(
    ipc, 'llm:listModels',
    async (_event, llmConfig: unknown) => {
      const resolved = resolveSecretForTest(configStore.get(), llmConfig as LLMConfig)
      const client = new LLMClient(resolved ?? (llmConfig as LLMConfig))
      const infos = await client.listModelsWithCapability()
      return { ok: true, models: infos.map((i) => i.id), infos }
    },
    { ok: false, error: '拉取模型列表失败', models: [] }
  )

  safeHandle<{ ok: boolean; models?: string[]; infos?: ModelInfo[]; error?: string }>(
    ipc, 'llm:test',
    async (_event, llmConfig: unknown) => {
      const resolved = resolveSecretForTest(configStore.get(), llmConfig as LLMConfig)
      const client = new LLMClient(resolved ?? (llmConfig as LLMConfig))
      if (!client.isReady()) {
        return { ok: false, error: '客户端未就绪（缺少 baseURL 或 apiKey）' }
      }
      const infos = await client.listModelsWithCapability()
      if (infos.length === 0) {
        return { ok: false, error: '连接成功但未返回任何模型' }
      }
      return { ok: true, models: infos.map((i) => i.id), infos }
    },
    { ok: false, error: '测试连接失败' }
  )
}
