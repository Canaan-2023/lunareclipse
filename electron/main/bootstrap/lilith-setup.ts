/**
 * @category 核心
 * @summary 莉莉丝链路装配（启动编排原子 ⑪a~c + 按需补同步）
 *
 * 为什么存在：莉莉丝三件事（MOD 配置桥接 / 适配器 / 自动拉起桌宠）此前内联在 `index.ts` 的
 * 装配体内，合计约 190 行，且都要读 `AppState` 的莉莉丝字段——留在入口模块会让「入口」
 * 同时承担跨应用契约（MOD 配置路径/协议）与业务装配两种职责（ADR-01 第 2 步）。
 *
 * 什么作用：导出四个能力点——`runLilithBridgeNow`（用户手动启动桌宠时按需补同步，IPC 回调用）、
 * `initLilithBridge`（把月蚀 API 端口写进 MOD 配置并触发 companion reload）、
 * `initLilithAdapter`（可选适配器模式）、`initLilithAutoStart`（按配置自动拉起桌宠）。
 *
 * 不删理由：`runLilithBridgeNow` 是「关掉『随月蚀启动』+ 手动启动桌宠」这条正常用法的唯一
 * 补同步入口，删掉即该用法静默断链（MOD companion 在游戏启动时把 config 缓存在内存，
 * 只写文件它读不到，必须 `POST /v1/control {action:'reload'}` 才生效）。
 *
 * 与 `AppState` 的关系：读写 `state.apiPortForLilithBridge` / `state.lilithAdapter` /
 * `state.lilithLlmClient`；其余依赖（`configStore` / `sessionStore` / `rootCtx`）经 `deps` 注入。
 */
import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import http from 'http'
import type { AppConfig } from '@shared/types'
import type { BaseDataPaths } from '../models/paths'
import type { Context } from '../kernel/cordis-runtime'
import type { ConfigStore } from '../api/config-store'
import type { SessionStore } from '../api/session-store'
import { LLMClient } from '../api/llm'
import { lilithEnabled } from '../api/lilith-session'
import { getHeadlessChatRunner, getGeoEnvText, SYSTEM_INJECTED_SESSION_ID } from '../api/server'
import { hasMod as lilithHasMod, launch as lilithLaunch } from '../services/lilith-launcher'
import type { AppState } from './app-state'
import { redactUserPath } from './runtime-paths'

/** 莉莉丝装配依赖（非 AppState 的部分） */
export interface LilithSetupDeps {
  configStore: ConfigStore
  sessionStore: SessionStore
  /** Cordis 根上下文：`rootCtx.lilith` 为适配器门面（未挂载时 `featurePlugins` 判定禁用 → 走默认 companion 链路） */
  rootCtx: Context
}

/**
 * 进程存活判定：`process.kill(pid, 0)` 只发信号 0（不实际杀进程）。
 * 为什么不能只看 runtime.json 存在：companion 退出后文件不删，「文件存在」≠「进程在跑」，
 * 只凭文件就发 reload 会把「本来就没开」误报成「reload 失败」，每次冷启动打一行假失败。
 * EPERM 表示进程存在但当前进程无权操作（如系统级进程）→ 按存活处理，不误判成未运行。
 */
function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 莉莉丝桥接的按需触发（用户主动启动桌宠时由 IPC 调用）。
 * 为什么存在：桥接 =「写 MOD 配置 + 通知已运行的 companion 重读」，两者是一次原子动作
 * （companion 在游戏启动时把 config 缓存在内存里，只写文件它读不到，必须 reload 才生效），
 * 所以整条一起受「随月蚀启动」开关控制；但关闭开关的用户手动启动桌宠/直接开游戏时，
 * companion 仍需读到指向月蚀的 provider，否则游戏内莉莉丝连不上月蚀。此时补同步一次。
 */
export function runLilithBridgeNow(state: AppState, deps: LilithSetupDeps): void {
  if (!lilithEnabled(deps.configStore)) return
  if (!state.apiPortForLilithBridge) return
  initLilithBridge(state, deps, state.apiPortForLilithBridge)
}

