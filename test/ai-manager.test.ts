import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AiManager } from '../electron/main/services/ai-manager'
import { readAiRegistry } from '../electron/main/models/ai-registry'

describe('AiManager（多 AI 子系统注册表接线）', () => {
  let root: string
  let registryPath: string
  let promptsRoot: string
  let mgr: AiManager

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ai-manager-'))
    registryPath = join(root, 'ai-registry.json')
    promptsRoot = join(root, 'frontend', 'ai-prompts')
    mkdirSync(join(root, 'frontend'), { recursive: true })
    mgr = new AiManager({ registryPath, aiPromptsRoot: promptsRoot })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('初始注册表只含系统 AI（月蚀=1 frontend / 莉莉丝=2 lilith）', () => {
    const ais = mgr.list()
    expect(ais).toHaveLength(2)
    expect(ais[0]).toMatchObject({ id: 1, name: '月蚀', agent: 'frontend', kind: 'system' })
    expect(ais[1]).toMatchObject({ id: 2, name: '莉莉丝', agent: 'lilith', kind: 'system' })
    expect(ais[0].deactivated).toBeUndefined()
  })

  it('注册 custom AI：id 顺延 3、agent 自动生成 custom-3、写提示词副本', () => {
    const r = mgr.register({ name: '织梦', systemPrompt: '你是织梦，负责梦境管理。' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.record.id).toBe(3)
    expect(r.record.agent).toBe('custom-3')
    expect(r.record.kind).toBe('custom')
    expect(r.record.createdAt).toBeTruthy()

    // 提示词副本落盘
    const promptPath = mgr.getPromptPath(3)
    expect(promptPath.endsWith(join('frontend', 'ai-prompts', 'AI3', 'system.md'))).toBe(true)
    expect(existsSync(promptPath)).toBe(true)
    expect(readFileSync(promptPath, 'utf-8')).toBe('你是织梦，负责梦境管理。')

    // 列表可见
    expect(mgr.list().map((a) => a.name)).toContain('织梦')
  })

  it('注册时不带提示词 → 不建副本文件（运行时回退内置）', () => {
    const r = mgr.register({ name: '无声' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(existsSync(mgr.getPromptPath(r.record.id))).toBe(false)
    expect(mgr.readPrompt(r.record.id)).toBeNull()
  })

  it('重名/同 agent 注册幂等：返回已有记录不重复创建', () => {
    const a = mgr.register({ name: '织梦' })
    const b = mgr.register({ name: '织梦' })
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.record.id).toBe(b.record.id)
    expect(b.existing).toBe(true)
    expect(mgr.list()).toHaveLength(3)
  })

  it('update：改名字/简介，id 与 agent 不可改', () => {
    const reg = mgr.register({ name: '织梦' })
    expect(reg.ok).toBe(true)
    if (!reg.ok) return

    const u = mgr.update(reg.record.id, { name: '织梦·改', description: '改名测试' })
    expect(u.ok).toBe(true)
    if (!u.ok) return
    expect(u.record.name).toBe('织梦·改')
    expect(u.record.description).toBe('改名测试')
    expect(u.record.id).toBe(reg.record.id)
    expect(u.record.agent).toBe('custom-3')
    expect(u.record.kind).toBe('custom')
  })

  it('update systemPrompt：同步写提示词副本；置空清副本', () => {
    const reg = mgr.register({ name: '织梦' })
    expect(reg.ok).toBe(true)
    if (!reg.ok) return

    const u = mgr.update(reg.record.id, { systemPrompt: '新版系统提示' })
    expect(u.ok).toBe(true)
    expect(readFileSync(mgr.getPromptPath(reg.record.id), 'utf-8')).toBe('新版系统提示')

    // 清空 → 副本删除，回退内置
    const clear = mgr.update(reg.record.id, { systemPrompt: '' })
    expect(clear.ok).toBe(true)
    expect(existsSync(mgr.getPromptPath(reg.record.id))).toBe(false)
    expect(mgr.readPrompt(reg.record.id)).toBeNull()
  })

  it('deactivate/reactivate：软停用不删数据，system AI 不可停用', () => {
    const reg = mgr.register({ name: '织梦' })
    expect(reg.ok).toBe(true)
    if (!reg.ok) return

    const d = mgr.deactivate(reg.record.id)
    expect(d.ok).toBe(true)
    const afterDeactivate = mgr.get(reg.record.id)
    expect(afterDeactivate?.deactivated).toBe(true)
    expect(afterDeactivate?.name).toBe('织梦') // 数据保留

    const r1 = mgr.reactivate(reg.record.id)
    expect(r1.ok).toBe(true)
    expect(mgr.get(reg.record.id)?.deactivated).toBe(false)

    // 系统 AI 不可停用
    const sys = mgr.deactivate(1)
    expect(sys.ok).toBe(false)
  })

  it('custom AI 数量上限 20', () => {
    for (let i = 0; i < 20; i++) {
      const r = mgr.register({ name: `小AI${i + 1}` })
      expect(r.ok).toBe(true)
    }
    const over = mgr.register({ name: '第21个' })
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.error).toContain('上限')
  })

  it('名称校验：长度 1-16、仅中文/英文/数字/部分标点', () => {
    expect(mgr.register({ name: '' }).ok).toBe(false)
    expect(mgr.register({ name: 'x'.repeat(17) }).ok).toBe(false)
    expect(mgr.register({ name: '织梦//非法' }).ok).toBe(false)
    expect(mgr.register({ name: ' 合法名字-2' }).ok).toBe(true)
  })

  it('parentAiId 溯源：父 AI 必须存在，不存在则拒绝', () => {
    const bad = mgr.register({ name: '孤儿AI', parentAiId: 99 })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('不存在')

    const good = mgr.register({ name: '月蚀之分身', parentAiId: 1 })
    expect(good.ok).toBe(true)
    if (good.ok) expect(good.record.parentAiId).toBe(1)
  })

  it('writePrompt 校验 + 覆盖写；getPromptPath 目录结构正确', () => {
    expect(mgr.writePrompt(1, 'x'.repeat(50_001)).ok).toBe(false)
    expect(mgr.writePrompt(1, ' 合法内容 ').ok).toBe(true)
    expect(mgr.readPrompt(1)).toBe('合法内容')
    const dirs = readdirSync(join(promptsRoot, 'AI1'))
    expect(dirs).toContain('system.md')
  })

  it('注册表文件持久化：从磁盘重读一致', () => {
    mgr.register({ name: '织梦', description: '持久化测试' })
    const fresh = new AiManager({ registryPath, aiPromptsRoot: promptsRoot })
    const ai = fresh.list().find((a) => a.name === '织梦')
    expect(ai).toBeTruthy()
    expect(ai?.description).toBe('持久化测试')
    expect(readAiRegistry(registryPath).ais).toHaveLength(3)
  })
})