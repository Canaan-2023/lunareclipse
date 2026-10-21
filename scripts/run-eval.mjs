#!/usr/bin/env node
/**
 * L6 验证层：CI 集成脚本
 *
 * 门禁机制：
 * - eval-on-PR：每次提交运行回归套件
 * - 通过率低于门禁则退出码 1（阻断合并）
 *
 * 用法：
 *   node scripts/run-eval.mjs                              # 跑默认回归套件，门禁 0.95
 *   node scripts/run-eval.mjs --suite=dmn-regression      # 指定套件
 *   node scripts/run-eval.mjs --gate=0.9                  # 调整门禁
 *   node scripts/run-eval.mjs --suite=frontend-ai-baseline --gate=0.3
 *
 * 实现说明：
 * 月蚀是 Electron 桌面应用，EvalHarness 依赖 Electron 主进程模块（LLMClient/ConfigStore/ToolRegistry）。
 * CI 场景下不便启动完整 Electron 进程，因此本脚本通过 vitest 跑 eval 测试套件
 * （test/eval-harness.test.ts 内 mock LLMClient，验证轨迹记录和评分流程）。
 * 真实 LLM 评测请在应用内通过设置面板触发（IPC: eval:runSuite）。
 *
 * 退出码：
 *   0 = 通过（passRate >= gate）
 *   1 = 失败（passRate < gate）
 *   2 = 运行错误（套件不存在/测试崩溃）
 */
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// 解析命令行参数
const args = process.argv.slice(2)
const suiteArg = args.find((a) => a.startsWith('--suite='))?.split('=')[1] ?? 'dmn-regression'
const gateArg = parseFloat(args.find((a) => a.startsWith('--gate='))?.split('=')[1] ?? '0.95')
const verbose = args.includes('--verbose')

// 套件 → 测试文件映射
const SUITE_TEST_MAP = {
  'dmn-regression': 'test/eval-harness.test.ts',
  'frontend-ai-baseline': 'test/eval-harness.test.ts'
}

const testFile = SUITE_TEST_MAP[suiteArg]
if (!testFile) {
  console.error(`✗ 未知套件: ${suiteArg}`)
  console.error(`  可用套件: ${Object.keys(SUITE_TEST_MAP).join(', ')}`)
  process.exit(2)
}

console.log(`=== L6 评测 CI 集成 ===`)
console.log(`套件: ${suiteArg}`)
console.log(`门禁: ${(gateArg * 100).toFixed(1)}%`)
console.log(`测试文件: ${testFile}`)
console.log()
// 2026-10-17（分发前审查 · AI 工程面）：明确本门禁的语义边界。
// 本脚本跑的是 mock LLM 驱动的评测**管线**测试（EvalHarness 调度/评分器/聚合/Pass@k 聚合逻辑），
// 它证明「评测链路可用、聚合口径正确」，**不度量模型质量**——mock 的应答是预设的，
// 通过率必然接近 100%，与真实模型表现无关。
// 真实模型质量评测（frontend-ai-baseline / dmn-regression 套件）须在应用内触发
// （IPC: eval:runSuite，真实 LLMClient + 真实任务集），其结论才可作为能力/回归判据。
// 本脚本的 gate 只用于「评测管线未被改坏」的防回归，不得当作模型质量门禁引用。
console.log('[语义说明] 本门禁校验评测管线（mock 驱动），非模型质量指标；模型质量评测请在应用内触发。')
console.log()

// 通过 vitest 跑 eval 测试
// vitest 配置在 app/vitest.config.ts，cwd 应为 app 目录
const appDir = resolve(__dirname, '..')
// Windows 下 node_modules/.bin/vitest 是无扩展名 sh 脚本，spawnSync 直接执行会 ENOENT（exit null），
// 统一改用 node 直跑 vitest.mjs 入口（process.execPath 跨平台稳定）——本脚本在 CI 中按此方式调用。
const vitestEntry = resolve(appDir, 'node_modules', 'vitest', 'vitest.mjs')

const result = spawnSync(
  process.execPath,
  [vitestEntry, 'run', testFile, '--reporter=verbose'],
  {
    cwd: appDir,
    stdio: verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    env: {
      ...process.env,
      EVAL_SUITE: suiteArg,
      EVAL_GATE: String(gateArg)
    }
  }
)

if (result.status !== 0) {
  console.error(`✗ 评测测试失败（exit ${result.status}）`)
  if (!verbose && result.stdout) console.log(result.stdout)
  if (!verbose && result.stderr) console.error(result.stderr)
  process.exit(1)
}

// 解析测试输出查找通过率
const output = (result.stdout ?? '') + (result.stderr ?? '')
const passRateMatch = output.match(/taskPassRate[=:]\s*([\d.]+)/)
const passRate = passRateMatch ? parseFloat(passRateMatch[1]) : null

if (passRate === null) {
  console.log('✓ 评测管线自检通过（未找到通过率指标，按测试通过判定）')
  process.exit(0)
}

console.log()
console.log(`管线自检通过率（mock 驱动，非模型质量）: ${(passRate * 100).toFixed(1)}%`)

if (passRate < gateArg) {
  console.error(`✗ 管线自检通过率 ${(passRate * 100).toFixed(1)}% 低于门禁 ${(gateArg * 100).toFixed(1)}%`)
  process.exit(1)
}

console.log(`✓ 评测管线自检通过（${(passRate * 100).toFixed(1)}% >= 门禁 ${(gateArg * 100).toFixed(1)}%）`)
process.exit(0)
