/**
 * @category i18n
 * @summary 字典条目类型（叶子模块）
 * 为什么存在：`domains/*` 分片与宿主 barrel 都需要 `DictEntry` 类型；若类型定义留在
 * `locales.ts`，分片就得 import barrel，形成 `locales → domains → locales` 循环依赖（ADR-07 风险 3）。
 * 不删理由：它是 i18n 域的类型叶子，被所有分片与 barrel 依赖，是打破循环的唯一落点。
 */

/** 单条文案：中文与英文成对（配对写在一行，任一语言漏 key 会在类型层暴露） */
export type DictEntry = { zh: string; en: string }
