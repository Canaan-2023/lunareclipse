/**
 * 为什么存在：未登录时的进场入口需要承载账号列表、登录/注册切换与无边框窗口控制，
 * 独立于已登录界面的所有面板。
 * 作用：渲染登录界面——账号列表选择、登录/注册表单切换、
 * 新账号注册（用户名/密码）与窗口最小化/最大化/关闭控制。
 */
import { useState, useEffect } from 'react'
import { useAppStore } from '../../stores/appStore'
import { ArrowLeft, Plus, Minus, Square, Copy, X } from 'lucide-react'

type Mode = 'list' | 'login' | 'register'

interface UserItem {
  UID: number
  用户名: string
  创建时间: string
}

interface InstanceStatus {
  role: 'standalone' | 'master' | 'satellite'
  master: { baseUrl: string; instanceId: string } | null
}

const ROLE_LABEL: Record<InstanceStatus['role'], string> = {
  standalone: '单机模式',
  master: '主系统',
  satellite: '分系统'
}

export function LoginScreen() {
  const [mode, setMode] = useState<Mode>('list')
  const [users, setUsers] = useState<UserItem[]>([])
  const [selectedUser, setSelectedUser] = useState<UserItem | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // 窗口最大化状态（右上角三键）
  const [maximized, setMaximized] = useState(false)

  // 登录窗口无系统边框（frame:false），右上角补齐最小化/最大化/关闭
  useEffect(() => {
    window.lunareclipse.getWindowMaximized().then(setMaximized)
    const unsubscribe = window.lunareclipse.onWindowStateChange(setMaximized)
    return () => {
      unsubscribe()
    }
  }, [])

  // 注册模型：填主系统接入链接 = 注册为分系统；留空 = 注册主系统账号（本机成为主系统）
  const [joinLink, setJoinLink] = useState('')
  const [instanceStatus, setInstanceStatus] = useState<InstanceStatus | null>(null)
  // 接入链接探测状态：null=未探测 / ok=可达 / fail=不可达
  const [probe, setProbe] = useState<{ ok: boolean; appName?: string; error?: string } | null>(null)
  const [probing, setProbing] = useState(false)

  const login = useAppStore((s) => s.login)
  const register = useAppStore((s) => s.register)

  // 加载用户列表 + 当前实例角色
  useEffect(() => {
    const load = async () => {
      try {
        const list = await window.lunareclipse.authListUsers()
        setUsers(list)
        if (list.length === 0) {
          // 没有用户，直接进入注册模式
          setMode('register')
        }
      } catch (err) {
        console.error('[LoginScreen] 加载用户列表失败:', err)
        setMode('login')
      }
      try {
        setInstanceStatus(await window.lunareclipse.multiGetStatus())
      } catch (err) {
        console.error('[LoginScreen] 读取实例角色失败:', err)
      }
    }
    load()
  }, [])

  const switchMode = (next: Mode) => {
    if (next === mode) return
    setMode(next)
    setError(null)
    setPassword('')
  }

  // 点击用户头像 → 进入密码输入
  const selectUser = (u: UserItem) => {
    setSelectedUser(u)
    setUsername(u.用户名)
    setPassword('')
    setError(null)
    setMode('login')
  }

  // 链接变化 → 防抖探测主系统可达性（仅当输入形似完整链接时）
  useEffect(() => {
    if (mode !== 'register') return
    if (!joinLink.trim()) {
      setProbe(null)
      return
    }
    const timer = setTimeout(async () => {
      setProbing(true)
      const url = extractBaseUrl(joinLink)
      if (!url) {
        setProbe({ ok: false, error: '链接格式不正确，请粘贴主系统分享的完整链接' })
        setProbing(false)
        return
      }
      const res = await window.lunareclipse.multiProbeMaster(url)
      setProbe(res)
      setProbing(false)
    }, 600)
    return () => clearTimeout(timer)
  }, [joinLink, mode])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy || !username.trim() || !password) return
    if (mode === 'login') {
      setError(null)
      setBusy(true)
      try {
        await login(username.trim(), password)
        setBusy(false)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
      }
      return
    }
    // 注册：填链接=分系统，留空=主系统账号
    setError(null)
    setBusy(true)
    try {
      if (joinLink.trim()) {
        // 先暂存接入链接（解析出 baseUrl + 准入码），再向主系统注册（UID 由主系统发放）
        const pending = await window.lunareclipse.multiSetPendingSatellite(joinLink.trim())
        if (!pending.ok) {
          setError(pending.error ?? '接入配置失败')
          setBusy(false)
          return
        }
        await register(username.trim(), password, 'joinSatellite')
      } else {
        await register(username.trim(), password, 'createMaster')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const isJoin = joinLink.trim().length > 0
  const canSubmit =
    mode === 'login' ? !!username.trim() && !!password : !!username.trim() && !!password

  const submitLabel =
    mode === 'login' ? '登录' : isJoin ? '接入主系统并注册' : '创建主系统并注册'

  return (
    <div className="relative flex h-screen w-screen items-center justify-center overflow-hidden bg-bg-base paper-texture">
      {/* 顶部透明拖拽条：frame:false 窗口需自绘拖拽区域，三键所在行亦可拖动窗口 */}
      <div
        className="absolute inset-x-0 top-0 z-10 h-9"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      />
      {/* 窗口控制三键：登录界面无系统边框，右上角需自绘最小化/最大化/关闭 */}
      <div
        className="absolute right-3 top-3 z-20 flex items-center gap-1"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          onClick={() => window.lunareclipse.windowMinimize()}
          className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary"
          title="最小化"
          aria-label="最小化"
        >
          <Minus size={14} />
        </button>
        <button
          onClick={() => window.lunareclipse.windowMaximize()}
          className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary"
          title={maximized ? '恢复窗口' : '最大化'}
          aria-label={maximized ? '恢复窗口' : '最大化'}
        >
          {maximized ? <Copy size={12} /> : <Square size={12} />}
        </button>
        <button
          onClick={() => window.lunareclipse.windowClose()}
          className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted transition-colors hover:bg-red-500/80 hover:text-white"
          title="关闭"
          aria-label="关闭"
        >
          <X size={14} />
        </button>
      </div>
      <div
        className="auth-glow pointer-events-none absolute h-[480px] w-[480px] rounded-full blur-3xl"
        style={{ background: 'radial-gradient(circle, var(--color-accent-glow) 0%, transparent 70%)' }}
      />

      <div className="relative z-10 w-[380px] rounded-card border border-border-subtle bg-bg-surface/95 p-7 shadow-2xl backdrop-blur-sm">
        <div className="auth-enter-1 mb-1 flex items-center gap-2">
          <div className="h-1.5 w-1.5 rounded-full bg-accent" />
          <span className="text-[10px] uppercase tracking-[0.3em] text-fg-muted">LunarEclipse</span>
          {instanceStatus && (
            <span className="ml-auto rounded-full border border-border-subtle px-2 py-0.5 text-[10px] text-fg-muted">
              {ROLE_LABEL[instanceStatus.role]}
              {instanceStatus.role === 'satellite' && instanceStatus.master
                ? ` · ${instanceStatus.master.baseUrl}`
                : ''}
            </span>
          )}
        </div>

        <div className="auth-enter-2 mb-1">
          <div className="text-heading font-medium text-fg-primary">月蚀</div>
        </div>

        <div className="auth-enter-2 mb-6 overflow-hidden">
          <div className="text-xs text-fg-muted">
            {mode === 'list' ? '选择账号继续' : mode === 'login' ? (selectedUser ? `欢迎回来，${selectedUser.用户名}` : '登录以继续') : '注册新账号'}
          </div>
          <div className="auth-line mt-3 h-px bg-gradient-to-r from-accent/60 via-border to-transparent" />
        </div>

        {/* 用户列表模式 */}
        {mode === 'list' && (
          <div className="space-y-2">
            {users.length === 0 ? (
              <div className="py-6 text-center text-xs text-fg-muted">加载中...</div>
            ) : (
              users.map((u) => (
                <button
                  key={u.UID}
                  onClick={() => selectUser(u)}
                  className="auth-enter-3 group flex w-full items-center gap-3 rounded-btn border border-border-subtle bg-bg-base/40 px-3 py-2.5 text-left transition-all duration-200 hover:border-accent/40 hover:bg-bg-base"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-sm font-medium text-accent">
                    {u.用户名.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-fg-primary">{u.用户名}</div>
                    <div className="truncate text-[10px] text-fg-muted">
                      创建于 {new Date(u.创建时间).toLocaleDateString('zh-CN')}
                    </div>
                  </div>
                </button>
              ))
            )}

            <button
              onClick={() => switchMode('register')}
              className="auth-enter-4 mt-3 flex w-full items-center justify-center gap-1.5 rounded-btn border border-dashed border-border-subtle px-3 py-2 text-xs text-fg-muted transition-all duration-200 hover:border-accent/40 hover:text-accent"
            >
              <Plus size={12} />
              注册新账号
            </button>

            <button
              onClick={() => switchMode('login')}
              className="mt-1 w-full text-center text-[11px] text-fg-muted/70 transition-opacity hover:opacity-80"
            >
              使用其他用户名登录
            </button>
          </div>
        )}

        {/* 登录/注册表单 */}
        {(mode === 'login' || mode === 'register') && (
          <form onSubmit={handleSubmit} className="space-y-3">
            {/* 返回用户列表的按钮（仅在有用户列表且当前是登录模式时显示） */}
            {mode === 'login' && users.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  switchMode('list')
                  setSelectedUser(null)
                  setUsername('')
                }}
                className="flex items-center gap-1 text-[11px] text-fg-muted transition-opacity hover:opacity-80"
              >
                <ArrowLeft size={11} />
                返回账号列表
              </button>
            )}

            <div className="auth-enter-3">
              <label className="mb-1.5 block text-[10px] uppercase tracking-wider text-fg-muted">
                用户名
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                disabled={!!selectedUser && mode === 'login'}
                autoComplete="username"
                className="w-full rounded-btn border border-border-subtle bg-bg-base/60 px-3 py-2 text-sm text-fg-primary placeholder:text-fg-muted/60 transition-all duration-200 focus:border-accent focus:bg-bg-base focus:outline-none focus:ring-1 focus:ring-accent/30 disabled:opacity-60"
                placeholder="输入用户名"
              />
            </div>

            <div className="auth-enter-4">
              <label className="mb-1.5 block text-[10px] uppercase tracking-wider text-fg-muted">
                密码
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus={!!selectedUser}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                className="w-full rounded-btn border border-border-subtle bg-bg-base/60 px-3 py-2 text-sm text-fg-primary placeholder:text-fg-muted/60 transition-all duration-200 focus:border-accent focus:bg-bg-base focus:outline-none focus:ring-1 focus:ring-accent/30"
                placeholder="输入密码"
              />
            </div>

            {/* 注册：角色由是否填入接入链接决定 */}
            {mode === 'register' && (
              <div className="auth-enter-5 space-y-2">
                <div>
                  <label className="mb-1.5 block text-[10px] uppercase tracking-wider text-fg-muted">
                    主系统接入链接
                    <span className="ml-1 normal-case tracking-normal text-fg-muted/60">（选填）</span>
                  </label>
                  <input
                    type="text"
                    value={joinLink}
                    onChange={(e) => setJoinLink(e.target.value)}
                    placeholder="http://192.0.2.10:62002/join?code=XXXX-XXXX-XXXX-XXXX"
                    className="w-full rounded-btn border border-border-subtle bg-bg-base/60 px-3 py-2 text-xs text-fg-primary placeholder:text-fg-muted/60 transition-all duration-200 focus:border-accent focus:bg-bg-base focus:outline-none focus:ring-1 focus:ring-accent/30"
                  />
                </div>

                {/* 动态角色说明 + 探测状态 */}
                <div
                  className={`flex items-start gap-2 rounded-btn border px-3 py-2 transition-all duration-200 ${
                    isJoin
                      ? probe?.ok
                        ? 'border-emerald-500/25 bg-emerald-500/5'
                        : 'border-accent/30 bg-accent/5'
                      : 'border-amber-500/25 bg-amber-500/5'
                  }`}
                >
                  <span
                    className={`mt-0.5 h-3 w-3 shrink-0 rounded-full ${
                      isJoin
                        ? probe?.ok
                          ? 'bg-emerald-400'
                          : probing
                            ? 'animate-pulse bg-accent/60'
                            : 'border border-fg-muted/40'
                        : 'bg-amber-400'
                    }`}
                  />
                  <span className="text-[10px] leading-relaxed text-fg-muted">
                    {isJoin ? (
                      <>
                        <span className="text-fg-primary">将以分系统身份注册</span>
                        <br />
                        账号由主系统统一发放，本地不保存账号与密码哈希。
                        {probe?.ok && (
                          <>
                            <br />
                            <span className="text-emerald-400">已连接主系统 {probe.appName ? `（${probe.appName}）` : ''}</span>
                          </>
                        )}
                        {probe && !probe.ok && (
                          <>
                            <br />
                            <span className="text-red-400">{probe.error}</span>
                          </>
                        )}
                      </>
                    ) : (
                      <>
                        <span className="text-fg-primary">本机将成为主系统</span>
                        <br />
                        注册成功后可在设置页获取接入链接，其他机器填入此链接即可接入为分系统。
                      </>
                    )}
                  </span>
                </div>

                {isJoin && probe && !probe.ok && (
                  <p className="px-1 text-[10px] leading-relaxed text-red-400">
                    主系统当前不可达，请检查地址与网络；仍可继续注册，链接将随注册请求一并提交。
                  </p>
                )}
              </div>
            )}

            {error && (
              <div className="auth-enter-5 rounded-btn border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-400">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={busy || !canSubmit}
              className="auth-enter-5 group relative w-full overflow-hidden rounded-btn bg-accent px-3 py-2 text-sm font-medium text-accent-fg transition-all duration-200 hover:shadow-lg hover:shadow-accent/20 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:shadow-none"
            >
              <span className="relative z-10">
                {busy ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    处理中
                  </span>
                ) : (
                  submitLabel
                )}
              </span>
            </button>
          </form>
        )}

        {/* 底部切换 */}
        <div className="auth-enter-5 mt-5 text-center text-xs text-fg-muted">
          {mode === 'login' ? (
            <span>
              没有账号？
              <button
                onClick={() => switchMode('register')}
                className="ml-1 text-accent transition-opacity hover:opacity-80"
              >
                注册
              </button>
            </span>
          ) : mode === 'register' ? (
            <span>
              已有账号？
              <button
                onClick={() => {
                  switchMode('login')
                  setSelectedUser(null)
                  setUsername('')
                }}
                className="ml-1 text-accent transition-opacity hover:opacity-80"
              >
                登录
              </button>
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** 从接入链接提取探测用 baseUrl；格式不符或非 http/https 返回 null */
function extractBaseUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  // 与主进程 parseJoinLink 一致：自带非 http/https scheme 直接拒绝
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) return null
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}