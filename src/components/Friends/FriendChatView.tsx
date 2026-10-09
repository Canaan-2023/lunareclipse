/**
 * 为什么存在：真人好友私聊是好友面板的主交互视图，AI 代聊开关与删除好友等
 * 操作都在此层，独立视图承载（批次 E-5a 拆分产物）。
 * 作用：渲染私聊视图——消息流（含 AI 代聊标识、邀请制文件传输卡片）与输入框
 * （含发送文件/文件夹按钮）、AI 代聊开关、删除好友等操作。
 * 邀请制直传：发送方点击文件/文件夹按钮 → 只发邀请信封；对方同意后本端推流，
 * 卡片按 state 流转（等待/同意/发送中/完成/拒绝/撤回/失败）。
 */
import { ArrowLeft, MessageSquare, X, Trash2, Send, RefreshCw, Bot, Paperclip, FolderOpen, Folder, FileText, Check, FolderSearch, XCircle } from 'lucide-react'
import type { RefObject } from 'react'
import type { TFunc } from '../../i18n/useT'
import type { FriendItem, FriendMsg } from './types'
import { FOCUS } from './types'
import { autoGrow, formatBubbleTime, formatBytes } from './utils'
import { DEFAULT_AI_ID } from '@shared/types'

/** 传输进度快照（文件夹逐文件上报；单文件不细分） */
export interface FileProgress {
  doneBytes: number
  totalBytes: number
  doneFiles: number
  totalFiles: number
}

interface FriendChatViewProps {
  contact: FriendItem
  myUid: number
  messages: FriendMsg[]
  aiReplyOn: boolean
  sending: boolean
  /** 文件邀请操作进行中（dialog 打开/同意/拒绝/撤回防重） */
  fileBusy: boolean
  /** transferId → 传输进度（瞬态，终态由消息卡片呈现） */
  progress: Record<string, FileProgress>
  draft: string
  onDraftChange: (v: string) => void
  busyUids: number[]
  onBack: () => void
  onClose: () => void
  onToggleAiReply: () => void
  onRemove: (uid: number) => void
  onSend: () => void
  onInviteFile: (mode: 'file' | 'dir') => void
  onAcceptFile: (uid: number, transferId: string) => void
  onRejectFile: (uid: number, transferId: string) => void
  onCancelFile: (uid: number, transferId: string) => void
  onSwitchToRelay: (uid: number, transferId: string) => void
  onOpenFileLocation: (uid: number, transferId: string) => void
  listRef: RefObject<HTMLDivElement | null>
  inputRef: RefObject<HTMLTextAreaElement | null>
  t: TFunc
}

