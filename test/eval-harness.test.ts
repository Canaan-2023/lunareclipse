import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ModelGrader } from '../electron/main/eval/graders/model-grader'
import type { LLMClient, ChatWithToolsResult } from '../electron/main/api/llm'
import { EvalHarness } from '../electron/main/eval/harness'
import { ConfigStore } from '../electron/main/api/config-store'
import { createToolRegistry } from '../electron/main/tools'
import type { EvalTask, Transcript } from '../electron/main/eval/types'
import { frontendAiBaselineSuite } from '../electron/main/eval/suites/frontend-ai-baseline'
import { dmnRegressionSuite } from '../electron/main/eval/suites/dmn-regression'
import { listSuites, loadSuite, SUITE_REGISTRY } from '../electron/main/eval'

/**
 * L6 验证层：集成测试

 * 覆盖：
 * - ModelGrader 的 verdict 解析（mock LLMClient 返回 JSON）
 * - EvalHarness.runSuite 的 Pass@k/Pass^k 聚合（mock LLMClient）
 * - 套件注册表（listSuites/loadSuite）
 */
describe('ModelGrader', () => {
  /**
   * 构造 mock LLMClient

   * chatWithTools 接收 messages + tools + model，返回 ChatWithToolsResult
   * 我们让 mock 根据调用次数返回不同预设结果（用于多轮 trial）
   */
  function createMockLLMClient(response: ChatWithToolsResult): LLMClient {
    return {
      chatWithTools: vi.fn().mockResolvedValue(response)
    } as unknown as LLMClient
  }

  it('judge 返回正确 JSON：解析为对应 verdicts', async () => {
    const mockClient = createMockLLMClient({
      content: '{"verdicts": [true, true, true, true, true, true], "reasons": ["ok"]}',
      toolCalls: [],
      finishReason: 'stop'
    })
    const grader = new ModelGrader(mockClient, 'claude-sonnet-4-5')

    const transcript: Transcript = {
      taskId: 'tg1',
      trial: 1,
      steps: [
        { role: 'user', content: 'hi', timestamp: Date.now() },
        { role: 'assistant', content: '你好', timestamp: Date.now() }
      ],
      totalTokens: 10,
      totalDurationMs: 50,
      estimatedCost: 0
    }
    const result = await grader.gradeTrajectoryQuality(transcript)
    expect(result.axis).toBe('trajectory_quality')
    expect(result.grader).toBe('model')
    expect(result.pass).toBe(true)
    expect(result.score).toBe(1)
    expect(result.reason).toContain('✓')
  })

  it('judge 返回部分 false：score < 1 且 pass=false', async () => {
    const mockClient = createMockLLMClient({
      content: '{"verdicts": [true, false, true, true, true, true], "reasons": ["ok","bad"]}',
      toolCalls: [],
      finishReason: 'stop'
    })
    const grader = new ModelGrader(mockClient, 'claude-sonnet-4-5')

    const transcript: Transcript = {
      taskId: 'tg2',
      trial: 1,
      steps: [
        { role: 'user', content: 'hi', timestamp: Date.now() },
        { role: 'assistant', content: '你好', timestamp: Date.now() }
      ],
      totalTokens: 10,
      totalDurationMs: 50,
      estimatedCost: 0
    }
    const result = await grader.gradeTrajectoryQuality(transcript)
    expect(result.pass).toBe(false)
    expect(result.score).toBe(5 / 6)
  })

  it('judge 返回非 JSON：所有 verdicts 默认 false', async () => {
    const mockClient = createMockLLMClient({
      content: '这不是 JSON，无法解析',
      toolCalls: [],
      finishReason: 'stop'
    })
    const grader = new ModelGrader(mockClient, 'claude-sonnet-4-5')

    const transcript: Transcript = {
      taskId: 'tg3',
      trial: 1,
      steps: [
        { role: 'user', content: 'hi', timestamp: Date.now() },
        { role: 'assistant', content: '你好', timestamp: Date.now() }
      ],
      totalTokens: 10,
      totalDurationMs: 50,
      estimatedCost: 0
    }
    const result = await grader.gradeTrajectoryQuality(transcript)
    expect(result.pass).toBe(false)
    expect(result.score).toBe(0)
  })

  it('judge 返回带前后多余文本的 JSON：能正确提取', async () => {
    const mockClient = createMockLLMClient({
      content: '好的，我来评估：\n{"verdicts": [true, true, true, true, true, true]}\n评估完成。',
      toolCalls: [],
      finishReason: 'stop'
    })
    const grader = new ModelGrader(mockClient, 'claude-sonnet-4-5')

    const transcript: Transcript = {
      taskId: 'tg4',
      trial: 1,
      steps: [
        { role: 'user', content: 'hi', timestamp: Date.now() },
        { role: 'assistant', content: '你好', timestamp: Date.now() }
      ],
      totalTokens: 10,
      totalDurationMs: 50,
      estimatedCost: 0
    }
    const result = await grader.gradeTrajectoryQuality(transcript)
    expect(result.pass).toBe(true)
  })

  it('judge 调用抛错：返回 fail 且 reason 包含错误信息', async () => {
    const mockClient = {
      chatWithTools: vi.fn().mockRejectedValue(new Error('网络超时'))
    } as unknown as LLMClient
    const grader = new ModelGrader(mockClient, 'claude-sonnet-4-5')

    const transcript: Transcript = {
      taskId: 'tg5',
      trial: 1,
      steps: [
        { role: 'user', content: 'hi', timestamp: Date.now() },
        { role: 'assistant', content: '你好', timestamp: Date.now() }
      ],
      totalTokens: 10,
      totalDurationMs: 50,
      estimatedCost: 0
    }
    const result = await grader.gradeTrajectoryQuality(transcript)
    expect(result.pass).toBe(false)
    expect(result.score).toBe(0)
    expect(result.reason).toContain('网络超时')
  })

  it('judge 返回数组长度不足：缺失项视为 false', async () => {
    const mockClient = createMockLLMClient({
      content: '{"verdicts": [true, true]}',
      toolCalls: [],
      finishReason: 'stop'
    })
    const grader = new ModelGrader(mockClient, 'claude-sonnet-4-5')

    const transcript: Transcript = {
      taskId: 'tg6',
      trial: 1,
      steps: [
        { role: 'user', content: 'hi', timestamp: Date.now() },
        { role: 'assistant', content: '你好', timestamp: Date.now() }
      ],
      totalTokens: 10,
      totalDurationMs: 50,
      estimatedCost: 0
    }
    const result = await grader.gradeTrajectoryQuality(transcript)
    expect(result.pass).toBe(false)
    expect(result.score).toBe(2 / 6)
  })
})

