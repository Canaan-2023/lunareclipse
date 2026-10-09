/**
 * 为什么存在：SKILL 管理需要列表、详情与启停的完整界面（面板形式），
 * 与市场 Tab 组成"已装 + 市场"双视图。
 * 作用：渲染 SKILL 面板——列表（来源/启用/状态）与详情（Markdown 渲染、元数据、
 * 运行时状态），支持启停/删除/重载/打开目录。
 */
import { useEffect, useState, useMemo } from 'react'
import { X, GraduationCap, RefreshCw, ArrowLeft, Loader2, AlertTriangle, Power, Zap, EyeOff, Clock, Hash, Store, Trash2, Folder, Upload } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useSkillStore } from '../../stores/skillStore'
import type { SkillMetadata, SkillRuntimeStatus } from '../../../electron/main/skills'
import { MarkdownRenderer } from '../Chat/MarkdownRenderer'
import { MarketTab } from './MarketTab'

const SOURCE_LABELS: Record<string, string> = {
  user: '用户级',
  domain: '领域级'
}

const SOURCE_COLORS: Record<string, string> = {
  user: 'bg-purple-500/10 text-purple-400',
  domain: 'bg-accent/10 text-accent'
}

/** 格式化时间戳为相对时间 */
function formatRelativeTime(ts: number | null): string {
  if (!ts) return '从未使用'
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

/**
 * SKILL 管理面板（对齐 MCP 系统架构）
 * - 右侧侧拉面板，与浏览器/沙箱面板同样的布局策略
 * - 列表视图：展示所有 SKILL 的 name / description / 来源标签 / 启用开关 / 状态徽章
 * - 正文视图：点击某个 SKILL 后展示其 Markdown 正文 + 元信息
 * - 配置层：支持启用/禁用（写入 .skills.json，触发热重载）
 * - 状态监控：显示使用次数、最后使用时间、加载错误
 */
export function SkillPanel() {
  const open = useAppStore((s) => s.activeDrawer === 'skill' && !s.vizPanelOpen && !s.settingsOpen)
  const closeDrawer = useAppStore((s) => s.closeDrawer)

  const skills = useSkillStore((s) => s.skills)
  const currentSkill = useSkillStore((s) => s.currentSkill)
  const statuses = useSkillStore((s) => s.statuses)
  const loadErrors = useSkillStore((s) => s.loadErrors)
  const loading = useSkillStore((s) => s.loading)
  const error = useSkillStore((s) => s.error)
const init = useSkillStore((s) => s.init)
  const reloadSkills = useSkillStore((s) => s.reloadSkills)
  const loadSkill = useSkillStore((s) => s.loadSkill)
  const clearCurrent = useSkillStore((s) => s.clearCurrent)
  const clearError = useSkillStore((s) => s.clearError)
  const toggleSkill = useSkillStore((s) => s.toggleSkill)
  const deleteSkill = useSkillStore((s) => s.deleteSkill)
  const [view, setView] = useState<'list' | 'market'>('list')
  // 上传到技能商场 busy 态：目录选择对话框弹出期间防止重复点击再次弹框（与 MarketTab 同策略）
  const [uploading, setUploading] = useState(false)
  const [uploadName, setUploadName] = useState<string | null>(null)
  const [uploadNotice, setUploadNotice] = useState('')
  const [uploadError, setUploadError] = useState('')

  // 打开时初始化（每次打开都重新拉取列表，与磁盘/主进程保持一致；
  // 已在 skillStore.init 移除 skillsLoaded 防重复标记——它曾导致安装/切换账号后列表永不刷新）
  useEffect(() => {
    if (open) void init()
  }, [open, init])

  if (!open) return null

  const handleDelete = async (name: string, _source: string) => {
    if (!confirm(`删除技能「${name}」？\n此操作不可撤销，技能目录及其所有文件将被永久删除。`)) return
    const ok = await deleteSkill(name)
    if (ok) void reloadSkills()
  }

  // 从列表上传到技能商场：主进程弹原生目录选择，选中的目录须含 SKILL.md（校验/发布/广播在服务端）
  const handleUpload = async () => {
    if (uploading || uploadName) return
    setUploading(true)
    setUploadNotice('')
    setUploadError('')
    try {
      const res = await window.lunareclipse.skill.marketUpload()
      if (!res.ok) {
        // 用户主动取消目录选择不是错误，不打扰；其余失败如实提示
        if (res.error !== '已取消选择目录') setUploadError(res.error ?? '上传失败')
        return
      }
      setUploadNotice(`✅ ${res.name} 已上传到技能商场${res.lint && res.lint.errors > 0 ? '（有 lint 错误）' : ''}`)
      void useSkillStore.getState().refresh()
    } finally {
      setUploading(false)
    }
  }

  // 列表项一键上传：按技能名直接同步到技能商场（领域落位由主进程按目录判定，无需选目录）
  const handleUploadByName = async (name: string) => {
    if (uploading || uploadName) return
    setUploadName(name)
    setUploadNotice('')
    setUploadError('')
    try {
      const res = await window.lunareclipse.skill.marketUploadByName(name)
      if (!res.ok) {
        setUploadError(res.error ?? `上传 ${name} 失败`)
        return
      }
      setUploadNotice(`✅ ${res.name} 已上传到技能商场${res.lint && res.lint.errors > 0 ? '（有 lint 错误）' : ''}`)
      void useSkillStore.getState().refresh()
    } finally {
      setUploadName(null)
    }
  }

  // 按 name 索引状态
  const statusMap = new Map<string, SkillRuntimeStatus>()
  for (const s of statuses) statusMap.set(s.name, s)

  return (
    <div className="flex h-full w-full flex-col bg-bg-surface">
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* 顶部工具栏 */}
        <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
          {currentSkill ? (
            <button
              onClick={clearCurrent}
              className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted transition-all duration-150 hover:bg-bg-muted hover:text-fg-primary active:scale-95"
              title="返回列表"
              aria-label="返回列表"
            >
              <ArrowLeft size={14} />
            </button>
          ) : (
            <GraduationCap size={14} className="text-accent shrink-0" />
          )}
          <span className="text-caption font-medium text-fg-primary mr-1 truncate">
            {currentSkill ? currentSkill.name : 'SKILL'}
          </span>
          {/* SKILL 数量 */}
          {!currentSkill && skills.length > 0 && (
            <span className="rounded-full bg-bg-muted px-1.5 py-0.5 text-[10px] text-fg-muted">
              {skills.length}
            </span>
          )}
          {/* 错误数量 */}
          {!currentSkill && loadErrors.length > 0 && (
            <span className="flex items-center gap-0.5 rounded-full bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-400" title={`${loadErrors.length} 个 SKILL 加载失败`}>
              <AlertTriangle size={9} />
              {loadErrors.length}
            </span>
          )}
          <div className="flex-1" />
          {/* 视图切换：列表 / 市场 */}
          {!currentSkill && (
            <button
              onClick={() => setView(view === 'market' ? 'list' : 'market')}
              className={`flex h-7 items-center gap-1 rounded-btn px-2 text-caption transition-colors ${
                view === 'market' ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:bg-bg-muted hover:text-fg-primary'
              }`}
              title={view === 'market' ? '返回 SKILL 列表' : '打开 SKILL 市场'}
            >
              <Store size={12} />
              {view === 'market' ? '列表' : '市场'}
            </button>
          )}
          {/* 上传到技能商场（列表/市场视图均可用，须选含 SKILL.md 的本地目录） */}
          {!currentSkill && (
            <button
              onClick={() => void handleUpload()}
              disabled={uploading}
              className="flex h-7 items-center gap-1 rounded-btn px-2 text-caption text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary disabled:opacity-40 disabled:cursor-not-allowed"
              title="从列表上传到技能商场"
            >
              {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
              上传
            </button>
          )}
          {/* 手动重载（强制重新扫描） */}
          <button
            onClick={() => void reloadSkills()}
            disabled={loading}
            className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted transition-all duration-150 hover:bg-bg-muted hover:text-fg-primary disabled:opacity-30"
            title="强制重载所有 SKILL"
            aria-label="强制重载所有 SKILL"
          >
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          </button>
          {/* 关闭 */}
          <button
            onClick={() => closeDrawer()}
            className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted transition-all duration-150 hover:bg-bg-muted hover:text-fg-primary active:scale-95"
            title="关闭"
            aria-label="关闭"
          >
            <X size={14} />
          </button>
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="flex items-center gap-2 border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-caption text-red-400">
            <AlertTriangle size={12} className="shrink-0" />
            <span className="flex-1">{error}</span>
            <button
              onClick={clearError}
              className="flex h-4 w-4 items-center justify-center rounded text-fg-muted hover:text-fg-primary"
              title="清除错误"
            >
              <X size={10} />
            </button>
          </div>
        )}

        {/* 上传失败提示 */}
        {uploadError && (
          <div className="flex items-center gap-2 border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-caption text-red-400">
            <AlertTriangle size={12} className="shrink-0" />
            <span className="flex-1">{uploadError}</span>
            <button
              onClick={() => setUploadError('')}
              className="flex h-4 w-4 items-center justify-center rounded text-fg-muted hover:text-fg-primary"
              title="清除错误"
            >
              <X size={10} />
            </button>
          </div>
        )}

        {/* 上传成功提示 */}
        {uploadNotice && (
          <div className="flex items-center gap-2 border-b border-green-500/20 bg-green-500/10 px-3 py-2 text-caption text-green-400">
            <span className="flex-1">{uploadNotice}</span>
            <button
              onClick={() => setUploadNotice('')}
              className="flex h-4 w-4 items-center justify-center rounded text-fg-muted hover:text-fg-primary"
              title="关闭"
            >
              <X size={10} />
            </button>
          </div>
        )}

        {/* 内容区（市场视图用 flex 布局让 MarketTab 内部滚动；列表/详情用 overflow-y-auto） */}
        <div className={`flex-1 ${view === 'market' && !currentSkill ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'}`}>
          {view === 'market' && !currentSkill ? (
            // ===== 市场视图 =====
            <MarketTab />
          ) : currentSkill ? (
            // ===== 正文视图 =====
            <div className="px-4 py-3">
              {/* 元信息卡片 */}
              <div className="mb-3 rounded-btn bg-bg-muted p-3">
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-body font-medium text-fg-primary">{currentSkill.name}</span>
                  {/* 删除按钮（仅 user / domain 来源可删除） */}
                  {(currentSkill.source === 'user' || currentSkill.source === 'domain') && (
                    <button
                      onClick={() => void handleDelete(currentSkill.name, currentSkill.source)}
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-muted transition-colors hover:bg-danger-soft hover:text-danger"
                      title="删除技能"
                      aria-label="删除技能"
                    >
                      <Trash2 size={11} />
                    </button>
                  )}
                  {/* 启用/禁用开关 */}
                  <button
                    onClick={() => void toggleSkill(currentSkill.name, !currentSkill.runtime.enabled)}
                    role="switch"
                    aria-checked={currentSkill.runtime.enabled}
                    aria-label={currentSkill.name}
                    className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${
                      currentSkill.runtime.enabled ? 'bg-accent' : 'bg-bg-muted border border-border-subtle'
                    }`}
                    title={currentSkill.runtime.enabled ? '点击禁用' : '点击启用'}
                  >
                    <span
                      className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
                        currentSkill.runtime.enabled ? 'left-3.5' : 'left-0.5'
                      }`}
                    />
                  </button>
                </div>
                <div className="mt-1 text-caption text-fg-secondary">{currentSkill.description}</div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {/* 来源 */}
                  <span className={`rounded-full px-2 py-0.5 text-[10px] ${SOURCE_COLORS[currentSkill.source] ?? SOURCE_COLORS.domain}`}>
                    {SOURCE_LABELS[currentSkill.source] ?? currentSkill.source}
                  </span>
                  {/* 领域（领域级） */}
                  {currentSkill.source === 'domain' && currentSkill.domain && (
                    <span className="flex items-center gap-0.5 rounded-full bg-accent/5 px-2 py-0.5 text-[10px] text-accent/80" title={`领域（文件夹）: ${currentSkill.domain}`}>
                      <Folder size={9} />
                      {currentSkill.domain}
                    </span>
                  )}
                  {/* 自动触发状态 */}
                  {currentSkill.runtime.enabled && !currentSkill.disableModelInvocation ? (
                    <span className="flex items-center gap-0.5 rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] text-green-400" title="AI 可自动触发">
                      <Zap size={9} />
                      自动触发
                    </span>
                  ) : currentSkill.disableModelInvocation ? (
                    <span className="flex items-center gap-0.5 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-400" title="禁用 AI 自动触发">
                      <Power size={9} />
                      禁用自动
                    </span>
                  ) : null}
                  {/* 用户可见性 */}
                  {currentSkill.userInvocable === false && (
                    <span className="flex items-center gap-0.5 rounded-full bg-bg-muted px-2 py-0.5 text-[10px] text-fg-muted" title="用户菜单不可见">
                      <EyeOff size={9} />
                      隐藏
                    </span>
                  )}
                  {/* 执行上下文 */}
                  {currentSkill.context === 'fork' && (
                    <span className="rounded-full bg-indigo-500/10 px-2 py-0.5 text-[10px] text-indigo-400" title="子 agent 隔离执行">
                      fork
                    </span>
                  )}
                  {/* 工具白名单 */}
                  {currentSkill.allowedTools && currentSkill.allowedTools.length > 0 && (
                    <span className="rounded-full bg-cyan-500/10 px-2 py-0.5 text-[10px] text-cyan-400" title={`工具白名单: ${currentSkill.allowedTools.join(', ')}`}>
                      {currentSkill.allowedTools.length} 工具
                    </span>
                  )}
                  {/* 路径自动激活 */}
                  {currentSkill.paths && currentSkill.paths.length > 0 && (
                    <span className="rounded-full bg-teal-500/10 px-2 py-0.5 text-[10px] text-teal-400" title={`路径匹配: ${currentSkill.paths.join(', ')}`}>
                      {currentSkill.paths.length} 路径
                    </span>
                  )}
                </div>
                {/* 使用统计 */}
                {statusMap.get(currentSkill.name) && (
                  <div className="mt-2 flex items-center gap-3 text-[10px] text-fg-muted">
                    <span className="flex items-center gap-0.5" title="使用次数">
                      <Hash size={9} />
                      {statusMap.get(currentSkill.name)?.useCount ?? 0}
                    </span>
                    <span className="flex items-center gap-0.5" title="最后使用时间">
                      <Clock size={9} />
                      {formatRelativeTime(statusMap.get(currentSkill.name)?.lastUsedAt ?? null)}
                    </span>
                  </div>
                )}
              </div>
              {/* 正文（Markdown 渲染，复用 Chat 的 MarkdownRenderer） */}
              {currentSkill.body
                ? <div className="text-body leading-relaxed text-fg-secondary"><MarkdownRenderer content={currentSkill.body} /></div>
                : <div className="px-3 py-8 text-center text-caption text-fg-muted">（无正文）</div>}
            </div>
          ) : (
            // ===== 列表视图 =====
            <div className="px-2 py-2">
              {skills.length === 0 && !loading ? (
                <div className="px-3 py-8 text-center text-caption text-fg-muted">
                  暂无 SKILL
                  <div className="mt-1 text-fg-muted/70">在 skills 目录下创建 SKILL.md 即可</div>
                </div>
              ) : (
                <SkillListGroups
                  skills={skills}
                  statusMap={statusMap}
                  uploadName={uploadName}
                  onToggle={(name, enabled) => void toggleSkill(name, enabled)}
                  onLoad={(name) => void loadSkill(name)}
                  onDelete={(name, source) => void handleDelete(name, source)}
                  onUploadByName={(name) => void handleUploadByName(name)}
                />
              )}
              {/* 加载错误列表 */}
              {loadErrors.length > 0 && (
                <div className="mt-3 border-t border-border-subtle px-2 pt-3">
                  <div className="mb-2 flex items-center gap-1 text-[10px] uppercase tracking-wider text-red-400">
                    <AlertTriangle size={10} />
                    加载错误（{loadErrors.length}）
                  </div>
                  {loadErrors.map((err, idx) => (
                    <div key={idx} className="mb-1 rounded-btn bg-red-500/5 px-2 py-1.5 text-[10px] text-red-400">
                      <div className="truncate font-mono">{err.filePath.split(/[\\/]/).pop()}</div>
                      <div className="mt-0.5 text-fg-muted">{err.error}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 技能列表分组容器：按来源（user/domain）和领域分组渲染。
 * 两个区域始终显示——空状态时展示占位提示，保证功能可发现性。
 */
function SkillListGroups({
  skills,
  statusMap,
  uploadName,
  onToggle,
  onLoad,
  onDelete,
  onUploadByName
}: {
  skills: SkillMetadata[]
  statusMap: Map<string, SkillRuntimeStatus>
  uploadName: string | null
  onToggle: (name: string, enabled: boolean) => void
  onLoad: (name: string) => void
  onDelete: (name: string, source: string) => void
  onUploadByName: (name: string) => void
}) {
  const groups = useMemo(() => {
    const userSkills = skills.filter((s) => s.source === 'user')
    const domainSkills = skills.filter((s) => s.source === 'domain')
    const domainMap = new Map<string, SkillMetadata[]>()
    for (const s of domainSkills) {
      const d = s.domain ?? '其他'
      if (!domainMap.has(d)) domainMap.set(d, [])
      domainMap.get(d)!.push(s)
    }
    return { userSkills, domainMap }
  }, [skills])

  return (
    <>
      {/* 用户级 */}
      <div className="mb-3">
        <div className="mb-1.5 flex items-center gap-1 px-1 text-[10px] uppercase tracking-wider text-fg-muted">
          <span className={`rounded-full px-2 py-0.5 ${SOURCE_COLORS.user}`}>
            {SOURCE_LABELS.user}
          </span>
          <span className="text-fg-muted/70">· {groups.userSkills.length}</span>
        </div>
        {groups.userSkills.length > 0 ? (
          groups.userSkills.map((skill) => (
            <SkillListItem
              key={skill.filePath}
              skill={skill}
              status={statusMap.get(skill.name)}
              uploadBusy={uploadName === skill.name}
              onClick={() => onLoad(skill.name)}
              onToggle={(enabled) => onToggle(skill.name, enabled)}
              onDelete={() => onDelete(skill.name, skill.source)}
              onUpload={() => onUploadByName(skill.name)}
            />
          ))
        ) : (
          <div className="px-3 py-2 text-[10px] text-fg-muted/60">暂无用户级技能</div>
        )}
      </div>

      {/* 领域级：按领域分组 */}
      <div className="mb-3">
        <div className="mb-1.5 flex items-center gap-1 px-1 text-[10px] uppercase tracking-wider text-fg-muted">
          <span className={`rounded-full px-2 py-0.5 ${SOURCE_COLORS.domain}`}>
            {SOURCE_LABELS.domain}
          </span>
          <span className="text-fg-muted/70">· {groups.domainMap.size}</span>
        </div>
        {groups.domainMap.size > 0 ? (
          [...groups.domainMap.entries()].map(([domain, domainSkills]) => (
            <div key={domain} className="mb-2">
              <div className="mb-1 flex items-center gap-1 px-1 text-[10px] text-fg-muted">
                <Folder size={9} className="text-accent/60" />
                <span className="font-medium">{domain}</span>
                <span className="text-fg-muted/50">· {domainSkills.length}</span>
              </div>
              {domainSkills.map((skill) => (
                <SkillListItem
                  key={skill.filePath}
                  skill={skill}
                  status={statusMap.get(skill.name)}
                  uploadBusy={uploadName === skill.name}
                  onClick={() => onLoad(skill.name)}
                  onToggle={(enabled) => onToggle(skill.name, enabled)}
                  onDelete={() => onDelete(skill.name, skill.source)}
                  onUpload={() => onUploadByName(skill.name)}
                />
              ))}
            </div>
          ))
        ) : (
          <div className="px-3 py-2 text-[10px] text-fg-muted/60">暂无领域级技能</div>
        )}
      </div>
    </>
  )
}

/** SKILL 列表项 */
function SkillListItem({
  skill,
  status,
  uploadBusy,
  onClick,
  onToggle,
  onDelete,
  onUpload
}: {
  skill: SkillMetadata
  status?: SkillRuntimeStatus
  uploadBusy?: boolean
  onClick: () => void
  onToggle: (enabled: boolean) => void
  onDelete: () => void
  onUpload: () => void
}) {
  const enabled = skill.runtime.enabled
  const canDelete = skill.source === 'user' || skill.source === 'domain'
  const canUpload = skill.source === 'user' || skill.source === 'domain'
  return (
    <div
      className={`group mb-1 flex flex-col gap-1 rounded-btn px-3 py-2 transition-all duration-150 hover:bg-bg-muted/70 ${
        !enabled ? 'opacity-50' : ''
      }`}
    >
      <div className="flex items-center gap-2">
        <button
          onClick={onClick}
          className="flex min-w-0 flex-1 items-center gap-2 text-left active:scale-[0.99]"
        >
          <span
            className={`max-w-[200px] truncate text-body ${enabled ? 'text-fg-primary' : 'text-fg-muted'}`}
            title={skill.name}
          >
            {skill.name}
          </span>
          {/* 来源标签 */}
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${SOURCE_COLORS[skill.source] ?? SOURCE_COLORS.domain}`}>
            {SOURCE_LABELS[skill.source] ?? skill.source}
          </span>
          {/* 自动触发徽章 */}
          {enabled && !skill.disableModelInvocation && (
            <span className="flex items-center gap-0.5 shrink-0 rounded-full bg-green-500/10 px-1.5 py-0.5 text-[10px] text-green-400" title="AI 可自动触发">
              <Zap size={8} />
            </span>
          )}
          {/* 禁用自动触发徽章 */}
          {skill.disableModelInvocation && (
            <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400" title="禁用 AI 自动触发">
              <Power size={8} />
            </span>
          )}
          {/* 隐藏徽章 */}
          {skill.userInvocable === false && (
            <span className="shrink-0 rounded-full bg-bg-muted px-1.5 py-0.5 text-[10px] text-fg-muted" title="用户菜单不可见">
              <EyeOff size={8} />
            </span>
          )}
        </button>
        {/* 操作区：固定宽度容器保证开关列在任意来源行严格右对齐（hover 显示按钮） */}
        <div className="flex h-5 w-[52px] shrink-0 items-center justify-end gap-0.5">
          {/* 删除按钮（仅 user / domain 来源可删除） */}
          {canDelete && (
            <button
              onClick={(e) => { e.stopPropagation(); onDelete() }}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-muted opacity-0 transition-opacity hover:bg-danger-soft hover:text-danger group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
              title="删除技能"
              aria-label="删除技能"
            >
              <Trash2 size={11} />
            </button>
          )}
          {/* 上传到技能市场（仅 user / domain 来源可上传） */}
          {canUpload && (
            <button
              onClick={(e) => { e.stopPropagation(); onUpload() }}
              disabled={uploadBusy}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-muted opacity-0 transition-opacity hover:bg-accent-soft hover:text-accent disabled:opacity-50 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
              title={uploadBusy ? '上传中…' : '一键上传到技能市场'}
              aria-label="上传到技能市场"
            >
              {uploadBusy ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
            </button>
          )}
        </div>
        {/* 启用/禁用开关 */}
        <button
          onClick={(e) => {
            e.stopPropagation()
            onToggle(!enabled)
          }}
          role="switch"
          aria-checked={enabled}
          aria-label={skill.name}
          className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${
            enabled ? 'bg-accent' : 'bg-bg-muted border border-border-subtle'
          }`}
          title={enabled ? '点击禁用' : '点击启用'}
        >
          <span
            className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
              enabled ? 'left-3.5' : 'left-0.5'
            }`}
          />
        </button>
      </div>
      <button onClick={onClick} className="text-left active:scale-[0.99]">
        <div className="text-caption text-fg-secondary line-clamp-2">
          {skill.description}
        </div>
        {/* 使用统计 */}
        {status && (status.useCount > 0 || status.lastUsedAt) && (
          <div className="mt-1 flex items-center gap-2 text-[10px] text-fg-muted">
            {status.useCount > 0 && (
              <span className="flex items-center gap-0.5">
                <Hash size={8} />
                {status.useCount}
              </span>
            )}
            {status.lastUsedAt && (
              <span className="flex items-center gap-0.5">
                <Clock size={8} />
                {formatRelativeTime(status.lastUsedAt)}
              </span>
            )}
          </div>
        )}
      </button>
    </div>
  )
}