/** 启动编排原子 ⑪a：莉莉丝 MOD 桥接（纯 TCP + MOD 协议，不吃 AI） */
export function initLilithBridge(state: AppState, deps: LilithSetupDeps, port: number): void {
  // ===== 莉莉丝 MOD 桥接：把月蚀 API 端口写入 MOD 配置 =====
  // MOD companion 的 provider.base_url 指向月蚀 → 游戏内莉莉丝的对话走月蚀上下文
  // MOD 配置路径：%APPDATA%\LilithAI\config.json（MOD 运行时会读）
  // 【为什么不删/不改落点】该路径是与其他应用（莉莉丝 MOD）的跨应用契约，写在哪由 MOD 侧
  // 读取逻辑决定，不属于本项目"统一落项目文件夹"范围；改动只会让 MOD 读不到配置而断链。
  // 失败不阻塞：MOD 未安装/路径变动时仅打日志
  try {
    const modConfigPath = join(app.getPath('appData'), 'LilithAI', 'config.json')
    if (existsSync(modConfigPath)) {
      const modCfg = JSON.parse(readFileSync(modConfigPath, 'utf-8'))
      const llmCfg = deps.configStore.get().llm
      modCfg.mock_mode = false
      modCfg.provider = {
        ...(modCfg.provider ?? {}),
        kind: 'custom',
        base_url: `http://127.0.0.1:${port}`,
        api_key: 'lunareclipse', // health-scan: ignore-secret 本地回环 mock 服务的固定占位 token，非真实凭据
        model: llmCfg.model || 'lunareclipse',
        wire_api: 'chat_completions',
        thinking_mode: 'default'
      }
      writeFileSync(modConfigPath, JSON.stringify(modCfg, null, 2), 'utf-8')
      console.log(
        `[lilith-bridge] MOD 配置已写入 base_url=http://127.0.0.1:${port}（${redactUserPath(modConfigPath)}）`
      )

      // 关键：companion 在游戏启动时缓存了 config（server.js 的 let config = loadConfig()），
      // 只会在 POST /v1/control {action:'reload'} 时重新加载。若游戏先于月蚀启动，
      // companion 的 base_url 仍是旧端口 → 链路断。这里主动触发 reload 热更新。
      // 注意：这一步只在 companion **确实在跑**时才有意义（reload 的目的是修「先开游戏后开月蚀」）；
      // 没在跑时无物可 reload，静默跳过——不打印任何「失败」，因为那不是失败、是正常状态。
      const runtimePath = join(app.getPath('appData'), 'LilithAI', 'runtime.json')
      if (existsSync(runtimePath)) {
        try {
          const rt = JSON.parse(readFileSync(runtimePath, 'utf-8')) as {
            pid?: number
            port?: number
            token?: string
          }
          if (rt?.port && isPidAlive(rt.pid)) {
            const payload = JSON.stringify({ action: 'reload' })
            const req = http.request(
              {
                host: '127.0.0.1',
                port: rt.port,
                path: '/v1/control',
                method: 'POST',
                headers: {
                  ...(rt.token ? { Authorization: `Bearer ${rt.token}` } : {}),
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(payload)
                }
              },
              (res) => {
                let raw = ''
                res.on('data', (c) => {
                  raw += c
                })
                res.on('end', () => {
                  const ok = res.statusCode === 200 && raw.includes('"ok":true')
                  console.log(
                    `[lilith-bridge] companion reload ${ok ? '成功' : `失败(status ${res.statusCode})`}（端口 ${rt.port}）`
                  )
                })
              }
            )
            req.on('error', (err) =>
              console.warn(
                `[lilith-bridge] companion reload 失败（companion 未运行?）: ${err.message}`
              )
            )
            req.setTimeout(3000, () => req.destroy(new Error('reload timeout')))
            req.end(payload)
          }
        } catch (err) {
          console.warn(`[lilith-bridge] 触发 companion reload 失败: ${(err as Error).message}`)
        }
      }
    } else {
      console.warn(`[lilith-bridge] MOD 配置不存在，跳过：${redactUserPath(modConfigPath)}`)
    }
  } catch (err) {
    console.error(
      '[lilith-bridge] MOD 配置写入失败:',
      redactUserPath(err instanceof Error ? err.message : String(err))
    )
  }
}

