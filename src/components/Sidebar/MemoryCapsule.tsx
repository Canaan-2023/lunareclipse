/**
 * @category 前端组件
 * @summary 记忆状态胶囊（记忆/日记工作流开关的内联展开）
 * @note 为什么存在：`index.tsx` 曾达 804 行破 800 硬红线（ADR-28 拆分）；胶囊是自包含的开关聚合体，与侧栏骨架无关。
 * @note 不删理由：替代旧三按钮的记忆开关入口，用户靠它一眼看到记忆/日记是否开启。
 */

import { useState } from 'react'
import {
  Moon,
  ChevronDown
} from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useT } from '../../i18n/useT'

/** 记忆状态胶囊：替代记忆工作流/日记工作流三按钮
 * 平时显示一行摘要 + 三个圆点（金色=开），点击内联展开开关列表（非浮层 popover） */
export function MemoryCapsule() {
  const memoryWorkflowEnabled = useAppStore((s) => s.memoryWorkflowEnabled)
  const setMemoryWorkflowEnabled = useAppStore((s) => s.setMemoryWorkflowEnabled)
  const diaryWorkflowEnabled = useAppStore((s) => s.diaryWorkflowEnabled)
  const setDiaryWorkflowEnabled = useAppStore((s) => s.setDiaryWorkflowEnabled)
  const t = useT()

  const [open, setOpen] = useState(false)

  const items = [
    { label: t('sidebar.memoryWorkflow'), desc: t('sidebar.memoryWorkflowDesc'), on: memoryWorkflowEnabled, toggle: () => setMemoryWorkflowEnabled(!memoryWorkflowEnabled) },
    { label: t('sidebar.diaryWorkflow'), desc: t('sidebar.diaryWorkflowDesc'), on: diaryWorkflowEnabled, toggle: () => setDiaryWorkflowEnabled(!diaryWorkflowEnabled) },
  ]

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-btn px-2 py-1 text-caption text-fg-secondary transition-colors hover:bg-bg-muted"
        title={t('sidebar.memoryStatus')}
      >
        <Moon size={11} className="shrink-0 text-fg-muted" />
        <span className="flex-1 text-left">{t('sidebar.memory')}</span>
        <div className="flex items-center gap-0.5">
          {items.map((item) => (
            <span
              key={item.label}
              className={`h-1.5 w-1.5 rounded-full ${item.on ? 'bg-accent' : 'bg-fg-muted/30'}`}
              title={`${item.label}: ${item.on ? '开' : '关'}`}
            />
          ))}
        </div>
        <ChevronDown size={10} className={`text-fg-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5 rounded-btn border border-border-subtle bg-bg-muted/30 px-1.5 py-1.5">
          {items.map((item) => (
            <button
              key={item.label}
              onClick={item.toggle}
              className="flex w-full items-center gap-2 rounded-btn px-2 py-1.5 text-left transition-colors hover:bg-bg-muted"
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${item.on ? 'bg-accent' : 'bg-fg-muted/30'}`} />
              <div className="min-w-0 flex-1">
                <div className="text-caption text-fg-secondary">{item.label}</div>
                <div className="text-micro text-fg-muted">{item.desc}</div>
              </div>
              <span className={`shrink-0 text-[10px] font-medium ${item.on ? 'text-accent' : 'text-fg-muted'}`}>
                {item.on ? 'ON' : 'OFF'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 头像菜单：替代 TitleBar 登出/设置 + 侧栏用户行切换/登出 */
