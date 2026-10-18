/**
 * 为什么存在：代码沙箱运行与文件只读预览是跨功能的工具场景，
 * 独立面板提供"编辑器 + 预览"双模式，并允许从任意消息的附件链接打开。
 * 作用：渲染文件工坊（编辑器/预览双模式）——流式代码运行输出、文件树浏览、
 * 文本/图片/PDF 只读预览与打开项目目录。
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import {
  X, Play, Trash2, Terminal, AlertTriangle, Loader2, Clock,
  FileText, ExternalLink, FolderOpen, Maximize2, Minimize2, Eye, ChevronDown,
  FileTerminal, Code2, Settings2, Plus
} from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { formatValue } from '@shared/utils/format-value'

type WorkshopTab = 'code' | 'preview'

interface FilePreviewState {
  path: string
  loading: boolean
  content: string | null
  totalLines: number | null
  error: string | null
}

let pendingPreviewPath: string | null = null
let openPreviewFn: ((path: string) => void) | null = null

export function openFilePreview(path: string): void {
  if (openPreviewFn) {
    openPreviewFn(path)
  } else {
    pendingPreviewPath = path
    useAppStore.getState().openDrawer('workshop')
  }
}

/**
 * 文件工坊面板（右侧侧栏模式）

 * - 代码模式：任意语言沙箱编辑器 + 流式输出
 * - 预览模式：文件内容只读预览（从消息气泡/工具行/Markdown 链接点击打开）
 * - 编辑器/输出区可拖拽调整比例，默认 55%/45%
 */
