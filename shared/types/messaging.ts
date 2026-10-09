/**
 * 消息接入（外部平台 → 月蚀大脑）配置（shared）。
 * 为什么存在：外部平台适配器在主进程运行，白名单与联系人路由在设置页编辑，需要共享同一份
 * 配置契约。
 * 作用：导出 MessagingConfig、MessagingContact 类型。
 */
/** 消息接入（外部平台 → 月蚀大脑）配置 */
export interface MessagingConfig {
  /** 总开关：false 时所有平台适配器不启动 */
  enabled: boolean
  /** 飞书开放平台自建应用凭证（App ID + App Secret，开放平台免费申请） */
  feishu?: {
    appId: string
    appSecret: string
  }
  /**
   * 白名单（open_id 列表；空数组 = 默认开放全部，任何私聊/群都能触发）。
   * 私聊校验发送者 open_id；群聊校验 chat_id（群级白名单）。
   */
  allowFrom: string[]
  /** 联系人/群 → agent 固定映射（未配置的默认走月蚀，能干活） */
  contacts: MessagingContact[]
}

/** 外部联系人/群映射 */
export interface MessagingContact {
  /** 平台标识：私聊 = 发送者 open_id；群聊 = chat_id */
  id: string
  /** 显示名（配置界面用） */
  name: string
  /** 私聊 or 群聊 */
  type: 'p2p' | 'group'
  /** 固定路由到的 agent：xi=月蚀（完整工具，可指挥干活）；lilith=莉莉丝（角色对话，记忆工具） */
  agent: 'xi' | 'lilith'
  /** 月蚀模式会话 ID（首次对话时生成，持久化到映射表） */
  sessionId?: string
}