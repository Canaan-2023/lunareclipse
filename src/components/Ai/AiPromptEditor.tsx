/**
 * 为什么存在：提示词编辑器自身有 9 个表单态（层级清单/选中文件/内置基底/编辑内容/新建态…），
 * 且带异步取数；它与面板的列表、删除弹层等状态无关，留在主组件会让这些状态互相牵动重渲染。
 * 作用：按层列出提示词文件（内置只读 / 副本可编辑），支持建立副本、保存、恢复内置与新建文件。
 */
import { useEffect, useState } from 'react'
import { FileText, Loader2, Save, Pencil, Trash2, Plus } from 'lucide-react'
import type { AiRecord } from '../../../electron/main/models/ai-registry'
import { useT } from '../../i18n/useT'

interface Props {
  ai: AiRecord
  busy: boolean
  onBack: () => void
  onNotify: (msg: string) => void
}

/** 文件粒度提示词编辑器：内置模板为基底，副本目录（frontend/shared）同名替换/独有追加。
 * 左侧按层列出参与合并的文件（内置=只读基底，副本=可编辑覆盖）；
 * 选中内置文件可「建立副本」后编辑；副本可保存/删除（恢复内置）；新建文件走 frontend/shared 层追加。 */
export function AiPromptEditor({ ai, busy, onBack, onNotify }: Props) {
  const t = useT()
  type PromptLayer = 'frontend' | 'shared'
  type PromptFileEntry = { name: string; source: 'builtin' | 'override' }
  type SelEntry = { layer: PromptLayer; name: string; source: 'builtin' | 'override' }

  const [layers, setLayers] = useState<{ frontend: PromptFileEntry[]; shared: PromptFileEntry[] }>({
    frontend: [],
    shared: []
  })
  const [loading, setLoading] = useState(true)
  const [sel, setSel] = useState<SelEntry | null>(null)
  const [builtin, setBuiltin] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [busyLocal, setBusyLocal] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const refresh = async () => {
    const res = await window.lunareclipse.aiListPromptFiles(ai.id)
    if (res?.ok && res.layers) {
      setLayers({ frontend: res.layers.frontend, shared: res.layers.shared })
    }
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.lunareclipse
      .aiListPromptFiles(ai.id)
      .then((res) => {
        if (cancelled || !res?.ok || !res.layers) return
        setLayers({ frontend: res.layers.frontend, shared: res.layers.shared })
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [ai.id])

  /** 打开文件：读副本内容（无副本走内置基底），编辑区展示当前生效文本 */
  const open = async (layer: PromptLayer, name: string, source: 'builtin' | 'override') => {
    setErr(null)
    setCreating(false)
    setSel({ layer, name, source })
    setContent('')
    setBuiltin(null)
    const res = await window.lunareclipse.aiReadPromptFile(ai.id, layer, name)
    if (!res?.ok) {
      setErr(res?.error ?? t('ai.readFileFail'))
      return
    }
    setBuiltin(res.builtin ?? null)
    setContent(res.content ?? res.builtin ?? '')
  }

  /** 保存当前文件副本；内容为空 = 删除副本恢复内置（后端同语义） */
  const save = async () => {
    if (!sel || busyLocal) return
    setBusyLocal(true)
    setErr(null)
    try {
      const res = await window.lunareclipse.aiSavePromptFile(ai.id, sel.layer, sel.name, content)
      if (!res?.ok) throw new Error(res?.error ?? t('ai.promptSaveFail'))
      if (content.trim()) onNotify(t('ai.promptFileSaved', { name: sel.name }))
      else onNotify(t('ai.promptRestored', { name: sel.name }))
      await refresh()
      // 空内容 = 副本删除 → 重新按内置打开
      await open(sel.layer, sel.name, content.trim() ? 'override' : 'builtin')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyLocal(false)
    }
  }

  /** 以内置为基底建立副本，进入可编辑状态 */
  const createCopy = async () => {
    if (!sel || busyLocal) return
    setBusyLocal(true)
    setErr(null)
    try {
      const res = await window.lunareclipse.aiSavePromptFile(ai.id, sel.layer, sel.name, builtin ?? '')
      if (!res?.ok) throw new Error(res?.error ?? t('ai.promptSaveFail'))
      onNotify(t('ai.promptCopyDone', { name: sel.name }))
      await refresh()
      await open(sel.layer, sel.name, 'override')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyLocal(false)
    }
  }

  /** 删除副本恢复内置（重新打开显示内置基底） */
  const removeCopy = async () => {
    if (!sel || busyLocal) return
    setBusyLocal(true)
    setErr(null)
    try {
      const res = await window.lunareclipse.aiClearPromptFile(ai.id, sel.layer, sel.name)
      if (!res?.ok) throw new Error(res?.error ?? t('ai.promptSaveFail'))
      onNotify(t('ai.promptRestored', { name: sel.name }))
      await refresh()
      await open(sel.layer, sel.name, 'builtin')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyLocal(false)
    }
  }

  /** 新建副本文件：校验文件名 → 写入内容落盘 → 打开编辑 */
  const createFile = async () => {
    const name = newName.trim()
    if (!name || busyLocal) return
    if (!/^[^\\/]+\.(md|txt)$/i.test(name)) {
      setErr(t('ai.promptNameHint'))
      return
    }
    setBusyLocal(true)
    setErr(null)
    try {
      const res = await window.lunareclipse.aiSavePromptFile(ai.id, 'frontend', name, content)
      if (!res?.ok) throw new Error(res?.error ?? t('ai.promptSaveFail'))
      onNotify(t('ai.promptFileSaved', { name }))
      setNewName('')
      setCreating(false)
      await refresh()
      await open('frontend', name, 'override')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyLocal(false)
    }
  }

  const layerList: Array<{ key: PromptLayer; label: string }> = [
    { key: 'frontend', label: t('ai.promptLayerFrontend') },
    { key: 'shared', label: t('ai.promptLayerShared') }
  ]

  return (
    <div className="flex h-full flex-col px-3 py-3">
      <div className="mb-2 text-caption text-fg-secondary">{t('ai.promptHint')}</div>
      {loading ? (
        <div className="flex flex-1 items-center justify-center py-10 text-fg-muted">
          <Loader2 size={16} className="animate-spin" />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-2">
          {/* 左侧文件清单（frontend/shared 两层） */}
          <div className="flex w-44 shrink-0 flex-col overflow-y-auto rounded-btn border border-border-subtle">
            {layerList.map(({ key, label }) => (
              <div key={key} className="flex flex-col">
                <div className="sticky top-0 z-10 flex items-center justify-between bg-bg-surface px-2 py-1 text-[10px] uppercase tracking-wider text-fg-muted">
                  <span className="flex items-center gap-1">
                    <FileText size={9} />
                    {label}
                  </span>
                  <button
                    onClick={() => {
                      setErr(null)
                      setCreating(true)
                      setSel(null)
                      setNewName('')
                      setContent('')
                    }}
                    className="rounded p-0.5 text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary"
                    title={t('ai.promptNew')}
                    aria-label={t('ai.promptNew')}
                  >
                    <Plus size={10} />
                  </button>
                </div>
                {layers[key].map((f) => {
                  const active = !creating && sel?.layer === key && sel?.name === f.name
                  return (
                    <button
                      key={f.name}
                      onClick={() => void open(key, f.name, f.source)}
                      className={`flex items-center gap-1.5 px-2 py-1.5 text-left text-caption transition-colors ${
                        active ? 'bg-accent/10 text-accent' : 'text-fg-muted hover:bg-bg-muted hover:text-fg-primary'
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate" title={f.name}>
                        {f.name}
                      </span>
                      <span
                        className={`shrink-0 rounded px-1 py-px text-[9px] ${
                          f.source === 'override' ? 'bg-warning/15 text-warning' : 'bg-bg-muted text-fg-muted'
                        }`}
                      >
                        {f.source === 'override' ? t('ai.promptOverrideBadge') : t('ai.promptBuiltinBadge')}
                      </span>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>

          {/* 右侧编辑区 */}
          <div className="flex min-w-0 flex-1 flex-col">
            {err && <div className="mb-2 text-caption text-danger">{err}</div>}
            {creating ? (
              <div className="flex flex-1 flex-col">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={t('ai.promptNewName')}
                  onKeyDown={(e) => e.key === 'Enter' && void createFile()}
                  className="mb-2 w-full rounded-btn border border-border-subtle bg-bg-base px-2.5 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
                />
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder={t('ai.promptPlaceholder')}
                  className="min-h-[200px] flex-1 resize-none rounded-btn border border-border-subtle bg-bg-base px-2.5 py-2 text-caption leading-relaxed text-fg-primary outline-none focus:border-accent"
                />
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => void createFile()}
                    disabled={busyLocal || busy}
                    className="flex h-7 flex-1 items-center justify-center gap-1 rounded-btn bg-accent px-3 text-caption font-medium text-accent-fg transition-colors hover:bg-accent/90 disabled:opacity-40"
                  >
                    {busyLocal ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                    {t('ai.promptNewCreate')}
                  </button>
                  <button
                    onClick={() => {
                      setCreating(false)
                      setErr(null)
                    }}
                    className="flex h-7 items-center rounded-btn border border-border-subtle px-3 text-caption text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary"
                  >
                    {t('ai.cancel')}
                  </button>
                </div>
              </div>
            ) : sel ? (
              <>
                <div className="mb-1.5 flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-caption font-medium text-fg-primary" title={sel.name}>
                    {sel.name}
                  </span>
                  <span
                    className={`shrink-0 rounded px-1 py-px text-[9px] ${
                      sel.source === 'override' ? 'bg-warning/15 text-warning' : 'bg-bg-muted text-fg-muted'
                    }`}
                  >
                    {sel.source === 'override' ? t('ai.promptOverrideBadge') : t('ai.promptBuiltinBadge')}
                  </span>
                </div>
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  readOnly={sel.source === 'builtin'}
                  placeholder={t('ai.promptPlaceholder')}
                  className="min-h-[200px] flex-1 resize-none rounded-btn border border-border-subtle bg-bg-base px-2.5 py-2 text-caption leading-relaxed text-fg-primary outline-none focus:border-accent disabled:opacity-60"
                />
                <div className="mt-1 text-micro text-fg-muted">
                  {sel.source === 'builtin' ? t('ai.promptBuiltinReadonly') : t('ai.promptEmptyRemoves')}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  {sel.source === 'builtin' ? (
                    <>
                      <button
                        onClick={() => void createCopy()}
                        disabled={busyLocal || busy}
                        className="flex h-7 flex-1 items-center justify-center gap-1 rounded-btn bg-accent px-3 text-caption font-medium text-accent-fg transition-colors hover:bg-accent/90 disabled:opacity-40"
                      >
                        {busyLocal ? <Loader2 size={12} className="animate-spin" /> : <Pencil size={12} />}
                        {t('ai.promptCreateCopy')}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => void save()}
                        disabled={busyLocal || busy}
                        className="flex h-7 flex-1 items-center justify-center gap-1 rounded-btn bg-accent px-3 text-caption font-medium text-accent-fg transition-colors hover:bg-accent/90 disabled:opacity-40"
                      >
                        {busyLocal ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                        {t('ai.promptSave')}
                      </button>
                      <button
                        onClick={() => void removeCopy()}
                        disabled={busyLocal || busy}
                        className="flex h-7 items-center gap-1 rounded-btn border border-border-subtle px-3 text-caption text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary"
                        title={t('ai.promptRestore')}
                      >
                        <Trash2 size={11} />
                        {t('ai.promptRestore')}
                      </button>
                    </>
                  )}
                  <button
                    onClick={onBack}
                    disabled={busyLocal || busy}
                    className="flex h-7 items-center rounded-btn border border-border-subtle px-3 text-caption text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary"
                  >
                    {t('ai.back')}
                  </button>
                </div>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-caption text-fg-muted">{t('ai.promptNoFile')}</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
