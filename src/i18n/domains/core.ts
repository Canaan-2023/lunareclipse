/**
 * @category i18n
 * @summary `core` 域文案分片（91 条 zh/en 配对）
 * 为什么存在：界面文案随 UI 域增长，全部塞进单个 `locales.ts` 会让任意 UI 域的改动
 * 都在同一文件上产生 merge 冲突；按域分片后各域独立演进（ADR-07）。
 * 不删理由：本文件是该域文案的唯一来源，宿主 barrel 用对象展开合并；条目保持
 * `{ zh, en }` 成对（按域拆、**不按语言拆**——配对是「单侧漏 key」的类型级防线）。
 */
import type { DictEntry } from '../dict-types'

const dict = {
  // ===== 模式描述 =====
  'mode.coding.label': { zh: '编程', en: 'Coding' },
  'mode.coding.desc': { zh: '工具链·长文输出·Markdown', en: 'Toolchain·Long-form·Markdown' },
  'mode.chat.label': { zh: '会话', en: 'Chat' },
  'mode.chat.desc': { zh: '自然对话·简短回复', en: 'Natural·Brief·Conversational' },
  'mode.task.label': { zh: '任务', en: 'Task' },
  'mode.task.desc': { zh: '需求拆解·多体协作', en: 'Decompose·Multi-agent' },
  'mode.plan.label': { zh: '计划', en: 'Plan' },
  'mode.plan.desc': { zh: '只读探索·方案获批后动手', en: 'Read-only explore·Approve before act' },
  'mode.plan.banner': { zh: '计划模式：只读探索中，方案获批后才会动手', en: 'Plan mode: read-only exploration, execute only after approval' },
  'mode.plan.exit': { zh: '退出计划模式', en: 'Exit Plan Mode' },
  // 「自主」：视图状态（chatViewMode==='room'），不是 aiMode 取值——与「计划」同为「进去/出来」，不是「回答方式」
  'mode.auto.label': { zh: '自主', en: 'Autonomous' },
  'mode.auto.desc': { zh: '进入自主房间·它自己感知与行动', en: 'Enter the room·It senses and acts on its own' },
  'mode.auto.running': { zh: '自主运行中（不在房间视图）', en: 'Autonomous running (not in room view)' },
  'mode.auto.return': { zh: '返回房间', en: 'Back to room' },
  'mode.auto.stop': { zh: '立即停止', en: 'Stop now' },
  'mode.indicator': { zh: '编辑并重发模式', en: 'Edit & Resend' },
  'mode.title': { zh: 'AI 输出模式', en: 'AI Output Mode' },

  // ===== 首页空态 =====
  'empty.brand': { zh: 'LunarEclipse · ABYSSAC', en: 'LunarEclipse · ABYSSAC' },
  'empty.subtitle': { zh: '月既蚀矣，银辉潜行。', en: 'The eclipse begins.' },
  'empty.hint': { zh: '开始对话，开启此刻。', en: 'Start a conversation.' },
  'empty.suggestion1': { zh: '整理今日笔记', en: "Organize today's notes" },
  'empty.suggestion2': { zh: '搜索技术资讯', en: 'Search tech news' },
  'empty.suggestion3': { zh: '解释项目结构', en: 'Explain project structure' },

  // ===== Sidebar =====
  'sidebar.sessions': { zh: '会话', en: 'Sessions' },
  'sidebar.newSession': { zh: '新建会话', en: 'New Session' },
  'sidebar.empty': { zh: '新建会话开始对话', en: 'Create a session to start' },

  // ===== 右侧面板 Tab =====
  'tab.chat': { zh: '会话', en: 'Chat' },
  'tab.browser': { zh: '浏览器', en: 'Browser' },
  'tab.workshop': { zh: '文件工坊', en: 'Workshop' },
  'tab.skill': { zh: 'SKILL', en: 'SKILL' },
  'tab.plugin': { zh: '插件', en: 'Modules' },
  'tab.cron': { zh: '定时任务', en: 'Cron' },
  'tab.hook': { zh: 'Hook', en: 'Hook' },
'tab.todo': { zh: '计划', en: 'Tasks' },
  'tab.calendar': { zh: '日历', en: 'Calendar' },
  'tab.workflow': { zh: '工作流', en: 'Workflow' },
  'tab.admin': { zh: '账号管理局', en: 'Accounts' },
  'tab.backup': { zh: '备份中心', en: 'Backups' },
  'tab.friend': { zh: '好友', en: 'Friends' },
  'tab.chatRoom': { zh: '聊天室', en: 'Chat Rooms' },
  'tab.publishBoard': { zh: '发布板', en: 'News' },
  'tab.social': { zh: '社交', en: 'Social' },
  'tab.ai': { zh: 'AI 管理', en: 'AI' },

  // ===== 视图切换 =====
  'view.chat': { zh: '对话', en: 'Chat' },
  'view.tree': { zh: '内部会话', en: 'Internal Sessions' },
  'view.treeCount': { zh: '本会话 {count} 份', en: '{count} in this session' },
  'view.refresh': { zh: '刷新', en: 'Refresh' },
  'view.zoomIn': { zh: '放大', en: 'Zoom in' },
  'view.zoomOut': { zh: '缩小', en: 'Zoom out' },
  'view.zoomFit': { zh: '适应画布', en: 'Fit to view' },
  'view.zoomReset': { zh: '重置 100%', en: 'Reset 100%' },
  'view.canvasHint': { zh: '滚轮平移 · Ctrl+滚轮缩放 · 拖拽画布', en: 'Scroll to pan · Ctrl+scroll to zoom · Drag canvas' },
  'view.treeEmpty': { zh: '暂无内部会话', en: 'No internal sessions' },
  'view.treeEmptyHint': { zh: '对话后由 AI 自动维护', en: 'Auto-maintained by AI' },
  'view.treeEmptyDesc': { zh: '对话达到容量上限或主动新建时，AI 会在此维护独立会话；上限配置见右上角按钮。', en: 'AI maintains independent sessions here when a conversation hits its limit or on demand; budget settings live in the top-right button.' },

  // ===== Token / 上下文 =====
  'token.approaching': { zh: '接近上限', en: 'Near limit' },
  'token.cache': { zh: '缓存', en: 'Cache' },
  'tool.calling': { zh: '正在调用 {name}', en: 'Calling {name}' },
  'tool.parallel': { zh: '+{n} 并行', en: '+{n} parallel' },
  // AI 状态条（消息流下方）：流式期间显示"AI 当前在做什么"的三个阶段
  'aiStatus.thinking': { zh: '正在思考…', en: 'Thinking…' },
  'aiStatus.calling': { zh: '正在调用 {name}', en: 'Calling {name}' },
  'aiStatus.generating': { zh: '正在生成回复…', en: 'Generating…' },

  // ===== 通用 =====
  'common.close': { zh: '关闭', en: 'Close' },
  'common.cancel': { zh: '取消', en: 'Cancel' },
  'common.create': { zh: '创建', en: 'Create' },
  'common.confirm': { zh: '确认', en: 'Confirm' },
  'common.save': { zh: '保存', en: 'Save' },
  'common.delete': { zh: '删除', en: 'Delete' },
  'common.add': { zh: '新增', en: 'Add' },
  'common.edit': { zh: '编辑', en: 'Edit' },
  'common.expand': { zh: '展开', en: 'Expand' },
  'common.collapse': { zh: '收起', en: 'Collapse' },
  'common.recall': { zh: '撤回', en: 'Recall' },
  'common.restore': { zh: '恢复', en: 'Restore' },
  'common.jumpingToBottom': { zh: '回到底部', en: 'Jump to bottom' },
  'common.loading': { zh: '加载中', en: 'Loading' },
  'common.noData': { zh: '暂无数据', en: 'No data' },
  'msg.historyTruncated': { zh: '历史过长，仅显示最近 {n} 条（共 {total} 条）', en: 'Showing last {n} of {total} messages' },
  'msg.loadEarlier': { zh: '加载更早', en: 'Load earlier' },
  'msg.error': { zh: '错误', en: 'Error' },

  // ===== 正文宽度 =====
  'settings.textWidthDesc': { zh: '控制消息正文列的最大宽度', en: 'Max width of message body' },
  'settings.textWidth.narrow': { zh: '窄', en: 'Narrow' },
  'settings.textWidth.medium': { zh: '中', en: 'Medium' },
  'settings.textWidth.wide': { zh: '宽', en: 'Wide' },

  // ===== 底部操作栏 =====
  'settings.saveHint': { zh: '设置保存后立即生效', en: 'Settings apply immediately on save' },

  // ===== 状态文本 =====
  'status.connected': { zh: '已连接', en: 'Connected' },
  'status.connecting': { zh: '连接中', en: 'Connecting' },
  'status.error': { zh: '错误', en: 'Error' },
  'status.disconnected': { zh: '未连接', en: 'Disconnected' },
  'status.reconnecting': { zh: '重连中', en: 'Reconnecting' },
  'status.unknownError': { zh: '未知错误', en: 'Unknown error' },

  // ===== 通用（新增） =====
  'common.processing': { zh: '处理中', en: 'Processing' },

} satisfies Record<string, DictEntry>

export default dict
