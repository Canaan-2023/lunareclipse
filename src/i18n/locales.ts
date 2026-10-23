/**
 * @category i18n
 * @summary i18n 字典宿主 barrel（导出 `Lang` / `LANGUAGES` / `getDictEntry`）
 *
 * 为什么存在：界面需中英双语且文案散落整个前端，集中管理语言类型、语言清单与字典查询入口。
 * 作用：本文件是 i18n 的**宿主 barrel**——按 ADR-07 把 1128 条文案按 UI 域拆到
 * `domains/*.ts` 分片后，此处只保留 `Lang` / `LANGUAGES` / `getDictEntry` 三个导出
 * （与拆分前逐字等价，消费方零改动），并用对象展开合并各域分片。
 * 不删理由：消费方（`useT.ts` / `SettingsPanel.tsx` / `systemSlice.ts`）与 ~60 个组件
 * 经 `useT` 间接依赖本路径；保留此 barrel 即保证全渲染面零回归。
 * 新增文案请改对应 `domains/<域>.ts`；新增 UI 域请新建分片并在此登记。
 */
// 分片默认导入统一加 `Dict` 后缀：避免 `eval` 这类绑定名——ESM 严格模式下
// `eval` / `arguments` 不能作绑定标识符（实测 rollup 报 Parse failure）。
import coreDict from './domains/core'
import aiDict from './domains/ai'
import pluginsDict from './domains/plugins'
import socialDict from './domains/social'
import settingsDict from './domains/settings'
import inputDict from './domains/input'
import memoryDict from './domains/memory'
import evalDict from './domains/eval'
import lilithDict from './domains/lilith'
import messagingDict from './domains/messaging'
import securityDict from './domains/security'
import type { DictEntry } from './dict-types'

export type Lang = 'zh' | 'en'

export const LANGUAGES: { value: Lang; label: string }[] = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
]

/** 合并各 UI 域分片（键唯一性由 `test/i18n-dict.test.ts` 的「无重复键」用例锁死） */
const DICT: Record<string, DictEntry> = {
  ...coreDict,
  ...aiDict,
  ...pluginsDict,
  ...socialDict,
  ...settingsDict,
  ...inputDict,
  ...memoryDict,
  ...evalDict,
  ...lilithDict,
  ...messagingDict,
  ...securityDict,
}

export function getDictEntry(key: string): DictEntry | undefined {
  return DICT[key]
}
