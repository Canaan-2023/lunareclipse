/**
 * 为什么存在：MCP Server 配置独立存 .mcp.json（不进 configStore），且保存触发
 * 热重载、运行时状态需轮询，独立设置区承载这份特殊生命周期。
 * 作用：渲染 MCP Server 管理区——server 增删改（本地副本编辑 → 保存应用），
 * 运行时状态（connected/error/toolCount）2 秒轮询展示。
 */
import { useState, useEffect } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { McpConfig, McpServerConfig, McpServerStatusSummary } from '@shared/types'
import { Field } from '../Field'
import { useT } from '../../../i18n/useT'

/**
 * MCP Server 管理

 * 独立于 AppConfig：MCP 配置存在 .mcp.json，不进 configStore。
 * 加载→本地副本编辑→保存并应用（触发热重载：连接新增/断开移除的 server）。
 * 运行时状态（connected/error/toolCount）通过 2 秒轮询 mcp:getStatuses 获取。
 */
export function McpConfigSection() {
  const t = useT()
  const [config, setConfig] = useState<McpConfig>({ mcpServers: {} })
  const [statuses, setStatuses] = useState<McpServerStatusSummary[]>([])
  const [selectedName, setSelectedName] = useState<string>('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string>('')

  // 首次加载 .mcp.json 配置
  useEffect(() => {
    const api = window.lunareclipse
    if (!api?.mcpGetConfig) return
    api.mcpGetConfig().then((cfg: McpConfig) => {
      setConfig(cfg)
      const first = Object.keys(cfg.mcpServers)[0]
      if (first) setSelectedName(first)
    })
  }, [])

  // 轮询运行时状态（2 秒，反映连接/重连进度）
  useEffect(() => {
    const api = window.lunareclipse
    if (!api?.mcpGetStatuses) return
    const tick = () => api.mcpGetStatuses().then((s: McpServerStatusSummary[]) => setStatuses(s))
    tick()
    const id = setInterval(tick, 2000)
    return () => clearInterval(id)
  }, [])

  const selected = config.mcpServers[selectedName]
  const statusOf = (name: string) => statuses.find((s) => s.name === name)

  const updateSelected = (patch: Partial<McpServerConfig>) => {
    if (!selected) return
    setConfig({
      mcpServers: { ...config.mcpServers, [selectedName]: { ...selected, ...patch } }
    })
    setDirty(true)
  }

  const addServer = () => {
    const name = `server-${Date.now().toString().slice(-5)}`
    const newServer: McpServerConfig = {
      name,
      transport: 'stdio',
      command: '',
      args: [],
      enabled: true,
      autoRestart: true
    }
    setConfig({ mcpServers: { ...config.mcpServers, [name]: newServer } })
    setSelectedName(name)
    setDirty(true)
  }

  const removeServer = (name: string) => {
    const next = { ...config.mcpServers }
    delete next[name]
    setConfig({ mcpServers: next })
    if (selectedName === name) {
      setSelectedName(Object.keys(next)[0] ?? '')
    }
    setDirty(true)
  }

  const save = async () => {
    const api = window.lunareclipse
    if (!api?.mcpSaveConfig) return
    setSaving(true)
    try {
      const res = await api.mcpSaveConfig(config)
      if (res.ok) {
        setDirty(false)
        setMsg(t('settings.hookSaved'))
      } else {
        setMsg(t('settings.hookSaveFail', { error: res.error ?? '' }))
      }
    } catch (err) {
      // IPC 抛异常时 saving 必须在 finally 复位，否则"保存中"态永久卡死按钮；
      // 异常与业务失败分开处理，保证用户都能看到可读错误信息
      setMsg(t('settings.hookSaveFail', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setSaving(false)
    }
    setTimeout(() => setMsg(''), 3000)
  }

  const connect = async () => {
    const api = window.lunareclipse
    if (!api?.mcpConnect || !selectedName) return
    setMsg(t('settings.mcpConnecting', { name: selectedName }))
    const res = await api.mcpConnect(selectedName)
    setMsg(res.ok ? t('settings.mcpConnectSent', { name: selectedName }) : t('settings.mcpConnectFail', { error: res.error ?? '' }))
    setTimeout(() => setMsg(''), 3000)
  }

  const disconnect = async () => {
    const api = window.lunareclipse
    if (!api?.mcpDisconnect || !selectedName) return
    const res = await api.mcpDisconnect(selectedName)
    setMsg(res.ok ? t('settings.mcpDisconnectSent', { name: selectedName }) : t('settings.mcpDisconnectFail', { error: res.error ?? '' }))
    setTimeout(() => setMsg(''), 3000)
  }

  // 状态徽章
  const statusBadge = (status?: string) => {
    if (!status) return null
    const colorMap: Record<string, string> = {
      connected: 'bg-success/15 text-success',
      connecting: 'bg-warning/15 text-warning',
      error: 'bg-danger/15 text-danger',
      disconnected: 'bg-bg-muted text-fg-muted',
      reconnecting: 'bg-accent/15 text-accent'
    }
    const labelMap: Record<string, string> = {
      connected: t('status.connected'),
      connecting: t('status.connecting'),
      error: t('status.error'),
      disconnected: t('status.disconnected'),
      reconnecting: t('status.reconnecting')
    }
    return (
      <span className={`rounded-full px-2 py-0.5 text-[10px] ${colorMap[status] ?? colorMap.disconnected}`}>
        {labelMap[status] ?? status}
      </span>
    )
  }

  const argsStr = (selected?.args ?? []).join(' ')
  const envStr = Object.entries(selected?.env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')

  const parseEnv = (s: string): Record<string, string> => {
    const env: Record<string, string> = {}
    for (const line of s.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const idx = trimmed.indexOf('=')
      if (idx > 0) env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1)
    }
    return env
  }

  // 通用 input 类名
  const inputCls = 'h-8 w-full rounded-btn border border-border bg-bg-elevated px-2.5 text-caption text-fg-primary focus:border-accent focus:outline-none'
  const btnCls = 'rounded-btn px-3 py-1.5 text-caption transition-all duration-150 active:scale-95'

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-caption uppercase tracking-wider text-fg-muted">{t('settings.mcpTitle')}</div>
        <div className="flex items-center gap-2">
          {msg && <span className="text-[11px] text-fg-muted">{msg}</span>}
          <button
            onClick={addServer}
            className={`${btnCls} flex items-center gap-1 border border-border-subtle text-fg-secondary hover:text-accent`}
            title={t('settings.mcpAddTitle')}
          >
            <Plus size={12} /> {t('settings.mcpAdd')}
          </button>
          <button
            onClick={save}
            disabled={!dirty || saving}
            className={`${btnCls} bg-accent text-accent-fg disabled:opacity-40 disabled:active:scale-100`}
          >
            {saving ? t('settings.mcpSaving') : t('settings.mcpSaveApply')}
          </button>
        </div>
      </div>

      <div className="flex gap-4" style={{ minHeight: '400px' }}>
        {/* 左栏：server 列表 */}
        <div className="w-52 shrink-0 space-y-1">
          {Object.entries(config.mcpServers).map(([name, s]) => {
            const st = statusOf(name)
            return (
              <button
                key={name}
                onClick={() => setSelectedName(name)}
                className={`mb-1 flex w-full flex-col gap-1 rounded-btn px-2.5 py-2 text-left transition-all duration-150 active:scale-95 ${
                  selectedName === name ? 'bg-accent/10 text-accent' : 'text-fg-secondary hover:bg-bg-muted'
                }`}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <span className="truncate font-mono text-[11px]">{name}</span>
                  {statusBadge(st?.status)}
                </div>
                {st && st.toolCount > 0 && (
                  <span className="text-[10px] text-fg-muted">{t('settings.mcpToolCount', { n: st.toolCount })}</span>
                )}
                {!s.enabled && (
                  <span className="text-[10px] text-fg-muted">{t('settings.mcpDisabledTag')}</span>
                )}
              </button>
            )
          })}
          {Object.keys(config.mcpServers).length === 0 && (
            <div className="text-caption text-fg-muted">{t('settings.mcpEmpty')}</div>
          )}
        </div>

        {/* 右栏：详情编辑 */}
        {selected ? (
          <div className="flex-1 space-y-3">
            <Field label={t('settings.mcpNameField')}>
              <input
                value={selected.name}
                onChange={(e) => {
                  const newName = e.target.value
                  if (!newName) return
                  // 重命名：保留配置，更换 key
                  const next = { ...config.mcpServers }
                  delete next[selectedName]
                  next[newName] = { ...selected, name: newName }
                  setConfig({ mcpServers: next })
                  setSelectedName(newName)
                  setDirty(true)
                }}
                className={inputCls}
              />
            </Field>

            <Field label={t('settings.mcpTransport')}>
              <select
                value={selected.transport}
                onChange={(e) => updateSelected({ transport: e.target.value as 'stdio' | 'streamable-http' })}
                className={inputCls}
              >
                <option value="stdio">{t('settings.mcpStdio')}</option>
                <option value="streamable-http">{t('settings.mcpHttp')}</option>
              </select>
            </Field>

            <Field label={t('settings.mcpEnabledLabel')}>
              <button
                onClick={() => updateSelected({ enabled: !selected.enabled })}
                className={`relative h-5 w-9 rounded-full transition-colors ${selected.enabled ? 'bg-accent' : 'bg-bg-muted'}`}
              >
                <span
                  className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                    selected.enabled ? 'translate-x-4' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </Field>

            {selected.transport === 'stdio' ? (
              <>
                <Field label={t('settings.mcpCommand')}>
                  <input
                    value={selected.command ?? ''}
                    onChange={(e) => updateSelected({ command: e.target.value })}
                    className={inputCls}
                    placeholder={t('settings.mcpCommandPh')}
                  />
                </Field>
                <Field label={t('settings.mcpArgs')}>
                  <input
                    value={argsStr}
                    onChange={(e) =>
                      updateSelected({ args: e.target.value.split(/\s+/).filter(Boolean) })
                    }
                    className={inputCls}
                    placeholder={t('settings.mcpArgsPh')}
                  />
                </Field>
                <Field label={t('settings.mcpEnv')}>
                  <textarea
                    value={envStr}
                    onChange={(e) => updateSelected({ env: parseEnv(e.target.value) })}
                    className="h-20 w-full resize-none rounded-btn border border-border bg-bg-elevated p-2 font-mono text-[11px] text-fg-primary focus:border-accent focus:outline-none"
                    placeholder={'API_KEY=xxx\nNODE_ENV=production'}
                  />
                </Field>
                <Field label={t('settings.mcpAutoRestart')}>
                  <button
                    onClick={() => updateSelected({ autoRestart: !selected.autoRestart })}
                    className={`relative h-5 w-9 rounded-full transition-colors ${selected.autoRestart ? 'bg-accent' : 'bg-bg-muted'}`}
                  >
                    <span
                      className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                        selected.autoRestart ? 'translate-x-4' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                </Field>
              </>
            ) : (
              <Field label="Server URL">
                <input
                  value={selected.url ?? ''}
                  onChange={(e) => updateSelected({ url: e.target.value })}
                  className={inputCls}
                  placeholder="https://example.com/mcp"
                />
              </Field>
            )}

            <div className="flex gap-2 pt-2">
              <button
                onClick={connect}
                className={`${btnCls} border border-border-subtle text-fg-secondary hover:text-accent`}
              >
                {t('settings.mcpConnect')}
              </button>
              <button
                onClick={disconnect}
                className={`${btnCls} border border-border-subtle text-fg-secondary hover:text-accent`}
              >
                {t('settings.mcpDisconnect')}
              </button>
              <button
                onClick={() => removeServer(selectedName)}
                className={`${btnCls} flex items-center gap-1 border border-danger/30 text-danger hover:bg-danger/10`}
              >
                <Trash2 size={12} /> {t('settings.mcpDelete')}
              </button>
            </div>

            {statusOf(selectedName)?.lastError && (
              <div className="rounded-btn bg-danger/10 px-3 py-2 text-[11px] text-danger">
                {statusOf(selectedName)!.lastError}
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 text-caption text-fg-muted">{t('settings.mcpEmptyDetail')}</div>
        )}
      </div>
    </div>
  )
}