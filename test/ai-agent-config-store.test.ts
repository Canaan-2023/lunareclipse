import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AiAgentConfigStore } from '../electron/main/multi-instance/ai-agent-config-store'

describe('AiAgentConfigStore 主动协作配置', () => {
  let roots: string[] = []

  function newRoot(): string {
    const r = mkdtempSync(join(tmpdir(), 'ai-agent-config-'))
    roots.push(r)
    return r
  }

  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true })
    roots = []
  })

  it('默认关闭主动协作，间隔为 10 分钟', () => {
    const s = new AiAgentConfigStore(newRoot())
    expect(s.isProactiveEnabled()).toBe(false)
    expect(s.getProactiveIntervalMs()).toBe(600_000)
  })

  it('老 JSON 无 proactive 字段：回落默认 false', () => {
    const root = newRoot()
    mkdirSync(join(root, 'federation'), { recursive: true })
    // 模拟旧版配置：只有 enabled/chatRooms/directChats，无 proactive
    writeFileSync(
      join(root, 'ai-agent-config.json'),
      JSON.stringify({ enabled: true, chatRooms: {}, directChats: {} }),
      'utf-8'
    )
    const s = new AiAgentConfigStore(root)
    expect(s.get().enabled).toBe(true)
    expect(s.isProactiveEnabled()).toBe(false)
    expect(s.getProactiveIntervalMs()).toBe(600_000)
  })

  it('开启 proactive 且间隔>0 时启用；回调保存', () => {
    const root = newRoot()
    const s = new AiAgentConfigStore(root)
    s.setProactive(true)
    s.setProactiveInterval(30_000)
    expect(s.isProactiveEnabled()).toBe(true)
    expect(s.getProactiveIntervalMs()).toBe(30_000)

    // 重启后仍生效
    const s2 = new AiAgentConfigStore(root)
    expect(s2.isProactiveEnabled()).toBe(true)
    expect(s2.getProactiveIntervalMs()).toBe(30_000)
  })

  it('proactive=true 但间隔为 0：视为关闭', () => {
    const s = new AiAgentConfigStore(newRoot())
    s.setProactive(true)
    s.setProactiveInterval(0)
    expect(s.isProactiveEnabled()).toBe(false)
  })
})