describe('EvalHarness Pass@k / Pass^k 聚合', () => {
  let tmpDir: string
  let configPath: string
  let configStore: ConfigStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'eval-harness-test-'))
    configPath = join(tmpDir, 'config.json')
    // 显式配置 LLM（评测运行的前提是模型已配置）：
    // 不依赖 DEFAULT_LLM_CONFIG.model 默认值——默认 model 已改为空表示未配置，
    // 若留空则 harness 的 judgeModel 为 ''，下方 mock 以 `if (model && ...)` 区分
    // judge 调用时会因空串 falsy 误判为 generator，导致聚合用例失败。
    writeFileSync(
      configPath,
      JSON.stringify({ llm: { model: 'eval-test-model' } }),
      'utf-8'
    )
    configStore = new ConfigStore(configPath)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  /**
   * 构造 mock LLMClient，区分 generator 和 judge 调用
   *
   * 区分依据：chatWithTools 第三参数 model
   * - generator 调用（executeTrial）：不传 model（undefined）→ 返回 generator 响应
   * - judge 调用（gradeTrajectoryQuality）：传 judgeModel → 返回 judge 响应
   *
   * 注：之前用 messages.length<=1 区分有缺陷 —— generator 第一个 turn 时
   * steps 只有 1 条用户消息，会被误判为 judge 调用导致 toolCalls 丢失。
   */
  function createMockLLMClient(opts: {
    generatorResponse: ChatWithToolsResult
    judgeResponse?: ChatWithToolsResult
  }): LLMClient {
    return {
      chatWithTools: vi
        .fn()
        .mockImplementation(
          (_messages: unknown[], _tools: unknown[], model?: string) => {
            if (model && opts.judgeResponse) {
              return Promise.resolve(opts.judgeResponse)
            }
            return Promise.resolve(opts.generatorResponse)
          }
        )
    } as unknown as LLMClient
  }

  it('Pass@k（k=3, any）：k 次中至少 1 次成功 → 任务 pass', async () => {
    // 任务期望调用 read 并输出包含关键词
    const task: EvalTask = {
      id: 'pk1',
      description: 'Pass@3',
      suite: 'test',
      kind: 'quality',
      input: '读取 package.json',
      expectedToolCalls: [{ name: 'read' }],
      expectedOutcome: { outputContains: ['lunareclipse'] },
      k: 3,
      passMode: 'any'
    }

    // 所有 trial 都调用 read + 输出关键词 + judge 全部 PASS
    const generatorResponse: ChatWithToolsResult = {
      content: '项目名是 lunareclipse',
      toolCalls: [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'read', arguments: '{"file_path":"package.json"}' }
        }
      ],
      finishReason: 'tool_calls'
    }
    const judgeResponse: ChatWithToolsResult = {
      content: '{"verdicts": [true, true, true, true, true, true]}',
      toolCalls: [],
      finishReason: 'stop'
    }

    const mockClient = createMockLLMClient({
      generatorResponse,
      judgeResponse
    })
    const harness = new EvalHarness(mockClient, configStore, (ctx) =>
      createToolRegistry(ctx, { onDemandEnabled: false })
    )

    const trials = await harness.runTask(task)
    expect(trials).toHaveLength(3)

    // 3 次 trial 都调用了 read（generatorResponse 固定返回 read 调用）
    for (const trial of trials) {
      const calledRead = trial.transcript.steps.some(
        (s) => s.role === 'assistant' && s.toolCalls?.some((tc) => tc.name === 'read')
      )
      expect(calledRead).toBe(true)
    }

    // runSuite 聚合：Pass@3 any 模式，3 次全 pass → 任务 pass
    const suiteResult = await harness.runSuite('test', [task])
    expect(suiteResult.taskPassRate).toBe(1)
    console.log(`taskPassRate=${suiteResult.taskPassRate}`)
  })

  it('Pass^k（k=2, all）：k 次全部成功 → 任务 pass', async () => {
    const task: EvalTask = {
      id: 'pk2',
      description: 'Pass^2',
      suite: 'test',
      kind: 'regression',
      input: '读取文件',
      expectedToolCalls: [{ name: 'read' }],
      // 注：不用 toolResultOk，因为 mock 工具名 'read' 在 registry 中是 'Read'（大写），
      // executeTool 会因名称不匹配返回 ok:false。测试目的是验证 Pass^k 聚合，不依赖工具执行。
      expectedOutcome: { outputContains: ['完成'] },
      k: 2,
      passMode: 'all'
    }

    const generatorResponse: ChatWithToolsResult = {
      content: '完成',
      toolCalls: [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'read', arguments: '{"file_path":"x"}' }
        }
      ],
      finishReason: 'tool_calls'
    }
    const judgeResponse: ChatWithToolsResult = {
      content: '{"verdicts": [true, true, true, true, true, true]}',
      toolCalls: [],
      finishReason: 'stop'
    }

    const mockClient = createMockLLMClient({
      generatorResponse,
      judgeResponse
    })
    const harness = new EvalHarness(mockClient, configStore, (ctx) =>
      createToolRegistry(ctx, { onDemandEnabled: false })
    )

    const trials = await harness.runTask(task)
    expect(trials).toHaveLength(2)

    // 2 次 trial 都调用了 read
    for (const trial of trials) {
      const calledRead = trial.transcript.steps.some(
        (s) => s.role === 'assistant' && s.toolCalls?.some((tc) => tc.name === 'read')
      )
      expect(calledRead).toBe(true)
    }

    // Pass^2 all 模式，2 次全 pass → 任务 pass
    const suiteResult = await harness.runSuite('test', [task])
    expect(suiteResult.taskPassRate).toBe(1)
  })

  it('Pass^k（k=2, all）：1 次失败 → 任务 fail', async () => {
    const task: EvalTask = {
      id: 'pk3',
      description: 'Pass^2 失败',
      suite: 'test',
      kind: 'regression',
      input: '读取文件',
      expectedToolCalls: [{ name: 'read' }],
      expectedOutcome: { toolResultOk: true },
      k: 2,
      passMode: 'all'
    }

    // judge 返回全部 FAIL → trajectory_quality 轴失败 → trial 失败
    const generatorResponse: ChatWithToolsResult = {
      content: '完成',
      toolCalls: [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'read', arguments: '{"file_path":"x"}' }
        }
      ],
      finishReason: 'tool_calls'
    }
    const judgeResponse: ChatWithToolsResult = {
      content: '{"verdicts": [false, false, false, false, false, false]}',
      toolCalls: [],
      finishReason: 'stop'
    }

    const mockClient = createMockLLMClient({
      generatorResponse,
      judgeResponse
    })
    const harness = new EvalHarness(mockClient, configStore, (ctx) =>
      createToolRegistry(ctx, { onDemandEnabled: false })
    )

    const suiteResult = await harness.runSuite('test', [task])
    // Pass^2 all：2 次都因 trajectory_quality 失败 → 任务 fail
    expect(suiteResult.taskPassRate).toBe(0)
  })

  it('runSuite 返回正确的聚合结构', async () => {
    // 简化测试：k=1 的任务，确保 runSuite 返回的 SuiteResult 结构完整
    const task: EvalTask = {
      id: 'rs1',
      description: '套件结构',
      suite: 'test-suite',
      kind: 'regression',
      input: 'hi',
      k: 1,
      passMode: 'all'
    }

    const mockClient = createMockLLMClient({
      generatorResponse: { content: '你好', toolCalls: [], finishReason: 'stop' },
      judgeResponse: {
        content: '{"verdicts": [true, true, true, true, true, true]}',
        toolCalls: [],
        finishReason: 'stop'
      }
    })
    const harness = new EvalHarness(mockClient, configStore, (ctx) =>
      createToolRegistry(ctx, { onDemandEnabled: false })
    )

    const result = await harness.runSuite('test-suite', [task])

    expect(result.suite).toBe('test-suite')
    expect(result.kind).toBe('regression')
    expect(result.results).toHaveLength(1)
    expect(typeof result.passRate).toBe('number')
    expect(typeof result.taskPassRate).toBe('number')
    expect(typeof result.totalCost).toBe('number')
    expect(typeof result.totalDurationMs).toBe('number')
    expect(typeof result.runAt).toBe('string')
    // 输出 taskPassRate 供 CI 脚本解析
    console.log(`taskPassRate=${result.taskPassRate}`)
  })
})

