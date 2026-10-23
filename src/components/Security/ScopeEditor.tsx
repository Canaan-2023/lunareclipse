/**
 * @category 安全
 * @summary 授权范围编辑器：**从真实可选项里挑**，而不是丢一个空白文本框让用户猜
 *
 * 为什么存在（用户 2026-10-20）：「T1 的给的那块让用户自己填的东西实在不知道填啥，像是局域网的
 * AI 转移之类的，你完全可以把当前节点列出来选择嘛…你得让用户知道填啥怎么填，要不就按路径地址或网址，
 * AI 自己去找就当授权了」。
 *
 * 做法：
 * - `scopeSource = 'lan-nodes'`（t1.migrate）：读 `lan:getTopology`，把**当前节点**列成勾选项；
 *   读不到（没开局域网 / 未登录）时如实说明，并保留手填；
 * - `targets` / `endpoints`：没有可靠的自动枚举，就给**具体示例**（IP / URL / 共享路径）+ 手填，
 *   并在说明里写清「填进去 = 授权它去访问；不在这里的一律拒绝」；
 * - 已选内容做成可删除的 chip；示例可点选。
 *
 * 边界：本组件只产出**字符串数组**，不做权限裁决；合法性（T1 / scoped 字段）在主进程
 * `security:grant` 里判（唯一检查点）。
 *
 * 不删理由：删掉即 scoped 授予退回「一个不知填什么的文本框」——用户会放弃授予或乱填，
 * 两种结果都比「可选项」差。
 */
import { useEffect, useState } from 'react'
import type { CapabilityDef } from '@shared/types'
import { useT } from '../../i18n/useT'
import { addScopeEntry, joinScopeLines, normalizeScopeEntry, removeScopeEntry, splitScopeLines } from './scope-input'

interface LanNodeOption {
  uid: number
  role: string
  online: boolean
}

/** 手填框的占位提示（按范围字段给具体格式，而不是一句泛泛的「每行一项」） */
function placeholderKey(cap: CapabilityDef): string {
  switch (cap.scopeField) {
    case 'nodes':
      return 'security.scope.placeholder.nodes'
    case 'targets':
      return 'security.scope.placeholder.targets'
    default:
      return 'security.scope.placeholder.endpoints'
  }
}

