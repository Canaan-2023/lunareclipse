// 为什么存在：语音输入/输出用浏览器原生 Web Speech API 即可覆盖，无需后端依赖，
// 降成本零配置；渲染进程内完成，配合输入区/小窗的语音按钮使用。
// 作用：语音服务——封装 ASR（语音识别）与 TTS（语音合成）：
// isASRSupported/isTTSSupported、ASRController、TTSController。
// 基于浏览器 Web Speech API 实现 ASR（语音识别）和 TTS（语音合成）
// 不依赖后端，全部在渲染进程完成

type SpeechRecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
}

function getRecognitionCtor(): { new (): SpeechRecognitionLike } | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: { new (): SpeechRecognitionLike }
    webkitSpeechRecognition?: { new (): SpeechRecognitionLike }
  }
  return w.SpeechRecognition || w.webkitSpeechRecognition || null
}

export function isASRSupported(): boolean {
  return getRecognitionCtor() !== null
}

export function isTTSSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

export interface ASRHandlers {
  onInterim?: (text: string) => void
  onFinal: (text: string) => void
  onError?: (err: string) => void
  onEnd?: () => void
}

export class ASRController {
  private recognition: SpeechRecognitionLike | null = null
  private listening = false
  private handlers: ASRHandlers

  constructor(handlers: ASRHandlers) {
    this.handlers = handlers
  }

  start(lang = 'zh-CN'): boolean {
    const Ctor = getRecognitionCtor()
    if (!Ctor) {
      this.handlers.onError?.('浏览器不支持语音识别')
      return false
    }
    if (this.listening) return true
    const rec = new Ctor()
    rec.lang = lang
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = (event) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i]
        const transcript = r[0].transcript
        if (r.isFinal) {
          this.handlers.onFinal(transcript)
        } else {
          interim += transcript
        }
      }
      if (interim && this.handlers.onInterim) {
        this.handlers.onInterim(interim)
      }
    }
    rec.onerror = (e) => {
      this.handlers.onError?.(e.error)
    }
    rec.onend = () => {
      this.listening = false
      this.handlers.onEnd?.()
    }
    try {
      rec.start()
      this.recognition = rec
      this.listening = true
      return true
    } catch (err) {
      this.handlers.onError?.((err as Error).message)
      return false
    }
  }

  stop(): void {
    if (!this.recognition || !this.listening) return
    try {
      this.recognition.stop()
    } catch {
      // 忽略
    }
    this.listening = false
  }

  abort(): void {
    if (!this.recognition) return
    try {
      this.recognition.abort()
    } catch {
      // 忽略
    }
    this.listening = false
  }

  isListening(): boolean {
    return this.listening
  }
}

export interface TTSOptions {
  rate?: number  // 0.1 - 10，默认 1
  pitch?: number // 0 - 2，默认 1
  volume?: number // 0 - 1，默认 1
  lang?: string
  voice?: SpeechSynthesisVoice
}

// TTS 流式播报：token 边生成边播报，可随时打断
export class TTSController {
  private synth: SpeechSynthesis | null = null
  private queue: string[] = []
  private speaking = false
  private stopped = false
  private currentUtterance: SpeechSynthesisUtterance | null = null
  private opts: TTSOptions = {}

  constructor() {
    if (isTTSSupported()) {
      this.synth = window.speechSynthesis
    }
  }

  setOptions(opts: TTSOptions): void {
    this.opts = { ...this.opts, ...opts }
  }

  // 入队文本（流式时按短语/短句切片增量入队：句+逗+顿+分号都切，
  // 让 AI 输出"半句"即开始朗读，更实时跟手）
  enqueue(text: string): void {
    if (!this.synth || !text) return
    const chunks = text.match(/[^，。！？!?；;、\n]+[，。！？!?；;、\n]?/g) || [text]
    let buf = ''
    for (const c of chunks) {
      if (!c.trim()) continue
      // 短短语聚簇：把连续多个小 chunk 合成一个 utterance 再入队，减少 SpeechSynthesis 频繁 speak 的毛刺（流畅）
      buf += c
      if (buf.length >= 6) {
        this.queue.push(buf)
        buf = ''
      }
    }
    if (buf.trim()) this.queue.push(buf)
    if (!this.speaking) {
      this.stopped = false
      this.pump()
    }
  }

  // 立即停止并清空队列
  stop(): void {
    this.stopped = true
    this.queue = []
    if (this.synth && this.speaking) {
      this.synth.cancel()
    }
    this.speaking = false
    this.currentUtterance = null
  }

  isSpeaking(): boolean {
    return this.speaking
  }

  private pump(): void {
    if (!this.synth) return
    if (this.stopped) return
    const next = this.queue.shift()
    if (!next) {
      this.speaking = false
      this.currentUtterance = null
      return
    }
    const u = new SpeechSynthesisUtterance(next)
    if (this.opts.rate !== undefined) u.rate = this.opts.rate
    if (this.opts.pitch !== undefined) u.pitch = this.opts.pitch
    if (this.opts.volume !== undefined) u.volume = this.opts.volume
    if (this.opts.lang) u.lang = this.opts.lang
    if (this.opts.voice) u.voice = this.opts.voice
    u.onend = () => {
      this.currentUtterance = null
      this.pump()
    }
    u.onerror = () => {
      this.currentUtterance = null
      this.pump()
    }
    this.currentUtterance = u
    this.speaking = true
    this.synth.speak(u)
  }
}
