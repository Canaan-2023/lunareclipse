/**
 * @category 核心
 * @summary 装配期运行时服务：raw_memory 写入器 / 地理位置服务 / Skills 加载器 / Hook 管理器（含事件桥与热重载）/ Cron 调度器
 * @note 为什么存在：这五者都是「创建即登记进 serviceRefs（释放链统一收口）」的装配期单例，彼此无依赖，
 * 只读配置与登录态；从宿主 `server.ts` 外移（ADR-02 第二轮）后，宿主只保留「拿到句柄 → 注入下游」。
 * @note 不删理由：Hook 事件桥的 detach 与 Cron 的「复用 index.ts 实例」语义都属释放/双实例红线，集中一处才可读。
 */
import type { ConfigStore } from './config-store'
import type { UserStore } from '../models/user-store'
import type { BaseDataPaths } from '../models/paths'
import type { ToolContext } from '../tools/base-tool'
import type { Context } from '../kernel/cordis-runtime'
import type { ActivationManager } from './activation-manager'
import { RawMemoryWriter } from '../services/raw-memory-writer'
import { GeoLocationService } from '../services/geo-location'
import { detectSystemPosition } from '../services/system-position'
import { SkillLoader, getDomainSkillsDir } from '../skills/loader'
import { getDefaultSkillsConfigPath } from '../skills/skill-config'
import { HookManager, loadAllHooks, watchHooksConfig } from '../hooks'
import { CronScheduler } from '../cron/scheduler'
import { getGlobalTimerRegistry } from '../monitor/timer-registry'
import { attachCordisEventBridge } from '../kernel/event-bridge'
import { DEFAULT_AI_ID } from '@shared/types'
import { serviceRefs } from './service-refs'

export interface RuntimeServices {
  rawMemoryWriter: RawMemoryWriter | null
  geoService: GeoLocationService | null
  skillLoader: SkillLoader
  hookManager: HookManager
  cronScheduler: CronScheduler | null
}

export interface RuntimeServicesDeps {
  configStore: ConfigStore
  userStore: UserStore
  dataPaths: BaseDataPaths
  toolCtx: ToolContext
  /** 装配期快照的 scoped 根（`safePaths(toolCtx)`）；null = 未登录。用 `ToolContext['paths']` 保 DataPaths 精度（ctx.memory.init 需要） */
  toolPaths: ToolContext['paths'] | null
  ctx?: Context
  activationManager: ActivationManager
}

/**
 * 创建并登记装配期运行时服务。副作用（登记 serviceRefs）即目的，返回值供下游注入。
 * 为什么 raw_memory 写入器在此：它按「当前登录用户 + AI1」动态取 scope，AI 不参与写入。
 */
