/**
 * @category 工具
 * @summary 多实例 registerIpc 各域注册函数共享的上下文接口（闭包捕获 MultiInstanceService this 后分发）
 * 为什么存在：各域 registerIpc 都要从 MultiInstanceService 取上下文，用接口类型约束传递可避免注册函数间参数漂移。
 */
import type { FriendIpcCtx } from './register-friend-ipc'
import type { AiSocialIpcCtx } from './register-ai-social-ipc'
import type { ChatRoomIpcCtx } from './register-chat-room-ipc'
import type { PublishBoardIpcCtx } from './register-publish-board-ipc'
import type { AccountIpcCtx } from './register-account-ipc'
import type { BackupIpcCtx } from './register-backup-ipc'
import type { RelayIpcCtx } from './register-relay-ipc'

/** registerIpc 全量上下文：index.ts 末构造一次，分发到 7 个域注册函数 */
export type MultiInstanceIpcCtx = FriendIpcCtx &
  AiSocialIpcCtx &
  ChatRoomIpcCtx &
  PublishBoardIpcCtx &
  AccountIpcCtx &
  BackupIpcCtx &
  RelayIpcCtx