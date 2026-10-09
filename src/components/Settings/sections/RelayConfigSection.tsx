/**
 * 为什么存在：中继异步传输（L1.5 大云盘）的下载位置与保留策略属于 AppConfig.relay 的可配置行为，
 * 走全局设置草稿（local/setLocal）+ 保存流程，与 MultiInstanceSection（独立 IPC、即时生效）分离：
 * 配置变更经 config:set 落盘后，relay 运行时的 getInfo 立即跟随（装配层同源读取），AI 提示词段亦随 config tier 刷新。
 * 作用：渲染中继配置区——自定义下载位置（留空=默认）、保留天数、当前实际生效值回显（relay:info 运行时真值）。
 */
import { useEffect, useState } from 'react'
import { HardDrive, Clock, Info } from 'lucide-react'
import type { AppConfig } from '@shared/types'
import { FOCUS } from '../../Friends/types'

interface RelayRuntimeInfo {
  isHub: boolean
  downloadDir: string
  retentionDays: number
}

export function RelayConfigSection({ config, onChange }: { config: AppConfig; onChange: (c: AppConfig) => void }) {
  /** 运行时真值（relay:info；配置保存后立即反映，与提示词段同源） */
  const [runtime, setRuntime] = useState<RelayRuntimeInfo | null>(null)
  /** 草稿：下载位置（留空 = 默认 {root}/relay/downloads） */
  const [downloadDir, setDownloadDir] = useState(config.relay?.downloadDir ?? '')
  /** 草稿：保留天数（非法/空 -> 保存前回退 7） */
  const [retentionDays, setRetentionDays] = useState(config.relay?.retentionDays?.toString() ?? '7')

  useEffect(() => {
    void window.lunareclipse.relayInfo().then((r) => {
      if (r.ok && r.info) setRuntime(r.info)
    })
  }, [])

  /**
   * 输入即同步到设置草稿（关键：不能让「更新」按钮做唯一写入口——用户改完后直接点面板右下
   * 「保存」时底层用 local 快照做差异合并，输入没同步就会丢；与 MessagingSection.syncLocal 同款）。
   * 保留天数防御：非法/空值回退 7（与 relay-service RELAY_DEFAULT_RETENTION_DAYS 语义一致）。
   */
  const syncLocal = (dir: string, daysRaw: string) => {
    const days = Number(daysRaw)
    const retention = Number.isFinite(days) && days > 0 ? Math.floor(days) : 7
    onChange({
      ...config,
      relay: { downloadDir: dir.trim(), retentionDays: retention }
    })
  }

  return (
    <section>
      <div className="mb-3 flex items-center gap-2 text-caption uppercase tracking-wider text-fg-muted">
        <HardDrive size={12} />
        <span>中继传输</span>
      </div>

      <div className="space-y-3 rounded-btn border border-border-subtle bg-bg-elevated p-3">
        {/* 运行时信息（实际生效值；与 AI 提示词段同源） */}
        {runtime && (
          <div className="flex items-start gap-2 rounded-btn border border-border-subtle bg-bg-base/60 px-3 py-2 text-[11px] text-fg-muted">
            <Info size={11} className="mt-0.5 shrink-0 text-accent" />
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="truncate">
                生效下载位置：<span className="font-mono text-fg-primary">{runtime.downloadDir}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center gap-1">
                  <Clock size={9} /> 保留 {runtime.retentionDays} 天
                </span>
                <span>{runtime.isHub ? '本机为主系统中继存储端' : '本机经主系统中继存取（非存储端）'}</span>
              </div>
            </div>
          </div>
        )}

        {/* 下载位置 */}
        <label className="block">
          <span className="mb-1 block text-caption text-fg-secondary">
            接收取件下载位置<span className="text-[10px] text-fg-muted">（留空 = 默认 {`{root}/relay/downloads`}）</span>
          </span>
          <input
            value={downloadDir}
            onChange={(e) => {
              setDownloadDir(e.target.value)
              syncLocal(e.target.value, retentionDays)
            }}
            placeholder="例如 C:\Users\me\Downloads\relay"
            aria-label="中继下载位置"
            className={`w-full rounded-btn border border-border-subtle bg-bg-base px-2.5 py-1.5 font-mono text-caption text-fg-primary outline-none focus:border-accent ${FOCUS}`}
          />
        </label>

        {/* 保留天数 */}
        <label className="block">
          <span className="mb-1 block text-caption text-fg-secondary">
            无人确认保留天数<span className="text-[10px] text-fg-muted">（发送方可在保留期内撤回，超期自动清理）</span>
          </span>
          <input
            value={retentionDays}
            onChange={(e) => {
              setRetentionDays(e.target.value)
              syncLocal(downloadDir, e.target.value)
            }}
            type="number"
            min={1}
            aria-label="中继保留天数"
            className={`w-24 rounded-btn border border-border-subtle bg-bg-base px-2.5 py-1.5 text-caption text-fg-primary outline-none focus:border-accent ${FOCUS}`}
          />
        </label>

        <p className="text-[11px] leading-relaxed text-fg-muted">
          修改随设置面板右下角「保存」一并落盘；保存后（主系统中继场景）立即生效，AI 提示词中的下载位置同步更新。
        </p>
      </div>
    </section>
  )
}