/**
 * 健康检查命令表（从 health-check.ts 拆出，0.53.10 体量让位）。
 *
 * 为什么不用 `npm run`：机器可能没有全局 npm，主进程 exec 裸调 npm 会 ENOENT。
 * 这里改为「便携 node 直接跑 node_modules 里的工具入口」，语义与 package.json scripts 一一等价。
 * 命令只负责「怎么跑」，是否可跑由 health-check-registry.ts 的 availability 判定。
 */
import { resolveNodeExe } from '../utils/node-runtime'
import { detectHardware, deriveConcurrency } from '../utils/hardware-profiler'

/**
 * 内置命令检查项。新增纯命令检查时：这里加 key + 命令，
 * 再到 health-check-registry.ts 加一个定义对象（两处都是显式声明，不靠隐式 switch）。
 */
export type CommandCheckKey = 'typecheck' | 'test' | 'lint' | 'build'

/**
 * Windows 下把绝对路径的盘符统一为大写。
 * 背景：Electron 的 app.getAppPath()/process.execPath 可能返回小写盘符（d:\...），
 * 而 vite-node 在 worker 侧解析 node_modules 时输出大写盘符（D:/...）。Node ESM
 * 模块缓存以 URL 字符串（含盘符大小写）为 key，同一物理文件会因此被实例化两次，
 * vitest 的 chunk 模块级状态（runner/defaultSuite）随之分裂——collect 在实例 A 设置
 * runner，测试文件 import 'vitest' 在实例 B 执行 describe，B 的 runner 永远 undefined，
 * 表现为此前反复出现的 127 全灭 `TypeError: reading 'config'`。统一 exec 链路的
 * 盘符大小写（node 可执行文件 + cwd）即消除双实例。
 */
export function normalizeDriveUpper(p: string): string {
  return /^[a-zA-Z]:[\\/]/.test(p) ? `${p[0].toUpperCase()}${p.slice(1)}` : p
}

/** 走外部命令的检查项（files/code-review/uiux 走静态检查，不走命令）。 */


export interface CheckCommandSpec {
  cmd: string
  timeoutMs: number
}

export const COMMAND_CHECK_KEYS: CommandCheckKey[] = ['typecheck', 'test', 'lint', 'build']

/**
 * 命令超时预算（不写裸数字）：
 * - typecheck/lint 180s：本机全量约 10~30s，留 6~18 倍余量给冷缓存/低配机/杀软扫描；
 * - test/build 300s：本机全量 test 约 40s、build 约 10s，留 7~30 倍余量。
 * 为什么不再短：健康检查在后台跑，误杀正常构建/测试会把「机器慢」变成假失败；
 * 为什么不再长：超过 5 分钟仍无输出，通常是 worker 死锁/网络挂起，继续等没有诊断价值。
 */
const TYPECHECK_TIMEOUT_MS = 180_000
const LINT_TIMEOUT_MS = 180_000
const TEST_TIMEOUT_MS = 300_000
const BUILD_TIMEOUT_MS = 300_000

export function buildCheckCommands(workDir: string): Record<CommandCheckKey, CheckCommandSpec> {
  const node = normalizeDriveUpper(resolveNodeExe(workDir))
  const n = (script: string): string => `"${node}" ${script}`
  // 测试并发不写死：按本机硬件（逻辑核/内存）自动推导，换机器自动适配。
  // 默认策略留一半核给系统与前台（App 运行中后台跑测试不挤占 UI），见 hardware-profiler。
  const testWorkers = deriveConcurrency(detectHardware())
  return {
    // = npm run typecheck（typecheck:node && typecheck:web）
    typecheck: {
      cmd: `${n('node_modules\\typescript\\bin\\tsc --noEmit -p tsconfig.node.json --composite false')} && ${n('node_modules\\typescript\\bin\\tsc --noEmit -p tsconfig.web.json --composite false')}`,
      timeoutMs: TYPECHECK_TIMEOUT_MS
    },
    // = npm run test:unit（排除 e2e 网络测试——依赖真实网络，网络抖动会误报失败）
    // 出包门禁回归单测已迁至仓库根 build/test/，日常自检只跑 app 侧单元测试。
    // 并行优化：原 --no-file-parallelism 强制单文件串行，全量约 102s → 改为 forks 并行，
    // worker 数由硬件自动推导（本机 32 核默认策略→16 worker，实测约 15-20s，留一半核给前台）。
    // 排障实录：曾临时改 --pool=threads 对照（threads 同样 127 全灭，证伪子进程链路；
    // 真因是 Windows 盘符大小写导致 Node ESM 双实例，见 normalizeDriveUpper 注释）。
    test: {
      cmd: `${n(`node_modules\\vitest\\vitest.mjs run --exclude "test/e2e-*.test.ts" --pool=forks --maxWorkers=${testWorkers}`)}`,
      timeoutMs: TEST_TIMEOUT_MS
    },
    // = npm run lint
    lint: { cmd: n('node_modules\\eslint\\bin\\eslint.js . --ext .ts,.tsx'), timeoutMs: LINT_TIMEOUT_MS },
    // = npm run build
    build: { cmd: n('node_modules\\electron-vite\\bin\\electron-vite.js build'), timeoutMs: BUILD_TIMEOUT_MS }
  }
}
