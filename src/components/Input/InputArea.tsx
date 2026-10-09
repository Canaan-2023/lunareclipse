/**
 * 为什么存在：消息输入承载模式切换/附件/语音/工具配置等多类入口，
 * 是聊天高频交互的核心控件，独立组件保证状态内聚与性能。
 * 作用：渲染输入区——文本输入（Ctrl+Enter 发送）、模式切换、文件附件、
 * 语音 ASR/TTS、前端 AI 工具配置弹层与发送/中止动作。
 */
import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { Send, Square, Paperclip, X, Globe, Mic, MicOff, Volume2, VolumeX, Wrench, Repeat, Shield, ShieldCheck, Code2, MessageCircle, Users, ChevronDown, Check, MessageSquare, Plus, ChevronRight, ArrowLeft, Folder, Sparkles } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useSkillStore } from '../../stores/skillStore'
import type { SkillMetadata } from '../../../electron/main/skills'
import type { Attachment } from '@shared/types'
import { estimateMessagesTokens } from '@shared/utils/token-estimate'
import { ASRController, TTSController, isASRSupported, isTTSSupported } from '../../services/voice'
import { ToolConfigPanel } from '../Chat/ToolConfigPanel'
import { useT } from '../../i18n/useT'

/** 模式选项元数据：图标 + i18n key（label/desc 在组件内用 t() 解析） */
const MODE_OPTIONS = [
  { value: 'coding' as const, labelKey: 'mode.coding.label', descKey: 'mode.coding.desc', icon: Code2 },
  { value: 'chat' as const, labelKey: 'mode.chat.label', descKey: 'mode.chat.desc', icon: MessageCircle },
  { value: 'task' as const, labelKey: 'mode.task.label', descKey: 'mode.task.desc', icon: Users },
]

/** 输入区最高两行：行高×2 + 上下 padding，超出后由 overflow-y-auto 内部滚动，不再撑大胶囊 */
const getTwoLineMaxHeight = (el: HTMLTextAreaElement) => {
  const cs = getComputedStyle(el)
  const lh = parseFloat(cs.lineHeight) || 20
  const pt = parseFloat(cs.paddingTop) || 0
  const pb = parseFloat(cs.paddingBottom) || 0
  return lh * 2 + pt + pb
}

