/**
 * @category 工具
 * @summary 消息接入：外部消息（如流/飞书）进出链路
 */
/**
 * 消息接入模块统一出口
 *
 * 模块职责：外部消息平台（飞书长连接）→ 月蚀大脑 的双向桥。
 * - feishu.ts：飞书适配器（官方 SDK 长连接 WS，收发）
 * - service.ts：入站管线（白名单 → 路由 → 串行队列 → 对话 → 回发）
 *
 * 实例由 server.ts 持有（闭包注入对话入口），IPC 通过 getMessagingService 访问。
 */
export { MessagingService, type MessagingDeps, type InboundMessage } from './service'
export { FeishuAdapter, type FeishuInboundMessage, type FeishuMessageHandler } from './feishu'
