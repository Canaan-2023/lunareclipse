/**
 * 维护规则体系：为 AI 维护各类系统对象（模块/插件/技能/hook/配置/健康检查）提供结构化指导。

 * 每条规则告诉 AI：这东西是什么、怎么查、怎么改、怎么验、常见坑。
 * AI 通过 module_inspect(action=maintain, category=...) 获取对应规则。
 * 为什么存在：AI 用 module_inspect 维护系统对象时，需要可分类查询的"是什么/怎么查/怎么改/怎么验"规则，故集中为常量表。
 */

export type MaintenanceCategory = 'module' | 'plugin' | 'skill' | 'hook' | 'config' | 'health'

export const MAINTENANCE_GUIDES: Record<MaintenanceCategory, string> = {
  module: `## 模块维护规则
模块 = 月蚀架构的一个组成部分（主进程/渲染/工具/记忆/监控/基础设施），共 29 个。

**怎么查**：module_inspect(action=overview) 看全量清单 + 状态；module_inspect(action=detail, id=xxx) 看具体模块的功能、关键文件、运行时状态。

**怎么改**：核心源码可直接 Edit，但改完必须 typecheck + 测试验证。改前先想清楚再动手，改坏了直接修复（无快照/备份兜底，代码文件即最终状态）。
- 改前先 Read keyFiles 理解现有结构，匹配命名/缩进/风格再改
- 改 tools/ 下的工具：同步更新 index.ts 的 import 和 ALL_TOOL_CTORS 登记表、registry.ts 的 TOOL_REGISTRY（编译期双向校验，漏改任一处 typecheck 即报错，无需手动核对）
- 改 IPC handler：同步更新 preload/index.ts 的 API 暴露
- 改共享类型：在 shared/types/index.ts 中修改，前后端共用

**常见坑**：① 改了工具类名/路径但忘了同步 index.ts import → typecheck 报模块找不到；② 改了 IPC 通道名但没同步 preload → 前端调不到；③ MODULE_DEFS 清单与实际代码漂移 → 定期核对。`,

  plugin: `## 插件维护规则
插件 = AI 扩展自己的正规入口，放在 abyssac_data/plugins/{插件名}/ 目录。

**结构**：plugin.json（清单）+ tools.js（工具数组）+ hooks.js（钩子）+ prompts.md（提示词段）+ config.patch.json（配置覆盖）。

**怎么查**：plugin_manage(action=list) 看全部插件（启用状态/工具数/模块/错误）。

**怎么改**：
- 新增插件：plugin_manage(action=install, name=xxx) 创建骨架 → Write/Edit 填实现 → 热重载自动生效
- 修改插件：直接 Edit 对应文件，插件目录变化触发事务化热重载（全量加载→全成功才原子切换）
- 卸载插件：plugin_manage(action=uninstall, name=xxx) → 先停用回滚注册再删目录，不可恢复

**验证**：改完后 plugin_manage(action=list) 确认 enabled + 无 errors；tool 调用测试。
**常见坑**：① hooks.js 语法错误导致整个插件加载失败 → 热重载回滚保持旧集，看 errors 字段；② 插件间 coeffect 依赖（provide/deps）→ 删一个被依赖的插件会导致依赖方重载。`,

  skill: `## 技能维护规则
技能 = 可复用工作流固化为 Markdown SOP，按需加载（渐进披露）。
分两层：用户级（常驻索引，L0）+ 领域级（按领域分类，L0.5 领域摘要），**两层都不随安装包分发**——打包分发版技能池为空是正常状态，不是故障。

**存储结构**（路径带作用域 U{uid}/AI{aiId}，随当前登录用户与 AI 实例切换）：
- 用户级：{dataRoot}/skills/U{uid}/AI{aiId}/{技能名}/SKILL.md
- 领域级：{dataRoot}/skills_domains/U{uid}/AI{aiId}/{领域路径}/{技能名}/SKILL.md（领域 = 文件夹路径，数量与层级不限，如 design/web）
- 配置：{dataRoot}/config/U{uid}/AI{aiId}/.skills.json（启用开关）与 .workspaces.json
- 强制登录：未登录/缺 aiId 时分层路径解析直接抛错，不存在顶层回退（曾回退导致技能列表不显示，已删）
- 注意：一个技能 = 一个目录 + 目录内 SKILL.md；目录名即技能名；子目录不含 SKILL.md 时被当作领域分类目录继续下钻扫描

**文件结构**：frontmatter（name/description/context/allowed-tools/hooks 等）+ 正文（SOP 步骤）。

**怎么查**：use_skill() 无参盘点全部技能 / 领域级技能用 Grep/Glob 检索 skills_domains/{领域路径}/ 目录定位 SKILL.md（frontmatter 判断匹配）后 use_skill(skill_name=xxx) 加载正文 / use_skill(domain=xxx) 仅辅助盘点；skill_manage 不支持 list。

**怎么改**：
- 创建：skill_manage(action=create, name=xxx, description=xxx, body=SOP正文, source=user|domain, domain=领域路径)
  （source 默认 user；source=domain 时 domain 必填，领域 = 文件夹路径、数量与层级不限；需用户授权；已存在同名会被拒绝，改用 update）
- 更新：skill_manage(action=update, name=xxx, body=新SOP) → 增量合并（未传字段保留原值）
- 删除：skill_manage(action=delete, name=xxx) → 用户级与领域级均可删，需用户确认（riskLevel=high）

**验证**：写入后 SkillLoader 的 watcher 自动热重载；再 use_skill(skill_name=xxx) 确认能加载；解析失败会进 loader 的 errors 列表（不阻断启动）。
**常见坑**：① 技能名必须 kebab-case（小写字母/数字/连字符），否则被拒；② frontmatter 字段拼错 → 解析告警，技能仍加载但触发匹配可能失败；③ 技能名全局唯一：create 遇已存在同名拒绝（改用 update）；④ 领域不用写进 frontmatter，由 skills_domains/ 下的文件夹路径决定。`,

  hook: `## Hook 维护规则
Hook = 工具调用前后的确定性钩子（PreToolUse/PostToolUse），用于权限拦截、审计、注入。

**怎么查**：kernel_inspect(action=detail, kind=hook) 看全部注册的 hook（id/event/matcher/source）；hook_list 工具看三源合并清单（config/内核/插件）。

**怎么改**：
- 插件 hook：写插件 hooks.js，reg.registerHook(event, fn, { matcher, priority }) → 热重载生效
- 内核 hook：在 kernel/governance.ts 等文件中通过 createRegistrar 注册 → 需重启生效
- 关闭治理 hook：config_patch 写 patch 覆盖 governance 配置，或建同事件更高优先级 hook 拦截

**验证**：kernel_inspect(action=detail, kind=hook) 确认 hook 注册数变化；触发对应事件看效果。
**常见坑**：① hook priority 越高越先执行，但同 priority 不保证顺序；② PreToolUse 返回拒绝会阻断工具调用，确保只在必要时拦截。`,

  config: `## 配置维护规则
  配置 = 核心配置（config.json）+ 覆盖层（abyssac_data/patch/*.json）+ 插件 patch（plugin config.patch.json）。

**怎么查**：kernel_inspect(action=effective) 看生效配置（核心+覆盖层合并）；kernel_inspect(action=effective, key=xxx) 看某项；config_patch(action=list) 看所有 patch 文件。

**怎么改**：
- 调整配置：config_patch(action=write, name=xxx, patch={...}) 写 patch 文件 → 深合并到核心配置
- 恢复默认：config_patch(action=delete, name=xxx) 删 patch 文件 → 回退到核心值
- 直接改核心 config.json：不推荐，改坏无覆盖层保护；用 patch 层更安全

**验证**：config_patch(action=write) 返回会回读校验；kernel_inspect(action=effective) 确认值已合并。
**常见坑**：① patch 深合并只合并对象不合并数组（数组整体替换）；② 多个 patch 文件按文件名排序叠加，后写的覆盖先写的。`,

  health: `## 健康检查维护规则
健康检查 = 定时自检 typecheck/test/lint/build/files/code-review/uiux + 运行时崩溃监控 + AlertGate 防死循环。
（检查项全部由主进程内置实现——命令执行与静态扫描，**不依赖任何技能**；打包后 workDir 指向 asar 时代码自检自动失效，运行时崩溃监控不受影响。）

**怎么查**：
- 面板：监控面板 → 健康检查 tab 看检查项状态 + 修复记录时间线
- AI：module_inspect(action=overview) 看哪些模块标红；module_inspect(action=detail, id=xxx) 看具体错误
- 状态文件：{dataDir}/.health_check/module-status.json（AI 可 Read）

**怎么响应**：健康检查失败时 AlertGate 注入事件唤醒 AI，消息格式「【健康检查】工作区代码自检发现 xxx 失败…请先定位根因，再针对性修复」。
（注入文案只描述「要做什么」，不写具体技能名——技能两层均不随包分发，写死名字会把 AI 指向不存在的 skill，白烧一轮唤醒。用户自装技能时由 AI 按描述自行匹配。）

**修复流程**：① module_inspect(action=detail, id=xxx) 看错误摘要和关键文件 → ② Read 关键文件定位问题 → ③ Edit 修复 → ④ typecheck 验证 → ⑤ 下次健康检查自动标绿。

**AlertGate 状态机**：alert（首次/变化）→ cooldown（同指纹 30 分钟不重复）→ silence（连续 3 次静默）→ recovered（恢复清状态）。避免同一错误反复唤醒 AI 死循环。`
}
