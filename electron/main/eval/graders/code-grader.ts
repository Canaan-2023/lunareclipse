/**
 * 代码型评分器：对任务完成、工具选择、成本耗时三轴做客观可复现的
 * 自动判定（输出关键词/工具调用对比/文件存在与内容检查/统计），
 * 避免主观打分，是评测中与 LLM-as-judge 互补的基础评分手段。
 */
import type { EvalTask, Transcript, GradeResult } from '../types'
import { existsSync, readFileSync } from 'fs'
import { isAbsolute, join } from 'path'

/**
 * 文件系统检查函数类型（可注入，便于测试 mock）

 * 默认实现用 fs.exists + fs.readFile + 正则匹配。
 * harness 可注入自定义实现（如限制工作区根目录）。
 */
export interface FsChecker {
  exists(path: string): boolean
  contentMatches(path: string, pattern: string): boolean
}

/** 默认 fs 检查器：相对路径按 workspacePath 解析 */
export function createDefaultFsChecker(workspacePath?: string): FsChecker {
  const resolve = (p: string) => (isAbsolute(p) || !workspacePath ? p : join(workspacePath, p))
  return {
    exists(path: string): boolean {
      try {
        return existsSync(resolve(path))
      } catch {
        return false
      }
    },
    contentMatches(path: string, pattern: string): boolean {
      try {
        const content = readFileSync(resolve(path), 'utf-8')
        return new RegExp(pattern).test(content)
      } catch {
        return false
      }
    }
  }
}

/**
 * 代码型评分器（第一类）

 * 速度快、客观、可复现。用于 3 个轴：
 * - task_completion：expectedOutcome 检查（输出包含关键词/工具结果成功/文件存在/文件内容匹配）
 * - tool_selection：expectedToolCalls 对比（工具名匹配 + 参数子集匹配）
 * - cost_latency：token 和时间统计

 * 不用于 trajectory_quality（需 LLM-as-judge）
 */
export class CodeGrader {
  constructor(private fsChecker?: FsChecker) {}

  /** 任务完成度评分 */
  gradeTaskCompletion(task: EvalTask, transcript: Transcript): GradeResult {
    const start = Date.now()
    if (!task.expectedOutcome) {
      // 无期望结果定义，仅检查 AI 是否给出了非空响应
      const lastAssistant = transcript.steps.filter((s) => s.role === 'assistant').pop()
      const pass = !!lastAssistant?.content?.trim()
      return {
        axis: 'task_completion',
        grader: 'code',
        pass,
        score: pass ? 1 : 0,
        reason: pass ? 'AI 给出了响应' : 'AI 未给出响应',
        durationMs: Date.now() - start
      }
    }

    const checks: string[] = []
    let allPass = true

    // AI 输出包含关键词
    if (task.expectedOutcome.outputContains) {
      const lastAssistant = transcript.steps.filter((s) => s.role === 'assistant').pop()
      const output = lastAssistant?.content ?? ''
      for (const kw of task.expectedOutcome.outputContains) {
        const found = output.includes(kw)
        checks.push(`输出包含"${kw}": ${found ? '✓' : '✗'}`)
        if (!found) allPass = false
      }
    }

    // 工具结果成功
    if (task.expectedOutcome.toolResultOk !== undefined) {
      const toolSteps = transcript.steps.filter((s) => s.role === 'tool')
      const allOk = toolSteps.length > 0 && toolSteps.every((s) => s.toolResult?.ok === true)
      // toolResultOk=true：要求有工具调用且全部成功
      // toolResultOk=false：要求有工具调用且至少一个失败（无工具调用则 fail，因为无法判断"失败"）
      const pass = task.expectedOutcome.toolResultOk
        ? allOk
        : toolSteps.length > 0 && !allOk
      checks.push(`工具结果全部成功: ${pass ? '✓' : '✗'}`)
      if (!pass) allPass = false
    }

    // 文件存在检查（需 fsChecker 注入）
    if (task.expectedOutcome.fileExists && this.fsChecker) {
      for (const f of task.expectedOutcome.fileExists) {
        const exists = this.fsChecker.exists(f)
        checks.push(`文件存在 ${f}: ${exists ? '✓' : '✗'}`)
        if (!exists) allPass = false
      }
    }

    // 文件内容正则匹配（需 fsChecker 注入）
    if (task.expectedOutcome.fileContentMatches && this.fsChecker) {
      for (const m of task.expectedOutcome.fileContentMatches) {
        const matched = this.fsChecker.contentMatches(m.path, m.pattern)
        checks.push(`文件 ${m.path} 匹配 /${m.pattern}/: ${matched ? '✓' : '✗'}`)
        if (!matched) allPass = false
      }
    }

    return {
      axis: 'task_completion',
      grader: 'code',
      pass: allPass,
      score: allPass ? 1 : 0,
      reason: checks.join('; '),
      durationMs: Date.now() - start
    }
  }

