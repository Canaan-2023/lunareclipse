/**
 * 为什么存在：cursor/工具调用的高风险操作必须经用户授权（含超时自动拒绝），
 * 需要全局弹窗承载权限请求流程。
 * 作用：渲染权限请求弹窗——展示风险等级/类型/内容与倒计时，
 * 允许（一次/本次会话）/拒绝操作，超时自动拒绝。
 */
import { useEffect, useState } from 'react'

interface PermissionRequest {
  id: string
  type: 'command' | 'setting' | 'clipboard_read' | 'device'
  description: string
  content: string
  risk: 'low' | 'medium' | 'high'
}

export function PermissionDialog() {
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
    low: { color: 'text-green-400', label: '低风险', border: 'border-green-500/30' },
    medium: { color: 'text-yellow-400', label: '中风险', border: 'border-yellow-500/30' },
    high: { color: 'text-red-400', label: '高风险', border: 'border-red-500/50' }
  }[request.risk]

  const typeLabel = {
    command: '执行系统命令',
    setting: '系统设置',
    clipboard_read: '读取剪贴板',
    device: '控制设备'
  }[request.type]

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`AI 权限请求 · ${typeLabel}`}
    >
      <div className={`w-[480px] overflow-hidden rounded-xl border ${riskConfig.border} bg-bg-elevated shadow-2xl`}>
        {/* 头部 */}
        <div className="border-b border-border-base px-5 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-base font-medium text-fg-primary">AI 权限请求</span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${riskConfig.color} bg-current/10`}>
                {riskConfig.label}
              </span>
            </div>
            <span className="text-xs text-fg-muted">{countdown}s 后自动拒绝</span>
          </div>
          <div className="mt-1 text-xs text-fg-muted">{typeLabel}</div>
        </div>

        {/* 内容 */}
        <div className="px-5 py-4">
          <div className="mb-3 text-sm text-fg-primary">{request.description}</div>
          {request.content && (
            <div className="mt-3">
              <div className="mb-1 text-xs text-fg-muted">操作内容：</div>
              <pre className="max-h-[200px] overflow-auto rounded-lg bg-bg-base p-3 text-xs text-fg-secondary">
                {request.content}
              </pre>
            </div>
          )}
          {request.risk === 'high' && (
            <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              ⚠ 高风险操作：请仔细确认命令内容，可能导致系统损坏或数据丢失
            </div>
          )}
        </div>

        {/* 按钮 */}
        <div className="flex items-center justify-end gap-2 border-t border-border-base px-5 py-3">
          <button
            onClick={() => respond(false, undefined)}
            className="rounded-lg px-4 py-1.5 text-sm text-fg-secondary transition-colors hover:bg-bg-hover"
          >
            拒绝
          </button>
          <button
            onClick={() => respond(true, 'session')}
            className="rounded-lg px-4 py-1.5 text-sm text-fg-primary transition-colors hover:bg-bg-hover"
          >
            本次会话允许
          </button>
          <button
            onClick={() => respond(true, 'once')}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm text-accent-fg transition-colors hover:bg-accent-hover"
          >
            单次允许
          </button>
        </div>
      </div>
    </div>
  )
}
