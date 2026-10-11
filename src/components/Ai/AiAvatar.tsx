/**
 * 为什么存在：AI 与用户的头像标识需支持 emoji/本地图片/暂存 dataURL 三种形态，
 * 且创建/编辑表单与个人中心都要用，抽成共用组件避免各面板自实现。
 * @category 多 AI 子系统
 * @summary 通用头像渲染与选择（AI / 用户共用）。

 * avatar 标识三种形态：
 * - emoji 短文本（如 '🦊'）：直接文本渲染（圆形容器）
 * - img:avatars/ai/{id}/avatar.png（ai:saveAvatarImage 落盘后写回）：经
 * lune-media:// 协议加载本地图片（media-protocol 放行 avatars/ 前缀）
 * - data:...（创建表单暂存预览，提交后由父级保存为 img: 引用再落库）

 * 组件：
 * - AiAvatar：只读渲染（<img> 或 emoji 圆形兜底）
 * - AvatarPicker：头像编辑器（默认图标集 + 本地图片上传 + 清除），
 * 供 AI 创建/编辑表单与个人中心复用。
 */
import { useState, useRef } from 'react'
import { ImagePlus, Trash2, Loader2 } from 'lucide-react'
import { DEFAULT_AI_ID, LILITH_AI_ID } from '@shared/types'
import { useT } from '../../i18n/useT'

/** 默认头像图标集（内置可选，不落图片文件） */
export const AI_AVATAR_CHOICES = ['✨', '🌙', '🦊', '🐱', '🐉', '🌸', '⚡', '🌿', '🌟', '🐺', '🍀', '🌺']

/** 默认头像兜底：系统月蚀=1 🌙、系统莉莉丝=2 💗、其余 🤖（头像选择/会话头/新建选择器共用，口径统一） */
export function aiAvatarFallback(aiId: number | undefined): string {
  return aiId === DEFAULT_AI_ID ? '🌙' : aiId === LILITH_AI_ID ? '💗' : '🤖'
}

/** img: 前缀 → lune-media:// 媒体 URL（无前缀返回 null） */
export function aiAvatarToMediaUrl(avatar: string | undefined | null): string | null {
  if (!avatar || !avatar.startsWith('img:')) return null
  const rel = avatar.slice(4).replace(/^\/+/, '')
  if (!rel) return null
  return `lune-media:///${rel}`
}

/**
 * 头像渲染：本地图片（lune-media:// 或 data: 预览）优先，emoji / 文本兜底。
 * @param avatar avatar 标识（emoji / img: 引用 / data: 预览）
 * @param fallback 无 avatar 时兜底文本（emoji）
 * @param className 容器/图片样式（继承调用方尺寸与圆角，如 "h-6 w-6 text-sm"）
 * @param title 悬停提示
 */
export function AiAvatar({
  avatar,
  fallback,
  className = '',
  title,
}: {
  avatar?: string | null
  fallback?: string
  className?: string
  title?: string
}) {
  const [broken, setBroken] = useState(false)
  const media = aiAvatarToMediaUrl(avatar)
  const isDataUrl = avatar?.startsWith('data:') ?? false
  const base = `shrink-0 overflow-hidden rounded-full ${className}`
  const src = media ?? (isDataUrl ? avatar : null)
  // 非图片引用的短文本（emoji）才可作文字兜底；img:/data: 引用失效时回退 fallback，不渲染原始路径字符串
  const hasEmoji = !!avatar && !avatar.startsWith('img:') && !avatar.startsWith('data:')

  if (src && !broken) {
    return (
      <img
        src={src}
        alt=""
        title={title}
        draggable={false}
        onError={() => setBroken(true)}
        className={`${base} object-cover`}
      />
    )
  }
  return (
    <div className={`flex items-center justify-center bg-accent/10 ${base}`} title={title}>
      <span className="leading-none">{hasEmoji ? avatar : (fallback ?? '🤖')}</span>
    </div>
  )
}

/**
 * 头像选择器：当前预览 + 内置图标集 + 本地图片上传 + 清除。
 * @param avatar 当前值（emoji / img: 引用 / data: 预览 / 空）
 * @param onChange 变更回调（emoji 文本 / img: 引用 / ''=清除）
 * @param saveImage 本地图片 dataURL → img: 引用（null=失败）；不传时选中图片仅以 data: 预览回传 onChange，由父级提交后落盘
 * @param label 预览空态文案（一般传默认 emoji）
 */
export function AvatarPicker({
  avatar,
  onChange,
  saveImage,
  label,
}: {
  avatar?: string
  onChange: (v: string) => void
  saveImage?: (dataUrl: string) => Promise<string | null>
  label?: string
}) {
  const t = useT()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) {
      setErr(t('ai.avatarTypeError'))
      return
    }
    if (file.size > 4 * 1024 * 1024) {
      setErr(t('ai.avatarSizeError'))
      return
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.onerror = () => reject(new Error('read failed'))
      r.readAsDataURL(file)
    })
    if (!saveImage) {
      // 无保存能力（如创建表单未落库）：仅预览，提交时由父级处理
      onChange(dataUrl)
      return
    }
    setErr(null)
    setBusy(true)
    try {
      const ref = await saveImage(dataUrl)
      if (ref) onChange(ref)
      else setErr(t('ai.avatarSaveFail'))
    } catch {
      setErr(t('ai.avatarSaveFail'))
    } finally {
      setBusy(false)
    }
  }

  const media = aiAvatarToMediaUrl(avatar)
  const isDataUrl = avatar?.startsWith('data:') ?? false
  const previewSrc = media ?? (isDataUrl ? avatar : null)

  return (
    <div>
      <div className="flex items-center gap-2">
        {/* 当前预览 */}
        {previewSrc ? (
          <img
            src={previewSrc}
            alt=""
            className={`h-8 w-8 shrink-0 overflow-hidden rounded-full object-cover ${busy ? 'opacity-50' : ''}`}
          />
        ) : (
          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-base ${busy ? 'opacity-50' : ''}`}>
            <span className="leading-none">{avatar?.trim() ? avatar : ((label ?? '') || '🤖')}</span>
          </div>
        )}
        {/* 上传本地图片 */}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="flex h-7 items-center gap-1 rounded-btn border border-border-subtle px-2 text-caption text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary disabled:opacity-40"
          title={t('ai.avatarUpload')}
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <ImagePlus size={11} />}
          {t('ai.avatarUpload')}
        </button>
        {/* 清除头像：还原为空（回退默认） */}
        {avatar && (
          <button
            type="button"
            onClick={() => onChange('')}
            className="flex h-7 w-7 items-center justify-center rounded-btn border border-border-subtle text-fg-muted transition-colors hover:bg-bg-muted hover:text-red-400"
            title={t('ai.avatarClear')}
            aria-label={t('ai.avatarClear')}
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(e) => void onFile(e)}
      />
      {/* 内置图标集 */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {AI_AVATAR_CHOICES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChange(avatar === c ? '' : c)}
            className={`flex h-7 w-7 items-center justify-center rounded-btn text-sm transition-all ${
              avatar === c ? 'bg-accent/20 ring-1 ring-inset ring-accent/40' : 'bg-bg-muted hover:bg-bg-base'
            }`}
            title={c}
          >
            {c}
          </button>
        ))}
      </div>
      {err && <div className="mt-1 text-caption text-red-400">{err}</div>}
    </div>
  )
}