/**
 * 为什么存在：DMN（记忆处理）的工具策略需与主会话分开管理，且要支持按分类批量开关，
 * 单独抽成可复用组件供莉莉丝等子模块使用。
 * 作用：按分类渲染 DMN 工具清单，支持 per-tool 与整分类启用/禁用，写回 toolPolicy。
 */
import type { ToolPolicy, ToolCategory } from '@shared/types'
import { getDmnTools, CATEGORY_LABELS, CATEGORY_ICONS, isToolEnabled } from '@shared/tools/registry'

export function DmnToolConfig({
  tools: toolList = getDmnTools(),
  policy,
  onChange
}: {
  tools?: ReturnType<typeof getDmnTools>
  policy: Record<string, ToolPolicy>
  onChange: (toolPolicy: Record<string, ToolPolicy>) => void
}) {
  const byCategory = new Map<ToolCategory, typeof toolList>()
  for (const t of toolList) {
    if (t.isMechanism) continue
    const arr = byCategory.get(t.category) ?? []
    arr.push(t)
    byCategory.set(t.category, arr)
  }

  const setTool = (toolId: string, enabled: boolean) => {
    onChange({ ...policy, [toolId]: { enabled } })
  }

  const setCategory = (cat: ToolCategory, enabled: boolean) => {
    const toolsInCat = byCategory.get(cat) ?? []
    const newPolicy = { ...policy }
    for (const t of toolsInCat) newPolicy[t.id] = { enabled }
    onChange(newPolicy)
  }

  return (
    <div className="space-y-3">
      {Array.from(byCategory.entries()).map(([cat, tools]) => {
        const allOn = tools.every((t) => isToolEnabled(t.id, policy))
        return (
          <div key={cat}>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-caption font-medium text-fg-primary">
                {CATEGORY_ICONS[cat]} {CATEGORY_LABELS[cat]}（{tools.length}）
              </span>
              <button
                onClick={() => setCategory(cat, !allOn)}
                className={`rounded-btn px-2 py-0.5 text-[11px] transition-all duration-150 active:scale-95 ${
                  allOn ? 'bg-accent/15 text-accent' : 'bg-bg-muted text-fg-muted'
                }`}
              >
                {allOn ? '全开' : '全关'}
              </button>
            </div>
            <div className="space-y-0.5 pl-4">
              {tools.map((t) => {
                const on = isToolEnabled(t.id, policy)
                return (
                  <div key={t.id} className="flex items-center justify-between rounded-btn px-2 py-1 hover:bg-bg-muted/30">
                    <div className="flex items-center gap-1.5">
                      <span className="text-caption text-fg-primary">{t.name}</span>
                      <span className="text-[10px] text-fg-muted">{t.id}</span>
                    </div>
<button
                      onClick={() => setTool(t.id, !on)}
                      role="switch"
                      aria-checked={on}
                      aria-label={t.name}
                      className={`relative h-4 w-8 shrink-0 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-bg-muted'}`}
                    >
                      <span className={`absolute left-[2px] top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-white shadow-sm transition-transform duration-200 ${on ? 'translate-x-[16px]' : 'translate-x-0'}`} />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
