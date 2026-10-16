/**
 * 为什么存在：应用配置项多且分属不同域（语言/主题/LLM/DMN/MCP/数据/账号等），
 * 需要 Tab 组织 + 本地草稿 + 快照合并保存的统一入口，避免逐处直写配置。
 * 作用：渲染设置抽屉——Tab 导航、各 section 装配、前后端 AI 配置状态
 * （useLlmConfigState）与保存/关闭流程。
 */
import { useState, useEffect, useRef } from 'react'
import { X, KeyRound, Database, Gauge, Server, Activity, Layers, Cat, Lock, Network, Webhook, Folder, Heart, MessageSquare, Languages, Share2, Wand2 } from 'lucide-react'
import type { AppConfig } from '@shared/types'
import { useAppStore } from '../../stores/appStore'
import { AiChatSection } from './AiChatSection'
import { GenerationSection } from './GenerationSection'
import { useT } from '../../i18n/useT'
import { LANGUAGES } from '../../i18n/locales'
import { EvalPanel } from './sections/EvalPanelSection'
import { WorkspaceConfigSection } from './sections/WorkspaceSection'
import { LilithConnectSection } from './sections/LilithSection'
import { MessagingSection } from './sections/MessagingSection'
import { MultiInstanceSection } from './sections/MultiInstanceSection'
import { RelayConfigSection } from './sections/RelayConfigSection'
import { InstanceSection } from './sections/InstanceSection'
import { DmnConfigSection } from './sections/DmnConfigSection'
import { McpConfigSection } from './sections/McpConfigSection'
import { HooksConfigSection } from './sections/HooksConfigSection'
import { useLlmConfigState } from './sections/useLlmConfigState'
import { FrontendLlmSection } from './sections/FrontendLlmSection'
import { BackendLlmSection } from './sections/BackendLlmSection'
import { CharacterSection } from './sections/CharacterSection'
import { ThemeSection } from './sections/ThemeSection'
import { DataSection } from './sections/DataSection'

type Tab = 'frontend-llm' | 'backend-llm' | 'character' | 'theme' | 'data' | 'dmn' | 'mcp' | 'hooks' | 'eval' | 'workspace' | 'lilith' | 'messaging' | 'ai-chat' | 'generation' | 'multi'

