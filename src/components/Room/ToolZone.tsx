/**
 * 为什么存在：交接单 §7 的工具区是「AI 自己做工具的地方，给执行器用的」，是最后一个仍是占位的 ROOM 分区。
 * 作用：列出 AI 自造工具（声明式组合），支持启用/停用、删除、以 JSON 新增。
 * 不删理由：删掉即工具区退回占位，`t1.tool-zone-enable` 没有作用对象。
 *
 * 形态说明（与主进程一致）：自造工具是**步骤序列**（引用既有工具），不是任意代码——
 * 每一步仍各自过执行器门控（`t1.tool-zone-enable` + 动作授权）。
 */
import { useState, useEffect, useCallback } from 'react'
import { Cpu, Plus, Trash2 } from 'lucide-react'
import { useT } from '../../i18n/useT'

interface ZoneEntry {
  id: string
  name: string
  description: string
  steps: Array<{ tool: string; params: Record<string, unknown> }>
  enabled: boolean
}

const SAMPLE = '{\n  "name": "看环境",\n  "description": "读取环境状态",\n  "steps": [{ "tool": "collect_environment", "params": { "scope": "env" } }]\n}'

export function ToolZone() {
  const t = useT()
  const [entries, setEntries] = useState<ZoneEntry[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const r = await window.lunareclipse?.roomToolZoneList?.()
    if (r?.ok) setEntries(r.entries as ZoneEntry[])
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const upsert = async () => {
    setError('')
    let parsed: unknown
    try {
      parsed = JSON.parse(draft)
    } catch (e) {
      setError(`${t('room.tools.jsonError')}：${(e as Error).message}`)
      return
    }
    const r = await window.lunareclipse?.roomToolZoneUpsert?.(parsed)
    if (!r?.ok) {
      setError(r?.error ?? t('room.tools.saveFailed'))
      return
    }
    setEntries((r.entries ?? []) as ZoneEntry[])
    setDraft('')
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto">
      <div className="rounded-card border-2 border-border-subtle bg-bg-surface p-3">
        <div className="mb-2 flex items-center gap-2 font-mono text-caption tracking-wider text-fg-muted">
          <Cpu size={12} />
          {t('room.zone.tools')}
        </div>
        <p className="mb-2 text-[11px] text-fg-muted">{t('room.tools.hint')}</p>
        {entries.length === 0 ? (
          <div className="text-[11px] text-fg-muted">{t('room.tools.empty')}</div>
        ) : (
          <div className="space-y-2">
            {entries.map((e) => (
              <div key={e.id} className="rounded-btn border-2 border-border-subtle p-2">
                <div className="flex items-center gap-2 text-[11px]">
                  <input
                    type="checkbox"
                    checked={e.enabled}
                    onChange={async (ev) => {
                      const r = await window.lunareclipse?.roomToolZoneToggle?.(e.id, ev.target.checked)
                      if (r?.ok) setEntries((r.entries ?? []) as ZoneEntry[])
                    }}
                  />
                  <span className="flex-1 font-mono text-fg-secondary">{e.name}</span>
                  <button
                    onClick={async () => {
                      const r = await window.lunareclipse?.roomToolZoneRemove?.(e.id)
                      if (r?.ok) setEntries((r.entries ?? []) as ZoneEntry[])
                    }}
                    className="text-fg-muted hover:text-red-400"
                    title={t('model.remove')}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                {e.description && <div className="mt-1 text-[11px] text-fg-muted">{e.description}</div>}
                <div className="mt-1 font-mono text-[10px] text-fg-muted">
                  {e.steps.map((s) => s.tool).join(' → ')}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-card border-2 border-border-subtle bg-bg-surface p-3">
        <div className="mb-2 font-mono text-[11px] tracking-wider text-fg-muted">{t('room.tools.add')}</div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={SAMPLE}
          rows={7}
          className="w-full rounded-btn border-2 border-border-subtle bg-bg-base p-2 font-mono text-[11px]"
        />
        {error && <div className="mt-1 text-[11px] text-red-400">{error}</div>}
        <button
          onClick={() => void upsert()}
          disabled={!draft.trim()}
          className="mt-2 flex items-center gap-1 rounded-btn bg-accent px-3 py-1.5 text-caption text-accent-fg active:scale-95 disabled:opacity-40"
        >
          <Plus size={12} />
          {t('room.tools.add')}
        </button>
      </div>
    </div>
  )
}
