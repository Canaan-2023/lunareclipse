/**
 * i18n 字典不变量测试（ADR-07 第 0 步前置硬条件）。
 *
 * 为什么存在：`src/i18n/locales.ts`（1288 行 / 1128 条 key）按 ADR-07 拆为
 * `domains/<域>.ts` 分片 + 宿主 barrel 时，**分片间的同名 key 会被对象展开静默覆盖**
 * （`{ ...a, ...b }` 无任何报错）——这是本域唯一的静默故障形态。拆分前本域 0 测试覆盖，
 * 故先立本文件作为「搬迁等价」判据：键集合快照 + 无重复键 + 配对完整性 + 回退语义。
 *
 * 覆盖的 ADR-07 §6 用例：
 *  - 键集合一致性：无重复键（分片展开不覆盖）
 *  - 键集合一致性：键集合快照（拆分前后逐字相同）
 *  - 配对完整性：每条目同时含 zh 与 en 且均非空
 *  - 缺失键回退：`getDictEntry(未知 key)` 返回 undefined
 *  - 导出面：`LANGUAGES` 含 zh / en
 *
 * 未覆盖（如实说明）：ADR-07 §6 的「`useT` 对未知 key 回退为 key 原文」未在此单测——
 * `useT` 是 React hook，需渲染器（devDeps 无 @testing-library/react）；其回退实现是
 * `useT.ts` 内的单表达式 `entry?.[lang] ?? key`，该行为由渲染类组件测试（如
 * `toolcall-card.test.ts`）间接覆盖。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { getDictEntry, LANGUAGES } from '../src/i18n/locales'

const I18N_DIR = join(__dirname, '..', 'src', 'i18n')
/** 匹配一条 dict 条目（键 + zh 起始），用于静态提取键集合 */
const KEY_RE = /^\s*'([^']+)':\s*\{\s*zh:\s*'/gm

/** 收集字典源文件（宿主 + 域分片）内的全部 key，并记录来源文件（便于定位冲突） */
function collectKeys(): Array<{ key: string; file: string }> {
  const files = [join(I18N_DIR, 'locales.ts')]
  const domainsDir = join(I18N_DIR, 'domains')
  if (existsSync(domainsDir)) {
    for (const f of readdirSync(domainsDir)) {
      if (f.endsWith('.ts')) files.push(join(domainsDir, f))
    }
  }
  const out: Array<{ key: string; file: string }> = []
  for (const f of files) {
    const text = readFileSync(f, 'utf-8')
    const base = f.split(/[\\/]/).pop() ?? f
    for (const m of text.matchAll(KEY_RE)) {
      out.push({ key: m[1], file: base })
    }
  }
  return out
}

describe('i18n 字典：键集合一致性', () => {
  it('无重复键（分片间同名 key 会被对象展开静默覆盖，必须为零）', () => {
    const all = collectKeys()
    const seen = new Map<string, string>()
    const dups: string[] = []
    for (const { key, file } of all) {
      const prev = seen.get(key)
      if (prev) dups.push(`${key}（${prev} 与 ${file}）`)
      else seen.set(key, file)
    }
    expect(dups).toEqual([])
  })

  it('键集合快照：拆分前后逐字相同（快照文件锁定，新增文案须显式更新）', () => {
    const keys = collectKeys().map((k) => k.key)
    expect([...keys].sort()).toMatchSnapshot()
  })

  it('键集合非空（防源文件被误删导致「空字典也算通过」）', () => {
    expect(collectKeys().length).toBeGreaterThan(1000)
  })
})

describe('i18n 字典：配对完整性与回退语义', () => {
  it('配对完整性：每条目 zh 与 en 均非空（按语言拆会破坏该防线，本测试守住）', () => {
    const bad: string[] = []
    for (const { key } of collectKeys()) {
      const entry = getDictEntry(key)
      if (!entry || !entry.zh?.trim() || !entry.en?.trim()) bad.push(key)
    }
    expect(bad).toEqual([])
  })

  it('缺失键回退：getDictEntry(未知 key) 返回 undefined（useT 据此回退为 key 原文）', () => {
    expect(getDictEntry('__no_such_key__')).toBeUndefined()
    expect(getDictEntry('')).toBeUndefined()
  })

  it('导出面：LANGUAGES 含 zh / en（消费方 SettingsPanel 的语言下拉依据）', () => {
    expect(LANGUAGES.map((l) => l.value).sort()).toEqual(['en', 'zh'])
  })
})