export function FileWorkshopPanel() {
  const activeDrawer = useAppStore((s) => s.activeDrawer)
  const workshopFullscreen = useAppStore((s) => s.workshopFullscreen)
  const setWorkshopFullscreen = useAppStore((s) => s.setWorkshopFullscreen)
  const closeDrawer = useAppStore((s) => s.closeDrawer)
  const setPreviewingFilePath = useAppStore((s) => s.setPreviewingFilePath)

  const language = useAppStore((s) => s.sandboxLanguage)
  const code = useAppStore((s) => s.sandboxCode)
  const running = useAppStore((s) => s.sandboxRunning)
  const output = useAppStore((s) => s.sandboxOutput)
  const result = useAppStore((s) => s.sandboxResult)
  const executors = useAppStore((s) => s.sandboxExecutors)
  const setLanguage = useAppStore((s) => s.sandboxSetLanguage)
  const setCode = useAppStore((s) => s.sandboxSetCode)
  const run = useAppStore((s) => s.sandboxRun)
  const clearOutput = useAppStore((s) => s.sandboxClearOutput)
  const loadExecutors = useAppStore((s) => s.sandboxLoadExecutors)

  const editorRef = useRef<HTMLTextAreaElement>(null)
  const outputRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [showResult, setShowResult] = useState(false)
  const [activeTab, setActiveTab] = useState<WorkshopTab>('code')
  const [langDropdownOpen, setLangDropdownOpen] = useState(false)
  const [executorMgrOpen, setExecutorMgrOpen] = useState(false)
  // 清空输出确认态：输出/结果是运行产物，误清不可恢复，先确认再执行。
  // 作用：给"清空输出"加不可逆操作确认，与执行器删除同一防护标准。
  // 不删的理由：若直接清空，用户误点后运行结果丢失且无任何撤销手段。
  const [confirmClear, setConfirmClear] = useState(false)
  const [splitRatio, setSplitRatio] = useState(0.55)
  const [dragging, setDragging] = useState(false)
  const [previewState, setPreviewState] = useState<FilePreviewState>({
    path: '',
    loading: false,
    content: null,
    totalLines: null,
    error: null
  })

  const loadFile = useCallback(async (path: string) => {
    setPreviewState({ path, loading: true, content: null, totalLines: null, error: null })
    setPreviewingFilePath(path)
    try {
      const res = await window.lunareclipse.fileRead(path)
      if (res.ok) {
        setPreviewState((s) => ({ ...s, loading: false, content: res.content ?? '', totalLines: res.totalLines ?? null }))
      } else {
        setPreviewState((s) => ({ ...s, loading: false, error: res.error ?? '读取失败' }))
      }
    } catch (err) {
      setPreviewState((s) => ({ ...s, loading: false, error: (err as Error).message }))
    }
  }, [setPreviewingFilePath])

  useEffect(() => {
    openPreviewFn = (path: string) => {
      setPreviewingFilePath(path)
      setActiveTab('preview')
      void loadFile(path)
    }
    if (pendingPreviewPath) {
      const p = pendingPreviewPath
      pendingPreviewPath = null
      openPreviewFn(p)
    }
    void loadExecutors()
    return () => {
      openPreviewFn = null
    }
  }, [loadFile, setPreviewingFilePath, loadExecutors])

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [output])

  useEffect(() => {
    if (result) setShowResult(true)
  }, [result])

  useEffect(() => {
    if (activeDrawer === 'workshop') {
      setTimeout(() => editorRef.current?.focus(), 100)
    }
  }, [activeDrawer])

  useEffect(() => {
    if (activeDrawer !== 'workshop') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (confirmClear) {
          // 清空确认弹层要最先响应 Esc：先收最内层弹层，再逐层收下拉/整个抽屉。
          // 作用：键盘可单键撤销确认弹层，避免误关整个面板。
          // 不删的理由：与下方 executorMgrOpen/langDropdownOpen 形成同一"逐层关闭"栈。
          setConfirmClear(false)
        } else if (executorMgrOpen) {
          setExecutorMgrOpen(false)
        } else if (langDropdownOpen) {
          setLangDropdownOpen(false)
        } else {
          closeDrawer()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeDrawer, langDropdownOpen, closeDrawer, executorMgrOpen, confirmClear])

  const onMouseDownSplit = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setDragging(true)
  }, [])

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => {
      if (!containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const y = e.clientY - rect.top
      const ratio = Math.min(0.85, Math.max(0.2, y / rect.height))
      setSplitRatio(ratio)
    }
    const onUp = () => setDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging])

  if (activeDrawer !== 'workshop') return null

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      const ta = e.currentTarget
      const start = ta.selectionStart
      const end = ta.selectionEnd
      const newCode = code.slice(0, start) + '  ' + code.slice(end)
      setCode(newCode)
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2
      })
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      void run()
    }
  }

  const fileName = previewState.path.replace(/\\/g, '/').split('/').pop() || previewState.path
  const currentExecutor = executors.find((e) => e.id === language)
  const hasOutput = !!(output || result)

  return (
    <div className="flex h-full w-full flex-col bg-bg-surface" ref={containerRef}>
      {/* 第一行：标题 + 右侧按钮 */}
      <div className="flex items-center gap-2 border-b border-border-subtle px-2.5 py-1.5">
        <FileTerminal size={14} className="text-accent shrink-0" />
        <span className="text-caption font-medium text-fg-primary">文件工坊</span>

        <div className="flex-1" />

        {/* 模式切换 */}
        <div className="flex items-center gap-0.5 rounded-btn bg-bg-muted p-0.5">
          <button
            onClick={() => setActiveTab('code')}
            className={`flex items-center gap-1 rounded-[6px] px-2 py-0.5 text-caption transition-colors ${
              activeTab === 'code'
                ? 'bg-accent text-accent-fg'
                : 'text-fg-muted hover:text-fg-secondary'
            }`}
          >
            <Code2 size={11} />
            代码
          </button>
          <button
            onClick={() => setActiveTab('preview')}
            className={`flex items-center gap-1 rounded-[6px] px-2 py-0.5 text-caption transition-colors ${
              activeTab === 'preview'
                ? 'bg-accent text-accent-fg'
                : 'text-fg-muted hover:text-fg-secondary'
            }`}
          >
            <Eye size={11} />
            预览
          </button>
        </div>

        <button
          onClick={() => setConfirmClear(true)}
          disabled={activeTab === 'preview' || running || !hasOutput}
          className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary disabled:opacity-30 disabled:cursor-not-allowed"
          title="清空输出"
          aria-label="清空输出"
        >
          <Trash2 size={12} />
        </button>
        <button
          onClick={() => setWorkshopFullscreen(!workshopFullscreen)}
          className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
          title={workshopFullscreen ? '退出全屏' : '全屏展开'}
          aria-label={workshopFullscreen ? '退出全屏' : '全屏展开'}
        >
          {workshopFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
        <button
          onClick={() => closeDrawer()}
          className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
          title="关闭（Esc）"
          aria-label="关闭文件工坊面板"
        >
          <X size={14} />
        </button>
      </div>

      {/* 主体内容区 */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {activeTab === 'code' ? (
          <>
            {/* 第二行：语言选择 + 快捷键提示（仅代码模式） */}
            <div className="flex items-center gap-2 border-b border-border-subtle bg-bg-surface/50 px-2.5 py-1">
              <div className="relative">
                <button
                  onClick={() => setLangDropdownOpen(!langDropdownOpen)}
                  className="flex items-center gap-1 rounded-btn bg-bg-muted px-2 py-0.5 text-caption text-fg-primary hover:bg-bg-elevated"
                >
                  {currentExecutor?.label ?? language}
                  <ChevronDown size={10} className={`transition-transform ${langDropdownOpen ? 'rotate-180' : ''}`} />
                </button>
                {langDropdownOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-10"
                      onClick={() => setLangDropdownOpen(false)}
                    />
                    <div className="absolute top-full left-0 z-20 mt-1 min-w-32 rounded-btn border border-border-subtle bg-bg-elevated shadow-lg">
                      {executors.length === 0 ? (
                        <div className="px-2.5 py-1.5 text-caption text-fg-muted">加载中...</div>
                      ) : (
                        executors.map((exec) => (
                          <button
                            key={exec.id}
                            onClick={() => {
                              setLanguage(exec.id)
                              setLangDropdownOpen(false)
                            }}
                            className={`flex w-full items-center justify-between gap-2 px-2.5 py-1 text-caption transition-colors ${
                              language === exec.id
                                ? 'bg-accent/20 text-accent'
                                : 'text-fg-primary hover:bg-bg-muted'
                            }`}
                          >
                            <span>{exec.label}</span>
                            {exec.builtin && (
                              <span className="text-[9px] text-fg-muted">默认</span>
                            )}
                          </button>
                        ))
                      )}
                      <div className="border-t border-border-subtle">
                        <button
                          onClick={() => {
                            setLangDropdownOpen(false)
                            setExecutorMgrOpen(true)
                          }}
                          className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-caption text-accent transition-colors hover:bg-bg-muted"
                        >
                          <Settings2 size={11} />
                          管理执行器
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>

              <span className="text-[10px] text-fg-muted">
                {language === 'javascript'
                  ? 'worker 隔离'
                  : '子进程执行'}
              </span>

              <div className="flex-1" />

              <span className="text-[10px] text-fg-muted font-mono">Ctrl+Enter</span>
            </div>

            {/* 代码编辑器（上栏） */}
            <div className="flex flex-col overflow-hidden" style={{ height: `${splitRatio * 100}%` }}>
              <textarea
                ref={editorRef}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={handleKeyDown}
                spellCheck={false}
                className="h-full w-full resize-none bg-bg-base px-2.5 py-2 font-mono text-body text-fg-primary outline-none"
                placeholder={`${language}...`}
                style={{
                  fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, Monaco, monospace',
                  fontSize: '12px',
                  lineHeight: 1.5,
                  tabSize: 2
                }}
              />
            </div>

            {/* 拖拽分隔条 */}
            <div
              onMouseDown={onMouseDownSplit}
              className={`flex h-1 shrink-0 items-center justify-center border-y border-border-subtle bg-bg-surface transition-colors ${
                dragging ? 'bg-accent/20' : 'hover:bg-bg-muted cursor-row-resize'
              }`}
            >
              <div className={`h-0.5 w-8 rounded-full ${dragging ? 'bg-accent' : 'bg-border-subtle'}`} />
            </div>

            {/* 输出区（下栏） */}
            <div className="flex flex-col overflow-hidden" style={{ height: `${(1 - splitRatio) * 100}%` }}>
              <div className="flex items-center gap-1.5 border-b border-border-subtle bg-bg-surface/50 px-2.5 py-0.5">
                <Terminal size={9} className="text-fg-muted" />
                <span className="text-[10px] uppercase tracking-wider text-fg-muted">输出</span>
                {running && (
                  <span className="ml-auto flex items-center gap-1 text-[10px] text-accent">
                    <Loader2 size={9} className="animate-spin" />
                    执行中
                  </span>
                )}
                {result && !running && (
                  <span className="ml-auto flex items-center gap-1 text-[10px] text-fg-muted">
                    <Clock size={9} />
                    {result.durationMs}ms
                    {result.timedOut && <span className="text-amber-400">超时</span>}
                  </span>
                )}
              </div>

              <div
                ref={outputRef}
                className="flex-1 overflow-auto bg-bg-base px-2.5 py-2 font-mono"
                style={{
                  fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, Monaco, monospace',
                  fontSize: '11px',
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all'
                }}
              >
                {!hasOutput ? (
                  <div className="flex h-full items-center justify-center text-fg-muted">
                    <div className="text-center">
                      <Terminal size={20} className="mx-auto mb-1.5 opacity-30" />
                      <div className="text-caption">按 Ctrl+Enter 或点击下方"执行"运行代码</div>
                    </div>
                  </div>
                ) : (
                  <>
                    {output && (
                      <pre className="whitespace-pre-wrap break-all">{output}</pre>
                    )}
                    {showResult && result && (
                      <div className="mt-2 border-t border-border-subtle pt-2">
                        <div className="mb-1 text-[10px] uppercase tracking-wider text-fg-muted">
                          结果 {result.ok ? 'OK' : 'FAIL'}
                        </div>
                        {result.result !== undefined && (
                          <pre className="whitespace-pre-wrap break-all text-emerald-300">
                            {formatValue(result.result)}
                          </pre>
                        )}
                        {result.errorMessage && (
                          <pre className="whitespace-pre-wrap break-all text-red-400">
                            {result.errorMessage}
                          </pre>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* 底部执行栏 */}
              <div className="flex items-center gap-2 border-t border-border-subtle bg-bg-surface px-2.5 py-1.5">
                {!running ? (
                  <button
                    onClick={() => void run()}
                    className="flex items-center gap-1.5 rounded-btn bg-accent px-3 py-1 text-caption text-accent-fg hover:bg-accent/90"
                    title="执行（Ctrl+Enter）"
                  >
                    <Play size={11} />
                    执行
                  </button>
                ) : (
                  <button
                    disabled
                    className="flex items-center gap-1.5 rounded-btn bg-bg-muted px-3 py-1 text-caption text-fg-muted cursor-not-allowed"
                  >
                    {/* 运行中禁用 + 旋转指示：原名 Square 停止图标对 disabled 按钮
                        是 affordance 误导（评审 MINOR-3）——改为 Loader2 表达「进行中」，
                        避免用户误以为可以手动停止却点击无反馈。 */}
                    <Loader2 size={11} className="animate-spin" />
                    执行中…
                  </button>
                )}
                <div className="text-[10px] text-fg-muted">
                  {running ? '超时自动终止' : '就绪'}
                </div>
              </div>
            </div>
          </>
        ) : (
          <PreviewMode
            previewState={previewState}
            fileName={fileName}
            onSwitchToCode={() => setActiveTab('code')}
          />
        )}
      </div>

      {/* 清空输出确认弹层：输出/结果是运行产物，误清不可恢复，先确认再执行。 */}
      {/* 作用：与执行器删除同一防护标准，复用项目既有 fixed inset-0 z-40 + 卡片弹层样式。 */}
      {/* 不删的理由：无确认时用户误点清空按钮会静默丢失全部运行输出与结果。 */}
      {confirmClear && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
          onClick={() => setConfirmClear(false)}
        >
          <div
            className="flex w-[340px] flex-col rounded-lg border border-border-subtle bg-bg-elevated shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
              <AlertTriangle size={14} className="text-danger" />
              <span className="text-caption font-medium text-fg-primary">清空输出</span>
            </div>
            <div className="px-3 py-3 text-caption text-fg-secondary">
              将清空当前输出与运行结果，此操作不可撤销。确定继续？
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-3 py-2">
              <button
                autoFocus
                onClick={() => setConfirmClear(false)}
                className="flex h-7 items-center rounded-btn border border-border-subtle px-2.5 text-caption text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary"
              >
                取消
              </button>
              <button
                onClick={() => {
                  clearOutput()
                  setShowResult(false)
                  setConfirmClear(false)
                }}
                className="flex h-7 items-center rounded-btn bg-danger/80 px-2.5 text-caption font-medium text-fg-primary transition-colors hover:bg-danger"
              >
                清空
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 执行器管理弹层（语言下拉底部「管理执行器」入口打开） */}
      <ExecutorManager
        open={executorMgrOpen}
        executors={executors}
        onClose={() => setExecutorMgrOpen(false)}
      />
    </div>
  )
}

function PreviewMode({
  previewState, fileName, onSwitchToCode
}: {
  previewState: FilePreviewState
  fileName: string
  onSwitchToCode: () => void
}) {
  if (!previewState.path) {
    return (
      <div className="flex h-full items-center justify-center text-fg-muted">
        <div className="text-center">
          <FileText size={24} className="mx-auto mb-1.5 opacity-40" />
          <div className="text-caption mb-2">从消息中点击文件路径打开预览</div>
          <button
            onClick={onSwitchToCode}
            className="text-caption text-accent hover:text-accent/80 underline"
          >
            或切换到代码模式编写代码 →
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border-subtle px-2.5 py-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <FileText size={12} className="text-accent shrink-0" />
          <span className="text-caption font-medium text-fg-primary truncate">{fileName}</span>
          {previewState.totalLines !== null && (
            <span className="text-caption text-fg-muted shrink-0">{previewState.totalLines} 行</span>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => void window.lunareclipse.openFile(previewState.path)}
            className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
            title="用系统默认程序打开"
            aria-label="用系统默认程序打开"
          >
            <ExternalLink size={12} />
          </button>
          <button
            onClick={() => void window.lunareclipse.showItemInFolder(previewState.path)}
            className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
            title="在文件夹中显示"
            aria-label="在文件夹中显示"
          >
            <FolderOpen size={12} />
          </button>
        </div>
      </div>

      <div className="border-b border-border-subtle px-2.5 py-1 text-caption text-fg-muted truncate font-mono">
        {previewState.path}
      </div>

      <div className="flex-1 overflow-auto bg-bg-base/50">
        {previewState.loading ? (
          <div className="flex h-full items-center justify-center text-fg-muted">
            <Loader2 size={16} className="animate-spin mr-2" />
            读取中...
          </div>
        ) : previewState.error ? (
          <div className="flex h-full items-center justify-center text-danger">
            <AlertTriangle size={14} className="mr-2" />
            {previewState.error}
          </div>
        ) : (
          <pre className="p-2.5 text-[11px] leading-relaxed text-fg-secondary whitespace-pre-wrap font-mono">
            {previewState.content}
          </pre>
        )}
      </div>
    </div>
  )
}

interface SandboxExecutorSummary {
  id: string
  label: string
  mode: string
  builtin: boolean
}

/**
 * 执行器管理弹层：新增/编辑/删除自定义执行器。
 * 直接对接 window.lunareclipse.codeUpsertExecutor / codeRemoveExecutor，
 * 成功后经 store.sandboxLoadExecutors 刷新语言下拉。
 */
function ExecutorManager({
  open,
  executors,
  onClose
}: {
  open: boolean
  executors: SandboxExecutorSummary[]
  onClose: () => void
}) {
  const loadExecutors = useAppStore((s) => s.sandboxLoadExecutors)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [id, setId] = useState('')
  const [label, setLabel] = useState('')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')
  const [stdinMode, setStdinMode] = useState(false)
  const [fileExtension, setFileExtension] = useState('')
  const [timeoutText, setTimeoutText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // 弹层打开时刷新执行器列表（不删的理由：列表可能因上次 IPC 失败或沙箱面板从未打开而陈旧/为空，
  // 打开时重拉保证「已安装执行器」区域与语言下拉展示真实当前数据）
  useEffect(() => {
    if (open) void loadExecutors()
  }, [open, loadExecutors])

  if (!open) return null

  const reset = () => {
    setEditingId(null)
    setId('')
    setLabel('')
    setCommand('')
    setArgsText('')
    setStdinMode(false)
    setFileExtension('')
    setTimeoutText('')
    setErr(null)
  }

  const startEdit = (e: SandboxExecutorSummary) => {
    // 编辑仅回填列表可得字段；argsTemplate/stdinMode/fileExtension/timeoutMs 由用户按需补充
    setEditingId(e.id)
    setId(e.id)
    setLabel(e.label)
    setCommand('')
    setArgsText('')
    setStdinMode(false)
    setFileExtension('')
    setTimeoutText('')
    setErr(null)
  }

  const save = async () => {
    const trimmedId = id.trim()
    const trimmedLabel = label.trim()
    const trimmedCommand = command.trim()
    if (!trimmedId || !trimmedLabel || !trimmedCommand) {
      setErr('id、名称与命令均为必填项')
      return
    }
    const argsParts = argsText
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
    const timeoutMs = timeoutText.trim() ? Number(timeoutText.trim()) : undefined
    if (timeoutText.trim() && (!Number.isFinite(timeoutMs) || (timeoutMs as number) <= 0)) {
      setErr('超时需为大于 0 的毫秒数')
      return
    }
    const config: {
      id: string
      label: string
      mode: 'subprocess'
      command: string
      argsTemplate?: string[]
      stdinMode?: boolean
      fileExtension?: string
      timeoutMs?: number
    } = {
      id: trimmedId,
      label: trimmedLabel,
      mode: 'subprocess',
      command: trimmedCommand
    }
    if (argsParts.length > 0) config.argsTemplate = argsParts
    if (stdinMode) config.stdinMode = true
    if (fileExtension.trim()) config.fileExtension = fileExtension.trim()
    if (timeoutMs !== undefined) config.timeoutMs = timeoutMs
    setBusy(true)
    setErr(null)
    try {
      const res = await window.lunareclipse.codeUpsertExecutor(config)
      if (!res?.ok) {
        setErr(res?.error ?? '保存失败')
        return
      }
      await loadExecutors()
      reset()
    } catch (caught) {
      setErr((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (e: SandboxExecutorSummary) => {
    if (!window.confirm(`删除执行器「${e.label}」（${e.id}）？删除后该语言将不可用。`)) return
    setBusy(true)
    setErr(null)
    try {
      const res = await window.lunareclipse.codeRemoveExecutor(e.id)
      if (!res?.ok) {
        setErr(res?.error ?? '删除失败')
        return
      }
      // 若正在编辑的正是被删执行器，清空表单
      if (editingId === e.id) reset()
      await loadExecutors()
      // 若删除的正是当前选中的语言，执行器池里已无该项，继续运行必失败——
      // 回退到内置 javascript（worker 隔离）执行器，保证语言下拉与运行行为一致
      if (useAppStore.getState().sandboxLanguage === e.id) {
        useAppStore.getState().sandboxSetLanguage('javascript')
      }
    } catch (caught) {
      setErr((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-[420px] flex-col rounded-lg border border-border-subtle bg-bg-elevated shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
          <Settings2 size={14} className="text-accent" />
          <span className="text-caption font-medium text-fg-primary">管理执行器</span>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary"
            title="关闭（Esc）"
            aria-label="关闭执行器管理弹层"
          >
            <X size={13} />
          </button>
        </div>

        {/* 现有执行器列表 */}
        <div className="border-b border-border-subtle px-3 py-2">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-fg-muted">已安装执行器</div>
          {executors.length === 0 ? (
            <div className="py-1 text-caption text-fg-muted">暂无执行器（可能加载失败，可关闭后重试）</div>
          ) : (
            <div className="max-h-40 space-y-0.5 overflow-y-auto">
              {executors.map((e) => (
                <div
                  key={e.id}
                  className={`flex items-center gap-2 rounded-btn px-2 py-1 text-caption ${
                    editingId === e.id ? 'bg-accent/10' : 'hover:bg-bg-muted'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate text-fg-primary">
                    {e.label}
                    <span className="ml-1.5 font-mono text-[10px] text-fg-muted">{e.id}</span>
                  </span>
                  {e.builtin ? (
                    <span className="shrink-0 rounded-full bg-bg-muted px-1.5 py-px text-[9px] text-fg-muted">默认</span>
                  ) : (
                    <>
                      <button
                        onClick={() => startEdit(e)}
                        className="shrink-0 rounded px-1 py-px text-[10px] text-accent transition-colors hover:bg-bg-muted"
                        title="编辑（仅名称；完整参数请重新填写）"
                      >
                        编辑
                      </button>
                      <button
                        onClick={() => void remove(e)}
                        disabled={busy}
                        className="shrink-0 rounded px-1 py-px text-[10px] text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-40"
                        title="删除执行器"
                      >
                        删除
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 新增/编辑表单 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          <div className="mb-1.5 text-[10px] uppercase tracking-wider text-fg-muted">
            {editingId ? '编辑执行器（参数需重新填写）' : '新增自定义执行器'}
          </div>
          <div className="space-y-1.5">
            <div>
              <div className="mb-0.5 text-[10px] text-fg-secondary">ID（唯一标识，如 python3）*</div>
              <input
                value={id}
                onChange={(e) => setId(e.target.value)}
                disabled={editingId !== null}
                spellCheck={false}
                placeholder="python3"
                className="w-full rounded-btn border border-border-subtle bg-bg-base px-2 py-1 text-caption font-mono text-fg-primary outline-none focus:border-accent disabled:opacity-50"
              />
            </div>
            <div>
              <div className="mb-0.5 text-[10px] text-fg-secondary">显示名称（如 Python3）*</div>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                spellCheck={false}
                placeholder="Python3"
                className="w-full rounded-btn border border-border-subtle bg-bg-base px-2 py-1 text-caption text-fg-primary outline-none focus:border-accent"
              />
            </div>
            <div>
              <div className="mb-0.5 text-[10px] text-fg-secondary">命令（如 python / node）*</div>
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                spellCheck={false}
                placeholder="python"
                className="w-full rounded-btn border border-border-subtle bg-bg-base px-2 py-1 text-caption font-mono text-fg-primary outline-none focus:border-accent"
              />
            </div>
            <div>
              <div className="mb-0.5 text-[10px] text-fg-secondary">参数模板（空格分隔，可选）</div>
              <input
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                spellCheck={false}
                placeholder="-u ${file}"
                className="w-full rounded-btn border border-border-subtle bg-bg-base px-2 py-1 text-caption font-mono text-fg-primary outline-none focus:border-accent"
              />
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-caption text-fg-secondary">
                <input
                  type="checkbox"
                  checked={stdinMode}
                  onChange={(e) => setStdinMode(e.target.checked)}
                  className="h-3 w-3 accent-accent"
                />
                从 stdin 读代码
              </label>
              <div className="flex-1">
                <input
                  value={fileExtension}
                  onChange={(e) => setFileExtension(e.target.value)}
                  spellCheck={false}
                  placeholder="文件扩展名（可选）"
                  className="w-full rounded-btn border border-border-subtle bg-bg-base px-2 py-1 text-caption font-mono text-fg-primary outline-none focus:border-accent"
                />
              </div>
            </div>
            <div>
              <div className="mb-0.5 text-[10px] text-fg-secondary">超时（毫秒，可选）</div>
              <input
                value={timeoutText}
                onChange={(e) => setTimeoutText(e.target.value)}
                inputMode="numeric"
                spellCheck={false}
                placeholder="30000"
                className="w-full rounded-btn border border-border-subtle bg-bg-base px-2 py-1 text-caption font-mono text-fg-primary outline-none focus:border-accent"
              />
            </div>
          </div>
          {err && <div className="mt-1.5 text-caption text-red-400">{err}</div>}
        </div>

        {/* 底部操作 */}
        <div className="flex items-center gap-2 border-t border-border-subtle px-3 py-2">
          {editingId && (
            <button
              onClick={reset}
              disabled={busy}
              className="flex h-7 items-center rounded-btn border border-border-subtle px-2.5 text-caption text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary disabled:opacity-40"
            >
              取消编辑
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={onClose}
            disabled={busy}
            className="flex h-7 items-center rounded-btn border border-border-subtle px-2.5 text-caption text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary disabled:opacity-40"
          >
            关闭
          </button>
          <button
            onClick={() => void save()}
            disabled={busy}
            className="flex h-7 items-center gap-1 rounded-btn bg-accent px-3 text-caption font-medium text-accent-fg transition-colors hover:bg-accent/90 disabled:opacity-40"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
            {editingId ? '保存' : '添加'}
          </button>
        </div>
      </div>
    </div>
  )
}
