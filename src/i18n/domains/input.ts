/**
 * @category i18n
 * @summary `input` 域文案分片（51 条 zh/en 配对）
 * 为什么存在：界面文案随 UI 域增长，全部塞进单个 `locales.ts` 会让任意 UI 域的改动
 * 都在同一文件上产生 merge 冲突；按域分片后各域独立演进（ADR-07）。
 * 不删理由：本文件是该域文案的唯一来源，宿主 barrel 用对象展开合并；条目保持
 * `{ zh, en }` 成对（按域拆、**不按语言拆**——配对是「单侧漏 key」的类型级防线）。
 */
import type { DictEntry } from '../dict-types'

const dict = {
  // ===== 输入区 =====
  'input.placeholder': { zh: '输入消息，Enter 发送，Shift+Enter 换行', en: 'Type a message. Enter to send.' },
  'input.hint': { zh: 'Enter 发送 · Shift+Enter 换行', en: 'Enter to send · Shift+Enter for newline' },
  'input.stop': { zh: '停止', en: 'Stop' },
  'input.interrupt': { zh: '打断', en: 'Interrupt' },
  'input.send': { zh: '发送', en: 'Send' },
  'input.answer': { zh: '回答', en: 'Answer' },
  'input.answerPlaceholder': { zh: '输入回答（留空跳过）', en: 'Type answer (leave empty to skip)' },
  'input.attachFile': { zh: '添加附件', en: 'Add attachment' },
  'input.cancelEdit': { zh: '取消编辑', en: 'Cancel edit' },
  'input.toolConfig': { zh: '工具配置', en: 'Tool config' },
  'input.webSearch.off': { zh: '开启网络搜索', en: 'Enable web search' },
  'input.webSearch.on': { zh: '关闭网络搜索', en: 'Disable web search' },
  'input.codeReview.off': { zh: '开启代码审查', en: 'Enable code review' },
  'input.codeReview.on': { zh: '关闭代码审查', en: 'Disable code review' },
  'input.greenlight.off': { zh: '开启权限绿通', en: 'Enable auto-approve' },
  'input.greenlight.on': { zh: '关闭权限绿通', en: 'Disable auto-approve' },
  'input.asr.start': { zh: '语音输入', en: 'Voice input' },
  'input.asr.stop': { zh: '停止语音输入', en: 'Stop voice input' },
  'input.tts.off': { zh: '开启语音播报', en: 'Enable TTS' },
  'input.tts.on': { zh: '关闭语音播报', en: 'Disable TTS' },
  'input.abort': { zh: '终止生成', en: 'Abort generation' },
  'input.interruptTitle': { zh: '发送并打断当前生成', en: 'Send and interrupt' },
  'input.sendTitle': { zh: '发送', en: 'Send' },
  'input.asrListening': { zh: '语音识别中：{text}', en: 'Listening: {text}' },
  'input.more': { zh: '更多', en: 'More' },
  'input.menu.upload': { zh: '上传附件', en: 'Upload attachment' },
  'input.menu.invokeSkill': { zh: '主动调用技能', en: 'Invoke skill' },
  'input.invokeSkill.title': { zh: '主动调用技能', en: 'Invoke skill' },
  'input.invokeSkill.back': { zh: '返回', en: 'Back' },
  'input.invokeSkill.user': { zh: '用户级', en: 'User' },
  'input.invokeSkill.domain': { zh: '领域级', en: 'Domain' },
  'input.invokeSkill.invoke': { zh: '调用', en: 'Invoke' },
  'input.invokeSkill.expand': { zh: '展开查看技能', en: 'Expand skills' },
  'input.invokeSkill.domainAll': { zh: '整体调用领域', en: 'Invoke domain' },
  'input.invokeSkill.empty': { zh: '暂无可用技能', en: 'No skills available' },
  'input.cancelSkillInvoke': { zh: '移除技能调用', en: 'Remove skill invocation' },

  // ===== Sidebar 扩展 =====
  'sidebar.expand': { zh: '展开侧栏', en: 'Expand sidebar' },
  'sidebar.collapse': { zh: '折叠侧栏', en: 'Collapse sidebar' },
  'sidebar.emptyHint': { zh: '点击 + 新建会话', en: 'Click + to create' },
  'sidebar.memory': { zh: '记忆', en: 'Memory' },
  'sidebar.memoryStatus': { zh: '记忆系统', en: 'Memory system' },
  'sidebar.memoryInjection': { zh: '记忆注入', en: 'Memory Injection' },
  'sidebar.memoryInjectionDesc': { zh: '回复前检索相关记忆', en: 'Retrieve memories before reply' },
  'sidebar.memoryWorkflow': { zh: '记忆工作流', en: 'Memory Workflow' },
  'sidebar.memoryWorkflowDesc': { zh: '后台归档对话为长期记忆', en: 'Auto-archive as long-term memory' },
  'sidebar.diaryWorkflow': { zh: '日记工作流', en: 'Diary Workflow' },
  'sidebar.diaryWorkflowDesc': { zh: '每日自动写日记', en: 'Auto-write daily diary' },
'sidebar.settings': { zh: '设置', en: 'Settings' },
  'sidebar.profile': { zh: '个人中心', en: 'Profile' },
  'sidebar.switchUser': { zh: '切换用户', en: 'Switch user' },
  'sidebar.logout': { zh: '登出', en: 'Logout' },
} satisfies Record<string, DictEntry>

export default dict
