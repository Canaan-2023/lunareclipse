/**
 * @category ROOM
 * @summary 全屏采集（多显示器）：逐显示器截图并落盘
 *
 * 为什么存在：既有 `system-input.captureScreen()` **只取主屏**（`sources.find(display_id === primary)`），
 * 多显示器用户看不到副屏内容。用户要求采集桌面时覆盖全部屏幕。
 *
 * 不删理由：删掉即多屏环境下 AI 只能看到一块屏，桌面采集形同残废。
 *
 * 边界：只做「逐屏截图 + 落盘 + 返回路径/尺寸」，不做图像理解（AI 用 read 读图）。
 * 采集失败逐屏降级（某块屏失败不影响其它屏）。
 */
import { desktopCapturer, screen } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

export interface ScreenShot {
  /** 显示器 id（Electron display.id 的字符串形式） */
  displayId: string
  /** 是否主屏 */
  primary: boolean
  path?: string
  width?: number
  height?: number
  error?: string
}

/**
 * 采集全部显示器。
 * @param shotDir 落盘目录（调用方传 `join(app.getPath('userData'), 'system-shots')`）
 */
export async function captureAllScreens(shotDir: string): Promise<ScreenShot[]> {
  let displays: Array<{ id: number; size: { width: number; height: number }; primary: boolean }> = []
  try {
    const primaryId = screen.getPrimaryDisplay().id
    displays = screen.getAllDisplays().map((d) => ({
      id: d.id,
      size: { width: Math.round(d.size.width), height: Math.round(d.size.height) },
      primary: d.id === primaryId
    }))
  } catch {
    return []
  }
  if (displays.length === 0) return []

  let sources: Awaited<ReturnType<typeof desktopCapturer.getSources>> = []
  try {
    // 取最大屏尺寸作为缩略图上限，保证任一屏都不被降采样到更小
    const maxW = Math.max(...displays.map((d) => d.size.width), 1920)
    const maxH = Math.max(...displays.map((d) => d.size.height), 1080)
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: maxW, height: maxH } })
  } catch {
    return displays.map((d) => ({ displayId: String(d.id), primary: d.primary, error: '屏幕源获取失败' }))
  }

  const out: ScreenShot[] = []
  for (const d of displays) {
    const src =
      sources.find((s) => s.display_id === String(d.id)) ?? (d.primary ? sources[0] : undefined)
    if (!src || !src.thumbnail) {
      out.push({ displayId: String(d.id), primary: d.primary, error: '未获取到该屏图像' })
      continue
    }
    try {
      const img = src.thumbnail
      mkdirSync(shotDir, { recursive: true })
      const p = join(shotDir, `screen-${d.id}-${Date.now()}.png`)
      writeFileSync(p, img.toPNG())
      const size = img.getSize()
      out.push({ displayId: String(d.id), primary: d.primary, path: p, width: size.width, height: size.height })
    } catch (err) {
      out.push({ displayId: String(d.id), primary: d.primary, error: (err as Error).message })
    }
  }
  return out
}
