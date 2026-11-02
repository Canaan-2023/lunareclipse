/**
 * 为什么存在：代码沙箱运行与文件只读预览是跨功能的工具场景，
 * 独立面板提供"编辑器 + 预览"双模式，并允许从任意消息的附件链接打开。
 * 作用：渲染文件工坊（编辑器/预览双模式）——流式代码运行输出、文件树浏览、
 * 文本/图片/PDF 只读预览与打开项目目录。
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import {
  X, Trash2, AlertTriangle, Loader2,
  FileText, ExternalLink, FolderOpen, Maximize2, Minimize2, Eye, ChevronDown,
  FileTerminal, Code2, Settings2, Plus
} from 'lucide-react'
import { useAppStore } from '../../stores/appStore'; import { useT } from '../../i18n/useT'
import {
  registerFilePreviewOpener,
  consumePendingFilePreview
} from './filePreviewOpener'
import { SandboxOutput } from './SandboxOutput'
import { Modal } from '../Modal'

type WorkshopTab = 'code' | 'preview'

interface FilePreviewState {
  path: string
  loading: boolean
  content: string | null
  totalLines: number | null
  error: string | null
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
  const setPreviewingFilePath = useAppStore((s) => s.setPreviewingFilePath); const t = useT()

  const language = useAppStore((s) => s.sandboxLanguage)
  const code = useAppStore((s) => s.sandboxCode)
  const running = useAppStore((s) => s.sandboxRunning)
  // 只订阅布尔派生值：流式追加 output 时该值保持 true，主组件不重渲染（输出区自行订阅原文）
  const hasOutput = useAppStore((s) => !!(s.sandboxOutput || s.sandboxResult))
  const executors = useAppStore((s) => s.sandboxExecutors)
  const setLanguage = useAppStore((s) => s.sandboxSetLanguage)
  const setCode = useAppStore((s) => s.sandboxSetCode)
  const run = useAppStore((s) => s.sandboxRun)
  const clearOutput = useAppStore((s) => s.sandboxClearOutput)
  const loadExecutors = useAppStore((s) => s.sandboxLoadExecutors)

  const editorRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
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
        setPreviewState((s) => ({ ...s, loading: false, error: res.error ?? t('panelui.workshop.readFailed') }))
      }
    } catch (err) {
      setPreviewState((s) => ({ ...s, loading: false, error: (err as Error).message }))
    }
  }, [setPreviewingFilePath])

  useEffect(() => {
    const openPreview = (path: string) => {
      setPreviewingFilePath(path)
      setActiveTab('preview')
      void loadFile(path)
    }
    registerFilePreviewOpener(openPreview)
    const pending = consumePendingFilePreview()
    if (pending) openPreview(pending)
    void loadExecutors()
    return () => {
      registerFilePreviewOpener(null)
    }
  }, [loadFile, setPreviewingFilePath, loadExecutors])

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

  return (
    <div className="flex h-full w-full flex-col bg-bg-surface" ref={containerRef}>
      {/* 第一行：标题 + 右侧按钮 */}
      <div className="flex items-center gap-2 border-b border-border-subtle px-2.5 py-1.5">
        <FileTerminal size={14} className="text-accent shrink-0" />
        <span className="text-caption font-medium text-fg-primary">{t('panelui.workshop.title')}</span>

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
            {t('panelui.workshop.code')}
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
            {t('panelui.workshop.preview')}
          </button>
        </div>

        <button
          onClick={() => setConfirmClear(true)}
          disabled={activeTab === 'preview' || running || !hasOutput}
          className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary disabled:opacity-30 disabled:cursor-not-allowed"
          title={t('panelui.workshop.clearOutput')}
          aria-label={t('panelui.workshop.clearOutput')}
        >
          <Trash2 size={12} />
        </button>
        <button
          onClick={() => setWorkshopFullscreen(!workshopFullscreen)}
          className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
          title={workshopFullscreen ? t('panelui.workshop.exitFullscreen') : t('panelui.workshop.fullscreen')}
          aria-label={workshopFullscreen ? t('panelui.workshop.exitFullscreen') : t('panelui.workshop.fullscreen')}
        >
          {workshopFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
        <button
          onClick={() => closeDrawer()}
          className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
          title={t('panelui.workshop.closeEsc')}
          aria-label={t('panelui.workshop.closePanel')}
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
                        <div className="px-2.5 py-1.5 text-caption text-fg-muted">{t('panelui.workshop.loading')}</div>
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
                              <span className="text-[9px] text-fg-muted">{t('panelui.workshop.default')}</span>
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
                          {t('panelui.workshop.manageExecutors')}
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>

              <span className="text-[10px] text-fg-muted">
                {language === 'javascript'
                  ? t('panelui.workshop.workerIsolated')
                  : t('panelui.workshop.subprocess')}
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

            {/* 输出区（下栏）：独立订阅流式输出，避免每个输出 tick 重渲染编辑器与语言栏 */}
            <SandboxOutput splitRatio={splitRatio} />
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
      <Modal
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        label={t('panelui.workshop.clearOutput')}
        backdropClassName="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
        cardClassName="flex w-[340px] flex-col rounded-lg border border-border-subtle bg-bg-elevated shadow-xl"
      >
            <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
              <AlertTriangle size={14} className="text-danger" />
              <span className="text-caption font-medium text-fg-primary">{t('panelui.workshop.clearOutput')}</span>
            </div>
            <div className="px-3 py-3 text-caption text-fg-secondary">
              {t('panelui.workshop.clearConfirm')}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-3 py-2">
              <button
                onClick={() => setConfirmClear(false)}
                className="flex h-7 items-center rounded-btn border border-border-subtle px-2.5 text-caption text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary"
              >
                {t('panelui.workshop.cancel')}
              </button>
              <button
                onClick={() => {
                  // 结果块显隐由输出区内部维护：清空后 result 为空，结果块自然不再渲染
                  clearOutput()
                  setConfirmClear(false)
                }}
                className="flex h-7 items-center rounded-btn bg-danger/80 px-2.5 text-caption font-medium text-fg-primary transition-colors hover:bg-danger"
              >
                {t('panelui.workshop.clear')}
              </button>
            </div>
      </Modal>

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
}) { const t = useT()
  if (!previewState.path) {
    return (
      <div className="flex h-full items-center justify-center text-fg-muted">
        <div className="text-center">
          <FileText size={24} className="mx-auto mb-1.5 opacity-40" />
          <div className="text-caption mb-2">{t('panelui.workshop.previewHint')}</div>
          <button
            onClick={onSwitchToCode}
            className="text-caption text-accent hover:text-accent/80 underline"
          >
            {t('panelui.workshop.switchToCode')}
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
            <span className="text-caption text-fg-muted shrink-0">{t('panelui.workshop.lines', { n: previewState.totalLines })}</span>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => void window.lunareclipse.openFile(previewState.path)}
            className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
            title={t('panelui.workshop.openWithSystem')}
            aria-label={t('panelui.workshop.openWithSystem')}
          >
            <ExternalLink size={12} />
          </button>
          <button
            onClick={() => void window.lunareclipse.showItemInFolder(previewState.path)}
            className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
            title={t('panelui.workshop.showInFolder')}
            aria-label={t('panelui.workshop.showInFolder')}
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
            {t('panelui.workshop.reading')}
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
}) { const t = useT()
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
      setErr(t('panelui.workshop.executor.required'))
      return
    }
    const argsParts = argsText
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
    const timeoutMs = timeoutText.trim() ? Number(timeoutText.trim()) : undefined
    if (timeoutText.trim() && (!Number.isFinite(timeoutMs) || (timeoutMs as number) <= 0)) {
      setErr(t('panelui.workshop.executor.timeoutInvalid'))
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
        setErr(res?.error ?? t('panelui.workshop.executor.saveFailed'))
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
    if (!window.confirm(t('panelui.workshop.executor.deleteConfirm', { label: e.label, id: e.id }))) return
    setBusy(true)
    setErr(null)
    try {
      const res = await window.lunareclipse.codeRemoveExecutor(e.id)
      if (!res?.ok) {
        setErr(res?.error ?? t('panelui.workshop.executor.deleteFailed'))
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
    <Modal
      open
      onClose={onClose}
      label={t('panelui.workshop.manageExecutors')}
      backdropClassName="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      cardClassName="flex max-h-[80vh] w-[420px] flex-col rounded-lg border border-border-subtle bg-bg-elevated shadow-xl"
    >
        {/* 头部 */}
        <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
          <Settings2 size={14} className="text-accent" />
          <span className="text-caption font-medium text-fg-primary">{t('panelui.workshop.manageExecutors')}</span>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary"
            title={t('panelui.workshop.closeEsc')}
            aria-label={t('panelui.workshop.executor.closeAria')}
          >
            <X size={13} />
          </button>
        </div>

        {/* 现有执行器列表 */}
        <div className="border-b border-border-subtle px-3 py-2">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-fg-muted">{t('panelui.workshop.executor.installed')}</div>
          {executors.length === 0 ? (
            <div className="py-1 text-caption text-fg-muted">{t('panelui.workshop.executor.empty')}</div>
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
                    <span className="shrink-0 rounded-full bg-bg-muted px-1.5 py-px text-[9px] text-fg-muted">{t('panelui.workshop.default')}</span>
                  ) : (
                    <>
                      <button
                        onClick={() => startEdit(e)}
                        className="shrink-0 rounded px-1 py-px text-[10px] text-accent transition-colors hover:bg-bg-muted"
                        title={t('panelui.workshop.executor.editTitle')}
                      >
                        {t('panelui.workshop.executor.edit')}
                      </button>
                      <button
                        onClick={() => void remove(e)}
                        disabled={busy}
                        className="shrink-0 rounded px-1 py-px text-[10px] text-danger transition-colors hover:bg-danger/10 disabled:opacity-40"
                        title={t('panelui.workshop.executor.deleteTitle')}
                      >
                        {t('panelui.workshop.delete')}
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
            {editingId ? t('panelui.workshop.executor.editForm') : t('panelui.workshop.executor.createForm')}
          </div>
          <div className="space-y-1.5">
            <div>
              <div className="mb-0.5 text-[10px] text-fg-secondary">{t('panelui.workshop.executor.idLabel')}</div>
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
              <div className="mb-0.5 text-[10px] text-fg-secondary">{t('panelui.workshop.executor.nameLabel')}</div>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                spellCheck={false}
                placeholder="Python3"
                className="w-full rounded-btn border border-border-subtle bg-bg-base px-2 py-1 text-caption text-fg-primary outline-none focus:border-accent"
              />
            </div>
            <div>
              <div className="mb-0.5 text-[10px] text-fg-secondary">{t('panelui.workshop.executor.commandLabel')}</div>
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                spellCheck={false}
                placeholder="python"
                className="w-full rounded-btn border border-border-subtle bg-bg-base px-2 py-1 text-caption font-mono text-fg-primary outline-none focus:border-accent"
              />
            </div>
            <div>
              <div className="mb-0.5 text-[10px] text-fg-secondary">{t('panelui.workshop.executor.argsLabel')}</div>
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
                {t('panelui.workshop.executor.stdinLabel')}
              </label>
              <div className="flex-1">
                <input
                  value={fileExtension}
                  onChange={(e) => setFileExtension(e.target.value)}
                  spellCheck={false}
                  placeholder={t('panelui.workshop.executor.extensionLabel')}
                  className="w-full rounded-btn border border-border-subtle bg-bg-base px-2 py-1 text-caption font-mono text-fg-primary outline-none focus:border-accent"
                />
              </div>
            </div>
            <div>
              <div className="mb-0.5 text-[10px] text-fg-secondary">{t('panelui.workshop.executor.timeoutLabel')}</div>
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
          {err && <div className="mt-1.5 text-caption text-danger">{err}</div>}
        </div>

        {/* 底部操作 */}
        <div className="flex items-center gap-2 border-t border-border-subtle px-3 py-2">
          {editingId && (
            <button
              onClick={reset}
              disabled={busy}
              className="flex h-7 items-center rounded-btn border border-border-subtle px-2.5 text-caption text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary disabled:opacity-40"
            >
              {t('panelui.workshop.executor.cancelEdit')}
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={onClose}
            disabled={busy}
            className="flex h-7 items-center rounded-btn border border-border-subtle px-2.5 text-caption text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary disabled:opacity-40"
          >
            {t('panelui.workshop.executor.close')}
          </button>
          <button
            onClick={() => void save()}
            disabled={busy}
            className="flex h-7 items-center gap-1 rounded-btn bg-accent px-3 text-caption font-medium text-accent-fg transition-colors hover:bg-accent/90 disabled:opacity-40"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
            {editingId ? t('panelui.workshop.executor.save') : t('panelui.workshop.executor.add')}
          </button>
        </div>
    </Modal>
  )
}
