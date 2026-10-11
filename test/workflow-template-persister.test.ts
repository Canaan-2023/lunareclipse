/**
 * WorkflowTemplateStore 提示词外置 + 防漂移机制测试

 * 覆盖 persister.ts save() 的提示词真源规范（MD 唯一真源 + .src 指纹防漂移）：
 * - 去 JSON 化：磁盘 JSON 模板副本不内嵌 prompt 正文，仅保留 promptFile 引用
 * - 无副本（MD 不存在）→ 用内置 prompt 生成 MD + 建 .src 指纹
 * - MD 未编辑且内置更新 → 自动覆盖 MD（解决漂移）
 * - MD 被用户编辑（与指纹不一致）→ 保留用户版本 + warn
 * - MD 与内置一致 → 仅刷新指纹
 * - 历史数据迁移（无 .src）：MD == 旧 JSON prompt → 对齐内置；否则保留 + warn
 * - 运行期回退链：缓存含完整 prompt（供运行回退），磁盘无 prompt
 * - exportToJson：从 MD 回填 prompt 正文（导出自包含）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { WorkflowTemplateStore } from '../electron/main/workflow/persister'
import type { BaseDataPaths, WorkflowTemplate, LlmConfig } from '../shared/workflow/types'

/** 构造测试用 BaseDataPaths */
function makePaths(root: string): BaseDataPaths {
  return {
    root,
    skills: join(root, 'skills'),
    memory: join(root, 'memory'),
    nng: join(root, 'nng'),
    nngRoot: join(root, 'nng', 'root'),
    nngRootJson: join(root, 'nng', 'root.json'),
    cache: join(root, 'cache'),
    cacheIndex: join(root, 'cache', 'index'),
    cacheIndexJson: join(root, 'cache', 'index.json'),
    cacheInjectionRoot: join(root, 'cache', 'injection'),
    users: join(root, 'users'),
    usersJson: join(root, 'users.json'),
    aiRegistryJson: join(root, 'ai-registry.json'),
    workflowPending: join(root, 'workflows', 'pending'),
    sessions: join(root, 'sessions'),
    fileMonitor: join(root, 'file-monitor'),
    fileMonitorErrorLog: join(root, 'file-monitor', 'error.log'),
    fileMonitorCorrupted: join(root, 'file-monitor', 'corrupted'),
    fileMonitorState: join(root, 'file-monitor', 'state.json'),
    taskDetails: join(root, 'task-details'),
    workflows: join(root, 'workflows'),
    workflowTemplates: join(root, 'workflows', 'templates'),
    workflowInstances: join(root, 'workflows', 'instances'),
    frontend: join(root, 'frontend'),
    plugins: join(root, 'plugins'),
    cron: join(root, 'cron'),
    sandboxEnv: join(root, 'sandbox-env.json'),
    sandboxRuntimes: join(root, 'sandbox-runtimes'),
    abyss: join(root, 'ABYSS')
  }
}

/** 构造一个带单个 llm 节点的模板 */
function makeTemplate(id: string, prompt: string): WorkflowTemplate {
  return {
    id,
    name: `${id} 模板`,
    description: '测试模板',
    mode: 'workflow',
    source: 'default',
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      { id: 'llm1', type: 'llm', name: 'LLM', config: { prompt, stream: false } }
    ],
    edges: []
  }
}