export function createRuntimeServices(deps: RuntimeServicesDeps): RuntimeServices {
  const { configStore, userStore, dataPaths, toolCtx, toolPaths, ctx, activationManager } = deps

  // raw_memory 写入器（系统自动写入对话对，AI 不参与）
  // 字符上限可配置（config.rawMaxChars，默认 20000）
  // 分层：getScope 动态取当前登录用户 + AI 编号（前端=月蚀=1）
  // 莉莉丝链路 write 时传 scopeOverride={uid, aiId:2} 落莉莉丝自己的 RAW。
  const rawMemoryWriter = dataPaths
    ? new RawMemoryWriter(
        dataPaths,
        () => {
          const u = userStore.getCurrentUser()
          return u ? { uid: u.UID, aiId: DEFAULT_AI_ID } : null
        },
        configStore.get().rawMaxChars ?? undefined
      )
    : null
  // 热更新：config.json 的 rawMaxChars 变化时同步（无需重启）
  try {
    configStore.subscribe((cfg) => {
      if (rawMemoryWriter && cfg.rawMaxChars) rawMemoryWriter.setRawMaxChars(cfg.rawMaxChars)
    })
  } catch {
    // 订阅失败不阻断（配置仅在重启后生效）
  }

  // 地理位置服务：AI 感知当前时间和地区
  // 时间每轮实时注入；单一系统坐标链路（渲染进程 navigator.geolocation → 逆地理中文地址 + 天气），
  // 由 config.geo.preciseLocationEnabled 显式开关控制（默认 false）。
  // 隐私红线整改：公共免费 API 的 IP 定位兜底已移除——开关关闭时无任何定位来源，
  // 不发起任何外部定位请求，AI 上下文仅注入时区；开启后仅走系统坐标链路。
  const preciseLocationEnabled = configStore.get().geo?.preciseLocationEnabled ?? false
  const geoService = toolPaths
    ? new GeoLocationService(toolPaths.root, preciseLocationEnabled ? detectSystemPosition : null)
    : null
  if (geoService) {
    // 启动刷新：开关关闭时无定位来源，refresh 直接返回既有缓存、不触网
    void geoService.refresh()
  }
  // 供 lilith-adapter 等主链路之外的消费方获取同构环境注入（避免重复实例化定位服务）
  serviceRefs.geoEnvTextRef = geoService ? () => geoService.buildInjection() : null

  // Skills 加载器（渐进式披露：元数据始终注入 / 正文 use_skill 触发加载）
  // 在 serverCtx 之前创建，以便 ToolContext 注入 skillLoader
  // 配置层：.skills.json 管理 per-skill enabled 覆盖（类似 .mcp.json）
  // 优先复用调用方注入的 skillLoader（index.ts 的 memoryWorkflowSkillLoader 单例）——
  // 加载/监听时机由登录成功回调（onAuthSuccess）统一驱动，未登录不加载；
  // 仅当调用方未提供（独立启动/测试，且已登录）时才本地构造并自行 load。
  const skillLoader = toolCtx.skillLoader ?? (ctx && ctx.featurePlugins.isEnabled('skills')
    ? ctx.skills.init(
        getDomainSkillsDir,
        () => getDefaultSkillsConfigPath()
      )
    : new SkillLoader(
        getDomainSkillsDir,
        () => getDefaultSkillsConfigPath()
      ))
  if (!toolCtx.skillLoader) {
    skillLoader.load()
    skillLoader.startWatching()
  }
  serviceRefs.skillLoaderRef = skillLoader // 容器引用，closeApiServer 时停止监听

  // PreToolUse/PostToolUse 在 executeTool 中触发，UserPromptSubmit/Stop 在 stream 生命周期触发
  const hookManager = new HookManager()
  const hookConfigs = loadAllHooks()
  hookManager.loadHooks(hookConfigs)

  // 事件桥：把月蚀 hook 事件流桥到 Cordis 事件总线（观察桥，Cordis 模块可监听）
  // ctx 存在时挂载，并把 attach 返回的 detach 交给 serviceRefs（退出时按「挂载的逆序」卸载，
  // 恢复 hookManager.run 原实现）。此前 detach 未接——虽因进程退出而不可观测，但属释放链漏项。
  let detachEventBridge: (() => void) | undefined
  if (ctx) {
    detachEventBridge = attachCordisEventBridge(ctx, hookManager)
    // ctx.memory 注入数据路径（无 paths 时忽略——等后续调用点再 init）
    // memory 服务未挂载（功能禁用）时跳过：memory.dataPaths 保持 null，外部引用已容忍
    if (toolPaths && ctx.featurePlugins.isEnabled('memory')) {
      ctx.memory.init(toolPaths)
    }
    // 【装配收敛】Cordis 插件挂载唯一发生在 index.ts 启动链（mountCordisPlugins，
    // detach 保留给 onBeforeQuit 清理）。此处传入的 ctx 即启动链的 rootCtx，
    // 若再挂载一次会让同一批插件（时间戳 query 使每次 importEntry 生成全新
    // 模块实例）注册两份到 ctx.registry，产生重复副作用且 detach 无处置。
    // 阶段 4 迁移的插件挂在 rootCtx 上，server 侧经 ctx.<service> 门面取用即可。
  }
  // 监听配置文件变化，热重载
  const unwatchHooks = watchHooksConfig(() => {
    const newHooks = loadAllHooks()
    hookManager.loadHooks(newHooks)
    console.log(`[hooks] 配置热重载，加载 ${newHooks.length} 个 hook`)
  })
  serviceRefs.hookManagerRef = { hookManager, unwatchHooks, detachEventBridge }

  // Cron 定时任务调度器
  // 复用 index.ts 已创建的实例（toolCtx.getCronScheduler），避免双实例 + Windows fs.watch
  // 不可靠导致删除任务后内存 jobs 不更新 → 已删任务继续触发。
  // 仅在 toolCtx 未提供实例时回退创建（非标准启动场景）。
  let cronScheduler: CronScheduler | null = null
  if (toolCtx.getCronScheduler?.()) {
    cronScheduler = toolCtx.getCronScheduler()!
    serviceRefs.cronSchedulerRef = cronScheduler
  } else if (toolPaths?.cron) {
    try {
      cronScheduler = ctx && ctx.featurePlugins.isEnabled('cron')
        ? ctx.cron.create(toolPaths.cron, activationManager, getGlobalTimerRegistry())
        : new CronScheduler(toolPaths.cron, activationManager, getGlobalTimerRegistry())
      cronScheduler.start()
      serviceRefs.cronSchedulerRef = cronScheduler
    } catch (err) {
      console.error('[cron] 调度器初始化失败:', err)
    }
  }

  return { rawMemoryWriter, geoService, skillLoader, hookManager, cronScheduler }
}
