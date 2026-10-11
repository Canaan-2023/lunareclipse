/**
 * 数据目录初始化：月蚀系统启动时按数据根目录预建全部基础目录骨架
 * （NNG/cache/users/plugins/cron/ABYSS 等），写入默认 users.json、AI 注册表等文件，
 * 并一次性把旧版 md 文件体系（历史遗留命名，迁移必须按原文件名读取）迁移到 ABYSS 体系。避免各处代码依赖的目录
 * 在首次访问时不存在而报错，是数据层可用的前置保证。
 */
import { mkdirSync, existsSync, writeFileSync, copyFileSync, readdirSync, renameSync, readFileSync } from 'fs'
import { basename, join } from 'path'
import type { BaseDataPaths } from './paths'
import { buildDataPaths } from './paths'
import { nowIso } from './memory'
import { readAiRegistry, writeAiRegistry } from './ai-registry'

const EMPTY_USERS_JSON = { users: [], next_uid: 1 }
const EMPTY_MONITOR_STATE = {
  启动时间: nowIso(),
  统计: {
    create_events: 0,
    modify_events: 0,
    delete_events: 0,
    move_events: 0
  }
}

export function initDataDirectory(dataDir: string, promptsDir: string): BaseDataPaths {
  const paths = buildDataPaths(dataDir)
  // 全局共享目录（跨用户/AI 的基础设施：工作流引擎、提示词、插件、cron 等）。
  // 分层改造：memory/raw_memory/sessions 不再全局创建，
  // 改由用户注册/登录时按 {uid}/{aiId} 动态创建（resolveScopePaths）。
  const dirs = [
    paths.root,
    paths.nng,
    paths.cache,
    paths.users,
    paths.workflowPending,
    paths.fileMonitor,
    paths.fileMonitorCorrupted,
    paths.frontend,
    paths.taskDetails,
    paths.workflows,
    paths.workflowTemplates,
    paths.workflowInstances,
    paths.plugins,
    paths.cron
  ]
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true })
  }

  // AI 编号注册表（月蚀=1、莉莉丝=2，可扩展）——首次启动写入默认表
  if (!existsSync(paths.aiRegistryJson)) {
    const registry = readAiRegistry(paths.aiRegistryJson)
    writeAiRegistry(paths.aiRegistryJson, registry)
  }

  // ABYSS 体系根目录（{root}/ABYSS；USER.md/AI.md 由 resolveScopePaths 输出、登录/写入时按需创建，
  // 这里仅预建根目录；旧版 md 文件数据由下方 migrateLegacyMd 一次性迁入）
  mkdirSync(paths.abyss, { recursive: true })

  // 记忆/RAW 计数器按作用域动态创建（resolveScopePaths 的计数器路径），此处不预建
  // 重构：全局 NNG/root.json、cache/index.json 已废弃（ROOT 在工作域内，
  // 由作用域 root.json/index.json 承担），此处不再预建全局索引

if (!existsSync(paths.usersJson)) {
    writeFileSync(paths.usersJson, JSON.stringify(EMPTY_USERS_JSON, null, 2), 'utf-8')
  }
  if (!existsSync(paths.fileMonitorState)) {
    writeFileSync(paths.fileMonitorState, JSON.stringify(EMPTY_MONITOR_STATE, null, 2), 'utf-8')
  }
  if (!existsSync(paths.fileMonitorErrorLog)) {
    writeFileSync(paths.fileMonitorErrorLog, '', 'utf-8')
  }

  // 一次性迁移（幂等）：旧版 md 文件体系（历史遗留命名 claude.md）→ ABYSS 体系（放在 usersJson 初始化之后，readFirstUid 可用）
  // - {root}/claude.md（全局）→ 首个已注册用户的 ABYSS/U{uid}/USER.md（无用户时迁到 ABYSS/_legacy-user.md）
  // - memory/U{uid}/claude.md（用户级）→ ABYSS/U{uid}/USER.md
  // - memory/U{uid}/AI{aiId}/claude.md（AI 自我认知）→ ABYSS/U{uid}/AI{aiId}/AI.md
  // 仅当目标不存在时写入；写入成功后旧文件重命名为 *.migrated-bak（迁移后不再沿用旧命名）。
  migrateLegacyMd(paths)

  copyPrompts(paths, promptsDir)

  initPluginsDir(paths.plugins)
  initCronDir(paths.cron)

  return paths
}

