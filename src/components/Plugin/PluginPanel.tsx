/**
 * 为什么存在：插件是扩展 AI 工具/内核能力的载体，需要集中检视、启停与打开所在目录，
 * 独立侧栏便于管理。
 * 作用：渲染插件列表（元数据/启用开关/错误）、刷新与打开插件目录，
 * 以及内核功能插件（十大功能模块）逐项开关。
 */
import { useEffect, useState, useCallback } from 'react'
import { FolderOpen, Puzzle, RefreshCw, AlertTriangle, X, Trash2, Boxes, PanelTop, ChevronDown } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useT, type TFunc } from '../../i18n/useT'

/**
 * 来源层级 → 本地化标签。
 * 徽标与 tooltip 两处都要显示来源，共用一个判定避免两处重复写三元链。
 */
function sourceLabelOf(t: TFunc, source: PluginInfo['source']): string {
  return source === 'domain'
    ? t('plugin.source.domain')
    : source === 'bundled'
      ? t('plugin.source.bundled')
      : t('plugin.source.user')
}

/**
 * 插件管理面板（右侧栏 tab）：
 * - 插件列表（名称/描述/版本/工具数/错误/启用开关），按「有面板 / 无面板」分组，
 * 无面板插件（如纯工具插件）不会出现在右侧栏 tab，但必须在此完整可见
 * - 打开插件目录按钮
 * - 刷新按钮
 * - 内核功能插件（阶段 4：十大功能模块对象表，可逐项开关状态）
 * 形态参考 SkillPanel + McpConfigSection（列表 + 状态徽章 + 开关）。
 *
 * 布局：头部固定，下方全部内容共用一个滚动容器（min-h-0 保证 flex 子项可收缩），
 * 内核功能插件默认折叠为标题行，展开后为紧凑网格——避免「一类占一大块」挤压
 * 下方分类列表，整面板可上下滑动。
 */
interface PluginPanelInfo {
  id: string
  title?: string
  component: string
}

interface PluginInfo {
  dirName: string
  name: string
  description: string
  version: string
  author?: string
  enabled: boolean
  toolCount: number
  tools: Array<{ name: string; description: string }>
  errors: string[]
  source: 'user' | 'domain' | 'bundled'
  panel: PluginPanelInfo | null
}

interface FeaturePluginInfo {
  id: string
  name: string
  description: string
  version: string
  serviceKey: string
  enabled: boolean
}