export function ScopeEditor({
  cap,
  value,
  onChange
}: {
  cap: CapabilityDef
  /** 草稿（多行文本；与 `SecurityPanel` 的 drafts 同形） */
  value: string
  onChange: (next: string) => void
}) {
  const t = useT()
  const selected = splitScopeLines(value)
  const [draft, setDraft] = useState('')
  const [nodes, setNodes] = useState<LanNodeOption[] | null>(null)
  const [lanFailed, setLanFailed] = useState(false)
  const wantsNodes = cap.scopeSource === 'lan-nodes'

  useEffect(() => {
    if (!wantsNodes) return
    let alive = true
    // 用 await 而不是 `api?.x?.().then(...)`：桥接方法缺失时可选项链会返回 undefined，
    // `.then` 会同步抛 TypeError（catch 接不住）——SRE/代码评审 P2。
    void (async () => {
      try {
        const r = await window.lunareclipse?.lanGetTopology?.()
        if (!alive) return
        if (!r?.ok) {
          setLanFailed(true)
          setNodes([])
          return
        }
        setNodes((r.nodes ?? []) as LanNodeOption[])
      } catch {
        if (!alive) return
        setLanFailed(true)
        setNodes([])
      }
    })()
    return () => {
      alive = false
    }
  }, [wantsNodes])

  const commit = (raw: string): void => {
    // 粘贴进来的「a,b」按两条处理——chip 里不能留逗号，否则提交时会被
    // `splitScopeLines` 再切一次，出现「所见 1 条、所授 2 条」（0.53.1 评审 P1）。
    let next = [...selected]
    for (const part of raw.split(/[\n,]/)) next = addScopeEntry(next, part)
    if (next.length !== selected.length) onChange(joinScopeLines(next))
    setDraft('')
  }

  const toggleNode = (uid: number): void => {
    const v = String(uid)
    onChange(joinScopeLines(selected.includes(v) ? removeScopeEntry(selected, v) : addScopeEntry(selected, v)))
  }

  return (
    <div className="mt-2 space-y-2">
      <p className="text-micro leading-5 text-fg-muted">{cap.scopeHint ?? t('security.scope.hint')}</p>

      {/* 节点白名单：把当前节点列出来勾选（t1.migrate） */}
      {wantsNodes && (
        <div className="rounded-btn border border-border-subtle bg-bg-base px-2 py-1.5">
          <div className="mb-1 font-mono text-micro tracking-wider text-fg-muted">{t('security.scope.nodes')}</div>
          {nodes == null ? (
            <p className="text-micro text-fg-muted">{t('security.scope.lanLoading')}</p>
          ) : lanFailed ? (
            <p className="text-micro text-warning">{t('security.scope.lanOff')}</p>
          ) : nodes.length === 0 ? (
            <p className="text-micro text-fg-muted">{t('security.scope.lanEmpty')}</p>
          ) : (
            <ul className="space-y-1">
              {nodes.map((n) => {
                const v = String(n.uid)
                const checked = selected.includes(v)
                return (
                  <li key={v}>
                    <label className="flex cursor-pointer items-center gap-2 text-micro text-fg-secondary">
                      <input type="checkbox" checked={checked} onChange={() => toggleNode(n.uid)} />
                      <span className="font-mono text-fg-primary">UID {n.uid}</span>
                      <span className="text-fg-muted">{n.role}</span>
                      <span className={n.online ? 'text-success' : 'text-fg-muted'}>
                        {n.online ? t('security.scope.nodeOnline') : t('security.scope.nodeOffline')}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {/* 手填：路径 / 网址 / IP 都认（用户原话：填进去就当授权，AI 自己去找） */}
      <div className="flex items-stretch gap-1.5">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit(draft)
            }
          }}
          placeholder={t(placeholderKey(cap))}
          aria-label={t('security.scope.manual')}
          className="min-w-0 flex-1 rounded-btn border border-border-subtle bg-bg-base px-2 py-1 font-mono text-micro text-fg-secondary outline-none"
        />
        <button
          type="button"
          onClick={() => commit(draft)}
          disabled={normalizeScopeEntry(draft) == null}
          className="shrink-0 rounded-btn border border-border-subtle px-2 py-1 text-micro text-fg-secondary disabled:opacity-40"
        >
          {t('security.scope.add')}
        </button>
      </div>

      {/* 示例：点一下就能填进去（降低「不知道填啥」的门槛） */}
      {cap.scopeExamples && cap.scopeExamples.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-micro">
          <span className="text-fg-muted">{t('security.scope.examples')}</span>
          {cap.scopeExamples.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => commit(ex)}
              disabled={selected.includes(ex)}
              className="rounded-btn border border-border-subtle px-1.5 py-0.5 font-mono text-fg-muted disabled:opacity-40"
            >
              {ex}
            </button>
          ))}
        </div>
      )}

      {/* 已选：chips（可删） */}
      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((v) => (
            <span
              key={v}
              className="inline-flex items-center gap-1 rounded-btn border border-accent/50 bg-accent/10 px-1.5 py-0.5 font-mono text-micro text-fg-primary"
            >
              {v}
              <button
                type="button"
                onClick={() => onChange(joinScopeLines(removeScopeEntry(selected, v)))}
                aria-label={`${t('security.scope.remove')}：${v}`}
                className="text-fg-muted"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-micro text-fg-muted">{t('security.scope.none')}</p>
      )}
      <p className="text-micro text-fg-muted">{t('security.scope.selected').replace('{n}', String(selected.length))}</p>
    </div>
  )
}
