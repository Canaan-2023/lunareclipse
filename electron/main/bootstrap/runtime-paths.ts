/**
 * @category 核心
 * @summary 运行期路径工具（组合根）：日志路径脱敏（**本文件当前只有这一个函数**）
 *
 * 为什么存在：`redactUserPath` 被两处需要——`index.ts` 顶层的 userData 重定向/实例解析日志，
 * 与 `bootstrap/lilith-setup.ts` 的 MOD 配置读写日志。留在 `index.ts` 会让后者反向依赖入口模块，
 * 故随 ADR-01 第 2 步先行抽出。
 *
 * 什么作用：把日志/错误文本里的真实用户目录段（`C:\Users\<名>`、`/Users/<名>`、`/home/<名>`）
 * 统一替换为 `[user]`——隐私红线：日志与错误信息不得出现本机真实用户名与绝对路径。
 *
 * 不删理由：这是日志侧唯一的口径单源；删掉即两处各自实现，替换规则会分叉（漏一处就等于泄漏）。
 *
 * 后续（ADR-01 第 6 步）：本模块将补入 `applyUserDataRedirect()`（承载旧 `.userdata` 迁移与
 * `app.setPath('userData')` 的**顺序敏感副作用**，故与 `prelude.ts` 一起最后迁）。
 */
import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, renameSync } from 'fs'
import { dirname } from 'path'
import { getAppAnchor } from '../utils/app-root'
import { initInstanceRuntime } from '../multi-instance/instance-runtime'
import { instanceUserData } from '../multi-instance/instance-args'
import { parseInstanceArg } from '../multi-instance/instance-args'

/**
 * 实例参数（`--instance <name>`）解析结果。为什么在模块加载期算一次：它决定 userData 落点，
 * 必须早于任何 `app.getPath('userData')` 消费点（崩溃目录/缓存清理/config/session/browser 状态/单实例锁）。
 * Electron 单实例锁按 userData 目录计算——重定向后不同实例自动获得不同锁，多开机制成立。
 */
export const instanceArg = parseInstanceArg(process.argv)
/** 当前实例名（'default' 或具名实例），供 IPC/UI/端口逻辑读取 */
export const CURRENT_INSTANCE_NAME = instanceArg.name
/** 是否具名实例（非 default） */
export const IS_CUSTOM_INSTANCE = !instanceArg.isDefault
/**
 * 重定向前默认 userData（`instances/` 目录父级，供扫描已建实例与 spawn 新实例）。
 * 为什么保留：统一随应用锚点落项目文件夹内（dev=`app/data/userdata`、打包=exe 旁 `data/userdata`），
 * 不写 `%APPDATA%` 系统目录——随项目整体搬迁、可移植；运行时只在项目根产生 `data/` 一个数据目录
 * （业务数据 `data/abyssac_data` + Electron 运行时数据 `data/userdata` 统一收纳其下）。
 * 不删理由：删掉会退回 Electron 默认 `%APPDATA%\lunareclipse`，多实例数据散落系统目录，各机器行为不一致。
 */
export const BASE_USER_DATA = app.isPackaged
  ? join(getAppAnchor(), 'data', 'userdata')
  : join(app.getAppPath(), 'data', 'userdata')
/** 旧 userData 位置（0.50 起「去特殊化」前落在项目根的 `.userdata/`，供一次性迁移判断） */
export const LEGACY_USER_DATA = app.isPackaged
  ? join(getAppAnchor(), '.userdata')
  : join(app.getAppPath(), '.userdata')

