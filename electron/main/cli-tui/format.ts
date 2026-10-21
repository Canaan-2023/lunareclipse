/**
 * @category CLI-TUI
 * @summary 终端文本折行工具（CJK 感知）
 *
 * 用 wrap-ansi 对任意文本按终端宽度折行并保留换行。
 * 宽度按 Unicode 显示宽度计算（中文=2），INK 组件每次渲染前把消息体
 * 折成行数组 —— 消息区可见窗口取最后 N 行，保证输入框固定在底部。
 */
import wrapAnsi from 'wrap-ansi'

/** 按显示宽度折行，返回渲染行数组（含原文本换行） */
export function wrapText(text: string, width: number): string[] {
  if (text.length === 0) return ['']
  if (width <= 1) return text.split('\n')
  return wrapAnsi(text, Math.max(1, width)).split('\n')
}

/** 字符串显示宽度（中文字符=2，ANSII 转义不计）；用于角色标签宽度对齐 */
export function displayWidth(text: string): number {
  // wrap-ansi 依赖 string-width 处理宽度，这里直接复用折行结果来推断：
  // 仅当需要按标签宽度缩进续行时使用（首折行后的对齐）
  let w = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a ||
        (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
        (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6))) {
      w += 2
    } else {
      w += 1
    }
  }
  return w
}