/** 邀请卡片：状态徽标 + 进度条 + 按状态/收发方给出操作按钮 */
function FileInviteCard({
  m,
  isMine,
  fileBusy,
  progress,
  onAcceptFile,
  onRejectFile,
  onCancelFile,
  onSwitchToRelay,
  onOpenFileLocation,
  t,
}: {
  m: FriendMsg
  isMine: boolean
  fileBusy: boolean
  progress: Record<string, FileProgress>
  onAcceptFile: (uid: number, transferId: string) => void
  onRejectFile: (uid: number, transferId: string) => void
  onCancelFile: (uid: number, transferId: string) => void
  onSwitchToRelay: (uid: number, transferId: string) => void
  onOpenFileLocation: (uid: number, transferId: string) => void
  t: TFunc
}) {
  const file = m.file
  if (!file) return null
  const state = file.state ?? 'pending'
  // 对端 uid：己方发出的消息发往 m.to，收到的消息来自 m.from
  const peerUid = isMine ? m.to : m.from
  const prog = progress[file.transferId]
  const isDir = file.kind === 'dir'
  const doneText =
    prog && file.size > 0 && (isDir ? prog.totalFiles > 0 : true)
      ? isDir
        ? t('friend.fileProgress', { doneFiles: prog.doneFiles, totalFiles: prog.totalFiles })
        : t('friend.fileBytes', { done: formatBytes(prog.doneBytes), total: formatBytes(prog.totalBytes) })
      : null
  const pct =
    prog && file.size > 0
      ? isDir && prog.totalFiles > 0
        ? Math.round((prog.doneFiles / prog.totalFiles) * 100)
        : Math.min(100, Math.round((prog.doneBytes / file.size) * 100))
      : 0

  return (
    <div className="w-[250px] max-w-full">
      <div className="flex items-center gap-2">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-card bg-accent/10 text-accent">
          {isDir ? <Folder size={16} /> : <FileText size={16} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-caption font-medium">{file.name}</div>
          <div className="mt-0.5 flex items-center gap-1 text-[9px] text-fg-muted">
            {isDir ? t('friend.dirInvite') : t('friend.fileInvite')}
            {' · '}
            {isDir ? t('friend.fileDirCount', { files: file.files ?? 0, dirs: file.dirs ?? 0 }) : formatBytes(file.size ?? 0)}
          </div>
        </div>
      </div>

      {/* 状态行 */}
      <div className="mt-2">
        {/* 接收方：待同意 → 操作按钮 */}
        {!isMine && state === 'pending' && (
          <div className="flex items-center gap-1.5">
            <button
              disabled={fileBusy}
              onClick={() => onAcceptFile(peerUid, file.transferId)}
              className={`flex h-6 flex-1 items-center justify-center gap-1 rounded-btn bg-accent/15 text-[10px] text-accent hover:bg-accent/25 disabled:opacity-40 ${FOCUS}`}
            >
              <Check size={11} />
              {t('friend.fileAccept')}
            </button>
            <button
              disabled={fileBusy}
              onClick={() => onRejectFile(peerUid, file.transferId)}
              className={`flex h-6 flex-1 items-center justify-center gap-1 rounded-btn border border-border-subtle text-[10px] text-fg-secondary hover:bg-bg-muted disabled:opacity-40 ${FOCUS}`}
            >
              <X size={11} />
              {t('friend.fileReject')}
            </button>
          </div>
        )}
        {/* 发送方：待同意 → 等待徽标 + 改用中继 + 撤回 */}
        {isMine && state === 'pending' && (
          <div className="flex items-center justify-between gap-1.5">
            <span className="flex items-center gap-1 text-[10px] text-fg-muted">
              <RefreshCw size={10} className="animate-spin" />
              {t('friend.fileWaiting')}
            </span>
            <div className="flex items-center gap-1">
              {/* 直传不可达等待时：可改走中继线路（对方仍在中继面板确认后领取，符合同意制） */}
              <button
                disabled={fileBusy}
                onClick={() => onSwitchToRelay(peerUid, file.transferId)}
                className={`flex h-6 items-center gap-1 rounded-btn px-1.5 text-[10px] text-accent hover:bg-accent/15 disabled:opacity-40 ${FOCUS}`}
                title={t('friend.useRelay')}
              >
                <Send size={10} />
                {t('friend.useRelay')}
              </button>
              <button
                disabled={fileBusy}
                onClick={() => onCancelFile(peerUid, file.transferId)}
                className={`flex h-6 items-center gap-1 rounded-btn px-1.5 text-[10px] text-fg-muted hover:bg-bg-muted hover:text-danger disabled:opacity-40 ${FOCUS}`}
              >
                <XCircle size={10} />
                {t('friend.fileCancel')}
              </button>
            </div>
          </div>
        )}
        {/* 传输中：进度条 + 计数 */}
        {state === 'accepted' && (
          <div>
            <div className="flex items-center justify-between gap-2 text-[9px] text-fg-muted">
              <span className="flex items-center gap-1">
                <RefreshCw size={9} className="animate-spin" />
                {isMine ? t('friend.fileSending') : t('friend.fileDownloading')}
              </span>
              {doneText && <span>{doneText}</span>}
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-bg-base">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.max(4, pct)}%` }} />
            </div>
          </div>
        )}
        {/* 完成：接收方显示打开位置 */}
        {state === 'done' && (
          <div className="flex items-center justify-between gap-1.5">
            <span className="flex items-center gap-1 text-[10px] text-success">
              <Check size={10} />
              {t('friend.fileDone')}
            </span>
            {!isMine && (
              <button
                onClick={() => onOpenFileLocation(peerUid, file.transferId)}
                className={`flex h-6 items-center gap-1 rounded-btn px-1.5 text-[10px] text-accent hover:bg-accent/15 ${FOCUS}`}
              >
                <FolderSearch size={10} />
                {t('friend.fileOpenLocation')}
              </button>
            )}
          </div>
        )}
        {/* 拒绝/撤回/失败徽标 */}
        {state === 'rejected' && (
          <span className="flex items-center gap-1 text-[10px] text-fg-muted">
            <X size={10} />
            {t('friend.fileRejected')}
          </span>
        )}
        {state === 'canceled' && (
          <span className="flex items-center gap-1 text-[10px] text-fg-muted">
            <X size={10} />
            {t('friend.fileCanceled')}
          </span>
        )}
        {state === 'failed' && (
          <div className="flex items-center justify-between gap-1.5">
            <div className="flex min-w-0 items-center gap-1 text-[10px] text-danger" title={file.error}>
              <X size={10} className="shrink-0" />
              <span className="truncate">{t('friend.fileFailed')}</span>
            </div>
            {/* 直传失败：一键改走中继线路重发（对方确认后由中继下发，符合同意制） */}
            {isMine && (
              <button
                disabled={fileBusy}
                onClick={() => onSwitchToRelay(peerUid, file.transferId)}
                className={`flex h-6 shrink-0 items-center gap-1 rounded-btn px-1.5 text-[10px] text-accent hover:bg-accent/15 disabled:opacity-40 ${FOCUS}`}
                title={t('friend.useRelay')}
              >
                <Send size={10} />
                {t('friend.useRelay')}
              </button>
            )}
          </div>
        )}
        {/* 已改用中继发送：中转端已收下文件，对方在传输面板确认后领取 */}
        {state === 'relayed' && (
          <div className="flex items-center gap-1 text-[10px] text-accent">
            <Send size={10} />
            {isMine ? t('friend.relayedSent') : t('friend.relayedReceived')}
          </div>
        )}
      </div>
    </div>
  )
}

/** 好友面板 · 私聊视图（受控组件，状态不下放） */
export function FriendChatView({
  contact,
  myUid,
  messages,
  aiReplyOn,
  sending,
  fileBusy,
  progress,
  draft,
  onDraftChange,
  busyUids,
  onBack,
  onClose,
  onToggleAiReply,
  onRemove,
  onSend,
  onInviteFile,
  onAcceptFile,
  onRejectFile,
  onCancelFile,
  onSwitchToRelay,
  onOpenFileLocation,
  listRef,
  inputRef,
  t,
}: FriendChatViewProps) {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-surface">
      {/* 头部 */}
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5 text-caption font-medium text-fg-secondary">
          <button
            onClick={onBack}
            className={`flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary ${FOCUS}`}
            title={t('friend.back')}
            aria-label={t('friend.back')}
          >
            <ArrowLeft size={12} />
          </button>
          <MessageSquare size={13} className="shrink-0 text-accent" />
          <span className="truncate">{contact.备注 || contact.昵称}</span>
          {contact.online && <span className="shrink-0 text-[9px] text-success">{t('friend.online')}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* AI 代聊开关：本机 AI 自动回复该好友 */}
          <button
            onClick={() => void onToggleAiReply()}
            className={`flex h-6 items-center gap-1 rounded-btn px-1.5 text-[10px] transition-colors ${FOCUS} ${
              aiReplyOn ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:bg-bg-muted hover:text-fg-secondary'
            }`}
            title={t('friend.aiReplyHint')}
            aria-label={t('friend.aiReply')}
            aria-pressed={aiReplyOn}
          >
            <Bot size={12} />
            {t('friend.aiReply')}
          </button>
          <button
            onClick={() => void onRemove(contact.uid)}
            disabled={busyUids.includes(contact.uid)}
            className={`flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-danger disabled:opacity-40 ${FOCUS}`}
            title={t('friend.remove')}
            aria-label={t('friend.remove')}
          >
            <Trash2 size={11} />
          </button>
          <button
            onClick={onClose}
            className={`flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary ${FOCUS}`}
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* AI 代聊提示 */}
      {aiReplyOn && (
        <div className="border-b border-border-subtle bg-accent/5 px-3 py-1.5 text-[10px] text-accent">
          {t('friend.aiReplyHint')}
        </div>
      )}

      {/* 消息区 */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-2.5" aria-live="polite" aria-atomic="false">
        {messages.length === 0 ? (
          <div className="px-3 py-8 text-center text-caption text-fg-muted">{t('friend.noMessages')}</div>
        ) : (
          messages.map((m) => {
            // 本机 uid 已知：from === 本机 uid 即为己方消息
            const isMine = m.from === myUid
            return (
              <div key={m.id} className={`mb-2 flex ${isMine ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[min(78%,360px)] rounded-card px-2.5 py-1.5 text-caption ${
                    isMine
                      ? 'bg-accent/15 text-fg-primary'
                      : 'border border-border-subtle bg-bg-elevated text-fg-primary'
                  }`}
                >
{m.file ? (
                    <FileInviteCard
                      m={m}
                      isMine={isMine}
                      fileBusy={fileBusy}
                      progress={progress}
                      onAcceptFile={onAcceptFile}
                      onRejectFile={onRejectFile}
                      onCancelFile={onCancelFile}
                      onSwitchToRelay={onSwitchToRelay}
                      onOpenFileLocation={onOpenFileLocation}
                      t={t}
                    />
                  ) : (
                    <div className="whitespace-pre-wrap break-words">{m.text}</div>
                  )}
                  <div className={`mt-0.5 flex items-center gap-1 text-[9px] ${isMine ? 'justify-end text-fg-muted/70' : 'text-fg-muted'}`}>
                    {m.isAiGenerated && (
                      <span className="rounded bg-accent/15 px-1 text-[8px] text-accent">
                        AI {m.from}-{m.aiId ?? DEFAULT_AI_ID}
                      </span>
                    )}
                    <span>{formatBubbleTime(m.ts)}</span>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>

{/* 输入区 */}
      <div className="flex items-end gap-1.5 border-t border-border-subtle p-2">
        {/* 邀请制直传入口：只发邀请信封，不占聊天通道；对方离线自动补投 */}
        <button
          onClick={() => onInviteFile('file')}
          disabled={fileBusy}
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`}
          title={t('friend.sendFile')}
          aria-label={t('friend.sendFile')}
        >
          <Paperclip size={13} />
        </button>
        <button
          onClick={() => onInviteFile('dir')}
          disabled={fileBusy}
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`}
          title={t('friend.sendDir')}
          aria-label={t('friend.sendDir')}
        >
          <FolderOpen size={13} />
        </button>
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          onChange={(e) => { onDraftChange(e.target.value); autoGrow(e.currentTarget) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void onSend() } }}
          placeholder={t('friend.messagePlaceholder')}
          className="max-h-[120px] min-h-[36px] min-w-0 flex-1 resize-none rounded-btn border border-border-subtle bg-bg-base px-2.5 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
        />
        <button
          onClick={() => void onSend()}
          disabled={sending || !draft.trim()}
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-btn bg-accent/15 text-accent hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`}
          title={t('input.send')}
          aria-label={t('input.send')}
        >
          {sending ? <RefreshCw size={12} className="animate-spin" /> : <Send size={12} />}
        </button>
      </div>
    </div>
  )
}