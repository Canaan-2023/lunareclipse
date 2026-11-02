/**
 * 为什么存在：设备交互/工具调用的高风险操作必须经用户授权（含超时自动拒绝），
 * 需要全局弹窗承载权限请求流程。
 * 作用：渲染权限请求弹窗——展示风险等级/类型/内容与倒计时，
 * 允许（一次/本次会话）/拒绝操作，超时自动拒绝。
 */
import { useEffect, useState } from 'react'
import { useT } from '../i18n/useT'

interface PermissionRequest {
  id: string
  type: 'command' | 'setting' | 'clipboard_read' | 'device'
  description: string
  content: string
  risk: 'low' | 'medium' | 'high'
}

export function PermissionDialog() {
  const t = useT()
  const [request, setRequest] = useState<PermissionRequest | null>(null)
  const [countdown, setCountdown] = useState(30)

  useEffect(() => {
    const unsub = window.lunareclipse.onPermissionRequest((req: PermissionRequest) => {
      setRequest(req)
      setCountdown(30)
    })
    return () => {
      unsub()
    }
  }, [])

  // 倒计时
  useEffect(() => {
    if (!request) return
    if (countdown <= 0) {
      // 超时自动拒绝
      window.lunareclipse.permissionRespond(request.id, false, undefined, '超时自动拒绝')
      setRequest(null)
      return
    }
    const timer = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [request, countdown])

  // 遮罩 Esc = 拒绝本次请求：权限弹窗是阻塞式授权点，未响应会拖住主进程等待，
  // Esc 取"安全默认"（与超时自动拒绝同向），禁止移除——不响应会让高风险命令在无确认下悬而未决。
  useEffect(() => {
    if (!request) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        window.lunareclipse.permissionRespond(request.id, false, undefined)
        setRequest(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [request])

  const respond = (allowed: boolean, scope?: 'once' | 'session') => {
    if (!request) return
    window.lunareclipse.permissionRespond(request.id, allowed, scope)
    setRequest(null)
  }

  if (!request) return null

  const riskConfig = {
    low: { color: 'text-success', labelKey: 'chatui.riskLow', border: 'border-success/30' },
    medium: { color: 'text-warning', labelKey: 'chatui.riskMedium', border: 'border-warning/30' },
    high: { color: 'text-danger', labelKey: 'chatui.riskHigh', border: 'border-danger/50' }
  }[request.risk]

  const typeLabel = t({
    command: 'chatui.typeCommand',
    setting: 'chatui.typeSetting',
    clipboard_read: 'chatui.typeClipboardRead',
    device: 'chatui.typeDevice'
  }[request.type])

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t('chatui.permissionRequestAria', { type: typeLabel })}
    >
      <div className={`w-[480px] overflow-hidden rounded-xl border ${riskConfig.border} bg-bg-elevated shadow-2xl`}>
        {/* 头部 */}
        <div className="border-b border-border-base px-5 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-base font-medium text-fg-primary">{t('chatui.permissionRequest')}</span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${riskConfig.color} bg-current/10`}>
                {t(riskConfig.labelKey)}
              </span>
            </div>
            <span className="text-xs text-fg-muted">{t('chatui.autoRejectAfter', { n: countdown })}</span>
          </div>
          <div className="mt-1 text-xs text-fg-muted">{typeLabel}</div>
        </div>

        {/* 内容 */}
        <div className="px-5 py-4">
          <div className="mb-3 text-sm text-fg-primary">{request.description}</div>
          {request.content && (
            <div className="mt-3">
              <div className="mb-1 text-xs text-fg-muted">{t('chatui.operationContent')}</div>
              <pre className="max-h-[200px] overflow-auto rounded-lg bg-bg-base p-3 text-xs text-fg-secondary">
                {request.content}
              </pre>
            </div>
          )}
          {request.risk === 'high' && (
            <div className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
              {t('chatui.highRiskWarning')}
            </div>
          )}
        </div>

        {/* 按钮 */}
        <div className="flex items-center justify-end gap-2 border-t border-border-base px-5 py-3">
          <button
            onClick={() => respond(false, undefined)}
            className="rounded-lg px-4 py-1.5 text-sm text-fg-secondary transition-colors hover:bg-bg-hover"
          >
            {t('chatui.reject')}
          </button>
          <button
            onClick={() => respond(true, 'session')}
            className="rounded-lg px-4 py-1.5 text-sm text-fg-primary transition-colors hover:bg-bg-hover"
          >
            {t('chatui.allowSession')}
          </button>
          <button
            onClick={() => respond(true, 'once')}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm text-accent-fg transition-colors hover:bg-accent-hover"
          >
            {t('chatui.allowOnce')}
          </button>
        </div>
      </div>
    </div>
  )
}