  /** 工具选择准确性评分 */
  gradeToolSelection(task: EvalTask, transcript: Transcript): GradeResult {
    const start = Date.now()
    if (!task.expectedToolCalls || task.expectedToolCalls.length === 0) {
      return {
        axis: 'tool_selection',
        grader: 'code',
        pass: true,
        score: 1,
        reason: '未定义期望工具调用，跳过',
        durationMs: Date.now() - start
      }
    }

    const actualCalls = transcript.steps
      .filter((s) => s.role === 'assistant' && s.toolCalls)
      .flatMap((s) => s.toolCalls!)

    const expected = task.expectedToolCalls
    let matched = 0
    const details: string[] = []

    for (let i = 0; i < expected.length; i++) {
      const exp = expected[i]
      const act = actualCalls[i]
      if (!act) {
        details.push(`第 ${i + 1} 步：缺失（期望 ${exp.name}）`)
        continue
      }
      if (act.name !== exp.name) {
        details.push(`第 ${i + 1} 步：调用了 ${act.name}，期望 ${exp.name}`)
        continue
      }
      // 参数子集匹配：期望的 key-value 必须在实际参数中找到
      let argsMatch = true
      if (exp.argumentsMatch) {
        for (const [k, v] of Object.entries(exp.argumentsMatch)) {
          if (JSON.stringify(act.arguments[k]) !== JSON.stringify(v)) {
            argsMatch = false
            details.push(`第 ${i + 1} 步：参数 ${k} 不匹配`)
            break
          }
        }
      }
      if (argsMatch) {
        matched++
        details.push(`第 ${i + 1} 步：✓ ${exp.name}`)
      }
    }

    const score = expected.length > 0 ? matched / expected.length : 1
    return {
      axis: 'tool_selection',
      grader: 'code',
      pass: score === 1,
      score,
      reason: details.join('; '),
      durationMs: Date.now() - start
    }
  }

  /** 成本/延迟评分（基于 transcript 聚合） */
  gradeCostLatency(
    transcript: Transcript,
    thresholds: { maxTokens?: number; maxMs?: number; maxCost?: number }
  ): GradeResult {
    const start = Date.now()
    const checks: string[] = []
    let pass = true

    if (thresholds.maxTokens !== undefined && transcript.totalTokens > thresholds.maxTokens) {
      checks.push(`token ${transcript.totalTokens} > ${thresholds.maxTokens}`)
      pass = false
    }
    if (thresholds.maxMs !== undefined && transcript.totalDurationMs > thresholds.maxMs) {
      checks.push(`耗时 ${transcript.totalDurationMs}ms > ${thresholds.maxMs}ms`)
      pass = false
    }
    if (thresholds.maxCost !== undefined && transcript.estimatedCost > thresholds.maxCost) {
      checks.push(`成本 $${transcript.estimatedCost.toFixed(4)} > $${thresholds.maxCost}`)
      pass = false
    }

    return {
      axis: 'cost_latency',
      grader: 'code',
      pass,
      score: pass ? 1 : 0,
      reason: checks.length > 0 ? checks.join('; ') : '在阈值内',
      durationMs: Date.now() - start
    }
  }
}
