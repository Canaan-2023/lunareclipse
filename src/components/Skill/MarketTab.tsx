/**
 * 为什么存在：SKILL 需要来源市场、可安装清单与安装管理的完整界面，
 * 独立 Tab 承载，与本地已装 Tab 区分。
 * 作用：渲染 SKILL 市场 Tab——源管理（添加/移除/刷新）、可安装列表（已装/更新可用/
 * 本地修改徽章）、安装/更新/卸载与同步。
 */
import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2, RefreshCw, Download, RotateCw, X, Store, AlertTriangle, CheckCircle2, Upload } from 'lucide-react'
import { useSkillStore } from '../../stores/skillStore'
import { useAppStore } from '../../stores/appStore'
import { useT } from '../../i18n/useT'

/**
 * SKILL 市场 tab：
 * - 源管理：添加/移除清单 JSON / 本地目录源
 * - 可安装列表：已装/更新可用/本地修改徽章
 * - 安装/更新/卸载 + 同步全部
 * - 列表内上传（选择本机 SKILL 目录发布进市场）与下架（主系统删任意 / 分系统删自己上传的）
 * - lint 结果 + config 提示
 */

interface MarketItem {
  name: string
  description: string
  repo: string
  subdir?: string
  version?: string
  /** 所属领域（文件夹即领域：目录层级决定，可任意数量与多级，如 design/web）；空=方法论/用户级 */
  domain?: string
  sourceId: string
  installed: boolean
  hasUpdate: boolean
  /** 本地已被用户手动修改：更新会被主进程拒绝，UI 需徽章提示并禁用更新 */
  userModified: boolean
  /** 上传条目的上传者 UID（主进程返回；非上传条目无此字段） */
  uploaderUid?: number
  /** 是否可删除本条目：主系统/单机为 true，分系统仅自己上传的为 true（服务端已判定） */
  canDelete?: boolean
}

/** 方法论/用户级分组展示名（没有领域目录的技能归此） */
const USER_LEVEL_GROUP = 'panelui.skill.market.userLevelGroup'

interface Source {
  id: string
  name: string
  url: string
  type: string
}

/**
 * 内置市场源标识（与主进程 market.ts 的 BUILTIN_SOURCE_URL 保持一致文案）。
 * 为什么存在——内置源持久化的是可移植标识 builtin://market-repo，不是本机路径；
 * 展示层需要把标识翻译成用户可读文案，而不是把原始串（更不可能出现的绝对路径）
 * 暴露给用户；
 * 作用——title 与来源行都经此判断，内置源显示「内置市场（随包分发）」，
 * 让用户明白这是随安装包自带的仓库，可整体搬迁、他人可改造；
 * 留存理由——标识判断是分发的关键语义，删除后 UI 会退回显示机器相关字样或标识本体。
 */
const BUILTIN_SOURCE_DISPLAY = 'panelui.skill.market.builtinSource'

/**
 * 源展示文本：内置源给可读文案，其余（用户添加的清单 URL/本地目录）显示原 url。
 * 不删理由——上传已并入内置仓库（local://uploads 层退役），只剩内置源需要翻译，
 * 该函数仍是标识→可读文案的唯一出口。
 */
function sourceDisplay(url: string): string {
  if (url === 'builtin://market-repo') return BUILTIN_SOURCE_DISPLAY
  return url
}

/**
 * 市场条目按领域分组：领域名直接用目录层级值（文件夹即领域，领域个数与层级不限，
 * 如 design/web 多级领域原样展示），组序按领域值排序保证稳定不跳动；
 * 无领域目录的方法论技能归「方法论 · 用户级」。
 * 为什么存在——市场分两档：领域级技能按目录组织（安装落 skills_domains/{领域目录}），
 * 方法论技能进用户级；前端分组标题与安装落位语义一致，用户一眼看出装了会去哪。
 * 不引入展示名映射（DOMAIN_LABELS）的原因——领域是用户/社区自由定义的文件夹，
 * 无法预知全部领域，固定映射会使未知领域显示异常；直接用目录值即可正确展示任意领域。
 */
