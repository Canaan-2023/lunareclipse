/**
 * ROOM 六主题适配的**机械守卫**（ADR-29 阶段 E）。
 *
 * 为什么用源码扫描：ROOM 只用语义 token（`text-success` / `text-warning` / `text-accent` /
 * `text-danger` / `text-fg-*` / `bg-bg-*` / `border-border*`），六套主题才能自动适配。
 * 一旦有人写 `text-red-400` 这类 **Tailwind 编号调色板**，它在**所有主题下都是同一个红**——
 * 不报错、不崩，只是「换主题时这一块不跟着变」（静默失效）。渲染测试看不见这种回归，
 * 只有扫源码才拦得住（与 `room-no-polling.test.ts` 同范式）。
 *
 * 白名单只留一条：抽屉遮罩的 `bg-black/30`——**主题无关的压暗层**（任何主题下遮罩都该是黑的），
 * 且它不是编号调色板类，本守卫的模式也不会命中它；这里显式记一笔是为了让读者知道「不是漏了」。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const ROOM_DIR = join(__dirname, '..', 'src', 'components', 'Room')

/** Tailwind **编号**调色板类（`text-red-400` / `bg-emerald-500` / `border-sky-300/40`…） */
const PALETTE_CLASS_RE =
  /\b(?:text|bg|border|ring|from|to|via|fill|stroke|decoration|outline|shadow|divide|accent|caret|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g

function roomSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) {
      out.push(...roomSourceFiles(abs))
    } else if (/\.tsx?$/.test(name)) {
      out.push(abs)
    }
  }
  return out
}

describe('ROOM 六主题适配：只用语义 token，不用 Tailwind 编号调色板', () => {
  it('Room 组件目录下无 Tailwind 编号调色板类', () => {
    const offenders: string[] = []
    for (const file of roomSourceFiles(ROOM_DIR)) {
      const text = readFileSync(file, 'utf-8')
      // 去掉注释再扫：注释里举例提到类名是允许的（本文件与若干头注释都在解释为什么不用）
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
      for (const m of code.matchAll(PALETTE_CLASS_RE)) {
        offenders.push(`${file.split(/[\\/]/).pop()}: ${m[0]}`)
      }
    }
    expect(offenders, `应改用语义 token（text-success / text-warning / text-danger / text-accent…）：\n${offenders.join('\n')}`).toEqual([])
  })

  it('相位语气与月相判定**同源**（顶栏不另写一份映射）', () => {
    const bar = readFileSync(join(ROOM_DIR, 'PresenceBar.tsx'), 'utf-8')
    expect(bar).toContain("from './room-status'")
    expect(bar).toContain('phaseTone(')
    expect(bar).toContain('phaseToMoon(')
    expect(bar).toContain('moonRows(')
    // 不得自带一份「相位 → 颜色」表
    expect(bar).not.toContain('PHASE_TONE')
  })
})
