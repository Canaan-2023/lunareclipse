/**
 * ROOM **无窗口面**的机械守卫（ADR-29 的 B-F：灰度回滚分支已物理删除）。
 *
 * 为什么用源码扫描：删干净是「删除类改动」唯一可验证的判据——只要有一处残留
 * （`room:open` 通道、`viewMode` 字段、`?room=1` 分支、窗口推送那一路），
 * 就会留下**半死的第二条承载面**：不报错、不崩，但没人维护、且与新形态语义冲突。
 * 渲染测试看不见这种残留，只有扫源码才拦得住（与 `room-no-polling` / `room-theme-tokens` 同范式）。
 *
 * 覆盖：preload 无窗口方法 / 主进程无窗口 IPC 通道 / `config.room` 无 `viewMode` /
 * 渲染侧无 `?room=1` 分支与 `RoomApp` / 不再有第二路状态推送。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8')

/** 逐条：文件 + 不得出现的片段 + 人话原因 */
const FORBIDDEN: Array<{ file: string; needle: string; why: string }> = [
  // preload：窗口面方法必须全删
  { file: 'electron/preload/domains/room.ts', needle: 'roomOpen', why: 'preload 不应再有开窗方法' },
  { file: 'electron/preload/domains/room.ts', needle: 'roomClose', why: 'preload 不应再有开窗方法' },
  { file: 'electron/preload/domains/room.ts', needle: 'roomToggle', why: 'preload 不应再有开窗方法' },
  { file: 'electron/preload/domains/room.ts', needle: 'onRoomClosed', why: 'preload 不应再有窗口事件订阅' },
  // 主进程：窗口面 IPC 通道必须全删
  { file: 'electron/main/ipc/handlers/room.ts', needle: "'room:open'", why: '不应再有开窗通道' },
  { file: 'electron/main/ipc/handlers/room.ts', needle: "'room:toggle'", why: '不应再有开窗通道' },
  { file: 'electron/main/ipc/handlers/room.ts', needle: "'room:is-open'", why: '不应再有开窗通道' },
  { file: 'electron/main/ipc/handlers/room.ts', needle: 'windowOpen', why: '状态里不应再有窗口字段' },
  // 配置：灰度 flag 必须删
  { file: 'shared/types/app-config.ts', needle: 'viewMode', why: '承载面 flag 已随窗口分支删除' },
  { file: 'shared/types/defaults.ts', needle: 'viewMode', why: '承载面 flag 已随窗口分支删除' },
  // 渲染：?room=1 分支必须删
  { file: 'src/App.tsx', needle: 'RoomApp', why: '旧窗口根组件已删，入口分支也应删' },
  { file: 'src/App.tsx', needle: "has('room')", why: '不应再有 ?room=1 分支' },
  // 状态推送：不应再有第二路（窗口那路）
  { file: 'electron/main/bootstrap/room-runtime.ts', needle: 'sendRoomStateToRoomWindow', why: '只剩主窗口一路推送' }
]

describe('ROOM 无窗口面（B-F 物理删除后）', () => {
  it('窗口相关文件与入口都已删除', () => {
    expect(existsSync(join(ROOT, 'electron/main/room-window.ts'))).toBe(false)
    expect(existsSync(join(ROOT, 'src/components/Room/RoomApp.tsx'))).toBe(false)
    expect(existsSync(join(ROOT, 'test/room-window-url.test.ts'))).toBe(false)
  })

  it('源码里没有任何窗口面残留', () => {
    const hits: string[] = []
    for (const { file, needle, why } of FORBIDDEN) {
      const text = read(file)
      // 先剥注释：头注释里解释「窗口分支已删」是允许的
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
      if (code.includes(needle)) hits.push(`${file}: 「${needle}」—— ${why}`)
    }
    expect(hits, hits.join('\n')).toEqual([])
  })

  it('运行面通道仍在（删窗口不等于删运行面）', () => {
    const ipc = read('electron/main/ipc/handlers/room.ts')
    for (const ch of [
      "'room:runtime-state'",
      "'room:status'",
      "'room:tick'",
      "'room:start-loop'",
      "'room:stop-loop'",
      "'room:host-session'",
      "'room:wake'"
    ]) {
      expect(ipc, `运行面通道 ${ch} 不应被误删`).toContain(ch)
    }
  })
})