/**
 * 插件目录初始化：写 README.md（编写说明 + 示例插件结构）。
 * 只写说明文件，不创建示例插件（避免用户误以为示例会加载）。
 */
function initPluginsDir(pluginsDir: string): void {
  const readme = join(pluginsDir, 'README.md')
  if (existsSync(readme)) return
  const content = `# 月蚀模块系统

插件 = 本目录下每个子文件夹一个插件。启动时自动加载，扔进文件夹即生效（热重载）。

## 插件结构

\`\`\`
plugins/
└── my-plugin/            # 插件名（kebab-case，唯一）
    ├── plugin.json       # 元数据（可选，缺省用目录名兜底）
    └── tools.js          # 工具定义（CJS，module.exports = 工具数组）
\`\`\`

## plugin.json

\`\`\`json
{
  "name": "my-plugin",
  "description": "示例插件",
  "version": "0.1.0",
  "author": "you",
  "tools": [
    { "id": "my_tool", "name": "我的工具", "description": "做什么的", "defaultEnabled": true, "riskLevel": "low", "agents": ["frontend"] }
  ]
}
\`\`\`

## tools.js

\`\`\`js
module.exports = [
  {
    name: 'my_tool',            // 与 plugin.json tools[].id 一致
    description: '返回当前时间',
    parameters: [],             // [{ name, type: 'string'|'number'|'boolean'|'array'|'object', description, required }]
    async execute(params, ctx) {
      // ctx: ToolContext（paths / user / requestPermission 等）
      return { ok: true, data: { time: new Date().toISOString() } }
    }
  }
]
\`\`\`

## 说明

- 工具对哪个 AI 可见由 plugin.json tools[].agents 决定（frontend=月蚀 / dmn=记忆工作流 / lilith=莉莉丝）
- 启用开关在「设置 → 插件」面板；.plugin-state.json 持久化启用状态
- 改 tools.js 保存即热重载（500ms 防抖）
- 工具能力经 ctx 注入，可参考 electron/main/tools/ 下的内置工具实现
`
  writeFileSync(readme, content, 'utf-8')
}

function initCronDir(cronDir: string): void {
  const jobsFile = join(cronDir, 'jobs.json')
  if (existsSync(jobsFile)) return
  const content = `{
  "jobs": []
}
`
  writeFileSync(jobsFile, content, 'utf-8')
}

/**
 * 首次启动时复制对话模式角色定义到用户数据目录（用户可编辑副本）。

 * 设计原则：
 * - 提示词（shared/frontend/topics）唯一权威 = prompts/ 目录，不改用户副本，直接改 prompts/ 即生效
 * - 对话模式角色定义（character/*.json）= 运行时数据（莉莉丝等角色），需要可编辑副本 → 首次复制到
 * abyssac_data/frontend/character/，之后不覆盖（保护用户编辑）

 * 旧 DMN 已迁移到 L8 工作流引擎，提示词内嵌在 MEMORY_PIPELINE_TEMPLATE 节点配置中，
 * 不再从文件系统加载，无需复制；历史 DMN 提示词已由 L8 工作流模板与 prompts 目录取代。
 */
function copyPrompts(paths: BaseDataPaths, promptsDir: string): void {
  // 对话模式角色定义（json，复制到 frontend/character/ 供用户编辑）
  copyPromptDir(join(promptsDir, 'character'), join(paths.frontend, 'character'), '对话模式角色定义', true)
}

/**
 * 按文件夹整体复制文件（对话模式角色定义用）。
 * - 保留源文件名
 * - 已存在的目标文件不覆盖（保护用户编辑）
 * - 默认只复制 .md/.txt 文件（与 loader.ts 的 PROMPT_EXTS 白名单一致）；allowJson=true 时额外复制 .json（对话模式角色定义用）
 */
function copyPromptDir(srcDir: string, destDir: string, label: string, allowJson = false): void {
  if (!existsSync(srcDir)) {
    console.error(`[data-init] ${label}备份目录缺失: ${srcDir}`)
    return
  }
  let files: string[]
  try {
    files = readdirSync(srcDir).filter((f) => {
      if (f.startsWith('.')) return false
      if (allowJson && f.endsWith('.json')) return true
      return f.endsWith('.md') || f.endsWith('.txt')
    })
  } catch (err) {
    console.error(`[data-init] 读取${label}备份目录失败:`, err)
    return
  }
  // 全新数据目录（打包分发首启 / 换机场景）下 dest 子目录可能尚不存在，
  // 先确保目标目录存在再复制，否则 copyFileSync 对不存在的 dest 目录抛 ENOENT
  mkdirSync(destDir, { recursive: true })
  for (const f of files) {
    const src = join(srcDir, f)
    const dest = join(destDir, f)
    if (existsSync(dest)) continue // 首次复制不覆盖
    try {
      copyFileSync(src, dest)
    } catch (err) {
      console.error(`[data-init] 复制${label}失败 ${src} -> ${dest}:`, err)
    }
  }
}