export function PluginPanel() {
  const t = useT()
  const open = useAppStore((s) => s.activeDrawer === 'plugin' && !s.vizPanelOpen && !s.settingsOpen)
  const closeDrawer = useAppStore((s) => s.closeDrawer)
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [featurePlugins, setFeaturePlugins] = useState<FeaturePluginInfo[]>([])
  const [rootDir, setRootDir] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  /** 正在切换启停的插件（dirName 或 `feature:${id}`）；飞行中禁用该开关，
   * 防止连点触发两次反向切换并给出在途反馈——禁止移除。 */
  const [busyToggle, setBusyToggle] = useState<string | null>(null)
  /** 正在删除的插件 dirName；删除是异步的（主进程要卸载 cordis fiber 再删目录），
   * 飞行中禁用该删除按钮并拦截重复点击——不防连点会导致同一插件被并发删除两次：
   * 第二次目录已不存在、fiber 已卸载，主进程按幂等处理返回失败，但 UI 会闪错误提示。
   * 禁止移除。 */
  const [busyDelete, setBusyDelete] = useState<string | null>(null)
  /** 内核功能插件分组是否展开；默认收起，展开时才渲染卡片网格，
   * 避免十个大卡片常驻占用整块面板高度。 */
  const [featureOpen, setFeatureOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.lunareclipse.pluginList()
      if (res.ok && res.plugins) {
        setPlugins(res.plugins)
        setRootDir(res.rootDir ?? '')
      }
      const fp = await window.lunareclipse.featurePluginList()
      if (fp.ok && fp.plugins) setFeaturePlugins(fp.plugins)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const toggle = async (dirName: string, enabled: boolean) => {
    if (busyToggle) return
    setBusyToggle(dirName)
    try {
      const res = await window.lunareclipse.pluginToggle(dirName, enabled)
      if (!res?.ok) {
        setErr(res?.error ?? '操作失败')
        setTimeout(() => setErr(''), 3000)
      }
    } finally {
      setBusyToggle(null)
    }
    void load()
  }

  const toggleFeature = async (id: string, enabled: boolean) => {
    if (busyToggle) return
    setBusyToggle(`feature:${id}`)
    try {
      const res = await window.lunareclipse.featurePluginToggle(id, enabled)
      if (!res?.ok) {
        setErr(res?.error ?? '操作失败')
        setTimeout(() => setErr(''), 3000)
      }
    } finally {
      setBusyToggle(null)
    }
    void load()
  }

  const openDir = async () => {
    await window.lunareclipse.pluginOpenDir()
  }

  const handleDelete = async (dirName: string, name: string) => {
    if (!confirm(`删除插件「${name}」？\n此操作不可撤销，插件目录及其所有文件将被永久删除。`)) return
    // 防连点：删除已在途时直接返回（按钮同时 disabled）；不防连点会并发删除同一插件
    if (busyDelete) return
    setBusyDelete(dirName)
    try {
      const res = await window.lunareclipse.pluginDelete(dirName)
      if (!res?.ok) {
        setErr(res?.error ?? '删除失败')
        setTimeout(() => setErr(''), 3000)
        return
      }
    } catch (e) {
      // plugin:delete 挂了 requireAuth：未登录时主进程抛 Unauthorized → IPC reject。
      // 不捕获会变成未处理异常，界面无任何反馈，用户看到的就是"删除完全失效"。
      setErr((e as Error)?.message === 'Unauthorized' ? '请先登录后再删除插件' : `删除插件失败：${(e as Error)?.message ?? '未知错误'}`)
      setTimeout(() => setErr(''), 4000)
      return
    } finally {
      setBusyDelete(null)
    }
    void load()
  }

  if (!open) return null

  const enabledFeatureCount = featurePlugins.filter((f) => f.enabled).length

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-surface">
      {/* 头部：标题 + 操作按钮（固定，不随内容滚动） */}
      <div className="shrink-0 border-b border-border-subtle px-3 py-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-caption font-medium text-fg-secondary">
            <Puzzle size={13} className="text-accent" />
            插件
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => void load()}
              className="flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
              title="刷新"
              aria-label="刷新"
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={() => void openDir()}
              className="flex items-center gap-1 rounded-btn bg-bg-muted px-2 py-1 text-[11px] text-fg-secondary hover:bg-bg-muted/70"
              title="打开插件目录"
            >
              <FolderOpen size={11} />
              目录
            </button>
            <button
              onClick={() => closeDrawer()}
              className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
              title="关闭"
              aria-label="关闭"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      </div>

      {err && (
        <div className="shrink-0 border-b border-border-subtle px-3 py-1.5 text-[11px] text-red-400">
          {err}
        </div>
      )}

      {/* 内容区：唯一滚动容器。min-h-0 是关键——flex 子项默认 min-height:auto，
          内容超高时会撑破父级而不是触发滚动；补上后可正常上下滑动 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {/* 内核功能插件（阶段 4）：默认折叠为标题行，展开为紧凑网格 */}
        {featurePlugins.length > 0 && (
          <section className="mb-3 overflow-hidden rounded-card border border-border-subtle">
            <button
              onClick={() => setFeatureOpen((v) => !v)}
              aria-expanded={featureOpen}
              className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left transition-colors hover:bg-bg-muted/60"
              title={featureOpen ? '收起内核功能插件' : '展开内核功能插件'}
            >
              <ChevronDown
                size={11}
                className={`shrink-0 text-fg-muted transition-transform duration-150 ${
                  featureOpen ? '' : '-rotate-90'
                }`}
              />
              <Boxes size={12} className="shrink-0 text-accent" />
              <span className="text-caption font-medium text-fg-primary">内核功能插件</span>
              <span className="text-[10px] font-normal text-fg-muted">
                （{enabledFeatureCount}/{featurePlugins.length} 启用）
              </span>
              <span className="ml-auto text-[10px] text-fg-muted/60">
                {featureOpen ? '收起' : '展开'}
              </span>
            </button>
            {featureOpen && (
              <div className="space-y-0.5 border-t border-border-subtle p-1.5">
                {featurePlugins.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-center gap-1.5 rounded-btn px-1.5 py-1 transition-colors hover:bg-bg-muted/60"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-caption font-medium text-fg-primary">
                          {f.name}
                        </span>
                        <span className="shrink-0 rounded bg-bg-muted px-1 py-0.5 font-mono text-[9px] text-fg-muted">
                          ctx.{f.serviceKey}
                        </span>
                      </div>
                      <div
                        className="mt-0.5 truncate text-[10px] text-fg-muted"
                        title={f.description}
                      >
                        {f.description}
                      </div>
                    </div>
                    <button
                      onClick={() => void toggleFeature(f.id, !f.enabled)}
                      role="switch"
                      aria-checked={f.enabled}
                      aria-label={f.name}
                      disabled={busyToggle === `feature:${f.id}`}
                      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${
                        f.enabled ? 'bg-accent' : 'bg-bg-muted'
                      } disabled:cursor-not-allowed disabled:opacity-50`}
                      title={f.enabled ? '点击禁用' : '点击启用'}
                    >
                      <span
                        className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
                          f.enabled ? 'left-3.5' : 'left-0.5'
                        }`}
                      />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* 插件列表：面板型 / 工具型分组显示，保证全部插件（含无面板插件）可见 */}
        {plugins.length === 0 ? (
          <div className="px-3 py-8 text-center text-caption text-fg-muted">
            {loading ? '加载中…' : '暂无插件'}
            <div className="mt-2 text-[11px] leading-relaxed">
              插件 = {rootDir || 'abyssac_data/plugins/'} 下的子文件夹
              <br />
              （plugin.json + tools.js），扔进文件夹即加载
            </div>
          </div>
        ) : (
          <>
            {/* 总览行：先报总数再分组。没有它时，工具型插件在右侧栏 tab 找不到，
                极易被误判成「插件被删了」——总数在此，一看便知一个都没少 */}
            <div className="mb-1.5 px-1 text-[10px] text-fg-muted">
              {t('plugin.group.total', { total: plugins.length })}
            </div>
            {['panel', 'tools'].map((group) => {
              const groupPlugins =
                group === 'panel' ? plugins.filter((p) => p.panel) : plugins.filter((p) => !p.panel)
              if (groupPlugins.length === 0) return null
              return (
                <section key={group} className="mb-3">
                  <div className="mb-1 flex items-center gap-1 px-1 text-[10px] uppercase tracking-wider text-fg-muted">
                    <PanelTop size={10} className="text-accent/60" />
                    <span className="font-medium">
                      {group === 'panel' ? t('plugin.group.panel') : t('plugin.group.tools')}
                    </span>
                    <span className="text-fg-muted/50">· {groupPlugins.length}</span>
                  </div>
                  {groupPlugins.map((p) => (
                    <div
                      key={p.dirName}
                      className={`group mb-1 rounded-btn px-2 py-1.5 transition-colors hover:bg-bg-muted/60 ${
                        p.enabled ? '' : 'opacity-60'
                      }`}
                    >
                      {/* 第一行：插件名 + 徽标 + 删除 + 开关 */}
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`truncate text-caption font-medium ${
                            p.enabled ? 'text-fg-primary' : 'text-fg-muted'
                          }`}
                          title={p.name}
                        >
                          {p.name}
                        </span>
                        {p.errors.length > 0 && (
                          <AlertTriangle size={10} className="shrink-0 text-warning" />
                        )}
                        <span
                          className="shrink-0 rounded bg-bg-muted px-1 py-0.5 text-[9px] text-fg-secondary"
                          title={t('plugin.tooltip.source', { source: sourceLabelOf(t, p.source) })}
                        >
                          {sourceLabelOf(t, p.source)}
                        </span>
                        {p.panel ? (
                          <span
                            className="shrink-0 rounded bg-accent/10 px-1 py-0.5 text-[9px] text-accent"
                            title={`${t('plugin.tooltip.panel')}: plugin:${p.panel.id}`}
                          >
                            {t('plugin.panel.yes')}
                          </span>
                        ) : (
                          <span
                            className="shrink-0 rounded bg-bg-muted px-1 py-0.5 text-[9px] text-fg-muted"
                            title={t('plugin.tooltip.noPanel')}
                          >
                            {t('plugin.panel.no')}
                          </span>
                        )}
                        <div className="ml-auto flex shrink-0 items-center gap-0.5">
                          {/* 删除按钮：常态可见（对齐 SkillPanel/SkillListItem 惯例）。
                              此前用 opacity-0 + group-hover 隐藏，用户找不到删除入口，
                              且 hover 依赖在部分输入方式（触摸/键盘）下不可达——回归为显式入口 */}
                          <button
                            onClick={() => void handleDelete(p.dirName, p.name)}
                            disabled={busyDelete === p.dirName}
                            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-muted transition-colors hover:bg-danger-soft hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
                            title={busyDelete === p.dirName ? '正在删除…' : '删除插件'}
                            aria-label="删除插件"
                          >
                            <Trash2 size={11} />
                          </button>
                          {/* 启用开关 */}
                          <button
                            onClick={() => void toggle(p.dirName, !p.enabled)}
                            role="switch"
                            aria-checked={p.enabled}
                            aria-label={p.dirName}
                            disabled={busyToggle === p.dirName || busyDelete === p.dirName}
                            className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${
                              p.enabled ? 'bg-accent' : 'bg-bg-muted'
                            } disabled:cursor-not-allowed disabled:opacity-50`}
                            title={p.enabled ? '点击禁用' : '点击启用'}
                          >
                            <span
                              className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
                                p.enabled ? 'left-3.5' : 'left-0.5'
                              }`}
                            />
                          </button>
                        </div>
                      </div>
                      {/* 第二行：描述（单行截断）+ 版本/工具数 */}
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-[10px] text-fg-muted">
                          {p.description || '（无描述）'}
                        </span>
                        <span className="shrink-0 text-[9px] text-fg-muted/60">
                          v{p.version}
                          {p.toolCount > 0 && ` · ${p.toolCount} 工具`}
                        </span>
                      </div>
                      {/* 工具列表：最多展示 4 个，其余折叠进 title，避免一插件占满整屏 */}
                      {p.tools.length > 0 && (
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          {p.tools.slice(0, 4).map((tool) => (
                            <span
                              key={tool.name}
                              className="rounded bg-bg-muted px-1 py-0.5 font-mono text-[9px] text-fg-secondary"
                              title={tool.description}
                            >
                              {tool.name}
                            </span>
                          ))}
                          {p.tools.length > 4 && (
                            <span
                              className="rounded bg-bg-muted/60 px-1 py-0.5 text-[9px] text-fg-muted"
                              title={p.tools.map((tool) => tool.name).join('、')}
                            >
                              +{p.tools.length - 4}
                            </span>
                          )}
                        </div>
                      )}
                      {/* 错误 */}
                      {p.errors.length > 0 && (
                        <div className="mt-1 rounded bg-danger-soft/60 px-1.5 py-0.5 text-[10px] text-danger">
                          {p.errors.slice(0, 2).map((e, i) => (
                            <div key={i} className="truncate" title={e}>
                              ⚠ {e}
                            </div>
                          ))}
                          {p.errors.length > 2 && (
                            <div className="text-fg-muted/70" title={p.errors.join('\n')}>
                              … 还有 {p.errors.length - 2} 条
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </section>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}