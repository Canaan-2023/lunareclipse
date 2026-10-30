/**
 * @category i18n
 * @summary `settings` 域文案分片（218 条 zh/en 配对）
 * 为什么存在：界面文案随 UI 域增长，全部塞进单个 `locales.ts` 会让任意 UI 域的改动
 * 都在同一文件上产生 merge 冲突；按域分片后各域独立演进（ADR-07）。
 * 不删理由：本文件是该域文案的唯一来源，宿主 barrel 用对象展开合并；条目保持
 * `{ zh, en }` 成对（按域拆、**不按语言拆**——配对是「单侧漏 key」的类型级防线）。
 */
import type { DictEntry } from '../dict-types'

const dict = {
// ===== 设置页 =====
  'settings.title': { zh: '设置', en: 'Settings' },
  'settings.reasoning': { zh: '思考强度', en: 'Reasoning Effort' },
  'settings.reasoning.off': { zh: '关闭思考', en: 'Off' },
  'settings.reasoning.off.desc': { zh: '快速直答，不做深度推理', en: 'Direct answer, no deep reasoning' },
  'settings.reasoning.minimal': { zh: '最低', en: 'Minimal' },
  'settings.reasoning.minimal.desc': {
    zh: '最轻量的思考，简单任务快速过一遍',
    en: 'Lightest reasoning, quick pass for simple tasks'
  },
  'settings.reasoning.low': { zh: '低', en: 'Low' },
  'settings.reasoning.low.desc': {
    zh: '轻度思考，日常问答更稳',
    en: 'Brief reasoning, steadier everyday answers'
  },
  'settings.reasoning.medium': { zh: '中', en: 'Medium' },
  'settings.reasoning.medium.desc': { zh: '均衡档（默认）', en: 'Balanced (default)' },
  'settings.reasoning.high': { zh: '高', en: 'High' },
  'settings.reasoning.high.desc': { zh: '复杂任务，推理更充分', en: 'Complex tasks, deeper reasoning' },
  'settings.reasoning.very_high': { zh: '极高', en: 'Very High' },
  'settings.reasoning.very_high.desc': {
    zh: '接近上限的深度推理，难题优先',
    en: 'Near-maximum reasoning depth for hard problems'
  },
  'settings.reasoning.max': { zh: '最大', en: 'Max' },
  'settings.reasoning.max.desc': { zh: '不设上限，思考到完成', en: 'No limit, think to completion' },
  'settings.reasoning.note.deepseek': {
    zh: 'DeepSeek 接口区分「低/高/最大」三档：最低/低 按低发送，中/高 按高发送，极高/最大 按最大发送',
    en: 'DeepSeek distinguishes Low/High/Max: Minimal/Low map to Low, Medium/High to High, Very High/Max to Max'
  },
  'settings.reasoning.note.openai': {
    zh: 'OpenAI 接口档位到「高」为止：极高/最大 按高发送',
    en: 'OpenAI effort caps at High: Very High/Max map to High'
  },
  'settings.reasoning.note.gemini': {
    zh: 'Gemini 3.7 起无「最低」档：最低 按低发送，极高/最大 按高发送',
    en: 'Gemini 3.7+ dropped Minimal: Minimal maps to Low, Very High/Max to High'
  },
  'settings.reasoning.note.qwen': {
    zh: '千问接口仅支持开关思考（不分档）：选中「均衡档」即开启思考',
    en: 'Qwen only supports thinking on/off (no levels): selecting Balanced turns thinking on'
  },
  'settings.reasoning.note.anthropic': {
    zh: 'Claude 经兼容网关接入：极高/最大 按高发送',
    en: 'Claude via compatible gateway: Very High/Max map to High'
  },
  'settings.autoApprove': { zh: '权限直通', en: 'Auto-approve' },
  'settings.contextWindow': { zh: '上下文窗口', en: 'Context Window' },
  'settings.textWidth': { zh: '正文宽度', en: 'Text Width' },
  'settings.webSearch': { zh: '网络搜索', en: 'Web Search' },
  'settings.language': { zh: '语言', en: 'Language' },
  'settings.theme': { zh: '主题', en: 'Theme' },
  'settings.followFrontend': { zh: '跟随前端 AI 配置', en: 'Follow frontend AI' },
  'settings.notConfigured': { zh: '尚未配置额外模型', en: 'No additional models configured' },
  'settings.defaultModel': { zh: '默认模型', en: 'Default model' },
  'settings.notSet': { zh: '未设置', en: 'Not set' },

  // 主题描述
  'theme.frost-glass': { zh: '雾白玻璃·深雾蓝·立体阴影', en: 'Frosted glass·Mist blue·Shadowed' },
  'theme.parchment': { zh: '纯白底·黑边黑字·高对比', en: 'White·Black·High contrast' },
  'theme.night': { zh: '纯黑·白字·夜间', en: 'Black·White·Night' },
  'theme.violet-night': { zh: '深紫黑·紫罗兰光', en: 'Deep violet·Glow' },
  'theme.eclipse': { zh: '深靛夜空·月白·月晕金', en: 'Indigo night·Moonlight·Gold' },
  'theme.gilded': { zh: '深棕黑底·烫金描边', en: 'Dark bronze·Gold foil' },

  // ===== 注销 / 清理工作域询问（登出双确认） =====
  'auth.confirmLogoutTitle': { zh: '确认退出登录？', en: 'Log out?' },
  'auth.confirmLogoutPurge': {
    zh: '是否同时清空本账号在本机的全部工作域数据（记忆/技能/对话/配置/备份）？\n\n【确定】= 清理后退出\n【取消】= 仅退出，保留数据',
    en: 'Also erase this account\'s local workspace (memory/skills/chats/config/backups)?\n\n[OK] = Purge then log out\n[Cancel] = Log out only'
  },
  'auth.confirmLogoutPurgeFail': {
    zh: '清理失败，已取消退出',
    en: 'Purge failed, logout cancelled'
  },
  'profile.title': { zh: '个人中心', en: 'Profile' },
  'profile.username': { zh: '用户名', en: 'Username' },
  'profile.usernameHint': { zh: '登录标识，修改后同步账号表，下次登录请用新用户名；不可与其他账号重复', en: 'Login identifier. Syncs to the account table; use the new name to log in next time. Must be unique.' },
  'profile.avatar': { zh: '头像', en: 'Avatar' },
  'profile.nickname': { zh: '昵称', en: 'Nickname' },
  'profile.nicknameHint': { zh: '未设置时展示用户名，保存后不可留空；最多 24 字符', en: 'Shows username when unset; once saved, cannot be empty. Max 24 chars' },
  'profile.nicknameEmpty': { zh: '昵称不能为空', en: 'Nickname cannot be empty' },
  'profile.save': { zh: '保存', en: 'Save' },
  'profile.saved': { zh: '已保存', en: 'Saved' },
  'profile.saveFail': { zh: '保存失败', en: 'Failed to save' },
  'profile.preference': { zh: '个人资料（USER.md）', en: 'Profile (USER.md)' },
  'profile.preferenceDesc': { zh: '所有 AI 会话共享的资料卡：姓名、生日、职业、住址、联系方式、联系人、偏好等。未填的字段将显示「（未填写）」，AI 也会按你的表达协助维护。', en: 'Shared profile card for all AI sessions: name, birthday, occupation, address, contacts, preferences, etc. Empty fields show (未填写); AI can also help maintain it.' },
  'profile.preferenceToggleRaw': { zh: '切换原始编辑', en: 'Toggle raw edit' },
  'profile.preferenceToggleFields': { zh: '切换字段编辑', en: 'Toggle field edit' },
  'profile.preferenceRawHint': { zh: '保持「# 用户个人资料卡」标题 + 字段表（字段 | 内容）；无信息的字段填（未填写）', en: 'Keep "# 用户个人资料卡" header + field table (Field | Value); use (未填写) for empty fields' },
  'profile.field.name': { zh: '姓名', en: 'Name' },
  'profile.field.gender': { zh: '性别', en: 'Gender' },
  'profile.field.birthday': { zh: '生日', en: 'Birthday' },
  'profile.field.occupation': { zh: '职业', en: 'Occupation' },
  'profile.field.workplace': { zh: '工作单位', en: 'Workplace' },
  'profile.field.personality': { zh: '性格', en: 'Personality' },
  'profile.field.experience': { zh: '经历', en: 'Experience' },
  'profile.field.preference': { zh: '偏好', en: 'Preferences' },
  'profile.field.address': { zh: '住址', en: 'Address' },
  'profile.field.contact': { zh: '联系方式', en: 'Contact' },
  'profile.field.contactHint': { zh: '标注类型再填内容，多种用分号分隔，如：邮箱（xxx@example.com）；手机（+86 138...）', en: 'Type first, then value; separate multiple with ";", e.g., Email (xxx@example.com); Phone (+86 138...)' },
  'profile.field.contacts': { zh: '联系人', en: 'Contacts' },
  'profile.field.contactsHint': { zh: '关系 + 姓名 + 联系方式，如：家人（妈妈，手机 138...）', en: 'Relation + name + contact, e.g., Family (Mom, phone 138...)' },
  'profile.field.social': { zh: '社交账号', en: 'Social accounts' },
  'profile.field.socialHint': { zh: '平台名（账号），如：微信（xxx）；微博（xxx）', en: 'Platform (account), e.g., WeChat (xxx); Weibo (xxx)' },
  'profile.field.timezone': { zh: '时区', en: 'Timezone' },
  'profile.field.notes': { zh: '备注', en: 'Notes' },
  'profile.writeFail': { zh: '偏好保存失败', en: 'Failed to save preferences' },
  'profile.writeSuccess': { zh: '偏好已保存，AI 会话将读取该文件', en: 'Preferences saved. AI sessions will read this file' },
  'sidebar.viz': { zh: '监控可视化', en: 'Monitoring' },
  'sidebar.vizOpen': { zh: '打开监控面板', en: 'Open monitoring panel' },
  'sidebar.memoryGraph': { zh: '记忆与图谱', en: 'Memory & Graph' },
  'sidebar.memoryGraphOpen': { zh: '打开记忆与图谱面板', en: 'Open memory & graph panel' },
  'sidebar.pin': { zh: '置顶', en: 'Pin' },
  'sidebar.unpin': { zh: '取消置顶', en: 'Unpin' },
  'sidebar.rename': { zh: '重命名', en: 'Rename' },
  'sidebar.confirmDeleteTitle': { zh: '删除会话', en: 'Delete Session' },
  'sidebar.confirmDeleteMessage': {
    zh: '会话「{name}」及其全部消息将被永久删除，此操作不可撤销。',
    en: 'The session "{name}" and all its messages will be permanently deleted. This action cannot be undone.'
  },
  'sidebar.time.justNow': { zh: '刚刚', en: 'Just now' },
  'sidebar.time.minutesAgo': { zh: '{n}分钟前', en: '{n}m ago' },
  'sidebar.time.hoursAgo': { zh: '{n}小时前', en: '{n}h ago' },
  'sidebar.time.daysAgo': { zh: '{n}天前', en: '{n}d ago' },

  // ===== 设置页扩展 =====
  'settings.tab.character': { zh: '角色', en: 'Character' },
  'settings.tab.frontendLlm': { zh: '前端 AI', en: 'Frontend AI' },
  'settings.tab.backendLlm': { zh: '后端 AI', en: 'Backend AI' },
  'settings.tab.memoryWorkflow': { zh: '记忆工作流', en: 'Memory Workflow' },
  'settings.tab.mcp': { zh: 'MCP', en: 'MCP' },
  'settings.tab.hooks': { zh: 'Hooks', en: 'Hooks' },
  'settings.tab.eval': { zh: '评测', en: 'Eval' },
  'settings.tab.theme': { zh: '主题', en: 'Theme' },
  'settings.tab.workspace': { zh: '工作区', en: 'Workspace' },
  'settings.tab.messaging': { zh: '消息接入', en: 'Messaging' },
  'settings.tab.aiChat': { zh: '浏览器配置', en: 'Browser Config' },
  'settings.tab.data': { zh: '数据', en: 'Data' },
  'settings.tab.multi': { zh: '主/分系统', en: 'Master/Satellite' },
  'settings.tab.generation': { zh: '内容生成', en: 'Generation' },
  'settings.tab.security': { zh: '权限', en: 'Permissions' },
  'settings.multi.title': { zh: '主/分系统', en: 'Master/Satellite' },
  'settings.multi.joinLink': { zh: '接入链接', en: 'Join Link' },
  'settings.multi.link': { zh: '完整链接（分享给新分系统）', en: 'Full link (share with new satellites)' },
  'settings.multi.code': { zh: '接入码', en: 'Join Code' },
  'settings.multi.copy': { zh: '复制', en: 'Copy' },
  'settings.multi.rotate': { zh: '轮换', en: 'Rotate' },
  'settings.multi.joinLinkHint': { zh: '分系统注册时粘贴此链接即为分系统；留空注册即成为主系统账号。轮换后旧链接立即失效。', en: 'Paste this link when registering a satellite; leave blank to register a master account. Rotating invalidates old links.' },
'settings.multi.satelliteHint': { zh: '本机已注册为分系统', en: 'This machine is a satellite' },
  'settings.multi.standaloneHint': { zh: '本机尚未接入主分系统体系', en: 'Not part of a master/satellite system yet' },
  'settings.instance.title': { zh: '多开实例（本机并行）', en: 'Instances (parallel on this machine)' },
  'settings.instance.current': { zh: '当前实例', en: 'Current instance' },
  'settings.instance.defaultBadge': { zh: '默认实例', en: 'Default' },
  'settings.instance.namedBadge': { zh: '实例', en: 'Instance' },
  'settings.instance.listTitle': { zh: '已创建的实例', en: 'Created instances' },
  'settings.instance.empty': { zh: '暂无其他实例', en: 'No other instances yet' },
  'settings.instance.namePlaceholder': { zh: '输入实例名（字母/数字/下划线/连字符）', en: 'Instance name (A-Z a-z 0-9 _ -)' },
  'settings.instance.launch': { zh: '启动', en: 'Launch' },
  'settings.instance.launchNew': { zh: '启动新实例', en: 'Launch new instance' },
  'settings.instance.hint': { zh: '每个实例独立账号/数据/端口，可同时运行互不影响。启动后在新窗口中分别登录不同账号即可。', en: 'Each instance has its own account, data and port. Launch and sign in with different accounts in each window.' },
  'settings.instance.launched': { zh: '已启动实例', en: 'Launched instance' },
  'settings.instance.rename': { zh: '改名', en: 'Rename' },
  'settings.instance.renamePlaceholder': { zh: '新实例名', en: 'New name' },
  'settings.instance.renameConfirm': { zh: '确认', en: 'OK' },
  'settings.instance.renameDone': { zh: '实例已改名：', en: 'Renamed ' },
  'settings.instance.delete': { zh: '删除', en: 'Delete' },
  'settings.instance.deleteConfirm': { zh: '确认删除', en: 'Confirm' },
  'settings.instance.deleteDone': { zh: '实例已删除：', en: 'Deleted ' },
  'settings.instance.deleteCancel': { zh: '取消', en: 'Cancel' },
  'settings.instance.deleteHint': { zh: '删除将清空该实例的账号与数据，不可恢复。', en: 'Deleting clears the instance account and data permanently.' },

  // ===== Provider 预设 =====
  'provider.openai': { zh: 'OpenAI 官方', en: 'OpenAI' },
  'provider.ollama': { zh: 'Ollama 本地', en: 'Ollama Local' },
  'provider.local': { zh: '本地服务', en: 'Local' },
  'provider.custom': { zh: '自定义', en: 'Custom' },

  // ===== 测试结果 =====
  'settings.errorMsg': { zh: '错误：{msg}', en: 'Error: {msg}' },
  'settings.noModelsError': { zh: '未发现模型：{error}', en: 'No models: {error}' },
  'settings.noModelsHint': { zh: '未发现模型，请检查服务是否启动', en: 'No models. Check if service is running.' },

  // ===== 数据 tab =====
  'settings.dataBudget': { zh: '数据与预算', en: 'Data & Budget' },
  'settings.configFilePath': { zh: '配置文件位置', en: 'Config File Location' },
  'settings.configFilePathDesc': { zh: '全部设置持久化于此 JSON 文件', en: 'All settings are persisted in this JSON file' },
  'settings.openInFolder': { zh: '在文件夹中显示', en: 'Show in Folder' },
  'settings.configPathLoadFail': { zh: '配置文件路径读取失败', en: 'Failed to read config file path' },
  'settings.dataDir': { zh: '数据目录', en: 'Data Directory' },
  'settings.dataDirReadonly': {
    zh: '数据目录在运行时不可修改（主进程 PROTECTED_FIELDS 保护）。如需迁移，请先退出应用后移动 data/ 目录。',
    en: 'Data directory cannot be changed while running (protected by main-process PROTECTED_FIELDS). To migrate, quit the app and move the data/ directory.'
  },
  'settings.tokenBudget': { zh: 'Token 预算（留空=无限，AI 不主动截断）', en: 'Token Budget (empty=unlimited)' },
  'settings.webSearchDesc': { zh: '允许 AI 搜索互联网补充回答', en: 'Allow AI to search the web' },
  'settings.bochaKey': { zh: '博查 Search API Key', en: 'Bocha Search API Key' },
  'settings.bochaDesc': { zh: 'AI 友好搜索引擎（bochaai.com），有免费额度。配置后 auto 模式优先使用', en: 'AI-friendly search (bochaai.com). Free tier available.' },
  'settings.bochaPlaceholder': { zh: '未配置则 auto 模式并行 11 源兜底', en: 'Empty = auto mode uses 11 parallel sources' },
  'settings.searchSources': { zh: '支持的搜索源（AI 通过 source 参数选用）', en: 'Supported search sources' },
  'settings.searchGeneral': { zh: '通用', en: 'General' },
  'settings.searchCommunity': { zh: '社区', en: 'Community' },
  'settings.searchWiki': { zh: '百科', en: 'Wiki' },
  'settings.searchClassic': { zh: '古典', en: 'Classic' },
  'settings.clickDisable': { zh: '点击关闭', en: 'Click to disable' },
  'settings.clickEnable': { zh: '点击开启', en: 'Click to enable' },
  'settings.preciseLocation': { zh: '启用时间与位置感知', en: 'Enable time & location awareness' },
  'settings.preciseLocationDesc': {
    zh: '关闭（默认）：AI 上下文仅注入时区，不发起任何定位请求。开启后：通过操作系统定位获取所在城市、天气与精确时段，仅供本机 AI 环境感知；精确坐标不写入日志、记忆与持久化缓存。',
    en: 'Off (default): AI context includes timezone only; no location requests are made. On: uses OS location for city, weather and precise time for on-device AI awareness; coordinates are never written to logs, memory or persistent cache.'
  },
  'settings.internalSessionBudget': { zh: '内部会话存储', en: 'Internal Sessions' },
  'settings.internalSessionBudgetDesc': { zh: 'AI 上下文层（内部会话）的存储整理阈值，非注入限制。', en: 'Storage hygiene thresholds for AI context (internal sessions), not injection limits.' },
  'settings.summaryBudgetChars': { zh: '单会话字符上限', en: 'Chars per session' },
  'settings.summaryBudgetCharsDesc': { zh: '内部会话 messages+summary 超过此字符数时，原会话冻结并新建继承会话（AI 再加工摘要承接，原始数据保留）。默认 0=按模型窗口 ×1/4 自动推导（保底 30000），改后即时生效', en: 'When a session exceeds this, it freezes and a heir session is created (AI reworks summary; raw data kept). Default 0 = auto-derived = model window × 1/4 (min 30000). Applies immediately.' },
  'settings.userShardMaxBytes': { zh: '用户会话分片上限', en: 'User shard max bytes' },
  'settings.userShardMaxBytesDesc': { zh: '用户会话单分片文件上限 {n} 字节，JSON 序列化超限自动切新片（只读，代码内常量）', en: 'User session shard file cap of {n} bytes; auto-splits when exceeded (read-only constant).' },
  'settings.routePreviewTurnPairs': { zh: '路由前会话预览对数', en: 'Preview turn pairs' },
  'settings.routePreviewTurnPairsDesc': { zh: '选取内部会话前，AI 可见的用户界面对话对数量（一个对话对 = 一条用户输入 + 一条 AI 输出），帮助路由精准选会话；0 = 关闭预览。仅路由阶段参考，不注入主上下文', en: 'Turn pairs of UI history visible to AI before internal-session routing (one pair = one user input + one AI reply); 0 = off. Reference only, not injected.' },

  // ===== 账号管理 =====
  'settings.accountMgmt': { zh: '账号管理', en: 'Account' },
  'settings.deregister': { zh: '注销当前账号', en: 'Deregister Account' },
  'settings.deregisterDesc': { zh: '删除账号 {name}（UID {uid}）的登录记录，保留所有记忆数据。注销后该用户名可被重新注册。', en: 'Remove login record for {name} (UID {uid}). Memory preserved. Username reusable.' },
  'settings.deregisterBtn': { zh: '注销账号', en: 'Deregister' },
  'settings.deregisterConfirm': { zh: '确认注销账号 {name}？', en: 'Confirm deregistering {name}?' },
  'settings.deregisterConfirmDesc': { zh: '此操作不可撤销，账号记录将被永久删除。记忆数据会保留但不再关联到本账号。', en: 'Irreversible. Account permanently deleted. Memory preserved but unlinked.' },
  'settings.processing': { zh: '处理中', en: 'Processing' },
  'settings.confirmDeregister': { zh: '确认注销', en: 'Confirm' },

  // ===== 工作区 =====
  'settings.wsAiWorkspace': { zh: 'AI 专属工作区', en: 'AI Workspace' },
  'settings.wsActive': { zh: '当前激活：{name}', en: 'Active: {name}' },
  'settings.wsActiveLabel': { zh: '当前激活：', en: 'Active: ' },
  'settings.wsPathParen': { zh: '（{path}）', en: '({path})' },
  'settings.wsAdd': { zh: '添加', en: 'Add' },
  'settings.wsNameField': { zh: '名称', en: 'Name' },
  'settings.wsNamePh': { zh: '如：我的工作区', en: 'e.g. My Workspace' },
  'settings.wsPathField': { zh: '路径', en: 'Path' },
  'settings.wsPathPh': { zh: '点击右侧选择目录，或手动输入绝对路径', en: 'Click to browse, or type absolute path' },
  'settings.wsSelectDir': { zh: '选择目录', en: 'Browse' },
  'settings.wsConfirmAdd': { zh: '确认添加', en: 'Confirm' },
  'settings.wsProcessing': { zh: '处理中…', en: 'Processing…' },
  'settings.wsSelectDirFirst': { zh: '请先选择目录', en: 'Select a directory first' },
  'settings.wsAdded': { zh: '已添加工作区', en: 'Workspace added' },
  'settings.wsAddFail': { zh: '添加失败：{error}', en: 'Add failed: {error}' },
  'settings.wsDeleted': { zh: '已删除工作区', en: 'Workspace deleted' },
  'settings.wsDeleteFail': { zh: '删除失败：{error}', en: 'Delete failed: {error}' },
  'settings.wsSwitched': { zh: '已切换激活工作区', en: 'Switched active workspace' },
  'settings.wsSwitchFail': { zh: '切换失败：{error}', en: 'Switch failed: {error}' },
  'settings.wsRenameFail': { zh: '重命名失败：{error}', en: 'Rename failed: {error}' },
  'settings.wsActiveBadge': { zh: '激活', en: 'Active' },
  'settings.wsSwitch': { zh: '切换', en: 'Switch' },
  'settings.wsRename': { zh: '重命名', en: 'Rename' },
  'settings.wsOpenInFinder': { zh: '在文件管理器中打开', en: 'Open in file manager' },
  'settings.wsKeepOne': { zh: '至少保留一个工作区', en: 'Keep at least one workspace' },
  'settings.wsCreatedAt': { zh: '创建于 {time}', en: 'Created {time}' },
  'settings.wsEmptyState': { zh: '暂无工作区（异常状态，应至少有一个默认工作区）', en: 'No workspaces (abnormal — should have at least one default)' },
  'settings.wsAboutTitle': { zh: '关于工作区', en: 'About Workspace' },
  'settings.wsAboutDesc': { zh: '工作区是 AI 的专属工作目录：AI 创建文件、整理资料、保存产物时放在这里。默认工作区为应用所在目录（随程序整体搬迁，不写入用户目录）。可添加多个工作区并切换激活——切换后，', en: 'Workspace is AI\'s dedicated directory: where AI creates files, organizes materials, and stores artifacts. Default workspace is the application directory (moves with the app; never written to the user home). You can add multiple workspaces and switch the active one — after switching, ' },
  'settings.wsAboutDesc2': { zh: 'hooks 配置会跟着切换。AI 收到的系统提示中会包含当前激活工作区路径和整洁规则。', en: 'hooks config will follow. AI\'s system prompt includes the current active workspace path and tidiness rules.' },
  'settings.wsUnnamed': { zh: '未命名工作区', en: 'Unnamed Workspace' },
  'settings.wsUnknownError': { zh: '未知错误', en: 'Unknown error' },
  'settings.wsActiveDblRename': { zh: '当前激活（双击重命名）', en: 'Active (double-click to rename)' },
  'settings.wsSelectDblRename': { zh: '点击选中（双击重命名）', en: 'Click to select (double-click to rename)' },
  'settings.wsSwitchToActive': { zh: '切换为激活工作区', en: 'Switch to active workspace' },

  // ===== 账号管理（新增） =====
  'settings.deleteAccount': { zh: '注销当前账号', en: 'Delete Account' },
  'settings.deleteAccountDesc': { zh: '删除账号 {name}（UID {uid}）的登录记录，保留所有记忆数据。注销后用户名可重新注册，UID 不回收。', en: 'Deletes login record for {name} (UID {uid}). Memory retained. Username re-registerable. UID not recycled.' },
  'settings.deleteAccountBtn': { zh: '注销账号', en: 'Delete Account' },
  'settings.deleteConfirm': { zh: '确认注销账号 {name}？此操作不可撤销，账号记录将被永久删除。记忆数据会保留但不再关联到本账号。', en: 'Confirm deleting account {name}? Irreversible. Memory retained but unlinked.' },
  'settings.confirmDelete': { zh: '确认注销', en: 'Confirm Delete' },
} satisfies Record<string, DictEntry>

export default dict