export function redactUserPath(text: string): string {
  if (!text) return text
  return text
    .replace(/[A-Za-z]:[\\/]Users[\\/][^\s\]\\"']+/gi, '[user]')
    .replace(/\/(Users|home)\/[^\s\]\\"']+/gi, '/$1/[user]')
}

/**
 * 应用 userData 重定向：旧 `.userdata` 一次性迁移 → 实例运行时初始化 → `app.setPath('userData')`。
 *
 * **必须最先调用**（顺序敏感）：Electron 的单实例锁按 userData 目录计算，config / session /
 * 崩溃目录 / 缓存清理全部以 userData 为根——任何 `app.getPath('userData')` 消费点之前必须已完成重定向。
 * 以**显式函数调用**（而非 import 顶层副作用）暴露，使调用顺序在 `index.ts` 顶层一眼可见。
 */
export function applyUserDataRedirect(): void {
  // ===== 一次性数据目录迁移：旧 .userdata → data/userdata（0.50 起，去特殊化） =====
  // 历史版本把 Electron userData（配置/会话/浏览器状态/Chromium 缓存）落在项目根的 .userdata/。
  // 0.50 起统一并入 data/ 数据根（业务数据 data/abyssac_data + 运行时数据 data/userdata），
  // 项目根只产生 data/ 一个数据目录。首次启动旧版本目录时整体平移，避免用户配置/会话丢失。
  // 路径常量（BASE_USER_DATA / LEGACY_USER_DATA）由 bootstrap/runtime-paths.ts 提供。

  try {
    if (existsSync(LEGACY_USER_DATA) && !existsSync(BASE_USER_DATA)) {
      mkdirSync(dirname(BASE_USER_DATA), { recursive: true })
      // 同盘 rename 原子且快（旧目录可能上百 MB，复制会拖慢首次启动）；跨盘/占用失败则跳过，不阻塞启动
      renameSync(LEGACY_USER_DATA, BASE_USER_DATA)
      console.log(
        `[userdata] 已迁移旧数据目录 ${redactUserPath(LEGACY_USER_DATA)} → ${redactUserPath(BASE_USER_DATA)}`
      )
    }
  } catch (err) {
    console.warn(
      `[userdata] 旧数据目录迁移失败（跳过，重新冷启动数据）: ${redactUserPath(err instanceof Error ? err.message : String(err))}`
    )
  }

  initInstanceRuntime(instanceArg.name, BASE_USER_DATA)

  if (instanceArg.invalidReason) {
    console.warn(`[instance] ${instanceArg.invalidReason}`)
  }
  if (IS_CUSTOM_INSTANCE) {
    const customUserData = instanceUserData(BASE_USER_DATA, instanceArg.name)
    app.setPath('userData', customUserData)
    console.log(`[instance] 实例 "${instanceArg.name}" userData → ${redactUserPath(customUserData)}`)
  } else {
  // default 实例：userData 重定向到项目本地 data/userdata（随 data/ 数据根统一收纳，
    // 与 README「data/ 用户数据（业务数据 abyssac_data + 运行时数据 userdata，不进版本库）」一致），
    // dev 与打包统一走同一路径，不再回落 %APPDATA%。
    // dev 下 app.getAppPath() 实测返回 app 目录（package.json 所在处），
    // 与 getAppAnchor()（out/main → app 目录）一致，故用同一表达式；
    // 曾因多实例改造回归丢失此重定向，导致读到 %APPDATA% 下全新默认配置（parchment 素笺），
    // UI 与用户原配置（data/userdata → eclipse 月蚀深色）天差地别。
    // 【为什么保留】配置/会话/日志随项目带走，多实例隔离与单实例锁都依赖
    // userData 路径，改回 %APPDATA% 会让本地开发配置漂移、多开逻辑失效。
    // 【安全约束（0.47 打包门禁配套）】data/userdata/config.json 可能含用户在本机保存的
    // 明文 LLM API key（llm/apiKey、workflowLlm/apiKey、feishu appSecret 等）——
    // 这是开发机本地数据，已被 electron-builder files 白名单、
    // 出包前的本机自动检查（归档/门禁脚本）多重排除，
    // 任何情况都不得把 data/ 复制进打包产物或分发目录。
    const defaultUserData = BASE_USER_DATA
    app.setPath('userData', defaultUserData)
    console.log(`[userdata] default 实例 userData → ${redactUserPath(defaultUserData)}`)
  }
}
