/**
 * @category 前端组件
 * @summary 内部会话面板共用小工具（时间格式化）
 * @note 为什么存在：`formatTime` 被节点卡片与会话详情里的消息行共用，抽到共用模块避免两处各写一份本地化格式（口径漂移不会报错、只会显示不一致）。
 * @note 不删理由：时间显示是面板的基础信息面，重复实现会让同一时间在卡片与详情里显示不一致。
 */


export function formatTime(ts: number): string {
  if (!ts) return ''
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}
