/**
 * T2 副本文件粒度合并 — 单元验证

 * 覆盖两个核心机制：
 * 1. loader 层：mergePromptDir / loadFrontendPromptForAi / loadSharedPromptsForAi
 *    文件粒度合并（内置为基底、副本同名替换/独有追加、自然序拼接）；
 * 2. ai-manager 层：listPromptFiles / readPromptFile / writePromptFile /
 *    clearPromptFile / readPromptFileDetail / readSharedPrompt / readBuiltinPromptFile，
 *    以及写入文件粒度副本后旧 system.md 整包被清除、空内容保存 = 删除副本恢复内置。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { mergePromptDir, loadFrontendPromptForAi, loadSharedPromptsForAi } from '../electron/main/prompts/loader'
import { AiManager } from '../electron/main/services/ai-manager'

// ===== 1. loader 层：文件粒度合并 =====

describe('提示词文件粒度合并（T2 loader）', () => {
  let root: string
  let builtin: string
  let override: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'prompt-merge-'))
    builtin = join(root, 'builtin')
    override = join(root, 'override')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('无副本目录 → 纯内置基底拼接（files 全 builtin）', () => {
    mkdirSync(builtin)
    writeFileSync(join(builtin, '1-a.md'), '内置A')
    writeFileSync(join(builtin, '2-b.md'), '内置B')
    const r = mergePromptDir(builtin, null, 't')
    expect(r.text).toContain('内置A')
    expect(r.text).toContain('内置B')
    expect(r.files.map((f) => f.source)).toEqual(['builtin', 'builtin'])
  })

  it('同名副本替换内置 + 独有副本追加 + 自然序拼接', () => {
    mkdirSync(builtin)
    mkdirSync(override)
    writeFileSync(join(builtin, '1-a.md'), '内置A')
    writeFileSync(join(builtin, '10-b.md'), '内置B')
    writeFileSync(join(override, '1-a.md'), '副本A')
    writeFileSync(join(override, '2-c.md'), '副本C')
    const r = mergePromptDir(builtin, override, 't')
    expect(r.text).toContain('副本A')
    expect(r.text).not.toContain('内置A')
    expect(r.text).toContain('内置B')
    expect(r.text).toContain('副本C')
    const files = r.files
    expect(files).toHaveLength(3)
    // 同名文件标记为 override；顺序按自然序（1-a < 2-c < 10-b）
    expect(files[0]).toEqual({ name: '1-a.md', source: 'override' })
    expect(files[1]).toEqual({ name: '2-c.md', source: 'override' })
    expect(files[2]).toEqual({ name: '10-b.md', source: 'builtin' })
  })

  it('两层目录均为空 → text 空串、files 空数组', () => {
    mkdirSync(builtin)
    const r = mergePromptDir(builtin, null, 't')
    expect(r.text).toBe('')
    expect(r.files).toEqual([])
  })

  it('loadFrontendPromptForAi / loadSharedPromptsForAi：按自定义内置目录合并副本', () => {
    const aiRoot = join(root, 'ai-prompts')
    const dir = join(root, 'builtin-root')
    mkdirSync(join(dir, 'frontend'), { recursive: true })
    mkdirSync(join(dir, 'shared'), { recursive: true })
    mkdirSync(join(aiRoot, 'AI1', 'frontend'), { recursive: true })
    mkdirSync(join(aiRoot, 'AI1', 'shared'), { recursive: true })
    writeFileSync(join(dir, 'frontend', '1-系统.md'), '内置系统能力')
    writeFileSync(join(dir, 'shared', '1-机制.md'), '内置通用机制')
    writeFileSync(join(aiRoot, 'AI1', 'frontend', '1-系统.md'), '定制系统能力')
    writeFileSync(join(aiRoot, 'AI1', 'shared', '2-额外.md'), 'AI1 独有通用')
    const fe = loadFrontendPromptForAi(aiRoot, 1, dir)
    expect(fe.text).toContain('定制系统能力')
    expect(fe.text).not.toContain('内置系统能力')
    expect(fe.files).toEqual([{ name: '1-系统.md', source: 'override' }])
    const sh = loadSharedPromptsForAi(aiRoot, 1, dir)
    expect(sh.text).toContain('内置通用机制')
    expect(sh.text).toContain('AI1 独有通用')
    expect(sh.files).toEqual([
      { name: '1-机制.md', source: 'builtin' },
      { name: '2-额外.md', source: 'override' }
    ])
  })
})

// ===== 2. ai-manager 层：文件粒度读写与同步 =====

describe('AiManager 文件粒度副本（T2）', () => {
  let root: string
  let registryPath: string
  let promptsRoot: string
  let mgr: AiManager

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ai-layer-'))
    registryPath = join(root, 'ai-registry.json')
    promptsRoot = join(root, 'frontend', 'ai-prompts')
    mkdirSync(join(root, 'frontend'), { recursive: true })
    mgr = new AiManager({ registryPath, aiPromptsRoot: promptsRoot })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('无副本 → listPromptFiles 全 builtin（基于真实内置目录），readPromptFile 返回 null', () => {
    const layers = mgr.listPromptFiles(1)
    expect(layers.frontend.length).toBeGreaterThan(0)
    expect(layers.frontend.every((f) => f.source === 'builtin')).toBe(true)
    expect(layers.shared.length).toBeGreaterThan(0)
    const name = layers.frontend[0].name
    expect(mgr.readPromptFile(1, 'frontend', name)).toBeNull()
    expect(mgr.readSharedPrompt(1)).toBeNull()
  })

  it('writePromptFile 写入副本：同名替换生效，readPromptFileDetail 标记 override', () => {
    const layers = mgr.listPromptFiles(1)
    const name = layers.frontend[0].name
    const w = mgr.writePromptFile(1, 'frontend', name, 'AI1 定制内容')
    expect(w).toEqual({ ok: true })
    expect(mgr.readPromptFile(1, 'frontend', name)).toBe('AI1 定制内容')
    const detail = mgr.readPromptFileDetail(1, 'frontend', name)
    expect(detail.source).toBe('override')
    expect(detail.content).toBe('AI1 定制内容')
    // readPrompt（frontend 层合并文本）应包含副本内容
    expect(mgr.readPrompt(1)).toContain('AI1 定制内容')
  })

  it('writePromptFile 空内容 = 删除副本恢复内置（并移除空目录）', () => {
    const layers = mgr.listPromptFiles(1)
    const name = layers.frontend[0].name
    mgr.writePromptFile(1, 'frontend', name, '临时副本')
    expect(mgr.readPromptFile(1, 'frontend', name)).toBe('临时副本')
    const w = mgr.writePromptFile(1, 'frontend', name, '')
    expect(w).toEqual({ ok: true })
    expect(mgr.readPromptFile(1, 'frontend', name)).toBeNull()
    // 空目录被清理
    expect(existsSync(join(promptsRoot, 'AI1', 'frontend'))).toBe(false)
  })

  it('clearPromptFile 删除副本恢复内置；readPromptFileDetail 回落到 builtin', () => {
    const layers = mgr.listPromptFiles(1)
    const name = layers.frontend[0].name
    mgr.writePromptFile(1, 'frontend', name, '要删的副本')
    mgr.clearPromptFile(1, 'frontend', name)
    expect(mgr.readPromptFile(1, 'frontend', name)).toBeNull()
    const detail = mgr.readPromptFileDetail(1, 'frontend', name)
    expect(detail.source).toBe('builtin')
    expect(detail.content).toBeNull()
    // 真实内置文件内容可读（供 UI「建立副本」复制基底）
    expect(detail.builtin).toBeTruthy()
    expect(mgr.readBuiltinPromptFile('frontend', name)).toBeTruthy()
  })

  it('文件名校验：禁路径分隔符与穿越、仅 .md/.txt', () => {
    expect(mgr.writePromptFile(1, 'frontend', 'a/../../etc/passwd.md', 'x').ok).toBe(false)
    expect(mgr.writePromptFile(1, 'frontend', '..\\evil.md', 'x').ok).toBe(false)
    expect(mgr.writePromptFile(1, 'frontend', 'x.exe', 'x').ok).toBe(false)
    expect(mgr.writePromptFile(1, 'frontend', 'x.txt', 'x').ok).toBe(true)
  })

  it('文件粒度副本激活后：旧 system.md 整包被清除，防止副本删光后旧整包复活', () => {
    // 模拟旧版整包写入（register 带 systemPrompt 或 ai:savePrompt）
    mgr.writePrompt(1, '旧整包内容')
    expect(mgr.readPrompt(1)).toBe('旧整包内容')
    // 进入文件粒度模式（写 frontend 层副本）→ 旧整包应被清掉
    const layers = mgr.listPromptFiles(1)
    mgr.writePromptFile(1, 'frontend', layers.frontend[0].name, '文件粒度副本')
    expect(existsSync(mgr.getPromptPath(1))).toBe(false)
    // 移除副本后仍无整包
    mgr.clearPromptFile(1, 'frontend', layers.frontend[0].name)
    expect(existsSync(mgr.getPromptPath(1))).toBe(false)
  })

  it('shared 层副本写入后 readSharedPrompt 返回合并文本', () => {
    const layers = mgr.listPromptFiles(1)
    const builtinShared = layers.shared[0].name
    mgr.writePromptFile(1, 'shared', builtinShared, 'AI1 共享定制')
    expect(mgr.readSharedPrompt(1)).toContain('AI1 共享定制')
  })

  it('注册 custom AI 的文件粒度副本独立于系统 AI（AI3 有自己的 frontend/shared 层）', () => {
    const reg = mgr.register({ name: '织梦' })
    expect(reg.ok).toBe(true)
    if (!reg.ok) return
    const id = reg.record.id
    // 注册不带 systemPrompt → 不写旧整包（运行时回退内置）
    expect(existsSync(mgr.getPromptPath(id))).toBe(false)
    // 写文件粒度副本 → 不污染系统 AI1
    const feName = mgr.listPromptFiles(id).frontend[0].name
    const shName = mgr.listPromptFiles(id).shared[0].name
    mgr.writePromptFile(id, 'frontend', feName, '织梦的系统提示')
    mgr.writePromptFile(id, 'shared', shName, '织梦的共享定制')
    expect(mgr.readPrompt(id)).toContain('织梦的系统提示')
    expect(mgr.readSharedPrompt(id)).toContain('织梦的共享定制')
    // AI1 不受影响
    expect(mgr.readPromptFile(1, 'frontend', feName)).toBeNull()
    expect(mgr.readSharedPrompt(1)).toBeNull()
  })
})

// ===== 3. 多 AI 提示词派生分支（T2/T3 历史用例）已随第二人格 AI 移除下线 =====
// 说明：原 T3 分支验证「AI2 从独立人设文件单源派生、可被文件粒度副本覆盖」。
// 该人设 AI 整条链路移除后，AiManager 不再有派生人设分支（agent 字段已删），
// 所有 AI（含自定义）统一走 T2 文件粒度合并，相关断言已无对应用例可测，故整段删除。