export function SettingsPanel() {
  const open = useAppStore((s) => s.settingsOpen)
  const closeSettings = useAppStore((s) => s.closeSettings)
  const config = useAppStore((s) => s.config)
  const saveConfig = useAppStore((s) => s.saveConfig)
  const lang = useAppStore((s) => s.lang)
  const setLang = useAppStore((s) => s.setLang)
  const t = useT()

  const [local, setLocal] = useState<AppConfig>(config)
  // 保存错误提示：保存失败时展示在面板顶部，防止「面板已关、内存有新值、磁盘是旧值」的静默失败
  const [saveError, setSaveError] = useState<string | null>(null)
  // LLM Tab 的连接测试/模型发现状态：由 hook 持有在面板层，避免切 Tab 卸载丢状态
  const llm = useLlmConfigState(local, setLocal, open)
  // 打开面板时的 config 快照：保存时只覆盖用户实际编辑过的字段，
  // 避免用旧快照把 AI 后端（update_abyss_md 等）在面板打开期间改的 config 打回
  const initialLocalRef = useRef<AppConfig | null>(null)
  const [tab, setTab] = useState<Tab>('frontend-llm')
  useEffect(() => {
    if (open) {
      setLocal(config)
      initialLocalRef.current = config
    }
    // 仅在 open 状态变化时同步：避免用户编辑中（local 脏）被 AI 后端改 config 后的推送覆盖。
    // 关闭再打开会读到最新值。
  }, [open])

  // Esc 关闭：设置是模态遮罩层，键盘用户应能用 Esc 退出（侧边栏/浏览器标签等
  // 面板均有同一惯例，缺了它就等于键盘无法关闭遮罩）。焦点在面板内 input 时
  // 也需响应，所以挂 window 级 keydown 而非遮罩的 onKeyDown。
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useAppStore.getState().closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null

  const handleSave = async () => {
    // 保存时标记用户手动编辑：只有实际改动了 aiName 才标记 manualEdited=true。
    // 之前 onChange 立即标记的设计太敏感——用户只是聚焦 textarea 输入又删除就锁定 AI，
    // 导致 AI 调 update_ai_name 被静默拒绝，但用户完全不知道。
    // 改为保存时标记：用户主动点保存才视为"手动编辑"，AI 才会被锁定。
    // 原实现 `...local` 整体覆盖——local 是打开面板时的
    // 快照，AI 后端在面板打开期间改的 config（update_abyss_md/update_lite_memory 等）会被
    // 用户一次全局保存用旧值打回。改为：以最新 config 为基底，只覆盖用户在面板实际改动
    // 过的顶层字段（local vs 打开时快照的差异），未编辑字段保留后端最新值。
    const base = initialLocalRef.current
    const lr = local as unknown as Record<string, unknown>
    const br = base as unknown as Record<string, unknown>
    // Stable deep-equal via recursively sorted-key JSON.stringify
    // 修复：原实现只排序顶层键，嵌套对象的键序差异仍会导致 false positive
    const stableKey = (obj: unknown, seen: WeakSet<object> = new WeakSet()): string => {
      if (obj === null || typeof obj !== 'object') return JSON.stringify(obj)
      if (seen.has(obj as object)) return '"[Circular]"' // 循环引用保护
      seen.add(obj as object)
      const sorted = Object.keys(obj as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = stableKey((obj as Record<string, unknown>)[k], seen)
        return acc
      }, {})
      return JSON.stringify(sorted)
    }
    const changedKeys = base
      ? Object.keys(lr).filter((k) => stableKey(lr[k]) !== stableKey(br[k]))
      : Object.keys(lr)
    const userEdits = Object.fromEntries(changedKeys.map((k) => [k, lr[k]]))
    const toSave = {
      ...config,
      ...userEdits,
      aiNameManualEdited: local.aiName !== config.aiName ? true : local.aiNameManualEdited
    }
    try {
      await saveConfig(toSave)
      closeSettings()
    } catch (err) {
      // 保存失败必须留在面板并可见提示：主进程磁盘写失败/校验拒绝时
      // 直接关面板会让用户误以为保存成功（静默失败）。
      setSaveError((err as Error).message)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="flex max-h-[88vh] w-[720px] flex-col rounded-window border border-border bg-bg-surface">
        {/* 标题栏 */}
        <div className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
          <h2 className="text-title font-medium text-fg-primary">{t('settings.title')}</h2>
          <div className="flex items-center gap-3">
            {/* 语言切换 */}
            <div className="flex items-center gap-1 rounded-btn border border-border-subtle bg-bg-elevated p-0.5">
              <Languages size={12} className="ml-1.5 text-fg-muted" />
              {LANGUAGES.map((l) => (
                <button
                  key={l.value}
                  onClick={() => setLang(l.value)}
                  className={`rounded-btn px-2 py-0.5 text-caption transition-colors ${
                    lang === l.value
                      ? 'bg-accent/15 text-accent'
                      : 'text-fg-muted hover:text-fg-secondary'
                  }`}
                >
                  {l.label}
                </button>
              ))}
            </div>
            <button
              onClick={closeSettings}
              aria-label="关闭设置"
              title="关闭"
              className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted transition-all duration-150 hover:bg-bg-muted hover:text-fg-primary active:scale-95"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* 主体：左侧 Tab + 右侧内容 */}
        <div className="flex flex-1 overflow-hidden">
          {/* Tab 侧栏 */}
          <nav className="w-36 shrink-0 border-r border-border-subtle bg-bg-base/40 p-2">
            {([
              { id: 'character' as Tab, label: t('settings.tab.character'), icon: Cat },
              { id: 'frontend-llm' as Tab, label: t('settings.tab.frontendLlm'), icon: KeyRound },
              { id: 'backend-llm' as Tab, label: t('settings.tab.backendLlm'), icon: Activity },
              { id: 'dmn' as Tab, label: t('settings.tab.dmn'), icon: Network },
              { id: 'mcp' as Tab, label: t('settings.tab.mcp'), icon: Server },
              { id: 'hooks' as Tab, label: t('settings.tab.hooks'), icon: Webhook },
              { id: 'eval' as Tab, label: t('settings.tab.eval'), icon: Gauge },
              { id: 'theme' as Tab, label: t('settings.tab.theme'), icon: Layers },
              { id: 'workspace' as Tab, label: t('settings.tab.workspace'), icon: Folder },
              { id: 'lilith' as Tab, label: t('settings.tab.lilith'), icon: Heart },
              { id: 'messaging' as Tab, label: t('settings.tab.messaging'), icon: MessageSquare },
              { id: 'ai-chat' as Tab, label: t('settings.tab.aiChat'), icon: MessageSquare },
              { id: 'generation' as Tab, label: t('settings.tab.generation'), icon: Wand2 },
              { id: 'multi' as Tab, label: t('settings.tab.multi'), icon: Share2 },
              { id: 'data' as Tab, label: t('settings.tab.data'), icon: Database }
            ]).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`mb-1 flex w-full items-center gap-2 rounded-btn px-3 py-2 text-caption transition-all duration-150 active:scale-95 ${
                  tab === id
                    ? 'bg-accent/10 text-accent'
                    : 'text-fg-muted hover:bg-bg-muted hover:text-fg-secondary'
                }`}
              >
                <Icon size={12} />
                {label}
              </button>
            ))}
          </nav>

          {/* 内容区 */}
          <div className="flex-1 overflow-y-auto px-6 py-5">

            {/* ====== 前端 AI ====== */}
            {tab === 'frontend-llm' && (
              <FrontendLlmSection local={local} setLocal={setLocal} llm={llm} />
            )}

            {/* ====== 后端 AI ====== */}
            {tab === 'backend-llm' && (
              <BackendLlmSection local={local} setLocal={setLocal} llm={llm} />
            )}

            {/* ====== 角色 ====== */}
            {tab === 'character' && (
              <CharacterSection local={local} setLocal={setLocal} config={config} />
            )}

            {/* ====== 主题 ====== */}
            {tab === 'theme' && <ThemeSection local={local} setLocal={setLocal} />}

            {/* ====== DMN 配置 ====== */}
            {tab === 'dmn' && (
              <div className="space-y-4">
                <DmnConfigSection config={local} onChange={setLocal} />
              </div>
            )}

            {/* ====== MCP 配置 ====== */}
            {tab === 'mcp' && (
              <McpConfigSection />
            )}

            {/* ====== Hooks 配置 ====== */}
            {tab === 'hooks' && (
              <div className="space-y-5">
                {/* 治理机制开关（用户手动开关入口；AI 侧走 config_patch 工具） */}
                <section>
                  <div className="mb-3 flex items-center gap-2 text-caption uppercase tracking-wider text-fg-muted">
                    <Lock size={12} />
                    <span>{t('settings.governance')}</span>
                  </div>
                  <div className="rounded-btn border border-border-subtle bg-bg-elevated p-3">
                    <div className="mb-2 text-[11px] text-fg-muted">
                      {t('settings.governanceDesc')}
                    </div>
                    <div className="space-y-2">
                      {(
                        [
                          { key: 'idleSuppression', labelKey: 'settings.gov.idleSuppression', descKey: 'settings.gov.idleSuppressionDesc' },
                          { key: 'factCheckReminder', labelKey: 'settings.gov.factCheck', descKey: 'settings.gov.factCheckDesc' },
                          { key: 'closingReflection', labelKey: 'settings.gov.closingReflection', descKey: 'settings.gov.closingReflectionDesc' },
                          { key: 'failureCircuitBreaker', labelKey: 'settings.gov.failureBreaker', descKey: 'settings.gov.failureBreakerDesc' }
                        ] as { key: keyof NonNullable<AppConfig['governance']>; labelKey: string; descKey: string }[]
                      ).map((item) => {
                        const on = local.governance?.[item.key] !== false
                        return (
                          <label
                            key={item.key}
                            className={`flex cursor-pointer items-start gap-2 rounded-btn border px-3 py-2 transition-all duration-150 ${
                              on
                                ? 'border-accent/30 bg-accent/5'
                                : 'border-border-subtle bg-bg-base opacity-70'
                            }`}
                          >
                            <input
                              type="checkbox"
                              className="mt-0.5"
                              checked={on}
                              onChange={() => {
                                const g = { ...(local.governance ?? {}) }
                                if (on) delete g[item.key]
                                else g[item.key] = false
                                setLocal({ ...local, governance: g })
                              }}
                            />
                            <span className="flex flex-col">
                              <span className="text-body text-fg-primary">
                                {t(item.labelKey)}
                                <span className={`ml-2 text-[11px] ${on ? 'text-accent' : 'text-fg-muted'}`}>
                                  {on ? t('settings.govOn') : t('settings.govOff')}
                                </span>
                              </span>
                              <span className="text-[11px] text-fg-muted">{t(item.descKey)}</span>
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  </div>
                </section>
                <HooksConfigSection />
              </div>
            )}

            {/* ====== 评测 ====== */}
            {tab === 'eval' && (
              <EvalPanel config={local} onChange={setLocal} />
            )}

            {/* ====== 工作区（AI 专属工作区管理）====== */}
            {tab === 'workspace' && (
              <WorkspaceConfigSection />
            )}

            {/* ====== 莉莉丝桌宠连接 ====== */}
            {tab === 'lilith' && (
              <LilithConnectSection config={local} onChange={setLocal} />
            )}

            {/* ====== 消息接入（飞书等外部平台 → 月蚀大脑） ====== */}
            {tab === 'messaging' && (
              <MessagingSection config={local} onChange={setLocal} />
            )}

            {/* ====== AI 聊天（浏览器配置 / 登录态接入） ====== */}
            {tab === 'ai-chat' && (
              <AiChatSection config={local} onChange={setLocal} />
            )}
            {tab === 'generation' && (
              <GenerationSection config={local} onChange={setLocal} />
            )}

            {/* ====== 主/分系统 ====== */}
            {tab === 'multi' && (
              <div className="space-y-6">
                {/* 多开实例（本机并行）优先展示 */}
                <InstanceSection />
                <MultiInstanceSection />
                {/* 中继异步传输（L1.5）：下载位置 + 保留策略，走全局配置草稿保存 */}
                <RelayConfigSection config={local} onChange={setLocal} />
              </div>
            )}

            {/* ====== 数据 ====== */}
            {tab === 'data' && (
              <div className="space-y-5">
                {/* 安全模式修复入口已删除：它依赖 safe:open 打开绕过登录门控的独立窗口，
                    与「系统强制登录后才可用、无兜底回退」的登录设计冲突 */}
                <DataSection local={local} setLocal={setLocal} />
              </div>
            )}
          </div>
        </div>

        {/* 底部操作栏 */}
        <div className="flex items-center justify-between border-t border-border-subtle px-6 py-4">
          <div className="text-caption text-fg-muted">
            {saveError ? (
              <span className="text-red-500" role="alert">{saveError}</span>
            ) : (
              t('settings.saveHint')
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={closeSettings}
              className="rounded-btn px-4 py-2 text-body text-fg-muted transition-all duration-150 hover:bg-bg-muted active:scale-95"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleSave}
              className="rounded-btn bg-accent px-4 py-2 text-body text-accent-fg transition-all duration-150 hover:bg-accent/80 active:scale-95"
            >
              {t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}