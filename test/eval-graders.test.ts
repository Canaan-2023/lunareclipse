import { describe, it, expect, beforeEach } from 'vitest'
import { CodeGrader } from '../electron/main/eval/graders/code-grader'
import type { EvalTask, Transcript } from '../electron/main/eval/types'

/**
 * L6 验证层：CodeGrader 单元测试
 *
 * 覆盖 3 个轴：
 * - task_completion：outputContains / toolResultOk / 空响应
 * - tool_selection：工具名匹配 / 参数子集匹配 / 缺失
 * - cost_latency：token/耗时/成本阈值
 */
describe('CodeGrader', () => {
  let grader: CodeGrader

  beforeEach(() => {
    grader = new CodeGrader()
  })

  // ===== task_completion 轴 =====
  describe('gradeTaskCompletion', () => {
    it('无 expectedOutcome：检查 AI 是否给出非空响应', () => {
      const task: EvalTask = {
        id: 't1',
        description: '测试',
        suite: 'test',
        kind: 'quality',
        input: 'hi'
      }
      const transcript: Transcript = {
        taskId: 't1',
        trial: 1,
        steps: [
          { role: 'user', content: 'hi', timestamp: Date.now() },
          { role: 'assistant', content: '你好', timestamp: Date.now() }
        ],
        totalTokens: 10,
        totalDurationMs: 100,
        estimatedCost: 0.001
      }
      const result = grader.gradeTaskCompletion(task, transcript)
      expect(result.axis).toBe('task_completion')
      expect(result.grader).toBe('code')
      expect(result.pass).toBe(true)
      expect(result.score).toBe(1)
    })

    it('无 expectedOutcome：AI 响应为空则 fail', () => {
      const task: EvalTask = {
        id: 't2',
        description: '测试',
        suite: 'test',
        kind: 'quality',
        input: 'hi'
      }
      const transcript: Transcript = {
        taskId: 't2',
        trial: 1,
        steps: [{ role: 'user', content: 'hi', timestamp: Date.now() }],
        totalTokens: 5,
        totalDurationMs: 50,
        estimatedCost: 0.001
      }
      const result = grader.gradeTaskCompletion(task, transcript)
      expect(result.pass).toBe(false)
      expect(result.score).toBe(0)
    })

    it('outputContains：包含所有关键词则 pass', () => {
      const task: EvalTask = {
        id: 't3',
        description: '读取 package.json',
        suite: 'test',
        kind: 'quality',
        input: '读取 package.json',
        expectedOutcome: {
          outputContains: ['lunareclipse', '0.1.0']
        }
      }
      const transcript: Transcript = {
        taskId: 't3',
        trial: 1,
        steps: [
          { role: 'user', content: '读取 package.json', timestamp: Date.now() },
          {
            role: 'assistant',
            content: '项目名是 lunareclipse，版本号 0.1.0',
            timestamp: Date.now()
          }
        ],
        totalTokens: 20,
        totalDurationMs: 100,
        estimatedCost: 0.001
      }
      const result = grader.gradeTaskCompletion(task, transcript)
      expect(result.pass).toBe(true)
    })

    it('outputContains：缺失任一关键词则 fail', () => {
      const task: EvalTask = {
        id: 't4',
        description: '读取 package.json',
        suite: 'test',
        kind: 'quality',
        input: '读取 package.json',
        expectedOutcome: {
          outputContains: ['lunareclipse', '0.1.0']
        }
      }
      const transcript: Transcript = {
        taskId: 't4',
        trial: 1,
        steps: [
          { role: 'user', content: '读取 package.json', timestamp: Date.now() },
          {
            role: 'assistant',
            content: '项目名是 lunareclipse，但没说版本',
            timestamp: Date.now()
          }
        ],
        totalTokens: 15,
        totalDurationMs: 80,
        estimatedCost: 0.001
      }
      const result = grader.gradeTaskCompletion(task, transcript)
      expect(result.pass).toBe(false)
      expect(result.reason).toContain('0.1.0')
    })

    it('toolResultOk=true：所有工具结果成功则 pass', () => {
      const task: EvalTask = {
        id: 't5',
        description: '测试工具结果',
        suite: 'test',
        kind: 'quality',
        input: '调用工具',
        expectedOutcome: { toolResultOk: true }
      }
      const transcript: Transcript = {
        taskId: 't5',
        trial: 1,
        steps: [
          { role: 'user', content: '调用工具', timestamp: Date.now() },
          {
            role: 'assistant',
            content: '调用 read',
            toolCalls: [{ name: 'read', arguments: { path: 'foo' } }],
            timestamp: Date.now()
          },
          {
            role: 'tool',
            content: 'OK',
            toolResult: { ok: true, data: 'content' },
            timestamp: Date.now()
          }
        ],
        totalTokens: 30,
        totalDurationMs: 150,
        estimatedCost: 0.002
      }
      const result = grader.gradeTaskCompletion(task, transcript)
      expect(result.pass).toBe(true)
    })

    it('toolResultOk=true：有失败的工具结果则 fail', () => {
      const task: EvalTask = {
        id: 't6',
        description: '测试工具结果',
        suite: 'test',
        kind: 'quality',
        input: '调用工具',
        expectedOutcome: { toolResultOk: true }
      }
      const transcript: Transcript = {
        taskId: 't6',
        trial: 1,
        steps: [
          { role: 'user', content: '调用工具', timestamp: Date.now() },
          {
            role: 'assistant',
            content: '调用 read',
            toolCalls: [{ name: 'read', arguments: { path: 'foo' } }],
            timestamp: Date.now()
          },
          {
            role: 'tool',
            content: 'FAIL',
            toolResult: { ok: false, error: '文件不存在' },
            timestamp: Date.now()
          }
        ],
        totalTokens: 25,
        totalDurationMs: 120,
        estimatedCost: 0.002
      }
      const result = grader.gradeTaskCompletion(task, transcript)
      expect(result.pass).toBe(false)
    })

    it('toolResultOk=true：无任何工具调用则 fail', () => {
      const task: EvalTask = {
        id: 't7',
        description: '要求工具调用',
        suite: 'test',
        kind: 'quality',
        input: '调用工具',
        expectedOutcome: { toolResultOk: true }
      }
      const transcript: Transcript = {
        taskId: 't7',
        trial: 1,
        steps: [
          { role: 'user', content: '调用工具', timestamp: Date.now() },
          { role: 'assistant', content: '好的', timestamp: Date.now() }
        ],
        totalTokens: 10,
        totalDurationMs: 50,
        estimatedCost: 0.001
      }
      const result = grader.gradeTaskCompletion(task, transcript)
      expect(result.pass).toBe(false)
    })
  })

  // ===== tool_selection 轴 =====
  describe('gradeToolSelection', () => {
    it('无 expectedToolCalls：跳过且 pass', () => {
      const task: EvalTask = {
        id: 'ts1',
        description: '无工具期望',
        suite: 'test',
        kind: 'quality',
        input: 'hi'
      }
      const transcript: Transcript = {
        taskId: 'ts1',
        trial: 1,
        steps: [{ role: 'user', content: 'hi', timestamp: Date.now() }],
        totalTokens: 5,
        totalDurationMs: 50,
        estimatedCost: 0
      }
      const result = grader.gradeToolSelection(task, transcript)
      expect(result.pass).toBe(true)
      expect(result.score).toBe(1)
      expect(result.reason).toContain('跳过')
    })

    it('工具名匹配 + 参数子集匹配：pass', () => {
      const task: EvalTask = {
        id: 'ts2',
        description: '期望调用 read',
        suite: 'test',
        kind: 'quality',
        input: '读取文件',
        expectedToolCalls: [
          { name: 'read', argumentsMatch: { file_path: 'package.json' } }
        ]
      }
      const transcript: Transcript = {
        taskId: 'ts2',
        trial: 1,
        steps: [
          { role: 'user', content: '读取文件', timestamp: Date.now() },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { name: 'read', arguments: { file_path: 'package.json', extra: 'x' } }
            ],
            timestamp: Date.now()
          }
        ],
        totalTokens: 20,
        totalDurationMs: 100,
        estimatedCost: 0.001
      }
      const result = grader.gradeToolSelection(task, transcript)
      expect(result.pass).toBe(true)
      expect(result.score).toBe(1)
    })

    it('工具名匹配但参数不匹配：fail', () => {
      const task: EvalTask = {
        id: 'ts3',
        description: '期望参数 file_path=package.json',
        suite: 'test',
        kind: 'quality',
        input: '读取文件',
        expectedToolCalls: [
          { name: 'read', argumentsMatch: { file_path: 'package.json' } }
        ]
      }
      const transcript: Transcript = {
        taskId: 'ts3',
        trial: 1,
        steps: [
          { role: 'user', content: '读取文件', timestamp: Date.now() },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ name: 'read', arguments: { file_path: 'other.json' } }],
            timestamp: Date.now()
          }
        ],
        totalTokens: 20,
        totalDurationMs: 100,
        estimatedCost: 0.001
      }
      const result = grader.gradeToolSelection(task, transcript)
      expect(result.pass).toBe(false)
      expect(result.score).toBe(0)
      expect(result.reason).toContain('file_path')
    })

    it('工具名不匹配：fail', () => {
      const task: EvalTask = {
        id: 'ts4',
        description: '期望 read',
        suite: 'test',
        kind: 'quality',
        input: '读取文件',
        expectedToolCalls: [{ name: 'read' }]
      }
      const transcript: Transcript = {
        taskId: 'ts4',
        trial: 1,
        steps: [
          { role: 'user', content: '读取文件', timestamp: Date.now() },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ name: 'grep', arguments: {} }],
            timestamp: Date.now()
          }
        ],
        totalTokens: 20,
        totalDurationMs: 100,
        estimatedCost: 0.001
      }
      const result = grader.gradeToolSelection(task, transcript)
      expect(result.pass).toBe(false)
      expect(result.reason).toContain('grep')
      expect(result.reason).toContain('read')
    })

    it('工具调用缺失：fail', () => {
      const task: EvalTask = {
        id: 'ts5',
        description: '期望 read',
        suite: 'test',
        kind: 'quality',
        input: '读取文件',
        expectedToolCalls: [{ name: 'read' }, { name: 'grep' }]
      }
      const transcript: Transcript = {
        taskId: 'ts5',
        trial: 1,
        steps: [
          { role: 'user', content: '读取文件', timestamp: Date.now() },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ name: 'read', arguments: {} }],
            timestamp: Date.now()
          }
        ],
        totalTokens: 20,
        totalDurationMs: 100,
        estimatedCost: 0.001
      }
      const result = grader.gradeToolSelection(task, transcript)
      expect(result.pass).toBe(false)
      expect(result.score).toBe(0.5)
      expect(result.reason).toContain('缺失')
    })
  })

  // ===== cost_latency 轴 =====
  describe('gradeCostLatency', () => {
    it('所有指标在阈值内：pass', () => {
      const transcript: Transcript = {
        taskId: 'cl1',
        trial: 1,
        steps: [],
        totalTokens: 1000,
        totalDurationMs: 5000,
        estimatedCost: 0.01
      }
      const result = grader.gradeCostLatency(transcript, {
        maxTokens: 5000,
        maxMs: 10000,
        maxCost: 0.05
      })
      expect(result.pass).toBe(true)
      expect(result.reason).toContain('在阈值内')
    })

    it('token 超阈值：fail', () => {
      const transcript: Transcript = {
        taskId: 'cl2',
        trial: 1,
        steps: [],
        totalTokens: 60000,
        totalDurationMs: 5000,
        estimatedCost: 0.01
      }
      const result = grader.gradeCostLatency(transcript, {
        maxTokens: 50000,
        maxMs: 60000,
        maxCost: 0.5
      })
      expect(result.pass).toBe(false)
      expect(result.reason).toContain('token')
      expect(result.reason).toContain('60000')
    })

    it('耗时超阈值：fail', () => {
      const transcript: Transcript = {
        taskId: 'cl3',
        trial: 1,
        steps: [],
        totalTokens: 100,
        totalDurationMs: 70000,
        estimatedCost: 0.01
      }
      const result = grader.gradeCostLatency(transcript, {
        maxTokens: 50000,
        maxMs: 60000,
        maxCost: 0.5
      })
      expect(result.pass).toBe(false)
      expect(result.reason).toContain('耗时')
    })

    it('成本超阈值：fail', () => {
      const transcript: Transcript = {
        taskId: 'cl4',
        trial: 1,
        steps: [],
        totalTokens: 100,
        totalDurationMs: 1000,
        estimatedCost: 0.7
      }
      const result = grader.gradeCostLatency(transcript, {
        maxTokens: 50000,
        maxMs: 60000,
        maxCost: 0.5
      })
      expect(result.pass).toBe(false)
      expect(result.reason).toContain('成本')
    })

    it('未配置阈值：全部 pass', () => {
      const transcript: Transcript = {
        taskId: 'cl5',
        trial: 1,
        steps: [],
        totalTokens: 999999,
        totalDurationMs: 999999,
        estimatedCost: 999
      }
      const result = grader.gradeCostLatency(transcript, {})
      expect(result.pass).toBe(true)
    })

    it('部分阈值配置：仅检查已配置项', () => {
      const transcript: Transcript = {
        taskId: 'cl6',
        trial: 1,
        steps: [],
        totalTokens: 100,
        totalDurationMs: 999999,
        estimatedCost: 0.01
      }
      const result = grader.gradeCostLatency(transcript, { maxTokens: 50000 })
      expect(result.pass).toBe(true)
    })
  })
})
