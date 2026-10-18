/**
 * SKILL IPC：技能管理的列表/加载/启停/重载/状态/错误通道，
 * 配置持久化与运行时状态监控都在此暴露给前端；manager 用 getter
 * 注入，未初始化时返回空值不阻断界面渲染。
 *
 * 登录守卫：所有 skill 通道统一套 requireAuth（系统强制登录后才可用，
 * 与 skill 数据按 U{uid}/AI{aiId} 前缀分层的设计一致——未登录无合法用户域，
 * 任何读取/写入/市场操作都拒绝，不提供未登录回退路径）。
 */
import { dialog } from 'electron'
import type { ipcMain as ipcMainType } from 'electron'
import type { SkillLoader } from '../../skills/loader'
import type { SkillMarket } from '../../skills/market'
import type { UserStore } from '../../models/user-store'
import { lintSkill, summarizeLint } from '../../skills/linter'
import { safeHandle, createAuthGuard, requireAuth } from './safe-handle'

/**
 * SKILL IPC 处理器（对齐 MCP 系统架构）

 * 通道分组：
 * 1. skill:list —— 列出所有 SKILL 元数据（L1，含禁用的；UI 管理用）
 * 2. skill:get —— 加载指定 SKILL 正文（L2，含 Markdown 指令）
 * 3. skill:toggle —— 启用/禁用 SKILL（写入 .skills.json，触发热重载）
 * 4. skill:reload —— 手动重载所有 SKILL（强制重新扫描目录）
 * 5. skill:status —— 获取所有 SKILL 运行时状态（监控用）
 * 6. skill:errors —— 获取加载错误列表

 * 设计要点：
 * - 配置层：toggle 通道写入 .skills.json，SkillLoader 监听变化自动热重载
 * - 状态监控：status 通道返回 lastUsedAt / useCount / loadError 等运行时状态
 * - getSkillLoader 以 getter 形式注入，handler 回调执行时读取最新值
 * - SkillLoader 未初始化时返回空数组 / null，不阻断前端渲染
 */