export function InputArea() {
  const [text, setText] = useState('')
  const [toolConfigOpen, setToolConfigOpen] = useState(false)
  const [modeOpen, setModeOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [skillPickOpen, setSkillPickOpen] = useState(false)
  const [expandedDomain, setExpandedDomain] = useState<string | null>(null)
  /** 待发送的技能调用列表（多技能 chip）：选中技能后不把整段指令塞进输入框，而是以小方块呈现，发送时才按添加顺序拼接指令前缀 */
  const [skillInvocations, setSkillInvocations] = useState<{ id: number; label: string; instruct: string }[]>([])
  const skillSeqRef = useRef(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const modeRef = useRef<HTMLDivElement>(null)
  const toolConfigRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLDivElement>(null)

  const sendMessage = useAppStore((s) => s.sendMessage)
  const abortStream = useAppStore((s) => s.abortStream)
  const editAndResend = useAppStore((s) => s.editAndResend)
  const editingMessageId = useAppStore((s) => s.editingMessageId)
  const setEditingMessageId = useAppStore((s) => s.setEditingMessageId)
  const inputPrefill = useAppStore((s) => s.inputPrefill)
  const setInputPrefill = useAppStore((s) => s.setInputPrefill)

  useEffect(() => {
    if (inputPrefill !== null) {
      setText(inputPrefill)
      setInputPrefill(null)
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
        textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, getTwoLineMaxHeight(textareaRef.current)) + 'px'
      }
    }
  }, [inputPrefill, setInputPrefill])

  const status = useAppStore((s) => s.status)
  const config = useAppStore((s) => s.config)
  const saveConfig = useAppStore((s) => s.saveConfig)
  const pendingAttachments = useAppStore((s) => s.pendingAttachments)
  const addAttachment = useAppStore((s) => s.addAttachment)
  const removeAttachment = useAppStore((s) => s.removeAttachment)
  const dmnAskPrompt = useAppStore((s) => s.dmnAskPrompt)
  const answerDmnQuestion = useAppStore((s) => s.answerDmnQuestion)
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const continuousActivation = useAppStore((s) => s.currentSessionContinuousActivation)
  const toggleContinuousActivation = useAppStore((s) => s.toggleContinuousActivation)
  const chatViewMode = useAppStore((s) => s.chatViewMode)
  const setChatViewMode = useAppStore((s) => s.setChatViewMode)

  const isStreaming = status === 'streaming'

  const [dmnAnswer, setDmnAnswer] = useState('')
  const [asrActive, setAsrActive] = useState(false)
  const [ttsEnabled, setTtsEnabled] = useState(false)
  const [asrSupported] = useState(isASRSupported())
  const [ttsSupported] = useState(isTTSSupported())
  const asrRef = useRef<ASRController | null>(null)
  const ttsRef = useRef<TTSController | null>(null)
  const ttsEnabledRef = useRef(false)

  const streamingMessageId = useAppStore((s) => s.streamingMessageId)
  const currentMessages = useAppStore((s) => s.currentMessages)
  // 上下文 token 计数：流式时用 WS 推送值回退本地实时估算；预算取 lastTokenBudget ?? config.tokenBudget，未配置时用软预算兜底
  const lastTokenCount = useAppStore((s) => s.lastTokenCount)
  const lastTokenBudget = useAppStore((s) => s.lastTokenBudget)
  const configTokenBudget = useAppStore((s) => s.config.tokenBudget)
  const lastUsage = useAppStore((s) => s.lastUsage)
  const contextWarning = useAppStore((s) => s.contextWarning)
  const lastSpokenLenRef = useRef(0)
  // 流式输出时每 500ms 前端实时估算 token（WS token 消息只在请求发起时刷新一次）
  const messagesRef = useRef(currentMessages)
  messagesRef.current = currentMessages
  const [streamingTokenEstimate, setStreamingTokenEstimate] = useState<number | null>(null)

  useEffect(() => {
    if (!streamingMessageId) {
      setStreamingTokenEstimate(null)
      return
    }
    setStreamingTokenEstimate(estimateMessagesTokens(messagesRef.current))
    const timer = setInterval(() => {
      setStreamingTokenEstimate(estimateMessagesTokens(messagesRef.current))
    }, 500)
    return () => clearInterval(timer)
  }, [streamingMessageId])

  useEffect(() => {
    if (!ttsSupported) return
    if (!ttsRef.current) {
      ttsRef.current = new TTSController()
    }
    ttsEnabledRef.current = ttsEnabled
    if (!ttsEnabled) {
      ttsRef.current.stop()
      lastSpokenLenRef.current = 0
      return
    }
    if (!streamingMessageId) {
      lastSpokenLenRef.current = 0
      return
    }
    const streaming = currentMessages.find((m) => m.id === streamingMessageId)
    if (!streaming) return
    const content = streaming.content || ''
    if (content.length > lastSpokenLenRef.current) {
      const delta = content.slice(lastSpokenLenRef.current)
      lastSpokenLenRef.current = content.length
      ttsRef.current.enqueue(delta)
    }
  }, [ttsEnabled, ttsSupported, streamingMessageId, currentMessages])

  useEffect(() => {
    return () => {
      asrRef.current?.abort()
      ttsRef.current?.stop()
    }
  }, [])

// 点击外部关闭模式下拉 / 工具配置浮层 / 更多菜单
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (modeRef.current && !modeRef.current.contains(e.target as Node)) setModeOpen(false)
      if (toolConfigRef.current && !toolConfigRef.current.contains(e.target as Node)) setToolConfigOpen(false)
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false)
        setSkillPickOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  // 主动调用技能：动态扫描技能目录，用户级在上、领域级在下、组内按首字母排序
  const allSkills = useSkillStore((s) => s.skills)
  const skillGroups = useMemo(() => {
    const userSkills = allSkills
      .filter((s) => s.source === 'user')
      .sort((a, b) => a.name.localeCompare(b.name))
    const domainSkills = allSkills.filter((s) => s.source === 'domain')
    const domainMap = new Map<string, SkillMetadata[]>()
    for (const s of domainSkills) {
      const d = s.domain ?? '未分组'
      if (!domainMap.has(d)) domainMap.set(d, [])
      domainMap.get(d)!.push(s)
    }
    const orderedDomains = Array.from(domainMap.entries())
      .map(([domain, list]) => [domain, [...list].sort((a, b) => a.name.localeCompare(b.name))] as const)
      .sort((a, b) => a[0].localeCompare(b[0]))
    return { userSkills, orderedDomains }
  }, [allSkills])

  // 打开技能选择时刷新列表（动态扫描磁盘，避免列表过期）
  useEffect(() => {
    if (skillPickOpen) {
      void useSkillStore.getState().refresh()
    }
  }, [skillPickOpen])

  const closeMore = () => {
    setMoreOpen(false)
    setSkillPickOpen(false)
    setExpandedDomain(null)
  }

  // 主动调用技能：不再把整段指令文本注入输入框（那会让输入胶囊被撑大、聊天里出现一大段话），
  // 而是记录为一个 chip（显示技能名/领域名），发送时才把指令前缀拼进实际消息。
  // 支持多技能叠加：连续选中不同技能会追加 chip（同技能去重），发送时按添加顺序拼接前缀。
  const invokeSkill = (names: string[], domainLabel?: string) => {
    const label = domainLabel ? `${domainLabel}（${names.join('、')}）` : names[0]
    const instruct = `请使用技能「${label}」完成下面的任务：\n\n`
    setSkillInvocations((prev) =>
      prev.some((s) => s.label === label) ? prev : [...prev, { id: ++skillSeqRef.current, label, instruct }]
    )
    closeMore()
    requestAnimationFrame(() => {
      autoResize()
      textareaRef.current?.focus()
    })
  }

  const toggleASR = () => {
    if (!asrSupported) return
    if (asrActive) {
      asrRef.current?.stop()
      setAsrActive(false)
      return
    }
    const ctrl = new ASRController({
      onInterim: (interim) => {
        if (textareaRef.current) {
          textareaRef.current.placeholder = t('input.asrListening', { text: interim })
        }
      },
      onFinal: (finalText) => {
        setText((prev) => (prev ? prev + ' ' + finalText : finalText))
        if (textareaRef.current) {
          textareaRef.current.placeholder = t('input.placeholder')
          textareaRef.current.style.height = 'auto'
          textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, getTwoLineMaxHeight(textareaRef.current)) + 'px'
        }
      },
      onError: (err) => {
        console.error('[asr]', err)
        setAsrActive(false)
        if (textareaRef.current) {
          textareaRef.current.placeholder = t('input.placeholder')
        }
      },
      onEnd: () => {
        setAsrActive(false)
        if (textareaRef.current) {
          textareaRef.current.placeholder = t('input.placeholder')
        }
      }
    })
    asrRef.current = ctrl
    if (ctrl.start('zh-CN')) {
      setAsrActive(true)
    }
  }

  const autoResize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    // 最高两行：行高×2 + 上下 padding；超出固定在上限不动，由 overflow-y-auto 内部滚动
    el.style.height = Math.min(el.scrollHeight, getTwoLineMaxHeight(el)) + 'px'
  }, [])

  const handleSend = async () => {
    // 技能调用 chip：发送时把指令前缀按添加顺序拼进实际消息（对 AI 的语义与旧版注入完全一致）；
    // 多技能时逐个前缀依次拼接，形成「前置任务声明 + 输入内容」的结构化消息；
    // 编辑重发场景不做叠加，避免把前缀重复注回被编辑的消息
    const skillPrefix = skillInvocations.map((s) => s.instruct).join('')
    const content = editingMessageId || !skillPrefix ? text : skillPrefix + text
    if (!content.trim() && pendingAttachments.length === 0) return
    setSkillInvocations([])
    if (editingMessageId) {
      const editId = editingMessageId
      setEditingMessageId(null)
      await editAndResend(editId, content)
    } else {
      await sendMessage(content)
    }
    setText('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const fileToAttachment = async (file: File): Promise<Attachment> => {
    const base: Attachment = {
      name: file.name,
      path: window.lunareclipse?.getPathForFile?.(file) ?? '',
      size: file.size,
      type: file.type
    }
    if (!file.type.startsWith('image/')) return base
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(r.result as string)
        r.onerror = () => reject(r.error)
        r.readAsDataURL(file)
      })
      return { ...base, dataUrl }
    } catch {
      return base
    }
  }

  const MAX_ATTACHMENT_SIZE = 8 * 1024 * 1024 // 8MB

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_SIZE) {
        console.warn(`[drop] 文件 ${file.name} 超过 8MB 限制 (${(file.size / 1024 / 1024).toFixed(1)}MB)`)
        continue
      }
      addAttachment(await fileToAttachment(file))
    }
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    for (const file of Array.from(files)) {
      addAttachment(await fileToAttachment(file))
    }
    e.target.value = ''
  }

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (!file) continue
        if (file.size > MAX_ATTACHMENT_SIZE) {
          console.warn(`[paste] 图片超过 8MB 限制 (${(file.size / 1024 / 1024).toFixed(1)}MB)`)
          break
        }
        const att = await fileToAttachment(file)
        if (att.dataUrl) {
          const saved = await window.lunareclipse?.saveClipboardImage?.(att.dataUrl)
          if (saved?.ok && saved.path) {
            addAttachment({ ...att, path: saved.path })
          } else {
            console.error('[paste] 图片落盘失败:', saved?.error)
          }
        }
        break
      }
    }
  }

  const toggleWebSearch = () => {
    saveConfig({ ...config, webSearchEnabled: !config.webSearchEnabled })
  }

  const handleDmnAnswer = async () => {
    if (!dmnAskPrompt) return
    await answerDmnQuestion(dmnAskPrompt.dmnId, dmnAnswer.trim() || null)
    setDmnAnswer('')
  }

