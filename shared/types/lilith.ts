/**
 * 莉莉丝桌宠接入配置（shared）。
 * 为什么存在：莉莉丝桥接链路（gamePath/固定端口/工具策略）由主进程执行、前端设置页编辑，
 * 共享 schema 防止两侧漂移。
 * 作用：导出 LilithConfig 及其字段约束说明。
 */
import type { ToolPolicy } from './tool-policy'

/** 莉莉丝桌宠接入配置 */
export interface LilithConfig {
  /**
   * 莉莉丝总开关（模块化）：false 时莉莉丝链路整体停用——
   * 不注册 lilith_* 工具、不启动 companion 桥接、前端不显示莉莉丝入口。
   * 缺省（undefined）视为 true（保留旧行为：配置了 gamePath 即启用）。
   */
  enabled?: boolean
  /** 游戏 MOD 目录（BepInEx/plugins/companion 所在路径） */
  gamePath: string
  /** 月蚀启动时自动拉起莉莉丝桌宠 */
  autoStart: boolean
  /**
   * 月蚀 API 固定端口（莉莉丝桥接用）：默认 62002。
   * companion 的 provider.base_url 指向此端口；固定端口避免动态端口漂移
   * （游戏先启动时 companion 缓存的 base_url 指向旧端口导致链路断）。
   */
  apiPort?: number
  /**
   * 协议适配器模式（默认 false）：true 时月蚀监听 6186 替代 companion。
   * 注意：LilithMod.dll 的 companion spawn 逻辑与占端口冲突（EADDRINUSE），
   * 此模式仅用于无 MOD companion 的场景；正常 MOD 用默认桥接链路。
   */
  useAdapter?: boolean
  /**
   * 莉莉丝工具策略（用户需求：工具可自己配置）。
   * 与常规线路（前端 AI / DMN）同一套 registry + policy 机制连通；
   * 缺省走 DEFAULT_LILITH_TOOL_POLICIES（记忆/情绪/浏览器类白名单），用户配置覆盖。
   */
  toolPolicy?: Record<string, ToolPolicy>
  /**
   * 莉莉丝人设（用户需求：角色自我塑造）。
   * 纯文本 markdown（# 身份 / # 性格 / # 说话风格 / # 行为规则…），注入为 system 段（最高优先级，覆盖 MOD 原版人设的冲突项）。
   * 空则不注入（用 MOD character 原版人设）。占位符 {playerName} 自动替换为当前玩家名。
   */
  persona?: string
  /**
   * 莉莉丝模式（用户需求：双模式）：
   * - 'character'（默认）：角色模式——工具白名单（记忆+浏览器），被动回复，思考强度跟全局配置
   * - 'agent'：全能模式——输出风格保持（人设 + [emotion/animation] 标记），但全工具自由调用 + 深度思考（high）+ 更长的工具循环（8 轮）
   */
  mode?: 'character' | 'agent'
}