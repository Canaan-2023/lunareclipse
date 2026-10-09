/**
 * 为什么存在：主题选择是高频、低耦合的偏好设置，独立成 Tab 以便快速切换
 * 并预览色板，避免混在复杂配置里。
 * 作用：渲染主题 Tab——主题卡片选择（含预览色板与候选主题说明），
 * 选中后写入 config 并应用主题 class。
 */
import { Moon, Snowflake, FileText, Sparkles, CircleDot, Gem } from 'lucide-react'
import type { AppConfig, ThemeName } from '@shared/types'
import { useT } from '../../../i18n/useT'

/** 主题清单（含预览色板） */
const THEMES: {
  name: ThemeName
  label: string
  icon: typeof Moon
  descKey: string
  preview: { bg: string; fg: string; accent: string }
}[] = [
  { name: 'frost-glass', label: '霜璃', icon: Snowflake, descKey: 'theme.frost-glass', preview: { bg: '#DCE4ED', fg: '#1E293B', accent: '#3D5A7A' } },
  { name: 'parchment', label: '素笺', icon: FileText, descKey: 'theme.parchment', preview: { bg: '#FFFFFF', fg: '#000000', accent: '#000000' } },
  { name: 'night', label: '夜幕', icon: Moon, descKey: 'theme.night', preview: { bg: '#000000', fg: '#F5F5F5', accent: '#E0E0E0' } },
  { name: 'violet-night', label: '紫夜', icon: Sparkles, descKey: 'theme.violet-night', preview: { bg: '#171226', fg: '#EDE9F8', accent: '#A78BFA' } },
  { name: 'eclipse', label: '月蚀', icon: CircleDot, descKey: 'theme.eclipse', preview: { bg: '#0D0F18', fg: '#ECEEF6', accent: '#D6B276' } },
  { name: 'gilded', label: '烫金', icon: Gem, descKey: 'theme.gilded', preview: { bg: '#1A140B', fg: '#F2E6D2', accent: '#D4AF37' } }
]

/** 主题 Tab：主题选择（预览色板卡片） */
export function ThemeSection({
  local,
  setLocal
}: {
  local: AppConfig
  setLocal: (updater: AppConfig | ((prev: AppConfig) => AppConfig)) => void
}) {
  const t = useT()

  return (
    <div className="space-y-5">
      <section>
        <div className="mb-3 text-caption uppercase tracking-wider text-fg-muted">
          {t('settings.theme')}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {THEMES.map((theme) => {
            const Icon = theme.icon
            const active = local.theme === theme.name
            return (
              <button
                key={theme.name}
                onClick={() => setLocal({ ...local, theme: theme.name })}
                className={`flex flex-col items-center gap-2 rounded-card border-2 px-3 py-4 transition-all duration-150 active:scale-95 ${
                  active ? 'border-accent shadow-lg' : 'border-border hover:border-accent/50'
                }`}
                style={{ backgroundColor: theme.preview.bg, color: theme.preview.fg }}
                title={`${theme.label}: ${t(theme.descKey)}`}
              >
                <Icon size={20} style={{ color: theme.preview.accent }} />
                <span className="text-body font-medium">{theme.label}</span>
                <span className="text-[10px] opacity-70">{t(theme.descKey)}</span>
              </button>
            )
          })}
        </div>
      </section>
    </div>
  )
}