/**
 * @category i18n
 * @summary `authui` 域文案分片（登录界面 `authui.*` 与 Hook 检视面板 `hookui.*`）
 * 为什么存在：登录入口与 Hook 面板文案独立于核心词条，单独分片避免与面板类文案互相污染（ADR-07）。
 * 不删理由：本文件是该域文案唯一来源，宿主 barrel 用对象展开合并；条目保持 `{ zh, en }` 成对。
 */
import type { DictEntry } from '../dict-types'

const dict = {
  // ===== 登录界面：角色标签 =====
  'authui.role.standalone': { zh: '单机模式', en: 'Standalone' },
  'authui.role.master': { zh: '主系统', en: 'Master system' },
  'authui.role.satellite': { zh: '分系统', en: 'Satellite system' },

  // ===== 登录界面：窗口控制 =====
  'authui.window.minimize': { zh: '最小化', en: 'Minimize' },
  'authui.window.maximize': { zh: '最大化', en: 'Maximize' },
  'authui.window.restore': { zh: '恢复窗口', en: 'Restore window' },
  'authui.window.close': { zh: '关闭', en: 'Close' },

  // ===== 登录界面：品牌与模式 =====
  'authui.brand.tagline': { zh: '月相 · 记忆 · 自主', en: 'Phases · Memory · Autonomy' },
  'authui.mode.chooseAccount': { zh: '选择账号继续', en: 'Choose an account to continue' },
  'authui.mode.welcomeBack': { zh: '欢迎回来，{name}', en: 'Welcome back, {name}' },
  'authui.mode.loginToContinue': { zh: '登录以继续', en: 'Log in to continue' },
  'authui.mode.registerNew': { zh: '注册新账号', en: 'Register a new account' },

  // ===== 登录界面：账号列表 =====
  'authui.loading': { zh: '加载中...', en: 'Loading...' },
  'authui.createdAt': { zh: '创建于 {date}', en: 'Created {date}' },
  'authui.useOtherUser': { zh: '使用其他用户名登录', en: 'Log in with another username' },
  'authui.backToList': { zh: '返回账号列表', en: 'Back to account list' },

  // ===== 登录界面：登录/注册表单 =====
  'authui.username': { zh: '用户名', en: 'Username' },
  'authui.usernamePlaceholder': { zh: '输入用户名', en: 'Enter username' },
  'authui.password': { zh: '密码', en: 'Password' },
  'authui.passwordPlaceholder': { zh: '输入密码', en: 'Enter password' },
  'authui.joinLink': { zh: '主系统接入链接', en: 'Master system join link' },
  'authui.optional': { zh: '（选填）', en: '(optional)' },
  'authui.registerAsSatellite': { zh: '将以分系统身份注册', en: 'Will register as a satellite system' },
  'authui.satelliteDesc': { zh: '账号由主系统统一发放，本地不保存账号与密码哈希。', en: 'The master system issues accounts; no account or password hash is stored locally.' },
  'authui.connectedMaster': { zh: '已连接主系统 {name}', en: 'Connected to master system {name}' },
  'authui.appNameParen': { zh: '（{name}）', en: '({name})' },
  'authui.willBeMaster': { zh: '本机将成为主系统', en: 'This machine will become the master system' },
  'authui.masterDesc': { zh: '注册成功后可在设置页获取接入链接，其他机器填入此链接即可接入为分系统。', en: 'After registration, get a join link from the settings page; other machines can join as satellite systems with it.' },
  'authui.masterUnreachable': { zh: '主系统当前不可达，请检查地址与网络；仍可继续注册，链接将随注册请求一并提交。', en: 'The master system is unreachable; check the address and network. You can still register; the link is submitted along with the registration request.' },
  'authui.error.badLink': { zh: '链接格式不正确，请粘贴主系统分享的完整链接', en: 'Invalid link format; paste the full link shared by the master system' },
  'authui.error.joinConfigFailed': { zh: '接入配置失败', en: 'Failed to configure joining' },
  'authui.action.login': { zh: '登录', en: 'Log in' },
  'authui.action.joinAndRegister': { zh: '接入主系统并注册', en: 'Join master system and register' },
  'authui.action.createMasterAndRegister': { zh: '创建主系统并注册', en: 'Create master system and register' },
  'authui.processing': { zh: '处理中', en: 'Processing' },
  'authui.noAccount': { zh: '没有账号？', en: 'No account?' },
  'authui.register': { zh: '注册', en: 'Register' },
  'authui.haveAccount': { zh: '已有账号？', en: 'Already have an account?' },
  'authui.login': { zh: '登录', en: 'Log in' },

  // ===== Hook 检视面板：头部 =====
  'hookui.title': { zh: 'Hook 机制', en: 'Hook governance' },
  'hookui.refresh': { zh: '刷新', en: 'Refresh' },
  'hookui.refreshAria': { zh: '刷新 Hook 列表', en: 'Refresh hook list' },
  'hookui.close': { zh: '关闭', en: 'Close' },
  'hookui.closeAria': { zh: '关闭 Hook 面板', en: 'Close hook panel' },
  'hookui.descPrefix': { zh: '真实生效的 hook（三源）：', en: 'Effective hooks (three sources):' },
  'hookui.source.kernel': { zh: '内核治理', en: 'Kernel governance' },
  'hookui.descSuffix': { zh: ' = 空转抑制/查证提醒/收尾反思/失败止损；config = 配置文件注册；plugin = 插件 hooks.js。停用单个治理机制用 config_patch 写 governance.机制名=false。', en: ' = idle suppression / verification reminder / closing reflection / failure stop-loss; config = registered in config files; plugin = plugin hooks.js. To disable one governance mechanism, set governance.<mechanism>=false via config_patch.' },
  'hookui.source.config': { zh: 'config 配置', en: 'config file' },
  'hookui.empty': { zh: '暂无生效 hook', en: 'No active hooks' },
  'hookui.emptyHint': { zh: '内核治理机制在重启后注册，若无显示请刷新', en: 'Kernel governance mechanisms register after restart; refresh if nothing shows' },
  'hookui.loadFailed': { zh: '加载失败', en: 'Load failed' },

  // ===== Hook 检视面板：事件名 =====
  'hookui.event.preToolUse': { zh: '工具调用前', en: 'Before tool use' },
  'hookui.event.postToolUse': { zh: '工具调用后', en: 'After tool use' },
  'hookui.event.userPromptSubmit': { zh: '用户提交消息', en: 'User submits prompt' },
  'hookui.event.preLLMCall': { zh: 'LLM 调用前', en: 'Before LLM call' },
  'hookui.event.stop': { zh: 'AI 完成响应', en: 'AI finishes response' },
  'hookui.event.subagentStop': { zh: '子 Agent 完成', en: 'Sub-agent finishes' },
  'hookui.event.notification': { zh: '通知', en: 'Notification' },
} satisfies Record<string, DictEntry>

export default dict
