/**
 * 莉莉丝情绪指令——工具函数（供莉莉丝回复链路消费，工具实现已迁到 bundled/lilith 插件）

 * 链路：插件 lilith_emotion 工具写入一次性情绪指令（{root}/.lilith_emotion.json，5 分钟过期）
 * → generateLilithReply 读取本模块 consumeLilithEmotion 注入 systemPrompt
 * → 莉莉丝按情绪回复 → clearLilithEmotion 清理

 * 注意：路径必须与插件 tools.js 的 lilithEmotionPath 保持一致（{root}/.lilith_emotion.json）。
 */
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'

/** 情绪指令文件（莉莉丝回复时读取消费） */
export function lilithEmotionPath(dataRoot: string): string {
  return join(dataRoot, '.lilith_emotion.json')
}

/** 读取并消费情绪指令（一次性；过期作废） */
export function consumeLilithEmotion(dataRoot: string): { emotion?: string; animation?: string; reason?: string } | null {
  try {
    const file = lilithEmotionPath(dataRoot)
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      emotion?: string
      animation?: string
      reason?: string
      expiresAt: number
    }
    // 过期作废
    if (Date.now() > parsed.expiresAt) {
      try {
        // 避免写 '{}' 占位文件残留
        // 过期指令直接删文件，语义与「一次性」一致。
        unlinkSync(file)
      } catch {
        /* 忽略 */
      }
      return null
    }
    return { emotion: parsed.emotion, animation: parsed.animation, reason: parsed.reason }
  } catch {
    return null
  }
}

/** 清除情绪指令（消费后） */
export function clearLilithEmotion(dataRoot: string): void {
  try {
    unlinkSync(lilithEmotionPath(dataRoot))
  } catch {
    /* 忽略（文件可能已被删/不存在） */
  }
}