describe('套件注册表', () => {
  it('listSuites 返回 frontend-ai-baseline 和 dmn-regression', () => {
    const suites = listSuites()
    expect(suites).toHaveLength(2)
    const names = suites.map((s) => s.name)
    expect(names).toContain('frontend-ai-baseline')
    expect(names).toContain('dmn-regression')

    const quality = suites.find((s) => s.name === 'frontend-ai-baseline')
    expect(quality?.kind).toBe('quality')
    expect(quality?.count).toBe(frontendAiBaselineSuite.length)

    const regression = suites.find((s) => s.name === 'dmn-regression')
    expect(regression?.kind).toBe('regression')
    expect(regression?.count).toBe(dmnRegressionSuite.length)
  })

  it('loadSuite 加载 frontend-ai-baseline 返回 3 个任务', () => {
    const tasks = loadSuite('frontend-ai-baseline')
    expect(tasks).toHaveLength(3)
    expect(tasks.every((t) => t.suite === 'frontend-ai-baseline')).toBe(true)
    expect(tasks.every((t) => t.kind === 'quality')).toBe(true)
  })

  it('loadSuite 加载 dmn-regression 返回 2 个任务', () => {
    const tasks = loadSuite('dmn-regression')
    expect(tasks).toHaveLength(2)
    expect(tasks.every((t) => t.suite === 'dmn-regression')).toBe(true)
    expect(tasks.every((t) => t.kind === 'regression')).toBe(true)
  })

  it('loadSuite 未知套件抛错', () => {
    expect(() => loadSuite('unknown')).toThrow('未知套件')
  })

  it('SUITE_REGISTRY 包含两个套件', () => {
    expect(Object.keys(SUITE_REGISTRY).sort()).toEqual([
      'dmn-regression',
      'frontend-ai-baseline'
    ])
  })

  it('frontend-ai-baseline 套件任务 k=3 + passMode=any', () => {
    for (const task of frontendAiBaselineSuite) {
      expect(task.k).toBe(3)
      expect(task.passMode).toBe('any')
    }
  })

  it('dmn-regression 套件任务 k=1 + passMode=all', () => {
    for (const task of dmnRegressionSuite) {
      expect(task.k).toBe(1)
      expect(task.passMode).toBe('all')
    }
  })
})
