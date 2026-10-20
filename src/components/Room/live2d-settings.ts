/**
 * @category ROOM
 * @summary Live2D 模型设置的**内存补全**：给 `model3.json` 补 Idle 动作与表情清单
 *
 * 为什么需要：玳瑁猫模型的 `model3.json` 没有声明 `Motions` / `Expressions`，
 * 但目录里明明有 `IDLE.motion3.json` 和一堆 `.exp3.json`。不补的话人物会一直定在一个姿势。
 *
 * 边界：**只改内存里的设置对象，不写回模型文件**——作者条款禁止修改模型；
 * 动作/表情的相对路径由 `pixi-live2d-display` 按 `settings.url`（model3.json 的 URL）解析，
 * 所以补进去的 `File` 必须是**文件名**（相对模型目录），不是绝对路径。
 */

export interface Live2DSettingsJson {
  url?: string
  FileReferences?: {
    Motions?: Record<string, Array<{ File: string; FadeInTime?: number; FadeOutTime?: number }>>
    Expressions?: Array<{ Name: string; File: string }>
  }
}

/**
 * 补 Idle 组：
 * 1. 设置里已声明 `Motions.Idle` → 尊重作者，不动；
 * 2. 否则优先挑文件名带 `idle` 的动作；
 * 3. 只有一个动作文件时也认（不同作者的命名习惯），多于一个且都没写 idle → 不猜。
 */
export function augmentSettings(
  json: Live2DSettingsJson,
  motions: readonly string[],
  expressions: readonly { name: string; file: string }[]
): Live2DSettingsJson {
  const refs = (json.FileReferences ??= {})
  const declaredIdle = refs.Motions?.Idle?.length ? refs.Motions.Idle : null
  if (!declaredIdle) {
    const named = motions.filter((f) => /idle/i.test(f))
    const files = named.length > 0 ? named : motions.length === 1 ? motions : []
    if (files.length > 0) {
      refs.Motions = {
        ...(refs.Motions ?? {}),
        Idle: files.map((File) => ({ File, FadeInTime: 0.8, FadeOutTime: 0.8 }))
      }
    }
  }
  if (!refs.Expressions?.length && expressions.length > 0) {
    refs.Expressions = expressions.map((e) => ({ Name: e.name, File: e.file }))
  }
  return json
}
