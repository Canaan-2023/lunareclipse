// ===== 工作区配置（AI 专属工作区）共享类型 =====
// 纯数据类型，供前端 UI 和主进程共享。
// 配置存储在 {userData}/.workspaces.json，类似 .mcp.json 的设计。
// 为什么存在：工作区列表与激活项由主进程读写 .workspaces.json、前端工作区切换器展示与选择，
// 两端需要同一份配置契约。

/** 单个工作区配置 */
export interface WorkspaceItem {
  /** 唯一 ID（uuid 或路径哈希） */
  id: string
  /** 显示名称（用户可改） */
  name: string
  /** 工作区根目录绝对路径（用户可配置，哪怕是硬盘根目录） */
  path: string
  /** 创建时间（ISO） */
  createdAt: string
}

/** 工作区配置（.workspaces.json） */
export interface WorkspaceConfig {
  /** 工作区列表（至少一个，默认 HOME 目录） */
  workspaces: WorkspaceItem[]
  /** 当前激活工作区 ID（指向 workspaces 中一项） */
  activeWorkspaceId: string
}