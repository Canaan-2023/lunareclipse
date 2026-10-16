/**
 * 会话消息与用户基础类型（shared）。
 * 为什么存在：消息、用户、附件是主进程（持久化/LLM 组包）与前端渲染共用的核心模型，必须
 * 共享定义以保证两侧一致。
 * 作用：导出 Role、CurrentUser、Attachment、ChatMessage 等基础类型。
 */
import type { ConversationRow } from './row-protocol'
import type { ToolCall } from './tool-types'

export type Role = 'user' | 'assistant' | 'system'

export interface CurrentUser {
  UID: number
  用户名: string
  /** 显示昵称（个人中心可改；缺省回退用户名展示） */
  昵称?: string
  /** 头像标识（emoji 或 img:avatars/... 本地图片引用，个人中心可改） */
  头像?: string
}

export interface Attachment {
  name: string
  path: string
  size: number
  type: string
  /** 图片附件预览用 data URL（前端 FileReader 生成，CSP 允许 data:；发送/持久化随消息） */
  dataUrl?: string
}

export interface ChatMessage {
  id: string
  role: Role
  content: string
  createdAt: number
  aborted?: boolean
  error?: string
  attachments?: Attachment[]
  /** 自主激活产生的消息（无对应用户输入）：用于空消息清理与 memo 比较，UI 不再据此渲染 */
  activation?: boolean
  /** 深度思考内容（reasoning_content / thinking 字段累积，可折叠展示） */
  reasoning?: string
  /** 本轮回复中的工具调用列表，按调用顺序。WS tool_start/tool_end 填充并持久化。*/
  toolCalls?: ToolCall[]
  /** 行协议：本消息（轮）的行流。有 rows 时前端按行渲染，无 rows 回退整段 markdown。*/
  rows?: ConversationRow[]
  /** 消息撤回标记：true 时 UI 显示撤回占位符，不注入 AI 上下文 */
  recalled?: boolean
  /** 撤回时间戳（ms） */
  recalledAt?: number
  /** 编辑时间戳（ms），用于 memo 比较 */
  editedAt?: number
}