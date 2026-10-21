/**
 * 提示词注入链的「本轮用途」契约（0.53.10）。
 *
 * 为什么单独成类型：`purpose` 决定三件互斥的事——
 * 1. 是否消费全局激活事件（只有前台对话消费）；
 * 2. 是否注入 ROOM 专属纪律与契约（只有 'room'）；
 * 3. 是否追加用途专属工具（只有 'room'）。
 * 用裸 string 时拼写错误不会报错，只会静默让后台轮拿到前台权限或让房间轮拿到对话纪律。
 *
 * `undefined` = 前台交互轮（WS 主链路）。**新增无头调用必须显式传值**。
 */
export type PromptPurpose =
  | 'room'
  | 'lan-chat'
  | 'lan-direct'
  | 'ai-social'
  | 'publish-board'
  | 'messaging'
  | 'system-injected'
  | 'cli'
