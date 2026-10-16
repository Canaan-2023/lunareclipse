/**
 * 为什么存在：多账号实例（userData 隔离）需要界面化创建/启动/管理，
 * 独立成设置区块避免与当前会话配置混淆。
 * 作用：渲染实例管理区块——实例列表（默认/自建）、启动当前实例、改名/删除。
 */
import { useState, useEffect } from 'react'
import { Layers, Rocket, Repeat, Pencil, Trash2, X } from 'lucide-react'
import { useT } from '../../../i18n/useT'

interface InstanceInfo {
  name: string
  isDefault: boolean
  baseUserData?: string
  instances?: string[]
}

/**
 * 多开实例区块（P5）：
 * - 展示当前实例名（默认实例 / 具名实例）
 * - 列出已创建实例
 * - 输入实例名启动新实例（spawn 本应用 --instance=<name>）
 * - 已创建实例支持改名（行内编辑）与删除（二次确认，幂等失败提示）
 */
export function InstanceSection() {
  const t = useT()
  const [info, setInfo] = useState<InstanceInfo | null>(null)
  const [name, setName] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [launching, setLaunching] = useState(false)
  /** 正在改名的实例名（null = 未处于改名状态） */
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  /** 待确认删除的实例名（null = 未处于删除确认状态） */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const refresh = async () => {
    const r = await window.lunareclipse.instanceGetInfo()
    if (r.ok) {
      setInfo({
        name: r.name ?? 'default',
        isDefault: r.isDefault ?? true,
        baseUserData: r.baseUserData,
        instances: r.instances ?? []
      })
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const launch = async (target?: string) => {
    const targetName = target ?? name.trim()
    if (!targetName) return
    setLaunching(true)
    setMsg(null)
    const r = await window.lunareclipse.instanceLaunch(targetName)
    if (r.ok) {
      setMsg(`${t('settings.instance.launched')} "${targetName}"`)
      setName('')
      await refresh()
    } else {
      setMsg(r.error ?? '启动失败')
    }
    setLaunching(false)
  }

  const startRename = (inst: string) => {
    setRenaming(inst)
    setRenameValue(inst)
    setConfirmDelete(null)
  }

  const submitRename = async (oldName: string) => {
    const newName = renameValue.trim()
    if (!newName || newName === oldName) {
      setRenaming(null)
      return
    }
    setMsg(null)
    const r = await window.lunareclipse.instanceRename(oldName, newName)
    if (r.ok) {
      setMsg(`${t('settings.instance.renameDone')} "${oldName}" → "${r.name ?? newName}"`)
    } else {
      setMsg(r.error ?? '改名失败')
    }
    setRenaming(null)
    await refresh()
  }

  const doDelete = async (inst: string) => {
    if (confirmDelete !== inst) {
      setConfirmDelete(inst)
      setRenaming(null)
      return
    }
    setMsg(null)
    const r = await window.lunareclipse.instanceDelete(inst)
    if (r.ok) {
      setMsg(`${t('settings.instance.deleteDone')} "${inst}"`)
    } else {
      setMsg(r.error ?? '删除失败')
    }
    setConfirmDelete(null)
    await refresh()
  }

  return (
    <section>
      <div className="mb-3 flex items-center gap-2 text-caption uppercase tracking-wider text-fg-muted">
        <Layers size={12} />
        <span>{t('settings.instance.title')}</span>
      </div>

      <div className="space-y-3">
        {/* 当前实例 */}
        <div className="flex items-center gap-2 rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2">
          <span className="text-[11px] text-fg-muted">{t('settings.instance.current')}</span>
          <span
            className={`rounded-full border px-2.5 py-1 text-[11px] ${
              info?.isDefault
                ? 'border-border-subtle bg-bg-base text-fg-muted'
                : 'border-accent/40 bg-accent/10 text-accent'
            }`}
          >
            {info?.isDefault
              ? t('settings.instance.defaultBadge')
              : `${t('settings.instance.namedBadge')} ${info?.name ?? ''}`}
          </span>
          {!info && <span className="text-[11px] text-fg-muted/60">…</span>}
        </div>

        {/* 启动新实例 */}
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void launch()
            }}
            placeholder={t('settings.instance.namePlaceholder')}
            className="min-w-0 flex-1 rounded-btn border border-border-subtle bg-bg-base px-3 py-2 text-body text-fg-primary outline-none transition-all duration-150 placeholder:text-fg-muted/50 focus:border-accent/50"
          />
          <button
            onClick={() => void launch()}
            disabled={launching || !name.trim()}
            className="flex items-center gap-1.5 rounded-btn bg-accent px-3 py-2 text-body text-accent-fg transition-all duration-150 hover:bg-accent/80 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Rocket size={13} />
            {t('settings.instance.launchNew')}
          </button>
        </div>

        {/* 已创建实例 */}
        <div className="rounded-btn border border-border-subtle bg-bg-elevated p-3">
          <div className="mb-2 text-[11px] uppercase tracking-wider text-fg-muted">
            {t('settings.instance.listTitle')}
          </div>
          {(info?.instances?.length ?? 0) === 0 ? (
            <div className="text-[11px] text-fg-muted/60">{t('settings.instance.empty')}</div>
          ) : (
            <div className="flex flex-col gap-2">
              {info?.instances?.map((inst) => (
                <div
                  key={inst}
                  className="flex items-center gap-2 rounded-btn border border-border-subtle bg-bg-base px-2.5 py-1 text-[11px] text-fg-primary"
                >
                  {renaming === inst ? (
                    <>
                      <input
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void submitRename(inst)
                          if (e.key === 'Escape') setRenaming(null)
                        }}
                        placeholder={t('settings.instance.renamePlaceholder')}
                        autoFocus
                        className="min-w-0 flex-1 rounded-btn border border-border-subtle bg-bg-base px-2 py-1 text-[11px] text-fg-primary outline-none placeholder:text-fg-muted/50 focus:border-accent/50"
                      />
                      <button
                        onClick={() => void submitRename(inst)}
                        className="flex items-center gap-1 text-accent transition-all duration-150 hover:text-accent/80 active:scale-95"
                      >
                        {t('settings.instance.renameConfirm')}
                      </button>
                      <button
                        onClick={() => setRenaming(null)}
                        className="flex items-center gap-1 text-fg-muted transition-all duration-150 hover:text-fg-primary active:scale-95"
                        title={t('settings.instance.deleteCancel')}
                      >
                        <X size={11} />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="font-mono">{inst}</span>
                      <button
                        onClick={() => void launch(inst)}
                        disabled={launching || renaming !== null}
                        className="flex items-center gap-1 text-accent transition-all duration-150 hover:text-accent/80 active:scale-95 disabled:opacity-40"
                      >
                        <Repeat size={11} />
                        {t('settings.instance.launch')}
                      </button>
                      <button
                        onClick={() => startRename(inst)}
                        disabled={renaming !== null}
                        className="flex items-center gap-1 text-fg-muted transition-all duration-150 hover:text-fg-primary active:scale-95 disabled:opacity-40"
                        title={t('settings.instance.rename')}
                      >
                        <Pencil size={11} />
                      </button>
                      <button
                        onClick={() => void doDelete(inst)}
                        disabled={renaming !== null}
                        className={`flex items-center gap-1 transition-all duration-150 active:scale-95 disabled:opacity-40 ${
                          confirmDelete === inst
                            ? 'text-danger hover:text-danger/80'
                            : 'text-fg-muted hover:text-danger active:text-danger'
                        }`}
                        title={confirmDelete === inst ? t('settings.instance.deleteHint') : t('settings.instance.delete')}
                      >
                        <Trash2 size={11} />
                        {confirmDelete === inst ? t('settings.instance.deleteConfirm') : t('settings.instance.delete')}
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <p className="text-[11px] leading-relaxed text-fg-muted">{t('settings.instance.hint')}</p>

        {msg && (
          <div className="rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2 text-[11px] text-fg-muted">
            {msg}
          </div>
        )}
      </div>
    </section>
  )
}