/**
 * 中继异步传输（L1.5）类型契约。
 * 为什么存在：实时 LAN 传输直连对端、即发即收；但当对端离线、或需要"上传到主系统中继、
 * 对端稍后确认再取件"的云盘式场景时，需要一个独立于实时直连的异步通道。
 * 作用：定义中继条目（元数据+状态机）、信封负载与前端事件三者契约。
 * 存储：{root}/relay/entries.json（清单，原子写）；文件实体 {root}/relay/files/{itemId}/。
 * 角色：主系统（master）是中继存储端；发送端上传、接收端确认后从主系统下载（独立两段）。
 */

/** 中继条目状态机：uploading → uploaded → notified → downloaded / expired */
export type RelayStatus = 'uploading' | 'uploaded' | 'notified' | 'downloaded' | 'expired'

/**
 * 中继条目（主系统本地持真值；发送/接收端缓存副本用于 UI 展示与事件对齐）。
 * 为什么需要副本：发送端要展示"我发的文件现在什么状态"，接收端要展示"谁给我发了什么"，
 * 但真值只存主系统（{root}/relay/entries.json，多机并发取件以主系统为准互不干扰）；
 * 两端经信封事件同步副本，避免每次查询都跨机握手。
 */
export interface RelayEntry {
  /** 条目 ID（发送端生成 uuid） */
  itemId: string
  /** 发送方 uid */
  senderUid: number
  /** 发送方用户名（roster 快照） */
  senderName: string
  /** 目标接收方 uid（唯一允许下载者；权限校验按此收敛） */
  receiverUid: number
  /** 接收方用户名快照 */
  receiverName: string
  /** 单文件 / 文件夹 */
  kind: 'file' | 'dir'
  /** 顶层落盘名：单文件=文件名；文件夹=原目录名 */
  name: string
  /** 总字节数（单文件=文件大小；文件夹=全部文件累计） */
  totalBytes: number
  /** 文件条目数（文件夹；单文件=1） */
  files: number
  /** 目录条目数（文件夹内含空目录；单文件=0） */
  dirs: number
  /** 条目创建（上传开始）时间 epoch ms */
  createdAt: number
  /** 状态机 */
  status: RelayStatus
  /** 无人确认保留策略：超过 expiresAt 且未下载 → 主系统清理（状态 expired，文件删除） */
  expiresAt: number
  /** 下载完成时间（status=downloaded 时有值） */
  downloadedAt?: number
  /** 主系统中继存储相对路径（{root}/relay/files/{itemId}；发送端/接收端副本无实体，仅作展示） */
  storagePath?: string
  /** 中继下载目标位置（接收端自定义下载位置；AI 经提示词感知，UI 展示回显用） */
  downloadDir?: string
}

/** entries.json 文件结构 */
export interface RelayEntriesFile {
  updatedAt: string
  entries: RelayEntry[]
}

// ===== 局域网信封负载（业务方向 relay.*，经 L0 直连/outbox 投递） =====

/** sender → master：宣布开始上传（主系统登记 uploading 条目并约定 itemId 目录） */
export interface RelayUploadBeginPayload {
  itemId: string
  senderUid: number
  senderName: string
  receiverUid: number
  receiverName: string
  kind: 'file' | 'dir'
  name: string
  totalBytes: number
  files: number
  dirs: number
  expiresAt: number
}

/** sender → master：上传流完成（主系统校验条目完整性后置 uploaded/notified） */
export interface RelayUploadDonePayload {
  itemId: string
  /** 实际送达且 ack 的字节数（主系统与本端统计或其他对端交叉核对） */
  ackedBytes?: number
}

/** master → receiver：文件就绪提醒（社交链路通知；对端在线直接送达，离线走 outbox 补投） */
export interface RelayNotifyPayload {
  itemId: string
  senderUid: number
  senderName: string
  kind: 'file' | 'dir'
  name: string
  totalBytes: number
  files: number
  expiresAt: number
  ts: number
}

/** receiver → master：确认取件（主系统校验 receiverUid 后把中继文件流式回发） */
export interface RelayConfirmPayload {
  itemId: string
}

/** receiver → master：取件完成（主系统置 downloaded / 按策略清理） */
export interface RelayDownloadDonePayload {
  itemId: string
  ok: boolean
  error?: string
}

/** sender → master：撤回上传（未确认/已过期前撤销；主系统删除条目与文件） */
export interface RelayRevokePayload {
  itemId: string
}

// ===== 前端事件（webContents.send('relay:event')） =====

/** 中继前端事件：提醒、进度、状态推进、错误 */
export type RelayEvent =
  | { type: 'notify'; entry: RelayEntry }
  | { type: 'entry'; entry: RelayEntry }
  | {
      type: 'progress'
      itemId: string
      phase: 'upload' | 'download'
      sentBytes: number
      totalBytes: number
      /** 发送侧进度回调有值；接收侧无（收件器以区块累计自行上报时可补） */
      doneFiles?: number
      totalFiles?: number
    }
  | { type: 'done'; itemId: string; ok: boolean; error?: string }
  | { type: 'revoked'; itemId: string }
  | { type: 'error'; itemId: string; error: string }

/** 前端列表项（RelayPanel：发送的 / 接收的 / 待取件） */
export interface RelayListItem {
  itemId: string
  kind: 'file' | 'dir'
  name: string
  totalBytes: number
  files: number
  dirs: number
  status: RelayStatus
  /** 与我的关系：send=我发出；receive=我接收 */
  direction: 'send' | 'receive'
  peerUid: number
  peerName: string
  createdAt: number
  expiresAt: number
  downloadedAt?: number
  downloadDir?: string
  unread?: boolean
}