/**
 * @category i18n
 * @summary `lilith` 域文案分片（59 条 zh/en 配对）
 * 为什么存在：界面文案随 UI 域增长，全部塞进单个 `locales.ts` 会让任意 UI 域的改动
 * 都在同一文件上产生 merge 冲突；按域分片后各域独立演进（ADR-07）。
 * 不删理由：本文件是该域文案的唯一来源，宿主 barrel 用对象展开合并；条目保持
 * `{ zh, en }` 成对（按域拆、**不按语言拆**——配对是「单侧漏 key」的类型级防线）。
 */
import type { DictEntry } from '../dict-types'

const dict = {
  // ===== 莉莉丝 =====
  'settings.lilithEnable': { zh: '启用状态', en: 'Status' },
  'settings.lilithEnableLabel': { zh: '启用莉莉丝', en: 'Enable Lilith' },
  'settings.lilithEnableDesc': { zh: '关闭后莉莉丝链路整体停用：不注册专属工具、不启动桥接、前端隐藏入口（会话数据保留，重新开启即恢复）', en: 'Disables Lilith: no tools, no bridge, UI hidden. Session data retained; re-enable to restore.' },
  'settings.lilithClickDisable': { zh: '点击停用', en: 'Click to disable' },
  'settings.lilithClickEnable': { zh: '点击启用', en: 'Click to enable' },
  'settings.lilithGamePath': { zh: '游戏路径', en: 'Game Path' },
  'settings.lilithPathPh': { zh: 'Lilith.exe 所在目录，如 D:\\Steam\\steamapps\\common\\The NOexistenceN of Lilith', en: 'Lilith.exe directory, e.g. D:\\Steam\\steamapps\\common\\The NOexistenceN of Lilith' },
  'settings.lilithDetecting': { zh: '检测中…', en: 'Detecting…' },
  'settings.lilithAutoDetect': { zh: '自动检测', en: 'Auto-detect' },
  'settings.lilithSaveConn': { zh: '保存连接', en: 'Save connection' },
  'settings.lilithLaunch': { zh: '立即启动', en: 'Launch' },
  'settings.lilithLaunching': { zh: '启动中…', en: 'Launching…' },
  'settings.lilithLaunchDisabled': { zh: '路径无效或 MOD 缺失，无法启动', en: 'Invalid path or missing MOD — cannot launch' },
  'settings.lilithAutoStart': { zh: '随月蚀启动', en: 'Auto-start' },
  'settings.lilithAutoStartDesc': { zh: '打开月蚀时自动启动莉莉丝', en: 'Auto-launch Lilith when opening the app' },
  'settings.lilithConnStatus': { zh: '连接状态', en: 'Connection Status' },
  'settings.lilithGameBody': { zh: '游戏本体', en: 'Game' },
  'settings.lilithFound': { zh: '已找到', en: 'Found' },
  'settings.lilithNotFoundCfg': { zh: '未找到/未配置', en: 'Not found' },
  'settings.lilithMod': { zh: 'MOD', en: 'MOD' },
  'settings.lilithComplete': { zh: '完整', en: 'Complete' },
  'settings.lilithMissing': { zh: '缺失', en: 'Missing' },
  'settings.lilithGameProcess': { zh: '游戏进程', en: 'Game Process' },
  'settings.lilithRunning': { zh: '运行中', en: 'Running' },
  'settings.lilithNotRunning': { zh: '未运行', en: 'Not running' },
  'settings.lilithCompanion': { zh: 'companion', en: 'Companion' },
  'settings.lilithOnline': { zh: '在线', en: 'Online' },
  'settings.lilithOffline': { zh: '离线', en: 'Offline' },
  'settings.lilithConfigPath': { zh: '配置路径', en: 'Config path' },
  'settings.lilithNotConfigured': { zh: '（未设置）', en: '(not set)' },
  'settings.lilithAboutTitle': { zh: '说明', en: 'About' },
  'settings.lilithAboutDesc': { zh: '连接保存一次后即生效：莉莉丝经 companion 桥接，与游戏内共享同一份会话上下文。', en: 'Takes effect after first save. Lilith shares the same conversation context with the in-game side via companion bridge.' },
  'settings.lilithAboutDesc2': { zh: '之后单独打开月蚀，只要 MOD 在，莉莉丝就会一起启动；月蚀窗口和桌宠气泡看到的是同一份对话。', en: 'Opening the app alone: if MOD exists, Lilith auto-launches. Both the app window and desktop pet see the same conversation.' },
  'settings.lilithMode': { zh: '莉莉丝模式', en: 'Lilith Mode' },
  'settings.lilithRoleMode': { zh: '角色模式', en: 'Role Mode' },
  'settings.lilithRoleModeDesc': { zh: '记忆+浏览器白名单工具，被动回复，像原作里的她', en: 'Memory + browser whitelist tools. Passive replies, like her original self.' },
  'settings.lilithOmniMode': { zh: '全能模式', en: 'Omni Mode' },
  'settings.lilithOmniModeDesc': { zh: '输出风格不变，但全工具 + 深度思考，能干任何活', en: 'Same personality, all tools + deep thinking, can do anything' },
  'settings.lilithOmniDesc': { zh: '「全能模式」：她说话还是她（人设 + 情感/动画标记不变），但后台思考、调用工具不再受限——检索记忆/读写文件/搜网页/操控浏览器/执行命令都可以。', en: 'Omni Mode: She still sounds like herself (persona + emotion/animation tags unchanged), but backend thinking and tool use are unrestricted — search memory, read/write files, browse web, control browser, run commands.' },
  'settings.lilithOmniDesc2': { zh: '工具白名单配置（下方「莉莉丝工具」）在角色模式下生效；全能模式忽略白名单，全工具可用。保存设置后对下次对话生效。', en: 'Tool whitelist (see "Lilith Tools" below) applies in Role Mode only; Omni Mode ignores the whitelist, all tools available. Changes apply to the next conversation after saving.' },
  'settings.lilithPersona': { zh: '莉莉丝人设（你的塑造）', en: 'Lilith Persona (custom)' },
  'settings.lilithPersonaPh': { zh: '# 身份\n她是……\n\n# 性格\n……\n\n# 说话风格\n……\n\n（占位符 {playerName} 自动替换为玩家名；留空 = 用游戏原版人设）', en: '# Identity\nShe is...\n\n# Personality\n...\n\n# Style\n...\n\n(Placeholder {playerName} = player name. Empty = use game default)' },
  'settings.lilithPersonaHint': { zh: '你写的莉莉丝人设优先于游戏原版（冲突时以你的为准）。想怎么塑造都行——性格/说话风格/与你的关系/小习惯。\n保存设置后对下次莉莉丝对话生效。', en: 'Your Lilith persona overrides the game default (yours wins on conflict). Shape her however you like — personality, speaking style, relationship with you, little habits.\nChanges apply to the next Lilith conversation after saving.' },
  'settings.lilithTools': { zh: '莉莉丝工具', en: 'Lilith Tools' },
  'settings.lilithToolsDesc': { zh: '莉莉丝会"记得"事——默认开启记忆类工具（memory / lilith_player_memory / lilith_lore_query，她会主动检索你们的过往）。\n打开开关即可给她加工具：与前端 AI / 记忆工作流同一套工具体系（registry + 策略），改动保存后对下次莉莉丝对话生效。', en: 'Lilith "remembers" — memory tools (memory / lilith_player_memory / lilith_lore_query) enabled by default. Toggle to add more. Same registry as frontend AI / memory workflow. Changes apply to next Lilith conversation.' },
  'settings.lilithDetectFoundMod': { zh: '✅ 检测到游戏本体（MOD 完整）：{dir}', en: '✅ Game found (MOD complete): {dir}' },
  'settings.lilithDetectFoundNoMod': { zh: '⚠️ 找到游戏本体但无 MOD：{dir}', en: '⚠️ Game found but no MOD: {dir}' },
  'settings.lilithDetectNotFound': { zh: '未找到游戏本体。请手动填写 Lilith.exe 所在目录。', en: 'Game not found. Please enter the Lilith.exe directory manually.' },
  'settings.lilithSaveOk': { zh: '✅ 已保存。', en: '✅ Saved.' },
  'settings.lilithSaveOkAutoStart': { zh: '下次打开月蚀将自动启动莉莉丝（MOD 存在时）。', en: 'Lilith will auto-launch next time you open the app (if MOD exists).' },
  'settings.lilithSaveOkNoAutoStart': { zh: '已关闭随月蚀自动启动。', en: 'Auto-start with app disabled.' },
  'settings.lilithSaveFail': { zh: '❌ 保存失败：{error}', en: '❌ Save failed: {error}' },
  'settings.lilithUnknownError': { zh: '未知错误', en: 'Unknown error' },
  'settings.lilithAlreadyRunning': { zh: '莉莉丝已在运行。', en: 'Lilith is already running.' },
  'settings.lilithLaunchOk': { zh: '✅ 已启动莉莉丝桌宠。', en: '✅ Lilith companion launched.' },
  'settings.lilithLaunchFail': { zh: '❌ 启动失败：{error}', en: '❌ Launch failed: {error}' },
  'settings.lilithLaunchTitle': { zh: '启动莉莉丝桌宠', en: 'Launch Lilith companion' },
  'settings.lilithOnlinePort': { zh: '在线（端口 {port}）', en: 'Online (port {port})' },
  'settings.lilithAutoStartCond': { zh: '仅当游戏目录存在且 MOD 完整时生效', en: 'Only when game directory exists and MOD is complete' },

} satisfies Record<string, DictEntry>

export default dict
