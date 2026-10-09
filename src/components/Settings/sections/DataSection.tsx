/**
 * 为什么存在：数据目录/预算、联网搜索、内部会话存储、账号管理同属"数据"域，
 * 聚合为一个设置 Tab，便于集中管理磁盘与账号相关配置。
 * 作用：渲染数据 Tab——配置文件路径、数据目录与预算、联网搜索、内部会话存储与账号管理区块。
 */
import { useEffect, useState } from 'react'
import { Database, FolderOpen } from 'lucide-react'
import type { AppConfig } from '@shared/types'
import { Field } from '../Field'
import { useT } from '../../../i18n/useT'
import { InternalSessionConfigSection } from './InternalSessionSection'
import { AccountManagementSection } from './AccountManagementSection'

/** 数据 Tab：数据目录/预算、联网搜索、内部会话存储、账号管理 */
export function DataSection({
  local,
  setLocal
}: {
  local: AppConfig
  setLocal: (updater: AppConfig | ((prev: AppConfig) => AppConfig)) => void
}) {
  const t = useT()
  // 配置文件绝对路径（configStore.getFilePath，main config.ts:88）
  const [configPath, setConfigPath] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.lunareclipse
      ?.getConfigFilePath()
      .then((p) => {
        if (!cancelled && p) setConfigPath(p)
      })
      .catch(() => {
        if (!cancelled) setConfigPath(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="space-y-5">
      {/* 配置文件路径（设置持久化位置，便于手工备份/迁移） */}
      <section>
        <div className="mb-3 flex items-center gap-2 text-caption uppercase tracking-wider text-fg-muted">
          <Database size={12} />
          <span>{t('settings.configFilePath')}</span>
        </div>
        <div className="rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2.5">
          <div className="text-caption text-fg-primary">{t('settings.configFilePathDesc')}</div>
          {configPath ? (
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-btn bg-bg-base px-2.5 py-1.5 font-mono text-[11px] text-fg-secondary">
                {configPath}
              </code>
              <button
                onClick={() => void window.lunareclipse?.showItemInFolder(configPath)}
                className="flex shrink-0 items-center gap-1.5 rounded-btn border border-border-subtle px-2.5 py-1.5 text-caption text-fg-secondary transition-colors hover:bg-bg-muted hover:text-fg-primary"
                title={t('settings.openInFolder')}
              >
                <FolderOpen size={11} />
                {t('settings.openInFolder')}
              </button>
            </div>
          ) : (
            <div className="mt-2 text-caption text-fg-muted">{t('settings.configPathLoadFail')}</div>
          )}
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center gap-2 text-caption uppercase tracking-wider text-fg-muted">
          <Database size={12} />
          <span>{t('settings.dataBudget')}</span>
        </div>
        <div className="space-y-3">
          <Field label={t('settings.dataDir')}>
            <input
              type="text"
              value={local.dataDir}
              readOnly
              title={t('settings.dataDirReadonly')}
              className="w-full cursor-not-allowed rounded-btn border border-border bg-bg-elevated px-3 py-2 text-body text-fg-muted focus:border-accent focus:outline-none"
            />
          </Field>
          <Field label={t('settings.tokenBudget')}>
            <input
              type="number"
              min="1"
              value={local.tokenBudget ?? ''}
              onChange={(e) =>
                setLocal({
                  ...local,
                  tokenBudget: e.target.value ? Number(e.target.value) : null
                })
              }
              placeholder={t('settings.unlimited')}
              className="w-full rounded-btn border border-border bg-bg-elevated px-3 py-2 text-body text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none"
            />
          </Field>

          <div className="flex items-center justify-between rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2.5">
            <div>
              <div className="text-body text-fg-primary">{t('settings.webSearch')}</div>
              <div className="text-caption text-fg-muted">{t('settings.webSearchDesc')}</div>
            </div>
            <button
              onClick={() => setLocal({ ...local, webSearchEnabled: !local.webSearchEnabled })}
              role="switch"
              aria-checked={local.webSearchEnabled}
              aria-label={t('settings.webSearch')}
              className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                local.webSearchEnabled ? 'bg-accent' : 'bg-bg-muted'
              }`}
              title={local.webSearchEnabled ? t('settings.clickDisable') : t('settings.clickEnable')}
            >
              <span
                className={`absolute left-[2px] top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                  local.webSearchEnabled ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
          {local.webSearchEnabled && (
            <div className="rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2.5 space-y-2">
              <div>
                <div className="text-body text-fg-primary">{t('settings.bochaKey')}</div>
                <div className="text-caption text-fg-muted">{t('settings.bochaDesc')}</div>
              </div>
              <input
                type="password"
                value={local.bochaApiKey ?? ''}
                onChange={(e) => setLocal({ ...local, bochaApiKey: e.target.value })}
                placeholder={t('settings.bochaPlaceholder')}
                className="w-full rounded-btn border border-border bg-bg-elevated px-3 py-2 text-body text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none"
              />
              <div className="text-caption text-fg-muted pt-1 border-t border-border-subtle">
                {t('settings.searchSources')}：<br />
                <span className="text-fg-secondary">{t('settings.searchGeneral')}：</span>auto / bocha / baidu / bing / duckduckgo / custom <br />
                <span className="text-fg-secondary">{t('settings.searchCommunity')}：</span>zhihu / douban / bilibili / tieba / weibo <br />
                <span className="text-fg-secondary">{t('settings.searchWiki')}：</span>baike / moegirl <br />
                <span className="text-fg-secondary">{t('settings.searchClassic')}：</span>gushiwen
              </div>
            </div>
          )}

          {/* 时间与位置感知开关：默认关闭，开启后启用系统定位链路（仍是隐私红线默认关闭项） */}
          <div className="flex items-center justify-between rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-body text-fg-primary">{t('settings.preciseLocation')}</div>
              <div className="text-caption text-fg-muted">{t('settings.preciseLocationDesc')}</div>
            </div>
            <button
              onClick={() =>
                setLocal((prev) => ({
                  ...prev,
                  geo: { ...(prev.geo ?? {}), preciseLocationEnabled: !(prev.geo?.preciseLocationEnabled ?? false) }
                }))
              }
              role="switch"
              aria-checked={local.geo?.preciseLocationEnabled ?? false}
              aria-label={t('settings.preciseLocation')}
              className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                local.geo?.preciseLocationEnabled ? 'bg-accent' : 'bg-bg-muted'
              }`}
              title={
                local.geo?.preciseLocationEnabled
                  ? t('settings.clickDisable')
                  : t('settings.clickEnable')
              }
            >
              <span
                className={`absolute left-[2px] top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                  local.geo?.preciseLocationEnabled ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </div>
      </section>

      {/* 内部会话存储（双层会话：AI 上下文层存储整理阈值，非注入限制） */}
      <InternalSessionConfigSection />

      {/* 账号管理：注销账号（删除账号记录但保留记忆数据） */}
      <AccountManagementSection />
    </div>
  )
}