/** 启动编排原子 ⑪b：莉莉丝适配器（lorina 守护服务模式，端口随机避开 MOD 冲突） */
export function initLilithAdapter(
  state: AppState,
  deps: LilithSetupDeps,
  config: AppConfig,
  dataPaths: BaseDataPaths
): void {
  // ===== 莉莉丝连接：默认走 companion 桥接链路（LilithMod 原生支持）=====
  // 实测结论：LilithMod.dll 的 EnsureCompanionRunning 是"先 spawn companion 进程"，
  // spawn 失败（端口被占）就判定 companion unavailable → 游戏内莉莉丝断连。
  // 因此月蚀适配器"占 6186 伪装 companion"的方案与 LilithMod 启动逻辑冲突（EADDRINUSE 死循环）。
  // 正确路径：让 LilithMod 正常 spawn 真 companion（占 6186），companion 的 provider.base_url
  // 指向月蚀 62002（上面已写入 config.json）→ 对话经 companion → 月蚀 /chat/completions → lilith_chat。
  // 适配器保留为可选（config.lilith.useAdapter=true 时启用，用于无 MOD companion 的场景）。
  const appDataDir = app.getPath('appData')
  // 真 fiber 化守卫（G3）：lilith 服务未挂载时视为使用默认 companion 桥接链路
  const useAdapter = config.lilith?.useAdapter === true && deps.rootCtx.featurePlugins.isEnabled('lilith')
  if (useAdapter) {
    state.lilithAdapter = deps.rootCtx.lilith.create({
      port: 6186,
      dataRoot: dataPaths.root,
      appDataDir,
      sessionStore: deps.sessionStore,
      getLlmClient: () => {
        if (!state.lilithLlmClient) {
          state.lilithLlmClient = new LLMClient(config.llm)
        }
        return state.lilithLlmClient
      },
      // 当前环境注入（地理位置/天气）：与主链路同构，适配器模式的莉莉丝同样感知时间/地区
      getEnvText: () => getGeoEnvText(),
      // 系统注入/健康检查消息：不发给莉莉丝，转交月蚀大脑处理（完整工具链），不吞消息。
      // 月蚀大脑未就绪（server 未启动）时返回明确占位，拒绝静默吞掉。
      onSystemInjected: (message) => {
        const runner = getHeadlessChatRunner()
        if (!runner) {
          console.warn('[lilith-adapter] 月蚀大脑未就绪，无法转交系统消息:', message.slice(0, 60))
          return '（系统消息已拦截，但月蚀大脑未就绪，请稍后重试）'
        }
        return runner(message, SYSTEM_INJECTED_SESSION_ID, undefined, 'system-injected')
      }
    })
    state.lilithAdapter.start().then((adapterPort) => {
      console.log(
        `[lilith-adapter] 适配器模式启用（端口 ${adapterPort}）——注意：此模式与 LilithMod 的 companion spawn 逻辑冲突，仅用于无 MOD 场景`
      )
    })
  } else {
    console.log(
      '[lilith-adapter] 使用 companion 桥接链路（默认）：LilithMod spawn 真 companion → provider 指向月蚀 62002'
    )
    // 清理月蚀可能残留的 runtime.json（避免干扰 LilithMod 的 companion 启动判断）
    // 注意：不删——真 companion 启动后会自己写。仅确保没有月蚀写的旧 runtime 残留。
    const rtPath = join(appDataDir, 'LilithAI', 'runtime.json')
    if (existsSync(rtPath)) {
      const rt = JSON.parse(readFileSync(rtPath, 'utf-8')) as { pid?: number }
      if (rt.pid === process.pid) {
        // 上次月蚀适配器写的残留 → 删除让 LilithMod 正常 spawn companion
        writeFileSync(rtPath, '{}', 'utf-8')
        console.log(
          '[lilith-adapter] 已清理月蚀残留 runtime.json（让 LilithMod 正常 spawn companion）'
        )
      }
    }
  }
}

/** 启动编排原子 ⑪c：莉莉丝 MOD 自启动（有游戏路径时拉起） */
export async function initLilithAutoStart(config: AppConfig): Promise<void> {
  // ===== 莉莉丝 autoStart：启动月蚀时自动拉起桌宠（配置开启 + MOD 完整时） =====
  // 设计来源：raw_memory 46.md 规划第 5 条（主进程启动钩子），此前未实现。
  // 游戏目录无效/MOD 缺失时静默跳过；launch 不等进程启动完成，故不阻塞月蚀启动。
  const lilithCfg = config.lilith
  if (lilithCfg?.autoStart && lilithCfg.gamePath) {
    if (lilithHasMod(lilithCfg.gamePath)) {
      // 原实现是 setTimeout(…, 3000) 才拉——但「等主窗口创建完再拉」这个理由不成立：
      // 主窗口在 initMainWindow 时就已经建好，这里早已在它之后，那 3 秒纯属固定白等
      // （用户感知就是「开月蚀后桌宠愣三秒才出」）。launch 本身不等进程启动完成、不阻塞月蚀启动，直接拉即可。
      void lilithLaunch(lilithCfg.gamePath).then((r) => {
        if (r.ok) {
          console.log(
            r.alreadyRunning
              ? '[lilith-autoStart] 莉莉丝已在运行，跳过'
              : '[lilith-autoStart] 已自动启动莉莉丝桌宠'
          )
        } else {
          console.warn(`[lilith-autoStart] 启动失败: ${r.error ?? '未知错误'}`)
        }
      })
    } else {
      console.warn(`[lilith-autoStart] MOD 缺失，跳过自动启动（${redactUserPath(lilithCfg.gamePath)}）`)
    }
  }
}
