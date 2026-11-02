/**
 * @category i18n
 * @summary `chatui` 域文案分片（聊天流、输入区、房间、社交浏览等界面壳层）
 * 为什么存在：与既有 core/input 分片拆开，避免聊天流大批文案挤占通用核心词条文件，
 * 也让本域后续改动只落在本文件（ADR-07 按域分片）。
 * 不删理由：本文件是该域文案唯一来源，宿主 barrel 用对象展开合并；条目保持 `{ zh, en }` 成对。
 */
import type { DictEntry } from '../dict-types'

const dict = {
  // ===== 空态品牌 =====
  'chatui.brandName': { zh: '月蚀', en: 'LunarEclipse' },

  // ===== 权限请求弹窗 =====
  'chatui.riskLow': { zh: '低风险', en: 'Low risk' },
  'chatui.riskMedium': { zh: '中风险', en: 'Medium risk' },
  'chatui.riskHigh': { zh: '高风险', en: 'High risk' },
  'chatui.typeCommand': { zh: '执行系统命令', en: 'Run system command' },
  'chatui.typeSetting': { zh: '系统设置', en: 'System setting' },
  'chatui.typeClipboardRead': { zh: '读取剪贴板', en: 'Read clipboard' },
  'chatui.typeDevice': { zh: '控制设备', en: 'Control device' },
  'chatui.permissionRequestAria': { zh: 'AI 权限请求 · {type}', en: 'AI permission request · {type}' },
  'chatui.permissionRequest': { zh: 'AI 权限请求', en: 'AI Permission Request' },
  'chatui.autoRejectAfter': { zh: '{n}s 后自动拒绝', en: 'Auto-reject in {n}s' },
  'chatui.operationContent': { zh: '操作内容：', en: 'Operation:' },
  'chatui.highRiskWarning': { zh: '⚠ 高风险操作：请仔细确认命令内容，可能导致系统损坏或数据丢失', en: '⚠ High-risk operation: review the command carefully; it may damage the system or cause data loss' },
  'chatui.reject': { zh: '拒绝', en: 'Deny' },
  'chatui.allowSession': { zh: '本次会话允许', en: 'Allow for session' },
  'chatui.allowOnce': { zh: '单次允许', en: 'Allow once' },

  // ===== 消息气泡 =====
  'chatui.you': { zh: '你', en: 'You' },
  'chatui.user': { zh: '用户', en: 'User' },
  'chatui.youRecalled': { zh: '你撤回了一条消息', en: 'You recalled a message' },
  'chatui.aiRecalled': { zh: 'AI 回复已撤回', en: 'AI reply recalled' },
  'chatui.systemBadge': { zh: '⚙️ 系统', en: '⚙️ System' },
  'chatui.systemInjected': { zh: '系统注入', en: 'System injected' },
  'chatui.reviewBadge': { zh: '⚖️ 审查', en: '⚖️ Review' },
  'chatui.codeReview': { zh: '代码审查', en: 'Code review' },
  'chatui.aiIndependentRound': { zh: '· AI 独立轮次', en: '· AI solo turn' },
  'chatui.locateMsg': { zh: '定位到消息：{text}', en: 'Jump to message: {text}' },
  'chatui.locateMsgShort': { zh: '定位到这条消息', en: 'Jump to this message' },
  'chatui.abortedTag': { zh: '[已终止]', en: '[Aborted]' },
  'chatui.errorTag': { zh: '[错误: {error}]', en: '[Error: {error}]' },
  'chatui.copy': { zh: '复制', en: 'Copy' },
  'chatui.recall': { zh: '撤回', en: 'Recall' },
  'chatui.regenerate': { zh: '重新生成', en: 'Regenerate' },
  'chatui.delete': { zh: '删除', en: 'Delete' },
  'chatui.deleteMsgConfirm': { zh: '删除该消息将同时删除其配对的回复，且无法恢复。确定删除？', en: 'Deleting this message also deletes its paired reply and cannot be undone. Delete?' },
  'chatui.rewindHere': { zh: '回退至此', en: 'Rewind here' },
  'chatui.rewindConfirm': { zh: '回退将删除该消息之后的所有消息（含 AI 内部会话），且无法恢复。确定回退至此？', en: 'Rewinding deletes all messages after this one (including AI internal sessions) and cannot be undone. Rewind here?' },
  'chatui.organizingReply': { zh: '正在组织回复', en: 'Composing reply' },
  'chatui.thinking': { zh: '思考', en: 'Thinking' },
  'chatui.thinkingInProgress': { zh: '思考中…', en: 'Thinking…' },
  'chatui.thinkingChars': { zh: '思考 · {n} 字', en: 'Thinking · {n} chars' },
  'chatui.collapseThinking': { zh: '收起思考过程', en: 'Collapse thinking process' },
  'chatui.expandThinking': { zh: '展开思考过程', en: 'Expand thinking process' },

  // ===== Markdown 渲染 =====
  'chatui.imageAlt': { zh: '图片', en: 'Image' },
  'chatui.openImage': { zh: '打开图片 {url}', en: 'Open image {url}' },
  'chatui.openLink': { zh: '打开 {url}', en: 'Open {url}' },
  'chatui.expand': { zh: '展开', en: 'Expand' },
  'chatui.collapse': { zh: '折叠', en: 'Collapse' },
  'chatui.copied': { zh: '已复制', en: 'Copied' },

  // ===== 行协议（回合 / 思考 / 子代理 / 模型切换） =====
  'chatui.turn': { zh: '回合', en: 'Turn' },
  'chatui.filesChanged': { zh: '{n} 文件', en: '{n} files' },
  'chatui.subtaskCount': { zh: '{n} 个子任务', en: '{n} subtasks' },
  'chatui.running': { zh: '运行中', en: 'Running' },
  'chatui.openPath': { zh: '点击打开：{path}', en: 'Click to open: {path}' },
  'chatui.parallelSubagent': { zh: '并行子代理', en: 'Parallel subagent' },
  'chatui.subagent': { zh: '子代理', en: 'Subagent' },
  'chatui.modelSwitchFrom': { zh: '模型切换：{from} → {to}', en: 'Model switch: {from} → {to}' },
  'chatui.modelSwitchTo': { zh: '模型切换：{to}', en: 'Model switch: {to}' },

  // ===== 聊天叠加窗 =====
  'chatui.startChatWith': { zh: '开始与 {name} 对话...', en: 'Start chatting with {name}...' },
  'chatui.emptyMsg': { zh: '(空)', en: '(empty)' },
  'chatui.removeAttachment': { zh: '移除附件', en: 'Remove attachment' },
  'chatui.generatingReply': { zh: '正在生成回复…', en: 'Generating reply…' },
  'chatui.webSearchOn': { zh: '联网搜索：开', en: 'Web search: on' },
  'chatui.webSearchOff': { zh: '联网搜索：关', en: 'Web search: off' },
  'chatui.webSearch': { zh: '联网', en: 'Web' },
  'chatui.overlayInputPlaceholder': { zh: '输入消息... (Enter 发送)', en: 'Type a message... (Enter to send)' },

  // ===== 内部会话 =====
  'chatui.inheritSuffix': { zh: '（延续）', en: ' (continued)' },
  'chatui.deleteInternalMsgConfirm': { zh: '删除该内部消息将永久移除且无法恢复。确定删除？', en: 'Deleting this internal message permanently removes it and cannot be undone. Delete?' },
  'chatui.deleteInternalSessionConfirm': { zh: '删除内部会话「{title}」将永久移除其中全部消息。确定删除？', en: 'Deleting internal session "{title}" permanently removes all its messages. Delete?' },

  // ===== 任务清单卡片 =====
  'chatui.priority.high': { zh: '高', en: 'High' },
  'chatui.priority.medium': { zh: '中', en: 'Medium' },
  'chatui.priority.low': { zh: '低', en: 'Low' },
  'chatui.todoIncomplete': { zh: '{n} 未完成', en: '{n} unfinished' },

  // ===== 工具调用卡片 =====
  'chatui.expandToolDetail': { zh: '展开工具调用明细', en: 'Expand tool call details' },
  'chatui.collapseToolDetail': { zh: '收起工具调用明细', en: 'Collapse tool call details' },
  'chatui.toolCallError': { zh: '工具调用有错误', en: 'Tool call error' },
  'chatui.toolCallCount': { zh: '工具调用 · {n} 次', en: 'Tool calls · {n}' },
  'chatui.collapseDetail': { zh: '收起详情', en: 'Collapse details' },
  'chatui.expandDetail': { zh: '展开详情', en: 'Expand details' },
  'chatui.noTitle': { zh: '(无标题)', en: '(untitled)' },
  'chatui.collapseSubagentDetail': { zh: '收起子 agent 详情', en: 'Collapse sub-agent details' },
  'chatui.expandSubagentDetail': { zh: '展开子 agent 详情', en: 'Expand sub-agent details' },
  'chatui.subtaskLabel': { zh: '子任务 {current}/{total}', en: 'Subtask {current}/{total}' },
  'chatui.toolTimes': { zh: '{n} 次工具', en: '{n} tools' },
  'chatui.output': { zh: '输出', en: 'Output' },
  'chatui.noProcessRecord': { zh: '（无过程记录）', en: '(no process record)' },

  // ===== 工具配置面板 =====
  'chatui.closeToolConfig': { zh: '关闭工具配置', en: 'Close tool config' },
  'chatui.selectAll': { zh: '全选', en: 'Select all' },
  'chatui.clearAll': { zh: '全清', en: 'Clear all' },
  'chatui.highRisk': { zh: '高风险', en: 'High risk' },
  'chatui.resetDefaults': { zh: '重置默认', en: 'Reset defaults' },
  'chatui.resetDefaultsConfirm': { zh: '恢复默认将覆盖当前所有工具开关设置，点击「应用」后生效且无法撤销。确定恢复默认？', en: 'Restoring defaults overwrites all current tool toggles; it takes effect after "Apply" and cannot be undone. Restore defaults?' },
  'chatui.apply': { zh: '应用', en: 'Apply' },

  // ===== 工作流人工弹窗 =====
  'chatui.wfRequestInput': { zh: '工作流请求输入', en: 'Workflow input request' },
  'chatui.aiAsk': { zh: 'AI 询问', en: 'AI question' },
  'chatui.inputTypeConfirm': { zh: '确认', en: 'Confirm' },
  'chatui.inputTypeText': { zh: '文本', en: 'Text' },
  'chatui.inputTypeChoice': { zh: '选择', en: 'Choice' },
  'chatui.pleaseInput': { zh: '请输入...', en: 'Please enter...' },
  'chatui.confirmYesNote': { zh: '确认后将向工作流返回 "yes"。', en: 'Confirming returns "yes" to the workflow.' },
  'chatui.hintCtrlEnter': { zh: 'Ctrl+Enter 提交 · Esc 取消', en: 'Ctrl+Enter to submit · Esc to cancel' },
  'chatui.hintEnterConfirm': { zh: 'Enter 确认 · Esc 取消', en: 'Enter to confirm · Esc to cancel' },
  'chatui.hintDigitChoice': { zh: '数字键 1-{n} 选择 · Esc 取消', en: 'Press 1-{n} to choose · Esc to cancel' },
  'chatui.hintEscCancel': { zh: 'Esc 取消', en: 'Esc to cancel' },
  'chatui.cancel': { zh: '取消', en: 'Cancel' },
  'chatui.submit': { zh: '提交', en: 'Submit' },

  // ===== 工作流状态条 =====
  'chatui.nodeType.tool': { zh: '工具', en: 'Tool' },
  'chatui.nodeType.condition': { zh: '条件', en: 'Condition' },
  'chatui.nodeType.human': { zh: '人工', en: 'Human' },
  'chatui.nodeType.answer': { zh: '回复', en: 'Answer' },
  'chatui.nodeType.end': { zh: '结束', en: 'End' },
  'chatui.wfRunning': { zh: '运行中', en: 'Running' },
  'chatui.wfWaitingInput': { zh: '等待输入', en: 'Awaiting input' },
  'chatui.wfWaitingMessage': { zh: '等待消息', en: 'Awaiting message' },
  'chatui.wfPaused': { zh: '已暂停', en: 'Paused' },
  'chatui.wfFailed': { zh: '失败', en: 'Failed' },
  'chatui.wfCompleted': { zh: '已完成', en: 'Completed' },
  'chatui.wfCancelled': { zh: '已取消', en: 'Cancelled' },
  'chatui.unknown': { zh: '未知', en: 'Unknown' },
  'chatui.modeChatflow': { zh: '对话流', en: 'Chatflow' },
  'chatui.modeWorkflow': { zh: '工作流', en: 'Workflow' },
  'chatui.pause': { zh: '暂停', en: 'Pause' },
  'chatui.resume': { zh: '恢复', en: 'Resume' },
  'chatui.wfCancelConfirm': { zh: '取消将终止该工作流实例，已执行的进度无法恢复。确定取消？', en: 'Cancelling terminates this workflow instance; completed progress cannot be recovered. Cancel?' },
  'chatui.noNodeHistory': { zh: '暂无节点执行记录', en: 'No node execution records' },
  'chatui.errorPrefix': { zh: '错误：', en: 'Error: ' },
  'chatui.outputPrefix': { zh: '输出：', en: 'Output: ' },

  // ===== 输入区技能引用 =====
  'chatui.memoryWorkflowId': { zh: '记忆工作流-{id}', en: 'Memory workflow-{id}' },
  'chatui.skillCount': { zh: '{n} 个', en: '{n}' },
  'chatui.ungrouped': { zh: '未分组', en: 'Ungrouped' },
  'chatui.countInParens': { zh: '（{n}）', en: ' ({n})' },

  // ===== 房间 =====
  'chatui.roomCamera': { zh: '{name}的房间直播镜头', en: "{name}'s room camera" },
  'chatui.positiveUp': { zh: '（正数向上）', en: ' (positive is up)' },
  'chatui.live2dPrefix': { zh: 'Live2D：', en: 'Live2D: ' },
  'chatui.live2dSelfProvided': { zh: '模型与 Cubism Core 由你自备（放在房间数据目录的 live2d/ 下），不随安装包分发。', en: 'You provide the model and Cubism Core (place them under live2d/ in the room data directory); they are not bundled with the installer.' },
  'chatui.live2dLicense': { zh: 'Live2D 核心是专有软件（不是 AGPL）；请确认你有权使用该模型，并遵守 Live2D 的发布许可。', en: "Live2D Core is proprietary software (not AGPL); ensure you have the right to use this model and comply with Live2D's release license." },

} satisfies Record<string, DictEntry>

export default dict
