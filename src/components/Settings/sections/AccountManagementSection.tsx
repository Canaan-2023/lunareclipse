/**
 * 为什么存在：注销账号是破坏性操作（删除账号记录），必须独立成"危险区"
 * 并二次确认，与普通设置隔离防止误触。
 * 作用：渲染账号管理危险区——展示当前账号、注销确认流程
 * （保留记忆数据、解放用户名、UID 不回收）。
 */
import { useState } from 'react'
import { UserX, AlertTriangle, Trash2 } from 'lucide-react'
import { useAppStore } from '../../../stores/appStore'
import { useT } from '../../../i18n/useT'

/**
 * 账号管理区域：注销账号
 * - 注销账号 = 删除 users.json 中的账号记录（用户名 + 密码哈希）
 * - 保留所有记忆数据（raw_memory / memory / NNG / cache / DMN 各目录均不动）
 * - 解放用户名，可被重新注册
 * - UID 不回收（next_uid 保持递增），避免新旧数据混乱
 */
export function AccountManagementSection() {
  const t = useT()
  const currentUser = useAppStore((s) => s.currentUser)
  const deleteAccount = useAppStore((s) => s.deleteAccount)
  const closeSettings = useAppStore((s) => s.closeSettings)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!currentUser) return null

  const handleDelete = async () => {
    setError(null)
    setBusy(true)
    try {
      await deleteAccount()
      setConfirming(false)
      closeSettings()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <div className="mb-3 flex items-center gap-2 text-caption uppercase tracking-wider text-fg-muted">
        <UserX size={12} />
        <span>{t('settings.accountMgmt')}</span>
      </div>
      <div className="rounded-btn border border-red-500/20 bg-red-500/5 p-4 space-y-3">
        <div>
          <div className="text-body text-fg-primary">{t('settings.deleteAccount')}</div>
          <div className="mt-1 text-caption text-fg-muted leading-relaxed">
            {t('settings.deleteAccountDesc', { name: currentUser.用户名, uid: currentUser.UID })}
          </div>
        </div>

        {error && (
          <div className="rounded-btn border border-red-500/30 bg-red-500/10 px-3 py-2 text-caption text-red-400">
            {error}
          </div>
        )}

        {!confirming ? (
          <button
            onClick={() => {
              setConfirming(true)
              setError(null)
            }}
            className="flex items-center gap-1.5 rounded-btn border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-caption text-red-400 transition-all duration-150 hover:bg-red-500/20 active:scale-95"
          >
            <UserX size={12} />
            {t('settings.deleteAccountBtn')}
          </button>
        ) : (
          <div className="space-y-2 rounded-btn border border-red-500/30 bg-bg-base/40 p-3">
            <div className="flex items-start gap-2 text-caption text-red-400">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>
                {t('settings.deleteConfirm', { name: currentUser.用户名 })}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void handleDelete()}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-btn bg-red-500 px-3 py-1.5 text-caption text-white transition-all duration-150 hover:bg-red-600 active:scale-95 disabled:opacity-50"
              >
                {busy ? (
                  <>
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    {t('common.processing')}
                  </>
                ) : (
                  <>
                    <Trash2 size={12} />
                    {t('settings.confirmDelete')}
                  </>
                )}
              </button>
              <button
                onClick={() => {
                  setConfirming(false)
                  setError(null)
                }}
                disabled={busy}
                className="rounded-btn border border-border-subtle px-3 py-1.5 text-caption text-fg-secondary transition-all duration-150 hover:bg-bg-muted active:scale-95"
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}