/**
 * 抽屉用的日期纯函数（`YYYY-MM-DD`）。
 *
 * 为什么独立成模块：日记要按天翻页，而日期运算是**纯算术**——把它做成纯函数才能单测，
 * 也才能让「时间只采样一次」这条纪律落地：`todayIso(now)` 的 `now` 是**注入的**，
 * 组件在挂载时取一次就够（不在渲染里反复调 `new Date()`）。
 *
 * 不删理由：删掉即日期拼接散回组件里，翻页边界（跨月/跨年）无人可测。
 */

/** 本地日期 → `YYYY-MM-DD`（**用本地时区**：日记是给人看的，不该按 UTC 跨日） */
export function toIso(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 今天（`now` 注入，缺省取当前时刻——调用方应在挂载时采样一次） */
export function todayIso(now: Date = new Date()): string {
  return toIso(now)
}

/**
 * 在 `YYYY-MM-DD` 上偏移 `days` 天（可为负）。
 * 非法输入原样返回（不抛——抽屉不该因为一个坏日期整块崩掉）。
 */
export function shiftIso(iso: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  d.setDate(d.getDate() + days)
  return toIso(d)
}
