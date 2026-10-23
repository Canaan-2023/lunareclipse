/**
 * 健康检查项注册表（0.53.10）。
 *
 * 为什么存在：旧实现把检查项写死成 `HealthCheckKey` 联合类型 + `CHECK_TO_MODULE` +
 * `health-availability` switch + 命令表多处分支。新增一项检查要改 5~6 个地方，
 * 而且 `config.checks` 里出现未知 key 会被静默忽略。
 *
 * 现在：**一项检查 = 一个定义对象**（key/label/module/默认开关/可用性/执行体/修复指引）。
 * - 新增检查：在 `BUILTIN_CHECK_DEFINITIONS` 加一个对象即可；
 * - 配置启用：`config.checks[key]=true`；
 * - 未知 key：执行时明确返回 `error`（「未知检查项」），不再静默跳过；
 * - 执行材料不齐：返回 `unavailable` + 具体缺什么。
 */
import { existsSync } from 'fs'
import { join } from 'path'
import type { HealthCheckOutcome } from '@shared/types'
import type { CheckCommandSpec } from './health-commands'

/** 单项检查的原始结果（HealthCheck 会补时间/诊断信息并汇总） */
export interface RawCheckResult {
  outcome: HealthCheckOutcome
  output: string
  reason?: string
  timedOut?: boolean
  exitCode?: number | null
  signal?: string | null
}

/** 检查执行上下文：由 HealthCheck 绑定，定义只描述「怎么做」，不持有实例状态 */
export interface CheckContext {
  workDir: string
  dataRoot: string
  packaged: boolean
  /** 已按 workDir 解析好的命令表 */
  commands: Record<string, CheckCommandSpec>
  /** 执行命令（超时/进程树/令牌由 HealthCheck 统一处理） */
  runCommand(spec: CheckCommandSpec): Promise<RawCheckResult>
  /** 在 worker 中执行语义扫描（硬超时由 runner 处理） */
  runSemantic(kind: 'code-review' | 'uiux'): Promise<RawCheckResult>
  /** 文件层检查（关键文件/残留） */
  scanFiles(): Promise<RawCheckResult>
}

export interface HealthCheckDefinition {
  /** 配置键（config.checks[key]） */
  key: string
  /** 面板展示名（主进程下发，渲染端不再维护第二份标签表） */
  label: string
  /** 默认是否启用 */
  defaultEnabled: boolean
  /** 失败时映射到的模块监控表 id */
  moduleId: string
  /** 告警里给 AI 的修复指引 */
  repairHint: string
  /**
   * 执行材料判定：返回 null = 可执行；返回字符串 = 无法执行的原因。
   * 这是「缺材料」的唯一判定点，不允许在 run 里静默跳过。
   */
  availability(workDir: string): string | null
  /** 执行检查；异常由 HealthCheck 统一捕获为 outcome=error */
  run(ctx: CheckContext): Promise<RawCheckResult>
}

const SOURCE_ROOTS = ['src', 'electron', 'shared']

function missing(workDir: string, required: string[], kind: string): string | null {
  const absent = required.filter((rel) => !existsSync(join(workDir, rel)))
  if (absent.length === 0) return null
  return `无法执行${kind}：工作区缺少 ${absent.join('、')}（${workDir}）。该状态不会被当作通过。`
}

function hasSourceRoot(workDir: string): boolean {
  return SOURCE_ROOTS.some((rel) => existsSync(join(workDir, rel)))
}

/**
 * 内置检查项。
 * 新增/删除检查项只改这个数组；UI、配置、告警、模块映射都会自动跟随。
 */
export const BUILTIN_CHECK_DEFINITIONS: HealthCheckDefinition[] = [
  {
    key: 'typecheck',
    label: '类型检查',
    defaultEnabled: true,
    moduleId: 'tools',
    repairHint: '请先定位根因，再针对性修复类型错误',
    availability: (workDir) =>
      missing(workDir, ['tsconfig.node.json', 'tsconfig.web.json', 'node_modules/typescript/bin/tsc'], '类型检查'),
    run: (ctx) => ctx.runCommand(ctx.commands.typecheck)
  },
  {
    key: 'test',
    label: '测试',
    defaultEnabled: true,
    moduleId: 'tools',
    repairHint: '请先定位失败用例的根因，再针对性修复',
    availability: (workDir) => missing(workDir, ['test', 'node_modules/vitest/vitest.mjs'], '测试'),
    run: (ctx) => ctx.runCommand(ctx.commands.test)
  },
  {
    key: 'lint',
    label: '代码规范',
    defaultEnabled: false,
    moduleId: 'tools',
    repairHint: '请按 ESLint 输出逐条修复，不要用 disable 注释掩盖问题',
    availability: (workDir) => missing(workDir, ['node_modules/eslint/bin/eslint.js', 'eslint.config.js'], '代码规范检查'),
    run: (ctx) => ctx.runCommand(ctx.commands.lint)
  },
  {
    key: 'build',
    label: '构建',
    defaultEnabled: false,
    moduleId: 'tools',
    repairHint: '请先定位构建失败的第一处错误，再针对性修复',
    availability: (workDir) =>
      missing(workDir, ['node_modules/electron-vite/bin/electron-vite.js', 'electron.vite.config.ts'], '构建'),
    run: (ctx) => ctx.runCommand(ctx.commands.build)
  },
  {
    key: 'files',
    label: '文件层',
    defaultEnabled: true,
    moduleId: 'workspace',
    repairHint: '请先定位根因，再针对性修复文件层问题',
    availability: () => null,
    run: (ctx) => ctx.scanFiles()
  },
  {
    key: 'code-review',
    label: '代码评审',
    defaultEnabled: true,
    moduleId: 'tools',
    repairHint: '请对上述问题逐条做代码评审并修复（区分真实缺陷与误报：只修确凿问题，疑似项结合上下文判断）',
    availability: (workDir) =>
      hasSourceRoot(workDir) ? null : `无法执行代码评审：工作区缺少 ${SOURCE_ROOTS.join('、')}（${workDir}）。该状态不会被当作通过。`,
    run: (ctx) => ctx.runSemantic('code-review')
  },
  {
    key: 'uiux',
    label: 'UI/UX 审计',
    defaultEnabled: true,
    moduleId: 'render-ui',
    repairHint: '请以 UI/UX 专家视角评估上述界面问题并修复（以可访问性与设计一致性为准，确属误报的在修复说明中标注排除）',
    availability: (workDir) =>
      hasSourceRoot(workDir) ? null : `无法执行UI/UX 审计：工作区缺少 ${SOURCE_ROOTS.join('、')}（${workDir}）。该状态不会被当作通过。`,
    run: (ctx) => ctx.runSemantic('uiux')
  }
]

/** 按 key 查定义（未注册返回 null） */
export function getCheckDefinition(key: string): HealthCheckDefinition | null {
  return BUILTIN_CHECK_DEFINITIONS.find((d) => d.key === key) ?? null
}

/** 默认开关表（配置缺省时使用；新增检查项自动出现） */
export function createDefaultChecks(): Record<string, boolean> {
  return Object.fromEntries(BUILTIN_CHECK_DEFINITIONS.map((d) => [d.key, d.defaultEnabled]))
}
