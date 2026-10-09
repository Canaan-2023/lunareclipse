/**
 * DMN 回归套件（regression）：覆盖记忆创建/NNG 查询/注入缓存等核心能力，
 * 目标通过率接近 100%（任何掉分即视为回归 bug），
 * 防止“昨天能做今天不能做”的能力回退。
 */
import type { EvalTask } from '../types'

/**
 * DMN 回归套件（回归评估，regression）
 *
 * 定位：
 * - 回归评估通过率必须接近 100%，任何掉分即 bug
 * - 防止"昨天能做今天不能做"
 *
 * 设计原则：
 * - 覆盖 DMN 核心能力：记忆创建 / NNG 查询 / 注入缓存
 * - k=1 + passMode='all' = Pass^1（替代人类场景，要求稳定）
 * - 期望工具调用 + 工具结果成功 双重校验
 *
 * 注意：Harness 用直接注入模式，工具名直接是真实工具名
 * （create_memory / nng_graph），无 call_tool 间接层
 */
export const dmnRegressionSuite: EvalTask[] = [
  {
    id: 'dmn-001',
    description: 'DMN 创建记忆节点',
    suite: 'dmn-regression',
    kind: 'regression',
    input: '为当前工作区创建一个 standard 类型的记忆节点，路径为 test-eval，内容为评测用临时记忆',
    expectedToolCalls: [
      { name: 'create_memory', argumentsMatch: { node_type: 'standard' } }
    ],
    expectedOutcome: {
      toolResultOk: true
    },
    k: 1,
    passMode: 'all'
  },
  {
    id: 'dmn-002',
    description: 'DMN 查询 NNG 图谱',
    suite: 'dmn-regression',
    kind: 'regression',
    input: '查询当前工作区的 NNG 图谱结构',
    expectedToolCalls: [{ name: 'nng_graph' }],
    expectedOutcome: {
      toolResultOk: true
    },
    k: 1,
    passMode: 'all'
  }
]