export function registerSkillHandlers(
  ipc: typeof ipcMainType,
  getSkillLoader: () => SkillLoader | null,
  getSkillMarket: () => SkillMarket | null,
  getUserStore?: () => UserStore | null
): void {
  // 登录守卫：未登录（getCurrentUser() 为 null）时所有 skill 通道抛 Unauthorized。
  // 为什么不用返回 fallback：skill 数据按 U{uid}/AI{aiId} 前缀分层，未登录没有合法数据域，
  // 静默返回空数组/空对象会让前端表现成"没有技能"，掩盖"未登录不可用"的真实状态；
  // 显式抛错让调用方（前端 store）捕获并提示，与 plugin/hooks 通道同一守卫语义。
  const authCheck = createAuthGuard(getUserStore ?? (() => null))

  /** 列出所有 SKILL 元数据（含禁用的；UI 管理用） */
  safeHandle(ipc, 'skill:list',
    requireAuth(authCheck, async () => {
      const loader = getSkillLoader()
      if (!loader) return []
      return loader.listMetadata()
    }, []),
    []
  )

  /** 加载指定 SKILL 的完整正文（含 body 字段） */
  safeHandle(ipc, 'skill:get',
    requireAuth(authCheck, async (_e, ...args: unknown[]) => {
      const loader = getSkillLoader()
      if (!loader) return null
      return loader.loadBody(args[0] as string)
    }, null),
    null
  )

  /** 启用/禁用 SKILL（写入 .skills.json，触发热重载） */
  safeHandle(ipc, 'skill:toggle',
    requireAuth(authCheck, async (_e, ...args: unknown[]) => {
      const loader = getSkillLoader()
      if (!loader) return { ok: false, error: 'loader not ready' }
      loader.setEnabled(args[0] as string, args[1] === true)
      return { ok: true }
    }, { ok: false, error: '操作失败' }),
    { ok: false, error: '操作失败' }
  )

  /** 删除 SKILL（仅限 user / domain 来源；builtin / plugin 不可删除） */
  safeHandle(ipc, 'skill:delete',
    requireAuth(authCheck, async (_e, ...args: unknown[]) => {
      const loader = getSkillLoader()
      if (!loader) return { ok: false, error: 'loader not ready' }
      return loader.deleteSkill(args[0] as string)
    }, { ok: false, error: '删除失败' }),
    { ok: false, error: '删除失败' }
  )

  /** 手动重载所有 SKILL（强制重新扫描目录） */
  safeHandle(ipc, 'skill:reload',
    requireAuth(authCheck, async () => {
      const loader = getSkillLoader()
      if (!loader) return { ok: false, error: 'loader not ready' }
      const result = loader.load()
      return { ok: true, count: result.metadatas.length, errors: result.errors }
    }, { ok: false, error: '操作失败' }),
    { ok: false, error: '操作失败' }
  )

  /** 获取所有 SKILL 运行时状态（监控用） */
  safeHandle(ipc, 'skill:status',
    requireAuth(authCheck, async () => {
      const loader = getSkillLoader()
      if (!loader) return []
      return loader.getStatuses()
    }, []),
    []
  )

  /** 获取加载错误列表 */
  safeHandle(ipc, 'skill:errors',
    requireAuth(authCheck, async () => {
      const loader = getSkillLoader()
      if (!loader) return []
      return loader.getErrors()
    }, []),
    []
  )

  // ===== 市场（技能市场本土化） =====

  /** 市场源列表 */
  safeHandle(ipc, 'skill:market-sources',
    requireAuth(authCheck, async () => {
      const market = getSkillMarket()
      if (!market) return { ok: false, error: '市场未初始化' }
      return { ok: true, sources: market.listSources() }
    }, { ok: false, error: '读取市场源失败' }),
    { ok: false, error: '读取市场源失败' }
  )

  /** 添加市场源（清单 JSON / 本地目录） */
  safeHandle(ipc, 'skill:market-add-source',
    requireAuth(authCheck, async (_e, ...args: unknown[]) => {
      const market = getSkillMarket()
      if (!market) return { ok: false, error: '市场未初始化' }
      return market.addSource(String(args[0] ?? ''), String(args[1] ?? ''))
    }, { ok: false, error: '添加市场源失败' }),
    { ok: false, error: '添加市场源失败' }
  )

  /** 移除市场源 */
  safeHandle(ipc, 'skill:market-remove-source',
    requireAuth(authCheck, async (_e, ...args: unknown[]) => {
      const market = getSkillMarket()
      if (!market) return { ok: false, error: '市场未初始化' }
      return market.removeSource(String(args[0] ?? ''))
    }, { ok: false, error: '移除市场源失败' }),
    { ok: false, error: '移除市场源失败' }
  )

  /** 市场可安装 skill 列表（含已装/更新状态） */
  safeHandle(ipc, 'skill:market-list',
    requireAuth(authCheck, async () => {
      const market = getSkillMarket()
      if (!market) return { ok: false, error: '市场未初始化', items: [] }
      const items = await market.listMarketSkills()
      return { ok: true, items }
    }, { ok: false, error: '读取市场列表失败', items: [] }),
    { ok: false, error: '读取市场列表失败', items: [] }
  )

  /** 安装 skill（落位以 SKILL.md frontmatter 的 domain 自我声明为唯一真源，不接受调用方传入的领域） */
  safeHandle(ipc, 'skill:market-install',
    requireAuth(authCheck, async (_e, ...args: unknown[]) => {
      const market = getSkillMarket()
      if (!market) return { ok: false, error: '市场未初始化' }
      return market.install(String(args[0] ?? ''))
    }, { ok: false, error: '安装 skill 失败' }),
    { ok: false, error: '安装 skill 失败' }
  )

  /** 更新 skill */
  safeHandle(ipc, 'skill:market-update',
    requireAuth(authCheck, async (_e, ...args: unknown[]) => {
      const market = getSkillMarket()
      if (!market) return { ok: false, error: '市场未初始化' }
      return market.update(String(args[0] ?? ''))
    }, { ok: false, error: '更新 skill 失败' }),
    { ok: false, error: '更新 skill 失败' }
  )

  /** 卸载 skill */
  safeHandle(ipc, 'skill:market-remove',
    requireAuth(authCheck, async (_e, ...args: unknown[]) => {
      const market = getSkillMarket()
      if (!market) return { ok: false, error: '市场未初始化' }
      return market.remove(String(args[0] ?? ''))
    }, { ok: false, error: '卸载 skill 失败' }),
    { ok: false, error: '卸载 skill 失败' }
  )

  /** 批量同步所有已安装 skill */
  safeHandle(ipc, 'skill:market-sync',
    requireAuth(authCheck, async () => {
      const market = getSkillMarket()
      if (!market) return { ok: false, error: '市场未初始化' }
      return market.syncAll()
    }, { ok: false, error: '同步 skill 失败' }),
    { ok: false, error: '同步 skill 失败' }
  )

  /**
   * 上传 skill 到市场（列表内「上传」按钮调用）。
   * 界面层不传路径：目录选择在本进程弹原生对话框，选中的目录内须有 SKILL.md，
   * 校验/复制/广播由 market.uploadSkill 完成（与 install 同一套 frontmatter +
   * 威胁扫描 + lint 校验）。
   */
  safeHandle(ipc, 'skill:market-upload',
    requireAuth(authCheck, async () => {
      const market = getSkillMarket()
      if (!market) return { ok: false, error: '市场未初始化' }
      const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
      if (result.canceled || result.filePaths.length === 0) return { ok: false, error: '已取消选择目录' }
      return market.uploadSkill(result.filePaths[0])
    }, { ok: false, error: '上传 skill 失败' }),
    { ok: false, error: '上传 skill 失败' }
  )

  /**
   * 按技能名一键上传已安装 skill 到市场（列表项「上传」按钮调用，免目录选择）。
   * 领域落位沿用 uploadSkill 的"文件夹即领域"判定：domain 来源技能目录在
   * skills_domains/{领域}/{技能名}，父目录名即领域；用户级技能父目录为结构容器
   * 名时按用户级平铺。与 install 同一套 frontmatter + 威胁扫描 + lint 校验。
   */
  safeHandle(ipc, 'skill:market-upload-by-name',
    requireAuth(authCheck, async (_e, ...args: unknown[]) => {
      const market = getSkillMarket()
      if (!market) return { ok: false, error: '市场未初始化' }
      const loader = getSkillLoader()
      if (!loader) return { ok: false, error: '技能加载器未初始化' }
      const name = String(args[0] ?? '')
      const meta = loader.findMetadata(name)
      if (!meta) return { ok: false, error: `技能 "${name}" 不存在` }
      if (meta.source !== 'user' && meta.source !== 'domain') {
        return { ok: false, error: `内置/插件技能（${meta.source}）不支持上传到市场` }
      }
      return market.uploadSkill(meta.dirPath)
    }, { ok: false, error: '上传 skill 失败' }),
    { ok: false, error: '上传 skill 失败' }
  )

  /** 从市场下架（删除）一个上传的 skill（权限判定在服务端：主系统/单机删任意，分系统删自己上传的） */
  safeHandle(ipc, 'skill:market-unpublish',
    requireAuth(authCheck, async (_e, ...args: unknown[]) => {
      const market = getSkillMarket()
      if (!market) return { ok: false, error: '市场未初始化' }
      return market.unpublish(String(args[0] ?? ''))
    }, { ok: false, error: '下架 skill 失败' }),
    { ok: false, error: '下架 skill 失败' }
  )

  /** 标记某 skill 为本地修改（更新时跳过） */
  safeHandle(ipc, 'skill:market-mark-modified',
    requireAuth(authCheck, async (_e, ...args: unknown[]) => {
      const market = getSkillMarket()
      if (!market) return { ok: false, error: '市场未初始化' }
      market.markUserModified(String(args[0] ?? ''))
      return { ok: true }
    }, { ok: false, error: '标记修改失败' }),
    { ok: false, error: '标记修改失败' }
  )

  // ===== lint（技能 lint 本土化） =====

  /** 对指定 skill 运行 lint */
  safeHandle(ipc, 'skill:lint',
    requireAuth(authCheck, async (_e, ...args: unknown[]) => {
      const loader = getSkillLoader()
      if (!loader) return { ok: false, error: 'loader not ready' }
      const name = String(args[0] ?? '')
      const meta = loader.findMetadata(name)
      if (!meta) return { ok: false, error: `skill "${name}" 不存在` }
      const body = loader.loadBody(name)?.body
      const issues = lintSkill({ name: meta.name, description: meta.description, platforms: meta.platforms, body })
      return { ok: true, issues, summary: summarizeLint(issues) }
    }, { ok: false, error: 'lint 执行失败' }),
    { ok: false, error: 'lint 执行失败' }
  )
}