function renderMarketGroups(items: MarketItem[]): Array<{ label: string; items: MarketItem[] }> {
  const groups = new Map<string, MarketItem[]>()
  for (const item of items) {
    const label = item.domain ?? USER_LEVEL_GROUP
    const arr = groups.get(label) ?? []
    arr.push(item)
    groups.set(label, arr)
  }
  const byName = (list: MarketItem[]) => [...list].sort((a, b) => a.name.localeCompare(b.name))
  const ordered: Array<{ label: string; items: MarketItem[] }> = []
  // 用户级方法论技能置顶；目录即领域：领域值排序（未知/新增领域也能稳定排位，不会每次刷新跳动）
  const known = groups.get(USER_LEVEL_GROUP)
  if (known) ordered.push({ label: USER_LEVEL_GROUP, items: byName(known) })
  for (const label of [...groups.keys()].filter((k) => k !== USER_LEVEL_GROUP).sort()) {
    ordered.push({ label, items: byName(groups.get(label)!) })
  }
  return ordered
}

export function MarketTab() {
  const t = useT()
  const [items, setItems] = useState<MarketItem[]>([])
  const [sources, setSources] = useState<Source[]>([])
  const [loading, setLoading] = useState(false)
  const [showAddSource, setShowSource] = useState(false)
  const [sourceName, setSourceName] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  // 逐项 busy 态：安装/更新/卸载期间禁用对应按钮，防双击重复写盘（评审 MINOR-12）
  const [busyName, setBusyName] = useState('')
  // 同步全部 busy 态：marketSync 为耗时网络操作，无 busy 时双击会重复同步并互相覆盖提示；
  // 作用：与逐项 busyName 同一防双击策略，只是作用于"同步全部"这一整体操作。
  // 不删的理由：同步期间再点一次会导致并发写盘与提示错乱。
  const [syncing, setSyncing] = useState(false)
  // 上传 busy 态：目录选择对话框弹出期间防止重复点击再次弹框
  const [uploading, setUploading] = useState(false)

  // 自动刷新触发源：① 切换会话 AI（currentAiId 变化，市场数据按 uid/aiId 作用域分层）；
  // ② 技能变更事件（skillsChangedAt 时间戳，安装/更新/卸载/同步/磁盘热重载后主进程广播）。
  // 任一变化都重拉市场，去掉手动刷新依赖。
  const currentAiId = useAppStore((s) => s.currentAiId)
  const skillsChangedAt = useSkillStore((s) => s.skillsChangedAt)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [listRes, srcRes] = await Promise.all([
        window.lunareclipse.skill.marketList(),
        window.lunareclipse.skill.marketSources()
      ])
      if (listRes.ok && listRes.items) setItems(listRes.items)
      else setError(listRes.error ?? t('panelui.skill.market.loadFailed'))
      if (srcRes.ok && srcRes.sources) setSources(srcRes.sources)
    } finally {
      setLoading(false)
    }
  }, [])

  // 挂载加载 + 自动刷新：currentAiId / skillsChangedAt 变化时重载市场
  useEffect(() => {
    void load()
  }, [load, currentAiId, skillsChangedAt])

  const addSource = async () => {
    setError('')
    if (!sourceUrl.trim()) { setError(t('panelui.skill.market.urlEmpty')); return }
    const res = await window.lunareclipse.skill.marketAddSource(sourceName.trim() || t('panelui.skill.market.customSource'), sourceUrl.trim())
    if (!res.ok) { setError(res.error ?? t('panelui.skill.market.addFailed')); return }
    setSourceName('')
    setSourceUrl('')
    setShowSource(false)
    void load()
  }

  const removeSource = async (id: string) => {
    // 移除市场源会从本地源清单删除条目，依赖该源的 skill 不再随同步更新，属不可逆配置变更。
    // 作用：给"移除源"加确认，防止误删后需重新填写 URL。
    // 不删的理由：与卸载 skill/删除定时任务等删除操作保持同一确认标准。
    if (!confirm(t('panelui.skill.market.removeSourceConfirm'))) return
    await window.lunareclipse.skill.marketRemoveSource(id)
    void load()
  }

  const install = async (item: MarketItem) => {
    setError('')
    setNotice('')
    setBusyName(item.name)
    try {
      const res = await window.lunareclipse.skill.marketInstall(item.name)
      if (!res.ok) { setError(res.error ?? t('panelui.skill.market.installFailed', { name: item.name })); return }
      setNotice(t('panelui.skill.market.installDone', { name: item.name, lint: res.lint && res.lint.errors > 0 ? t('panelui.skill.lintWarn') : '', config: res.config?.length ? t('panelui.skill.market.hasConfig') : '' }))
      void load()
      // 重拉已装列表：市场安装/更新/卸载会写磁盘，已装 Tab 数据必须与主进程重新对齐
      void useSkillStore.getState().refresh()
    } finally {
      setBusyName('')
    }
  }

  const update = async (name: string) => {
    setBusyName(name)
    try {
      const res = await window.lunareclipse.skill.marketUpdate(name)
      if (!res.ok) { setError(res.error ?? t('panelui.skill.market.updateFailed', { name })); return }
      setNotice(t('panelui.skill.market.updated', { name }))
      void load()
      // 重拉已装列表：与安装/卸载保持一致，避免更新后已装 Tab 版本信息滞后
      void useSkillStore.getState().refresh()
    } finally {
      setBusyName('')
    }
  }

  const remove = async (name: string) => {
    // 卸载 skill 会删除磁盘上的已安装文件，属不可逆操作，先确认再执行。
    // 作用：防止误点"卸载"丢失本地 skill 文件。
    // 不删的理由：与 Cron/日历/执行器等其他删除操作保持同一确认标准。
    if (!confirm(t('panelui.skill.market.removeConfirm', { name }))) return
    setBusyName(name)
    try {
      const res = await window.lunareclipse.skill.marketRemove(name)
      if (!res.ok) { setError(res.error ?? t('panelui.skill.market.removeFailed', { name })); return }
      setNotice(t('panelui.skill.market.removed', { name }))
      void load()
      // 重拉已装列表：卸载后已装 Tab 不能仍显示已被移除的技能
      void useSkillStore.getState().refresh()
    } finally {
      setBusyName('')
    }
  }

  const syncAll = async () => {
    // 同步是耗时网络操作，进行中禁止再次触发，防止并发写盘与提示互相覆盖（与逐项 busyName 同策略）。
    // 作用：syncAll 整体只允许一个在途实例。
    // 不删的理由：无此保护时双击"同步全部"会并发同步并错乱 notice/error 提示。
    if (syncing) return
    setSyncing(true)
    setError('')
    try {
      const res = await window.lunareclipse.skill.marketSync()
      if (res.updated?.length) setNotice(t('panelui.skill.market.syncDone', { n: res.updated.length }))
      else if (res.errors?.length) setError(t('panelui.skill.market.syncPartial', { errors: res.errors.join('; ') }))
      else setNotice(t('panelui.skill.market.syncAllFresh'))
    } finally {
      setSyncing(false)
      void load()
      // 同步可能改变已装技能集合，已装 Tab 一并回刷
      void useSkillStore.getState().refresh()
    }
  }

  /** 列表内直接上传：主进程弹原生目录选择，选中的目录须含 SKILL.md（校验/发布/广播在服务端） */
  const upload = async () => {
    if (uploading) return
    setUploading(true)
    setError('')
    setNotice('')
    try {
      const res = await window.lunareclipse.skill.marketUpload()
      if (!res.ok) {
        // 用户主动取消目录选择不是错误，不打扰；其余失败如实提示
        if (res.error !== '已取消选择目录') setError(res.error ?? t('panelui.skill.uploadFailed'))
        return
      }
      setNotice(t('panelui.skill.market.uploadDone', { name: res.name ?? '', lint: res.lint && res.lint.errors > 0 ? t('panelui.skill.lintWarn') : '' }))
      // 上传会写入市场源/条目，列表与已装面板都应与主进程重新对齐
      void load()
      void useSkillStore.getState().refresh()
    } finally {
      setUploading(false)
    }
  }

  /** 从市场删除（下架）一个 skill；权限由主进程判定（主系统删任意 / 分系统删自己上传的） */
  const unpublish = async (item: MarketItem) => {
    // 删除是市场级不可逆操作（全网不再显示、需重新上传才能恢复），先确认再执行。
    // 作用：防止误点"删除"移除他人可用的市场技能；与卸载/删源保持同一确认标准。
    if (!item.canDelete) return
    if (!confirm(t('panelui.skill.market.unpublishConfirm', { name: item.name }))) return
    setBusyName(item.name)
    try {
      const res = await window.lunareclipse.skill.marketUnpublish(item.name)
      if (!res.ok) { setError(res.error ?? t('panelui.skill.market.unpublishFailed', { name: item.name })); return }
      setNotice(t('panelui.skill.market.unpublished', { name: item.name }))
      void load()
    } finally {
      setBusyName('')
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* 源管理 + 操作 */}
      <div className="border-b border-border-subtle px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Store size={13} className="text-accent shrink-0" />
          <span className="text-caption font-medium text-fg-primary">{t('panelui.skill.market.title')}</span>
          <div className="flex-1" />
          <button
            onClick={() => void syncAll()}
            disabled={syncing}
            className="flex items-center gap-1 rounded-btn bg-bg-muted px-2 py-1 text-[11px] text-fg-secondary hover:bg-bg-muted/70 disabled:opacity-40 disabled:cursor-not-allowed"
            title={t('panelui.skill.market.syncAllTitle')}
          >
            <RefreshCw size={11} className={syncing ? 'animate-spin' : ''} />
            {t('panelui.skill.market.syncAll')}
          </button>
          <button
            onClick={() => void load()}
            className="flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
            title={t('panelui.skill.market.refresh')}
            aria-label={t('panelui.skill.market.refreshAria')}
          >
            <RotateCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => setShowSource(!showAddSource)}
            className="flex items-center gap-1 rounded-btn bg-accent/15 px-2 py-1 text-[11px] text-accent hover:bg-accent/25"
            title={t('panelui.skill.market.addSource')}
          >
            <Plus size={11} />
            {t('panelui.skill.market.addSourceShort')}
          </button>
          <button
            onClick={() => void upload()}
            disabled={uploading}
            className="flex items-center gap-1 rounded-btn bg-accent px-2 py-1 text-[11px] font-medium text-accent-fg hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
            title={t('panelui.skill.market.uploadTitle')}
          >
            <Upload size={11} />
            {uploading ? t('panelui.skill.uploading') : t('panelui.skill.upload')}
          </button>
        </div>
        {/* 源列表 */}
        {sources.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {sources.map((s) => (
              <span key={s.id} className="flex items-center gap-1 rounded bg-bg-muted px-1.5 py-0.5 text-[10px] text-fg-secondary" title={t(sourceDisplay(s.url))}>
                {s.name}
                <button
                  onClick={() => void removeSource(s.id)}
                  className="text-fg-muted hover:text-danger"
                  title={t('panelui.skill.market.removeSource')}
                  aria-label={t('panelui.skill.market.removeSourceAria', { name: s.name })}
                >
                  <X size={9} />
                </button>
              </span>
            ))}
          </div>
        )}
        {/* 添加源表单 */}
        {showAddSource && (
          <div className="mt-2 space-y-1.5 rounded-card border border-border-subtle bg-bg-base/50 p-2">
            <input
              value={sourceName}
              onChange={(e) => setSourceName(e.target.value)}
              placeholder={t('panelui.skill.market.sourceNamePlaceholder')}
              className="w-full rounded-btn border border-border-subtle bg-bg-base px-2 py-1 text-caption text-fg-primary outline-none focus:border-accent"
            />
            <input
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder={t('panelui.skill.market.sourceUrlPlaceholder')}
              className="w-full rounded-btn border border-border-subtle bg-bg-base px-2 py-1 text-caption text-fg-primary outline-none focus:border-accent"
            />
            <button
              onClick={() => void addSource()}
              className="w-full rounded-btn bg-accent py-1 text-caption font-medium text-accent-fg hover:bg-accent/90"
            >
              {t('panelui.skill.market.add')}
            </button>
          </div>
        )}
      </div>

      {/* 提示/错误 */}
      {notice && (
        <div className="flex items-center gap-1.5 border-b border-success/20 bg-success/8 px-3 py-1.5 text-[11px] text-success">
          <CheckCircle2 size={11} />
          {notice}
        </div>
      )}
      {error && (
        <div className="flex items-center gap-1.5 border-b border-danger/20 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
          <AlertTriangle size={11} />
          <span className="flex-1">{error}</span>
        </div>
      )}

      {/* 可安装列表 */}
      <div className="flex-1 overflow-y-auto p-2">
        {items.length === 0 ? (
          <div className="px-3 py-8 text-center text-caption text-fg-muted">
            {loading ? t('panelui.skill.market.loading') : t('panelui.skill.market.empty')}
            <div className="mt-2 text-[11px] leading-relaxed">
              {t('panelui.skill.market.emptyHint1')}
              <br />
              {t('panelui.skill.market.emptyHint2')}
            </div>
          </div>
        ) : (
          renderMarketGroups(items).map((group) => (
            <div key={group.label} className="mb-3">
              <div className="mb-1 flex items-center gap-1.5 px-0.5">
                <span className="text-[10px] font-medium uppercase tracking-wide text-fg-muted">
                  {t(group.label)}
                </span>
                <span className="text-[10px] text-fg-muted/50">({group.items.length})</span>
              </div>
              {group.items.map((item) => (
                <div key={item.name} className="mb-2 rounded-card border border-border-subtle bg-bg-base/50 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-caption font-medium text-fg-primary">{item.name}</span>
                  {item.domain && (
                    <span className="shrink-0 rounded-full bg-accent/10 px-1.5 py-0.5 text-[9px] text-accent" title={t('panelui.skill.market.domainFolder', { domain: item.domain })}>
                      {item.domain}
                    </span>
                  )}
                  {item.installed && (
                    <span className="shrink-0 rounded-full bg-success/15 px-1.5 py-0.5 text-[9px] text-success">{t('panelui.skill.market.installed')}</span>
                  )}
                  {item.hasUpdate && (
                    <span className="shrink-0 rounded-full bg-accent/15 px-1.5 py-0.5 text-[9px] text-accent">{t('panelui.skill.market.hasUpdate')}</span>
                  )}
                  {item.userModified && (
                    <span className="shrink-0 rounded-full bg-warning/15 px-1.5 py-0.5 text-[9px] text-warning" title={t('panelui.skill.market.userModifiedTitle')}>{t('panelui.skill.market.userModified')}</span>
                  )}
                  {item.version && <span className="shrink-0 text-[10px] text-fg-muted/70">v{item.version}</span>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {item.installed ? (
                    <>
                      {item.hasUpdate && (
                        <button
                          onClick={() => void update(item.name)}
                          // 本地修改过的 skill：主进程 update() 会拒绝（「已被本地修改，更新跳过」），
                          // 按钮必须禁用并解释，否则用户以为点了没反应是 bug
                          disabled={busyName !== '' || item.userModified}
                          title={item.userModified ? t('panelui.skill.market.userModifiedUpdateTitle') : undefined}
                          className="flex items-center gap-1 rounded-btn bg-accent/15 px-2 py-1 text-[10px] text-accent hover:bg-accent/25 disabled:opacity-40"
                        >
                          <RotateCw size={10} />
                          {item.userModified ? t('panelui.skill.market.modified') : busyName === item.name ? t('panelui.skill.market.updating') : t('panelui.skill.market.update')}
                        </button>
                      )}
                      <button
                        onClick={() => void remove(item.name)}
                        disabled={busyName !== ''}
                        className="flex items-center gap-1 rounded-btn bg-danger/10 px-2 py-1 text-[10px] text-danger hover:bg-danger/20 disabled:opacity-40"
                      >
                        <Trash2 size={10} />
                        {busyName === item.name ? t('panelui.skill.market.processing') : t('panelui.skill.market.uninstall')}
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => void install(item)}
                      disabled={busyName !== ''}
                      className="flex items-center gap-1 rounded-btn bg-accent/15 px-2 py-1 text-[10px] text-accent hover:bg-accent/25 disabled:opacity-40"
                    >
                      <Download size={10} />
                      {busyName === item.name ? t('panelui.skill.market.installing') : t('panelui.skill.market.install')}
                    </button>
                  )}
                  {/* 市场条目的删除入口：canDelete 由主进程按角色+条目归属判定
                      （主系统/单机删任意条目含内置源；分系统仅删自己上传的） */}
                  {item.canDelete && (
                    <button
                      onClick={() => void unpublish(item)}
                      disabled={busyName !== ''}
                      className="flex items-center gap-1 rounded-btn bg-danger/10 px-2 py-1 text-[10px] text-danger hover:bg-danger/20 disabled:opacity-40"
                      title={t('panelui.skill.market.unpublishTitle')}
                    >
                      <X size={10} />
                      {busyName === item.name ? t('panelui.skill.market.processing') : t('panelui.skill.market.delete')}
                    </button>
                  )}
                </div>
              </div>
              <div className="mt-1 text-[11px] leading-relaxed text-fg-muted">
                {item.description || t('panelui.skill.market.noDescription')}
              </div>
              <div className="mt-1 truncate text-[10px] text-fg-muted/50">
                {item.subdir ? `${t(sourceDisplay(item.repo))}/${item.subdir}` : t(sourceDisplay(item.repo))}
              </div>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