const currentMode = MODE_OPTIONS.find((m) => m.value === (config.aiMode ?? 'coding')) ?? MODE_OPTIONS[0]
  const t = useT()

  // 上下文计数（从 ChatArea 状态条迁入工具条）：流式时优先前端估算，否则回退 WS 推送
  const displayTokenCount = streamingTokenEstimate ?? lastTokenCount
  // 有效预算：lastTokenBudget ?? config.tokenBudget ?? 软预算兜底（与后端 SOFT_BUDGET_TOKENS 一致）
  const SOFT_BUDGET_TOKENS = 16000
  const effectiveBudget = lastTokenBudget !== null && lastTokenBudget > 0
    ? lastTokenBudget
    : configTokenBudget !== null && configTokenBudget > 0
      ? configTokenBudget
      : SOFT_BUDGET_TOKENS
  const showTokenBar = displayTokenCount !== null
  const tokenPercent = showTokenBar ? Math.min(100, (displayTokenCount! / effectiveBudget) * 100) : 0
  const tokenWarn = showTokenBar && tokenPercent > 80
  const tokenMid = showTokenBar && tokenPercent > 60 && !tokenWarn

  return (
    <div className="border-t border-border-subtle bg-bg-surface px-6 py-3">
      <div className="mx-auto max-w-3xl">
        {dmnAskPrompt && (
          <div className="mb-2 rounded-card border border-accent/30 bg-accent/5 px-4 py-3">
            <div className="mb-1 text-caption text-accent">
              DMN-{dmnAskPrompt.dmnId.replace('dmn', '')}
            </div>
            <div className="mb-2 text-body text-fg-primary">{dmnAskPrompt.question}</div>
            {dmnAskPrompt.context && (
              <div className="mb-2 text-caption text-fg-muted">{dmnAskPrompt.context}</div>
            )}
            <div className="flex items-end gap-2">
              <textarea
                value={dmnAnswer}
                onChange={(e) => setDmnAnswer(e.target.value)}
                placeholder={t('input.answerPlaceholder')}
                rows={1}
                className="max-h-[100px] flex-1 resize-none rounded-btn border border-border bg-bg-elevated px-2 py-1 text-body text-fg-primary placeholder:text-fg-muted focus:outline-none"
              />
              <button
                onClick={handleDmnAnswer}
                className="flex h-8 shrink-0 items-center rounded-btn bg-accent px-3 text-caption text-accent-fg transition-all duration-150 hover:bg-accent/80 active:scale-95"
              >
                {t('input.answer')}
              </button>
            </div>
          </div>
        )}

        {/* 编辑模式指示器 */}
        {editingMessageId && (
          <div className="mb-2 flex items-center gap-2 rounded-full border border-accent/30 bg-accent/8 px-3 py-1.5">
            <Repeat size={11} className="text-accent" />
            <span className="text-caption text-accent">{t('mode.indicator')}</span>
            <button
              onClick={() => {
                setEditingMessageId(null)
                setText('')
              }}
              className="ml-auto flex h-5 w-5 items-center justify-center rounded-full text-fg-muted hover:bg-bg-muted hover:text-fg-secondary"
              title={t('input.cancelEdit')}
            >
              <X size={11} />
            </button>
          </div>
        )}

        {/* 功能工具条：模式 + 网络搜索 + 工具配置 + 持续激活 + 权限绿通 —— 紧凑单行 */}
        <div className="relative mb-1.5 flex items-center gap-1">

          {/* 模式选择 pill */}
          <div ref={modeRef} className="relative shrink-0">
            <button
              onClick={() => setModeOpen((v) => !v)}
              className="flex items-center gap-1 rounded-full bg-bg-muted px-2 py-1 text-caption text-fg-secondary transition-all duration-150 hover:text-fg-primary active:scale-95"
              title={t('mode.title')}
            >
              <currentMode.icon size={12} className="text-fg-muted" />
              <span>{t(currentMode.labelKey)}</span>
              <ChevronDown size={10} className={`text-fg-muted transition-transform ${modeOpen ? 'rotate-180' : ''}`} />
            </button>
            {modeOpen && (
              <div className="absolute bottom-full left-0 z-30 mb-1 w-56 rounded-btn border border-border bg-bg-elevated py-1 shadow-lg">
                {MODE_OPTIONS.map((opt) => {
                  const isActive = (config.aiMode ?? 'coding') === opt.value
                  return (
                    <button
                      key={opt.value}
                      onClick={() => {
                        saveConfig({ ...config, aiMode: opt.value })
                        setModeOpen(false)
                      }}
                      className={`flex w-full items-start gap-2 px-2.5 py-2 text-left transition-colors ${
                        isActive ? 'bg-accent/10 text-accent' : 'text-fg-secondary hover:bg-bg-muted'
                      }`}
                    >
                      <opt.icon size={12} className="mt-0.5 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-caption font-medium">{t(opt.labelKey)}</span>
                          {isActive && <Check size={10} className="text-accent" />}
                        </div>
                        <div className="text-micro text-fg-muted">{t(opt.descKey)}</div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* 网络搜索 */}
          <button
            onClick={toggleWebSearch}
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-btn transition-all duration-150 active:scale-95 ${
              config.webSearchEnabled
                ? 'text-accent ring-1 ring-accent/25'
                : 'text-fg-muted hover:bg-bg-muted hover:text-fg-secondary'
            }`}
            title={config.webSearchEnabled ? t('input.webSearch.on') : t('input.webSearch.off')}
          >
            <Globe size={13} />
          </button>

          {/* 工具配置 */}
          <div className="relative shrink-0">
            <button
              onClick={() => setToolConfigOpen((v) => !v)}
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-btn transition-all duration-150 active:scale-95 ${
                toolConfigOpen
                  ? 'bg-accent/15 text-accent'
                  : 'text-fg-muted hover:bg-bg-muted hover:text-fg-secondary'
              }`}
              title={t('input.toolConfig')}
            >
              <Wrench size={13} />
            </button>
            {/* 工具配置浮层：绝对定位锚定工具图标正上方弹出（脱离文档流，不占位不顶起输入框） */}
            {toolConfigOpen && (
              <div
                ref={toolConfigRef}
                className="absolute bottom-full left-1/2 z-30 mb-1.5 w-[22rem] -translate-x-1/2 rounded-card border border-border bg-bg-elevated shadow-xl"
              >
                <ToolConfigPanel onClose={() => setToolConfigOpen(false)} />
              </div>
            )}
          </div>

          {/* 持续激活 */}
          <button
            onClick={() => toggleContinuousActivation(!continuousActivation)}
            disabled={!currentSessionId}
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-btn transition-all duration-150 active:scale-95 disabled:opacity-30 ${
              continuousActivation
                ? 'bg-accent/15 text-accent'
                : 'text-fg-muted hover:bg-bg-muted hover:text-fg-secondary'
            }`}
            title={continuousActivation ? t('input.continuous.on') : t('input.continuous.off')}
          >
            <Repeat size={13} />
          </button>

          {/* 权限绿通 */}
          <button
            onClick={() => saveConfig({ ...config, permissionGreenlight: !config.permissionGreenlight })}
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-btn transition-all duration-150 active:scale-95 ${
              config.permissionGreenlight
                ? 'bg-accent/15 text-accent'
                : 'text-fg-muted hover:bg-bg-muted hover:text-fg-secondary'
            }`}
            title={config.permissionGreenlight ? t('input.greenlight.on') : t('input.greenlight.off')}
          >
            {config.permissionGreenlight ? <ShieldCheck size={13} /> : <Shield size={13} />}
          </button>

          {/* 视图切换：普通 <-> 树块 */}
          <button
            onClick={() => setChatViewMode(chatViewMode === 'normal' ? 'tree' : 'normal')}
            disabled={!currentSessionId}
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-btn transition-all duration-150 active:scale-95 disabled:opacity-30 ${
              chatViewMode === 'tree'
                ? 'bg-accent/15 text-accent'
                : 'text-fg-muted hover:bg-bg-muted hover:text-fg-secondary'
            }`}
            title={chatViewMode === 'tree' ? t('view.tree') : t('view.chat')}
          >
            {chatViewMode === 'tree' ? <MessageSquare size={13} /> : <MessageCircle size={13} />}
          </button>

          {/* 上下文计数 pill：仅占一小块，hover 展开详情 */}
          {showTokenBar && (
            <div
              className={`group relative ml-auto flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-full px-2.5 transition-all duration-150 ${
                tokenWarn
                  ? 'bg-red-500/10 ring-1 ring-red-500/40'
                  : tokenMid
                    ? 'bg-amber-500/10 ring-1 ring-amber-500/30'
                    : 'bg-bg-muted'
              }`}
              title={lastTokenBudget !== null && lastTokenBudget > 0 ? 'Token budget' : 'Soft budget estimate'}
            >
              <span
                className={`tabular-nums text-micro font-medium ${
                  tokenWarn ? 'text-red-400' : tokenMid ? 'text-amber-400' : 'text-fg-muted'
                }`}
              >
                {(displayTokenCount! / 1000).toFixed(1)}k/{(effectiveBudget / 1000).toFixed(0)}k
                {lastTokenBudget === null && configTokenBudget === null && <span className="ml-0.5 opacity-60">*</span>}
              </span>
              {/* hover 展开详情 */}
              <div className="invisible absolute bottom-full right-0 z-30 mb-1.5 whitespace-nowrap rounded-btn border border-border bg-bg-elevated px-3 py-2 shadow-lg opacity-0 transition-all duration-150 group-hover:visible group-hover:opacity-100">
                <div className="flex items-center gap-3 text-micro text-fg-muted">
                  <span className="tabular-nums">
                    {displayTokenCount} / {effectiveBudget} token
                  </span>
                  <span className="tabular-nums">
                    {tokenPercent.toFixed(0)}%
                  </span>
                </div>
                {lastUsage && (
                  <div className="mt-1 flex items-center gap-2 text-micro text-fg-muted">
                    <span
                      title={`Input ${lastUsage.inputTokens} / Output ${lastUsage.outputTokens}${lastUsage.cacheReadTokens !== undefined ? ` / Cache ${lastUsage.cacheReadTokens}` : ''}`}
                    >
                      ↑{lastUsage.inputTokens} ↓{lastUsage.outputTokens}
                    </span>
                    {lastUsage.cacheReadTokens !== undefined && (
                      <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-emerald-400">
                        {t('token.cache')} {lastUsage.cacheReadTokens}
                      </span>
                    )}
                  </div>
                )}
                {contextWarning && (
                  <div className="mt-1 flex items-center gap-1 text-[10px] text-amber-400">
                    <span className="max-w-60 truncate">{contextWarning}</span>
                    <button
                      onClick={() => useAppStore.setState({ contextWarning: null })}
                      className="shrink-0 text-amber-400/70 hover:text-amber-400"
                      title={t('common.close')}
                    >
                      ×
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 组合框：输入栏内 chips（附件+技能，按添加顺序可移除）+ 输入框 + 语音 + 发送 —— 宽敞的输入空间 */}
        <div
          className="rounded-full border border-border bg-bg-elevated px-4 py-2"
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
        >
          {(pendingAttachments.length > 0 || skillInvocations.length > 0) && (
            <div className="mb-1.5 flex w-full flex-wrap items-center gap-1.5">
              {pendingAttachments.map((a, i) => (
                <div
                  key={`att-${i}`}
                  className="flex items-center gap-1.5 rounded-btn bg-bg-muted px-2 py-1 text-caption"
                >
                  {a.dataUrl && a.type.startsWith('image/') ? (
                    <img src={a.dataUrl} alt={a.name} className="h-8 w-8 rounded object-cover" />
                  ) : (
                    <Paperclip size={10} className="text-fg-muted" />
                  )}
                  <span className="max-w-32 truncate">{a.name}</span>
                  <button
                    onClick={() => removeAttachment(i)}
                    className="text-fg-muted hover:text-red-400"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
              {skillInvocations.map((s) => (
                <div
                  key={`skill-${s.id}`}
                  className="flex items-center gap-1.5 rounded-btn border border-accent/30 bg-accent/8 px-2 py-1 text-caption text-accent"
                >
                  <Sparkles size={11} className="shrink-0" />
                  <span className="max-w-48 truncate">{s.label}</span>
                  <button
                    onClick={() => {
                      setSkillInvocations((prev) => prev.filter((x) => x.id !== s.id))
                      textareaRef.current?.focus()
                    }}
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-secondary"
                    title={t('input.cancelSkillInvoke')}
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
          <div ref={moreRef} className="relative shrink-0">
            <button
              onClick={() => {
                setMoreOpen((v) => !v)
                if (!moreOpen) setSkillPickOpen(false)
              }}
              className={`flex h-8 w-8 items-center justify-center rounded-btn transition-all duration-150 active:scale-95 ${
                moreOpen ? 'bg-accent/20 text-accent' : 'text-fg-muted hover:bg-bg-muted hover:text-fg-secondary'
              }`}
              title={t('input.more')}
            >
              <Plus size={16} />
            </button>
            {moreOpen && (
              <div className="absolute bottom-full left-0 z-40 mb-2 w-64 overflow-hidden rounded-btn border border-border bg-bg-elevated py-1 shadow-xl">
                {!skillPickOpen ? (
                  <>
                    <button
                      onClick={() => {
                        closeMore()
                        fileInputRef.current?.click()
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-caption text-fg-secondary transition-colors hover:bg-bg-muted"
                    >
                      <Paperclip size={13} className="text-fg-muted" />
                      <span>{t('input.menu.upload')}</span>
                    </button>
                    <button
                      onClick={() => {
                        setSkillPickOpen(true)
                        void useSkillStore.getState().refresh()
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-caption text-fg-secondary transition-colors hover:bg-bg-muted"
                    >
                      <Sparkles size={13} className="text-fg-muted" />
                      <span>{t('input.menu.invokeSkill')}</span>
                    </button>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-1 border-b border-border-subtle px-2 py-1.5">
                      <button
                        onClick={() => setSkillPickOpen(false)}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-btn text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-secondary"
                        title={t('input.invokeSkill.back')}
                      >
                        <ArrowLeft size={13} />
                      </button>
                      <span className="flex-1 truncate text-caption font-medium text-fg-primary">
                        {t('input.invokeSkill.title')}
                      </span>
                      <span className="shrink-0 text-[10px] text-fg-muted">
                        {skillGroups.userSkills.length + skillGroups.orderedDomains.reduce((n, [, l]) => n + l.length, 0)} 个
                      </span>
                    </div>
                    <div className="max-h-72 overflow-y-auto">
                      {skillGroups.userSkills.length === 0 && skillGroups.orderedDomains.length === 0 && (
                        <div className="px-3 py-4 text-center text-caption text-fg-muted">
                          {t('input.invokeSkill.empty')}
                        </div>
                      )}
                      {skillGroups.userSkills.length > 0 && (
                        <div className="py-1">
                          <div className="px-3 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-fg-muted">
                            {t('input.invokeSkill.user')}
                          </div>
                          {skillGroups.userSkills.map((s) => (
                            <button
                              key={s.name}
                              onClick={() => invokeSkill([s.name])}
                              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-caption text-fg-secondary transition-colors hover:bg-bg-muted"
                            >
                              <Shield size={11} className="shrink-0 text-fg-muted" />
                              <span className="min-w-0 flex-1 truncate">{s.name}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      {skillGroups.orderedDomains.map(([domain, list]) => (
                        <div key={domain} className="py-1">
                          <div className="px-3 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-fg-muted">
                            {t('input.invokeSkill.domain')} · {domain}（{list.length}）
                          </div>
                          <button
                            onClick={() => invokeSkill(list.map((s) => s.name), domain)}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-caption text-accent transition-colors hover:bg-bg-muted"
                          >
                            <Folder size={11} className="shrink-0" />
                            <span className="min-w-0 flex-1 truncate">{t('input.invokeSkill.domainAll')}</span>
                            <ChevronRight
                              size={11}
                              className={`shrink-0 transition-transform ${expandedDomain === domain ? 'rotate-90' : ''}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                setExpandedDomain(expandedDomain === domain ? null : domain)
                              }}
                            />
                            <span className="sr-only">{t('input.invokeSkill.expand')}</span>
                          </button>
                          {expandedDomain === domain &&
                            list.map((s) => (
                              <button
                                key={s.name}
                                onClick={() => invokeSkill([s.name])}
                                className="flex w-full items-center gap-2 py-1.5 pl-7 pr-3 text-left text-caption text-fg-secondary transition-colors hover:bg-bg-muted"
                              >
                                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                                <span className="shrink-0 text-fg-muted">{t('input.invokeSkill.invoke')}</span>
                              </button>
                            ))}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />
          <textarea
            ref={textareaRef}
            id="chat-input-area"
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              autoResize()
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={t('input.placeholder')}
            rows={1}
            className="max-h-[64px] min-h-[40px] flex-1 resize-none overflow-y-auto bg-transparent py-2 leading-relaxed text-body text-fg-primary placeholder:text-fg-muted focus:outline-none"
            style={{ caret: 'text' }}
          />
          {/* 语音工具 */}
          <div className="flex shrink-0 items-center gap-1">
            {asrSupported && (
              <button
                onClick={toggleASR}
                className={`flex h-8 w-8 items-center justify-center rounded-btn transition-all duration-150 active:scale-95 ${
                  asrActive ? 'bg-accent/20 text-accent' : 'text-fg-muted hover:bg-bg-muted hover:text-fg-secondary'
                }`}
                title={asrActive ? t('input.asr.stop') : t('input.asr.start')}
              >
                {asrActive ? <Mic size={14} /> : <MicOff size={14} />}
              </button>
            )}
            {ttsSupported && (
              <button
                onClick={() => setTtsEnabled((v) => !v)}
                className={`flex h-8 w-8 items-center justify-center rounded-btn transition-all duration-150 active:scale-95 ${
                  ttsEnabled ? 'bg-accent/20 text-accent' : 'text-fg-muted hover:bg-bg-muted hover:text-fg-secondary'
                }`}
                title={ttsEnabled ? t('input.tts.on') : t('input.tts.off')}
              >
                {ttsEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
              </button>
            )}
          </div>
          {isStreaming ? (
            <>
              <button
                onClick={abortStream}
                className="flex h-8 shrink-0 items-center gap-1.5 rounded-btn bg-red-500/15 px-3 text-caption text-red-400 transition-all duration-150 hover:bg-red-500/25 active:scale-95"
                title={t('input.abort')}
              >
                <Square size={12} />
                <span>{t('input.stop')}</span>
              </button>
              <button
                onClick={handleSend}
                disabled={!text.trim() && pendingAttachments.length === 0 && skillInvocations.length === 0}
                className="flex h-8 shrink-0 items-center gap-1.5 rounded-btn bg-accent px-3 text-caption text-accent-fg transition-all duration-150 hover:bg-accent/80 active:scale-95 disabled:opacity-30"
                title={t('input.interruptTitle')}
              >
                <Send size={12} />
                <span>{t('input.interrupt')}</span>
              </button>
            </>
          ) : (
            <button
              onClick={handleSend}
              disabled={!text.trim() && pendingAttachments.length === 0 && skillInvocations.length === 0}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-btn bg-accent px-3 text-caption text-accent-fg transition-all duration-150 hover:bg-accent/80 active:scale-95 disabled:opacity-30"
              title={t('input.sendTitle')}
            >
              <Send size={12} />
              <span>{t('input.send')}</span>
            </button>
          )}
        </div>
        </div>
      </div>
    </div>
  )
}