export function ensureDataPaths(dataDir: string, promptsDir: string): BaseDataPaths {
  return initDataDirectory(dataDir, promptsDir)
}

/**
 * 一次性迁移：旧版 md 文件体系（历史遗留命名 claude.md）→ ABYSS 体系（幂等，启动时执行；失败不影响主流程）。

 * 旧路径 → 新路径：
 * {root}/claude.md → 首个已注册用户 ABYSS/U{uid}/USER.md
 * memory/U{uid}/claude.md → ABYSS/U{uid}/USER.md（用户级，所有 AI 共享）
 * memory/U{uid}/AI{aiId}/claude.md → ABYSS/U{uid}/AI{aiId}/AI.md（AI 自我认知）

 * 规则：
 * - 目标已存在 → 跳过写入（保护用户已写内容），仅把源重命名为 *.migrated-bak（放弃旧命名）
 * - 目标不存在且源非空 → 写入目标后把源重命名为 *.migrated-bak
 * - 源为空文件 → 直接重命名为 *.migrated-bak
 * - 全部采用 rename 而非 delete：旧数据保留 .bak 兜底，用户确认稳定后可手动清理
 */
function migrateLegacyMd(paths: BaseDataPaths): void {
  const retireSource = (src: string): void => {
    try {
      renameSync(src, src + '.migrated-bak')
    } catch (err) {
      console.error(`[data-init] 旧版 md 文件退役失败（${basename(src)}）:`, err)
    }
  }
  const migrateFile = (src: string, dest: string): void => {
    if (!existsSync(src)) return // 源不存在：无需迁移
    if (existsSync(dest)) {
      // 新文件已就绪（可能用户已在新体系编辑过）：放弃旧文件命名，不覆盖
      retireSource(src)
      return
    }
    try {
      const text = readFileSync(src, 'utf8')
      if (text.trim()) {
        mkdirSync(join(dest, '..'), { recursive: true })
        writeFileSync(dest, text, 'utf-8')
        console.log(`[data-init] 迁移成功: ${basename(src)} -> ${basename(dest)}`)
      }
      retireSource(src)
    } catch (err) {
      console.error(`[data-init] 迁移失败 ${basename(src)} -> ${basename(dest)}:`, err)
    }
  }

  // 1. 全局 {root}/claude.md（历史遗留文件名，按原名读取）→ 首个已注册用户（users.json 第一位的 UID）
  const firstUid = readFirstUid(paths.usersJson)
  migrateFile(join(paths.root, 'claude.md'), firstUid != null ? join(paths.abyss, `U${firstUid}`, 'USER.md') : join(paths.abyss, '_legacy-user.md'))

  // 2. memory/U{uid}/claude.md（用户级，历史遗留文件名）与 memory/U{uid}/AI{aiId}/claude.md（AI 级）
  if (!existsSync(paths.memory)) return
  for (const uEntry of readdirSync(paths.memory)) {
    const um = /^U(\d+)$/.exec(uEntry)
    if (!um) continue
    const uid = um[1]
    const uidDir = join(paths.memory, uEntry)
    migrateFile(join(uidDir, 'claude.md'), join(paths.abyss, `U${uid}`, 'USER.md'))
    let aiDirs: string[] = []
    try {
      aiDirs = readdirSync(uidDir)
    } catch {
      continue
    }
    for (const aiEntry of aiDirs) {
      const am = /^AI(\d+)$/.exec(aiEntry)
      if (!am) continue
      migrateFile(join(uidDir, aiEntry, 'claude.md'), join(paths.abyss, `U${uid}`, aiEntry, 'AI.md'))
    }
  }
}

/** 读取 users.json 中第一个有效 UID（无则 null） */
function readFirstUid(usersJson: string): number | null {
  try {
    if (!existsSync(usersJson)) return null
    const data = JSON.parse(readFileSync(usersJson, 'utf8')) as { users?: Array<{ UID?: number }> }
    const u = (data.users ?? []).find((x) => typeof x.UID === 'number')
    return u?.UID ?? null
  } catch {
    return null
  }
}