describe('WorkflowTemplateStore · 提示词外置与防漂移', () => {
  let root: string
  let paths: BaseDataPaths
  let store: WorkflowTemplateStore
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wf-persist-'))
    paths = makePaths(root)
    store = new WorkflowTemplateStore(paths)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    rmSync(root, { recursive: true, force: true })
  })

  function mdPathOf(tpl: WorkflowTemplate): string {
    return join(paths.workflows, 'prompts', tpl.id, 'llm1.md')
  }
  function srcPathOf(tpl: WorkflowTemplate): string {
    return `${mdPathOf(tpl)}.src`
  }

  it('首次 save：生成 MD + .src 指纹，磁盘 JSON 不内嵌 prompt（去 JSON 化）', () => {
    const tpl = makeTemplate('wf_t1', '内置提示词 v1')
    store.save(tpl)

    // MD 存在且内容 = 内置 prompt
    const mdPath = mdPathOf(tpl)
    expect(existsSync(mdPath)).toBe(true)
    expect(readFileSync(mdPath, 'utf-8')).toBe('内置提示词 v1')
    // .src 指纹存在
    expect(existsSync(srcPathOf(tpl))).toBe(true)
    expect(readFileSync(srcPathOf(tpl), 'utf-8')).toBe('内置提示词 v1')
    // JSON 不内嵌 prompt，仅保留 promptFile
    // （readFileSync+JSON.parse 替代 require 动态加载，避免 CommonJS 语法混入 ESM 测试工程）
    const disk = JSON.parse(readFileSync(join(paths.workflowTemplates, 'wf_t1.json'), 'utf-8'))
    const cfg = disk.nodes[0].config
    expect(cfg.prompt).toBeUndefined()
    expect(cfg.promptFile).toBe(mdPath)
    // 缓存含完整 prompt（运行期回退可用，不依赖磁盘）
    const loaded = store.load('wf_t1')!
    expect((loaded.nodes[0].config as LlmConfig).prompt).toBe('内置提示词 v1')
  })

  it('内置更新且 MD 未编辑（MD == 指纹）→ 自动覆盖 MD，解决漂移', () => {
    store.save(makeTemplate('wf_t2', '内置提示词 v1'))

    // 模拟内置模板升级：用新 prompt 再次 save
    const upgraded = makeTemplate('wf_t2', '内置提示词 v2')
    store.save(upgraded)

    expect(readFileSync(mdPathOf(upgraded), 'utf-8')).toBe('内置提示词 v2')
    expect(readFileSync(srcPathOf(upgraded), 'utf-8')).toBe('内置提示词 v2')
    // 无 warn（MD 未编辑，自动同步是正常路径）
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('MD 被用户编辑（与指纹不一致）→ 保留用户版本 + warn，内置不覆盖', () => {
    store.save(makeTemplate('wf_t3', '内置提示词 v1'))

    // 用户直接编辑 MD（副本优先）
    writeFileSync(mdPathOf(makeTemplate('wf_t3', 'x')), '用户自定义提示词', 'utf-8')

    // 内置升级，再次 save
    const upgraded = makeTemplate('wf_t3', '内置提示词 v2')
    store.save(upgraded)

    // MD 保留用户版本
    expect(readFileSync(mdPathOf(upgraded), 'utf-8')).toBe('用户自定义提示词')
    // 指纹不被污染（仍记录上次同步的内置版本）
    expect(readFileSync(srcPathOf(upgraded), 'utf-8')).toBe('内置提示词 v1')
    // 有 warn 提示
    expect(warnSpy).toHaveBeenCalled()
    // 运行期：缓存读取时 promptFile 指向 MD（用户版本优先）
    const loaded = store.load('wf_t3')!
    expect((loaded.nodes[0].config as LlmConfig).promptFile).toBe(mdPathOf(upgraded))
  })

  it('MD 与内置一致（用户改回默认）→ 仅刷新指纹，不重复写 MD', () => {
    store.save(makeTemplate('wf_t4', '内置提示词 v1'))

    // 用户把 MD 改回与内置一致后再保存
    writeFileSync(mdPathOf(makeTemplate('wf_t4', 'x')), '内置提示词 v1', 'utf-8')
    store.save(makeTemplate('wf_t4', '内置提示词 v1'))

    expect(readFileSync(mdPathOf(makeTemplate('wf_t4', 'x')), 'utf-8')).toBe('内置提示词 v1')
    expect(readFileSync(srcPathOf(makeTemplate('wf_t4', 'x')), 'utf-8')).toBe('内置提示词 v1')
  })

  it('历史数据（无 .src）MD == 旧 JSON prompt → 判定旧内置落地，对齐内置', () => {
    // 构造旧版数据：JSON 已含 prompt、MD 为旧内置 v1、无 .src 指纹
    const tpl = makeTemplate('wf_t5', '内置提示词 v1')
    const mdPath = mdPathOf(tpl)
    mkdirSync(join(paths.workflowTemplates), { recursive: true })
    writeFileSync(join(paths.workflowTemplates, 'wf_t5.json'), JSON.stringify(tpl, null, 2), 'utf-8')
    mkdirSync(join(paths.workflows, 'prompts', tpl.id), { recursive: true })
    writeFileSync(mdPath, '内置提示词 v1', 'utf-8')
    expect(existsSync(srcPathOf(tpl))).toBe(false)

    // 内置升级到 v2，save 触发迁移判定：MD == 旧 JSON prompt → 旧内置 → 对齐 v2
    store.save(makeTemplate('wf_t5', '内置提示词 v2'))
    const upgraded = makeTemplate('wf_t5', 'x')
    expect(readFileSync(mdPathOf(upgraded), 'utf-8')).toBe('内置提示词 v2')
    expect(readFileSync(srcPathOf(upgraded), 'utf-8')).toBe('内置提示词 v2')
  })

  it('历史数据（无 .src）MD != 旧 JSON prompt → 无法判定来源，保留 MD + warn', () => {
    // 旧 JSON prompt 是 v1，但 MD 是"用户自定义"（既非内置也非 JSON）
    const tpl = makeTemplate('wf_t6', '内置提示词 v1')
    const mdPath = mdPathOf(tpl)
    mkdirSync(join(paths.workflowTemplates), { recursive: true })
    writeFileSync(join(paths.workflowTemplates, 'wf_t6.json'), JSON.stringify(tpl, null, 2), 'utf-8')
    mkdirSync(join(paths.workflows, 'prompts', tpl.id), { recursive: true })
    writeFileSync(mdPath, '用户自定义提示词', 'utf-8')

    store.save(makeTemplate('wf_t6', '内置提示词 v2'))
    const upgraded = makeTemplate('wf_t6', 'x')
    // 保留 MD，不覆盖
    expect(readFileSync(mdPathOf(upgraded), 'utf-8')).toBe('用户自定义提示词')
    expect(warnSpy).toHaveBeenCalled()
  })

  it('非 llm 节点不受影响；多 llm 节点各自外置', () => {
    const tpl: WorkflowTemplate = {
      ...makeTemplate('wf_t7', '提示词A'),
      nodes: [
        { id: 'tool1', type: 'tool', name: '工具', config: { toolId: 'run_command', args: { command: 'echo hi' } } },
        { id: 'llm1', type: 'llm', name: 'LLM1', config: { prompt: '提示词A' } },
        { id: 'llm2', type: 'llm', name: 'LLM2', config: { prompt: '提示词B' } }
      ],
      edges: []
    }
    store.save(tpl)
    expect(existsSync(join(paths.workflows, 'prompts', 'wf_t7', 'llm1.md'))).toBe(true)
    expect(existsSync(join(paths.workflows, 'prompts', 'wf_t7', 'llm2.md'))).toBe(true)
    expect(readFileSync(join(paths.workflows, 'prompts', 'wf_t7', 'llm1.md'), 'utf-8')).toBe('提示词A')
    expect(readFileSync(join(paths.workflows, 'prompts', 'wf_t7', 'llm2.md'), 'utf-8')).toBe('提示词B')
    const disk = JSON.parse(readFileSync(join(paths.workflowTemplates, 'wf_t7.json'), 'utf-8'))
    for (const n of disk.nodes) {
      if (n.type === 'llm') expect(n.config.prompt).toBeUndefined()
      if (n.type === 'tool') expect(n.config.prompt).toBeUndefined()
    }
    // 缓存保留完整 prompt（llm 节点）
    const loaded = store.load('wf_t7')!
    const cfgs = loaded.nodes.filter((n) => n.type === 'llm').map((n) => (n.config as LlmConfig).prompt)
    expect(cfgs).toEqual(['提示词A', '提示词B'])
  })

  it('save 不修改调用方/内置常量对象（structuredClone 工作副本）', () => {
    const tpl = makeTemplate('wf_t8', '提示词')
    store.save(tpl)
    // 调用方对象未被剔除 prompt
    expect((tpl.nodes[0].config as LlmConfig).prompt).toBe('提示词')
    expect((tpl.nodes[0].config as LlmConfig).promptFile).toBeUndefined()
  })

  it('exportToJson：有 promptFile 无 prompt 的节点从 MD 回填 prompt（导出自包含）', () => {
    const tpl = makeTemplate('wf_t9', '导出提示词')
    store.save(tpl)
    const exported = JSON.parse(store.exportToJson('wf_t9')!)
    expect(exported.nodes[0].config.prompt).toBe('导出提示词')
    expect(exported.nodes[0].config.promptFile).toBe(mdPathOf(tpl))
  })

  it('importFromJson：导入后 save 重新外置 MD，新 ID 无冲突', () => {
    const tpl = makeTemplate('wf_t10', '导入提示词')
    // 导出 → 导入（导入生成新 ID + save 外置 MD）
    store.save(tpl)
    const exported = store.exportToJson('wf_t10')!
    const imported = store.importFromJson(exported, '导入的模板')
    expect(imported.id).not.toBe('wf_t10')
    // 新模板有自己的 MD 与指纹
    const mdPath = join(paths.workflows, 'prompts', imported.id, 'llm1.md')
    expect(existsSync(mdPath)).toBe(true)
    expect(readFileSync(mdPath, 'utf-8')).toBe('导入提示词')
    expect(existsSync(`${mdPath}.src`)).toBe(true)
    // 磁盘 JSON 不内嵌 prompt
    const disk = JSON.parse(readFileSync(join(paths.workflowTemplates, `${imported.id}.json`), 'utf-8'))
    expect(disk.nodes[0].config.prompt).toBeUndefined()
    // 原模板不受影响
    const original = store.load('wf_t10')!
    expect((original.nodes[0].config as LlmConfig).prompt).toBe('导入提示词')
  })

  it('list() 从磁盘读取（无 prompt 但含 promptFile），不影响模板完整性', () => {
    store.save(makeTemplate('wf_t11', '提示词'))
    const list = store.list()
    expect(list.length).toBe(1)
    expect((list[0].nodes[0].config as LlmConfig).prompt).toBeUndefined()
    expect((list[0].nodes[0].config as LlmConfig).promptFile).toBe(mdPathOf(makeTemplate('wf_t11', 'x')))
  })

  it('搬家场景：MD 被删除后再次 save 会重新生成（无副本兜底内置）', () => {
    const tpl = makeTemplate('wf_t12', '内置提示词 v2已删除')
    store.save(tpl)
    // 第三方删除 MD
    rmSync(mdPathOf(tpl), { force: true })
    // save 时无 MD → 按内置重新生成
    store.save(makeTemplate('wf_t12', '内置提示词 v2已删除'))
    expect(existsSync(mdPathOf(tpl))).toBe(true)
    expect(readFileSync(mdPathOf(tpl), 'utf-8')).toBe('内置提示词 v2已删除')
    expect(readFileSync(srcPathOf(tpl), 'utf-8')).toBe('内置提示词 v2已删除')
  })
})