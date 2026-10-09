/**
 * 前端 AI 能力基线套件（quality）：以窄任务 + 期望工具调用/结果双重校验
 * 评估前端 Agent 尚未稳定的能力，通过率目标 30-50%，
 * 是能力验收与后续“毕业”为回归套件的任务来源。
 */
import type { EvalTask } from '../types'

/**
 * 前端 AI 基线套件（能力评估，quality）
 *
 * 定位：
 * - 能力评估初始通过率目标 30-50%，聚焦尚未稳定的能力
 * - 通过率持续高于 50% 后"毕业"为回归套件，新增更难的任务
 *
 * 设计原则：
 * - 每个任务单一窄任务（step 1）
 * - 期望工具调用 + 期望结果同时校验，确保"过程对+结果对"
 * - k=3 + passMode='any' = Pass@3（辅助人类场景，允许发散）
 */
export const frontendAiBaselineSuite: EvalTask[] = [
  {
    id: 'fa-001',
    description: '读取文件并总结内容',
    suite: 'frontend-ai-baseline',
    kind: 'quality',
    input: '读取 package.json 并告诉我项目名称和版本号',
    expectedToolCalls: [
      { name: 'Read', argumentsMatch: { file_path: 'package.json' } }
    ],
    expectedOutcome: {
      outputContains: ['lunareclipse', '0.1.0']
    },
    k: 3,
    passMode: 'any'
  },
  {
    id: 'fa-002',
    description: '搜索代码并报告位置',
    suite: 'frontend-ai-baseline',
    kind: 'quality',
    input: '搜索项目中所有包含 "HookManager" 的文件',
    expectedToolCalls: [
      { name: 'Grep', argumentsMatch: { pattern: 'HookManager' } }
    ],
    expectedOutcome: {
      outputContains: ['hook-manager']
    },
    k: 3,
    passMode: 'any'
  },
  {
    id: 'fa-003',
    description: '编辑文件并保留结构',
    suite: 'frontend-ai-baseline',
    kind: 'quality',
    // 注：用 data/userdata 临时目录避免污染源码树（评测后不清理，下次评测覆盖）
    input: '在 data/userdata/ 目录创建一个临时文件 eval-temp.ts，内容为 export const hello = "world"',
    expectedToolCalls: [{ name: 'Write' }],
    expectedOutcome: {
      toolResultOk: true
    },
    k: 3,
    passMode: 'any'
  }
]
