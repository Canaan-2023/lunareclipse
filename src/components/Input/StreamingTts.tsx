/**
 * 为什么存在：TTS 需要在流式期间逐字取出「正在流式的那条消息」的新增内容。
 * 该订阅若留在 InputArea 里，输入框会随每条 token 重渲染；独立成无渲染组件后，
 * 重渲染只发生在这一个空组件上，输入框主体不受影响。
 * 作用：按 streamingMessageId 选取流式消息正文，只把新增片段送入 TTS 队列。
 */
import { useEffect, useRef } from 'react'
import { useAppStore } from '../../stores/appStore'
import { TTSController } from '../../services/voice'

export function StreamingTts({ enabled, supported }: { enabled: boolean; supported: boolean }) {
  // 只选取正在流式的那条消息的正文（字符串），内容变化时才触发本组件重渲染。
  const streamingContent = useAppStore((s) => {
    if (!enabled || !s.streamingMessageId) return ''
    return s.currentMessages.find((m) => m.id === s.streamingMessageId)?.content ?? ''
  })
  const streamingMessageId = useAppStore((s) => s.streamingMessageId)

  const ttsRef = useRef<TTSController | null>(null)
  const lastSpokenLenRef = useRef(0)

  useEffect(() => {
    if (!supported) return
    if (!ttsRef.current) {
      ttsRef.current = new TTSController()
    }
    if (!enabled) {
      ttsRef.current.stop()
      lastSpokenLenRef.current = 0
    }
  }, [enabled, supported])

  // 流结束（消息 id 清空）时重置已朗读长度，下一轮从 0 开始
  useEffect(() => {
    if (!streamingMessageId) lastSpokenLenRef.current = 0
  }, [streamingMessageId])

  useEffect(() => {
    if (!supported || !enabled) return
    if (streamingContent.length > lastSpokenLenRef.current) {
      const delta = streamingContent.slice(lastSpokenLenRef.current)
      lastSpokenLenRef.current = streamingContent.length
      ttsRef.current?.enqueue(delta)
    }
  }, [streamingContent, enabled, supported])

  useEffect(() => {
    return () => {
      ttsRef.current?.stop()
    }
  }, [])

  return null
}
