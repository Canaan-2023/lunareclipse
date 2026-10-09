/**
 * 为什么存在：用户级信息（昵称/头像/USER.md 个人资料）会注入所有 AI 会话，
 * 需要一个统一入口编辑且与"配置"分离，避免混淆账号与配置两个概念。
 * @category 个人中心
 * @summary 个人中心抽屉面板：昵称 / 头像 / 个人资料（USER.md，ABYSS 体系用户级）。

 * 数据通路（主进程 profile handlers）：
 * - 昵称/头像：profile:update 写 users.json 记录 → 返回最新 CurrentUser → store 刷新
 * - 头像图片：profile:saveAvatarImage(dataURL) → avatars/user/{uid}/avatar.{ext} → 写回 img: 引用
 * - 个人资料：profile:readUserMd / profile:writeUserMd 读写用户级资料 USER.md
 * （ABYSS/U{uid}/USER.md，所有 AI 会话注入；AI 侧经 update_user_preference 工具可读可写，≤4000 字符）
 * UI 为字段化编辑（默认）与原始 markdown 编辑（可切换），两者共用 shared/utils/user-md.ts 的字段 schema

 * 头像选择复用 AiAvatar/AvatarPicker（默认图标集 + 本地图片上传 + 清除）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Loader2, User, FileText, Check, Save, Code2, ListChecks } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useT } from '../../i18n/useT'
import { AiAvatar, AvatarPicker } from '../Ai/AiAvatar'
import {
  USER_MD_FIELDS,
  USER_MD_EMPTY,
  buildUserMdTemplate,
  parseUserMd,
  serializeUserMd,
  extractUnknown,
  type UserMdFieldDef
} from '@shared/utils/user-md'

const USER_MD_MAX = 4000

export function ProfilePanel() {
  const currentUser = useAppStore((s) => s.currentUser)
  const closeDrawer = useAppStore((s) => s.closeDrawer)
  const t = useT()

  const [昵称, set昵称] = useState(currentUser?.昵称 ?? '')
  const [用户名, set用户名] = useState(currentUser?.用户名 ?? '')
  const [头像, set头像] = useState(currentUser?.头像 ?? '')
  // USER.md：字段化编辑持有按字段名的值映射与未知字段；raw 编辑持有原文
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
  const [unknownFields, setUnknownFields] = useState<Record<string, string>>({})
  const [mdText, setMdText] = useState('')
  const [rawMode, setRawMode] = useState(false)
  const [mdLoaded, setMdLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [mdBusy, setMdBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const mdLoadedRef = useRef(false)

  const showError = (m: string) => { setError(m); setNotice(null) }
  const showNotice = (m: string) => { setNotice(m); setError(null) }

  // 进入面板加载一次 USER.md（避免头像/昵称联动导致的循环加载）
  useEffect(() => {
    if (mdLoadedRef.current) return
    mdLoadedRef.current = true
    void (async () => {
      const r = await window.lunareclipse.profileReadUserMd()
      const content = r?.ok ? (r.content ?? '') : ''
      if (!content.trim()) {
        // 空文件：用默认模板初始化，让用户从结构化的（未填写）表单开始
        const tmpl = buildUserMdTemplate()
        const { values, unknown } = parseUserMd(tmpl)
        setFieldValues(values)
        setUnknownFields(extractUnknown(values, unknown))
        setMdText(tmpl)
      } else {
        const { values, unknown } = parseUserMd(content)
        setFieldValues(values)
        setUnknownFields(extractUnknown(values, unknown))
        setMdText(content)
      }
      setMdLoaded(true)
    })()
  }, [])

  // 字段表单 → markdown 原文（raw 模式切换与保存共用一个来源）
  const builtMd = useMemo(
    () => (mdLoaded ? serializeUserMd(fieldValues, unknownFields).trim() : ''),
    [fieldValues, unknownFields, mdLoaded]
  )

  // 单字段更新：同步 fieldValues 与 mdText（切换 raw 时能拿到最新字段值）
  const updateField = (f: UserMdFieldDef, v: string) => {
    setFieldValues((prev) => {
      const next = { ...prev, [f.key]: v }
      setMdText(serializeUserMd(next, unknownFields).trim())
      return next
    })
  }

  // 切换编辑模式；从 raw 切回字段模式时以当前 mdText（raw 可能改过）重新解析，避免丢失改动
  const toggleRaw = () => {
    if (rawMode) {
      const { values, unknown } = parseUserMd(mdText || buildUserMdTemplate())
      setFieldValues(values)
      setUnknownFields(extractUnknown(values, unknown))
    }
    setRawMode((v) => !v)
  }

  // 用户资料外部变化（如切换账号）时同步表单
  useEffect(() => {
    set昵称(currentUser?.昵称 ?? '')
    set用户名(currentUser?.用户名 ?? '')
    set头像(currentUser?.头像 ?? '')
  }, [currentUser?.UID, currentUser?.昵称, currentUser?.用户名, currentUser?.头像])

  const saveProfile = async () => {
    const nick = 昵称.trim()
    if (!nick) { showError(t('profile.nicknameEmpty')); return }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const r = await window.lunareclipse.profileUpdate({ 用户名: 用户名.trim(), 昵称: nick, 头像 })
      if (!r?.ok) { showError(r?.error ?? t('profile.saveFail')); return }
      // 刷新全局 currentUser，侧栏头像菜单即时反映新用户名/昵称/头像
      useAppStore.setState({ currentUser: r.user })
      showNotice(t('profile.saved'))
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /** 头像统一落库：emoji / 图片引用（img:） / 清除（''） 均经 profile:update 持久化 */
  const onAvatarChange = async (v: string) => {
    set头像(v)
    const r = await window.lunareclipse.profileUpdate({ 头像: v })
    if (r?.ok) useAppStore.setState({ currentUser: r.user })
    else if (r?.error) showError(r.error)
  }

  const saveMd = async () => {
    setMdBusy(true)
    setError(null)
    setNotice(null)
    try {
      // 字段模式以 builtMd（字段→markdown 序列化）为准；raw 模式原样保存
      const out = rawMode ? mdText : builtMd
      if (out.length > USER_MD_MAX) {
        showError(`USER.md 内容过长（≤${USER_MD_MAX} 字符）`)
        return
      }
      const r = await window.lunareclipse.profileWriteUserMd(out)
      if (!r?.ok) { showError(r?.error ?? t('profile.writeFail')); return }
      setMdText(out) // 保存成功后以落盘内容为准
      showNotice(t('profile.writeSuccess'))
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err))
    } finally {
      setMdBusy(false)
    }
  }

  if (!currentUser) return null

  const displayName = currentUser.昵称 || currentUser.用户名

  return (
    <div className="flex h-full w-full flex-col bg-bg-surface">
      {/* 顶部工具栏 */}
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <User size={14} className="shrink-0 text-accent" />
        <span className="mr-1 truncate text-caption font-medium text-fg-primary">{t('profile.title')}</span>
        <div className="flex-1" />
        <button
          onClick={closeDrawer}
          className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted transition-all duration-150 hover:bg-bg-muted hover:text-fg-primary active:scale-95"
          title={t('common.close')}
          aria-label={t('common.close')}
        >
          <X size={14} />
        </button>
      </div>

      {notice && (
        <div className="flex items-center gap-2 border-b border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-caption text-emerald-400">
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} className="text-emerald-400/70 hover:text-emerald-400" title={t('common.close')} aria-label={t('common.close')}>
            <X size={10} />
          </button>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-caption text-red-400">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-red-400/70 hover:text-red-400" title={t('common.close')} aria-label={t('common.close')}>
            <X size={10} />
          </button>
        </div>
      )}

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto">
        {/* —— 基本信息 —— */}
        <div className="border-b border-border-subtle px-4 py-4">
          <div className="mb-3 flex items-center gap-3">
            <AiAvatar avatar={头像 || currentUser.头像} fallback={displayName.charAt(0).toUpperCase()} className="h-12 w-12 text-xl" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-body font-medium text-fg-primary">{displayName}</div>
              <div className="truncate text-caption text-fg-muted">{t('profile.username')}：{currentUser.用户名} · #{currentUser.UID}</div>
            </div>
          </div>

          <div className="mb-3">
            <div className="mb-1.5 text-caption text-fg-secondary">{t('profile.avatar')}</div>
            <AvatarPicker
              avatar={头像 || currentUser.头像}
              onChange={(v) => void onAvatarChange(v)}
              saveImage={async (dataUrl) => {
                // 仅落盘图片文件并返回 img: 引用；引用统一经 onChange → onAvatarChange 写入用户资料，避免重复落库
                const r = await window.lunareclipse.profileSaveAvatarImage(dataUrl)
                if (!r?.ok) return null
                return r.ref ?? null
              }}
              label={displayName.charAt(0).toUpperCase()}
            />
          </div>

          <div className="mb-1.5 text-caption text-fg-secondary">{t('profile.username')}</div>
          <div className="flex gap-1.5">
            <input
              value={用户名}
              onChange={(e) => set用户名(e.target.value)}
              maxLength={24}
              placeholder={currentUser.用户名}
              className="min-w-0 flex-1 rounded-btn border border-border-subtle bg-bg-muted/40 px-2.5 py-1.5 text-body text-fg-primary outline-none transition-colors placeholder:text-fg-muted focus:border-accent/50"
            />
          </div>
          <div className="mt-1.5 text-micro text-fg-muted">{t('profile.usernameHint')}</div>

          <div className="mb-1.5 mt-4 text-caption text-fg-secondary">{t('profile.nickname')}</div>
          <div className="flex gap-1.5">
            <input
              value={昵称}
              onChange={(e) => set昵称(e.target.value)}
              maxLength={24}
              placeholder={currentUser.用户名}
              className="min-w-0 flex-1 rounded-btn border border-border-subtle bg-bg-muted/40 px-2.5 py-1.5 text-body text-fg-primary outline-none transition-colors placeholder:text-fg-muted focus:border-accent/50"
            />
            <button
              onClick={() => void saveProfile()}
              disabled={busy}
              className="flex h-8 shrink-0 items-center gap-1 rounded-btn bg-accent/15 px-3 text-caption font-medium text-accent transition-colors hover:bg-accent/25 disabled:opacity-40"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              {t('profile.save')}
            </button>
          </div>
          <div className="mt-1.5 text-micro text-fg-muted">{t('profile.nicknameHint')}</div>
        </div>

        {/* —— USER.md 个人资料（ABYSS 用户级） —— */}
        <div className="px-4 py-4">
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <FileText size={13} className="text-accent" />
              <span className="text-caption font-medium text-fg-primary">{t('profile.preference')}</span>
            </div>
            <button
              onClick={toggleRaw}
              disabled={!mdLoaded}
              className="flex h-6 items-center gap-1 rounded-btn px-2 text-micro text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary disabled:opacity-40"
              title={rawMode ? t('profile.preferenceToggleFields') : t('profile.preferenceToggleRaw')}
            >
              {rawMode ? <ListChecks size={11} /> : <Code2 size={11} />}
              {rawMode ? t('profile.preferenceToggleFields') : t('profile.preferenceToggleRaw')}
            </button>
          </div>
          <div className="mb-2 text-micro leading-relaxed text-fg-muted">{t('profile.preferenceDesc')}</div>

          {rawMode ? (
            <>
              <textarea
                value={mdText}
                onChange={(e) => setMdText(e.target.value)}
                maxLength={USER_MD_MAX}
                placeholder="| 字段 | 内容 |"
                rows={12}
                className="w-full resize-y rounded-btn border border-border-subtle bg-bg-muted/40 px-2.5 py-2 text-body leading-relaxed text-fg-primary outline-none transition-colors placeholder:text-fg-muted focus:border-accent/50"
              />
              <div className="mt-1.5 text-micro text-fg-muted">{t('profile.preferenceRawHint')}</div>
            </>
          ) : (
            <div className="space-y-2.5">
              {USER_MD_FIELDS.map((f) => (
                <label key={f.key} className="block">
                  <div className="mb-1 flex items-baseline justify-between gap-2">
                    <span className="text-caption font-medium text-fg-secondary">
                      {t(f.labelKey ?? 'profile.field.name')}
                    </span>
                    {f.key && fieldValues[f.key] === USER_MD_EMPTY && (
                      <span className="text-micro text-fg-muted/70">{USER_MD_EMPTY}</span>
                    )}
                  </div>
                  {f.multiline ? (
                    <textarea
                      value={fieldValues[f.key] === USER_MD_EMPTY ? '' : (fieldValues[f.key] ?? '')}
                      onChange={(e) => updateField(f, e.target.value)}
                      placeholder={USER_MD_EMPTY}
                      rows={2}
                      className="w-full resize-y rounded-btn border border-border-subtle bg-bg-muted/40 px-2.5 py-1.5 text-body leading-relaxed text-fg-primary outline-none transition-colors placeholder:text-fg-muted/70 focus:border-accent/50"
                    />
                  ) : (
                    <input
                      value={fieldValues[f.key] === USER_MD_EMPTY ? '' : (fieldValues[f.key] ?? '')}
                      onChange={(e) => updateField(f, e.target.value)}
                      placeholder={USER_MD_EMPTY}
                      className="w-full rounded-btn border border-border-subtle bg-bg-muted/40 px-2.5 py-1.5 text-body text-fg-primary outline-none transition-colors placeholder:text-fg-muted/70 focus:border-accent/50"
                    />
                  )}
                  {f.hintKey && <div className="mt-1 text-micro text-fg-muted/80">{t(f.hintKey)}</div>}
                </label>
              ))}
            </div>
          )}

          <div className="mt-3 flex items-center justify-between gap-2">
            <span className={`text-micro ${(rawMode ? mdText : builtMd).length > USER_MD_MAX * 0.9 ? 'text-amber-400' : 'text-fg-muted'}`}>
              {(rawMode ? mdText : builtMd).length}/{USER_MD_MAX}
            </span>
            <button
              onClick={() => void saveMd()}
              disabled={mdBusy || !mdLoaded}
              className="flex h-7 items-center gap-1 rounded-btn bg-accent/15 px-3 text-caption font-medium text-accent transition-colors hover:bg-accent/25 disabled:opacity-40"
            >
              {mdBusy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              {t('profile.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}