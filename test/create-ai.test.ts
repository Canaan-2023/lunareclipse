import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CreateAiTool } from '../electron/main/tools/create-ai'
import { AiManager } from '../electron/main/services/ai-manager'
import { readAiRegistry, type AiRecord } from '../electron/main/models/ai-registry'
import type { DataPaths } from '../electron/main/models/paths'

describe('CreateAiTool（多 AI 子系统 P4：AI 自建 AI）', () => {
  let root: string
  let registryPath: string
  let promptsRoot: string
  let mgr: AiManager
  let tool: CreateAiTool

  /** 构造最小 ToolContext（paths 只填工具用到的两字段） */
  function makeCtx(overrides?: {
    sessionId?: string | null
    getSessionAiId?: (sid?: string) => number
    requestPermission?: (req: { type: string; description: string; content: string; risk: string }) => Promise<{ allowed: boolean; reason?: string }>
  }) {
    const paths = {
      aiRegistryJson: registryPath,
      frontend: join(root, 'frontend')
    } as unknown as DataPaths
    return {
      paths,
      sessionId: overrides?.sessionId ?? 'sess-1',
      getSessionAiId: overrides?.getSessionAiId ?? (() => 1),
      requestPermission: overrides?.requestPermission ?? (async () => ({ allowed: true }))
    }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'create-ai-'))
    registryPath = join(root, 'ai-registry.json')
    promptsRoot = join(root, 'frontend', 'ai-prompts')
    mkdirSync(join(root, 'frontend'), { recursive: true })
    mgr = new AiManager({ registryPath, aiPromptsRoot: promptsRoot })
    tool = new CreateAiTool()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('月蚀（aiId=1）创建成功：id=3、kind=custom、parentAiId=1、写提示词副本', async () => {
    const r = await tool.execute(
      { name: '织梦', description: '月蚀创造的分身', systemPrompt: '你是织梦。', avatar: '🌙' },
      makeCtx()
    )
    expect(r.ok).toBe(true)
    const rec = (r as { ok: true; data: { record: AiRecord } }).data.record
    expect(rec.id).toBe(3)
    expect(rec.name).toBe('织梦')
    expect(rec.kind).toBe('custom')
    expect(rec.agent).toBe('custom-3')
    expect(rec.parentAiId).toBe(1)

    // parentAiId 落盘 + 提示词副本落盘
    const disk = readAiRegistry(registryPath).ais.find((a) => a.id === 3)
    expect(disk?.parentAiId).toBe(1)
    expect(readFileSync(mgr.getPromptPath(3), 'utf-8')).toBe('你是织梦。')
  })

  it('防递归：custom AI 调用被拒绝（自定义 AI 不可再创建 AI）', async () => {
    const reg = mgr.register({ name: '已存在分身', parentAiId: 1 })
    expect(reg.ok).toBe(true)
    if (!reg.ok) return
    const customId = reg.record.id // id=3，kind=custom

    const r = await tool.execute(
      { name: '孙辈AI' },
      makeCtx({ getSessionAiId: () => customId })
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('防递归')
    // 注册表没有新增
    expect(readAiRegistry(registryPath).ais).toHaveLength(3)
  })

  it('父提示词继承：systemPrompt 缺省时继承父 AI 提示词副本', async () => {
    // 先给月蚀（id=1）写提示词副本
    mgr.writePrompt(1, '我是月蚀，我的孩子要继承我的使命。')
    const r = await tool.execute({ name: '继承者' }, makeCtx())
    expect(r.ok).toBe(true)
    const rec = (r as { ok: true; data: { record: AiRecord } }).data.record
    expect(readFileSync(mgr.getPromptPath(rec.id), 'utf-8')).toBe('我是月蚀，我的孩子要继承我的使命。')
    expect(readAiRegistry(registryPath).ais.find((a) => a.id === rec.id)?.systemPrompt).toBe(
      '我是月蚀，我的孩子要继承我的使命。'
    )
  })

  it('传入 systemPrompt 优先于继承；父无副本时缺省不建副本（回退内置）', async () => {
    // 父（id=1）无副本
    const r1 = await tool.execute({ name: '无提示词分身' }, makeCtx())
    expect(r1.ok).toBe(true)
    const rec1 = (r1 as { ok: true; data: { record: AiRecord } }).data.record
    expect(existsSync(mgr.getPromptPath(rec1.id))).toBe(false)

    // 显式传入优先
    const r2 = await tool.execute({ name: '显式提示词分身', systemPrompt: '独立提示词。' }, makeCtx())
    expect(r2.ok).toBe(true)
    const rec2 = (r2 as { ok: true; data: { record: AiRecord } }).data.record
    expect(readFileSync(mgr.getPromptPath(rec2.id), 'utf-8')).toBe('独立提示词。')
  })

  it('权限确认：用户拒绝则不创建', async () => {
    const denied = makeCtx({
      requestPermission: async () => ({ allowed: false, reason: '用户不想创建' })
    })
    const r = await tool.execute({ name: '被拒的分身' }, denied)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('用户拒绝')
    expect(readAiRegistry(registryPath).ais).toHaveLength(2)
  })

  it('权限确认：会携带创建者信息与操作内容', async () => {
    const spy = vi.fn(async () => ({ allowed: true }))
    await tool.execute({ name: '带信息的创建' }, makeCtx({ requestPermission: spy }))
    expect(spy).toHaveBeenCalledTimes(1)
    const req = spy.mock.calls[0][0]
    expect(req.risk).toBe('medium')
    expect(req.description).toContain('"带信息的创建"')
    expect(req.content).toContain('名字：带信息的创建')
  })

  it('重名幂等：返回已有记录不重复创建', async () => {
    const a = await tool.execute({ name: '织梦' }, makeCtx())
    const b = await tool.execute({ name: '织梦' }, makeCtx())
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    const ra = (a as { ok: true; data: { record: AiRecord } }).data.record
    const rb = (b as { ok: true; data: { record: AiRecord } }).data.record
    expect(ra.id).toBe(rb.id)
    expect((b as { ok: true; data: { message: string } }).data.message).toContain('已存在同名')
    expect(readAiRegistry(registryPath).ais).toHaveLength(3)
  })

  it('数量上限：满 20 个后创建失败', async () => {
    for (let i = 0; i < 20; i++) {
      const r = await tool.execute({ name: `分身${i + 1}` }, makeCtx())
      expect(r.ok).toBe(true)
    }
    const over = await tool.execute({ name: '第21个分身' }, makeCtx())
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.error).toContain('上限')
  })

  it('参数校验：name 缺失/非法直接拒绝（不弹权限）', async () => {
    const spy = vi.fn(async () => ({ allowed: true }))
    const ctx = makeCtx({ requestPermission: spy })

    const noName = await tool.execute({}, ctx)
    expect(noName.ok).toBe(false)
    if (!noName.ok) expect(noName.error).toContain('name 参数必填')

    const badName = await tool.execute({ name: 'x'.repeat(17) }, ctx)
    expect(badName.ok).toBe(false)

    // 非法输入不触发权限弹窗
    expect(spy).not.toHaveBeenCalled()
  })
})