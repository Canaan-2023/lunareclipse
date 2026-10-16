// ===== shared/types 域拆分 barrel =====
// 按域拆分子文件（chat/row-protocol/tool-types/session/llm/app-config/...），
// 本文件仅做再导出，外部引用路径（@shared/types 或 ../types）保持不变。
// 拆分底层动因：早期单一 types 文件已达数百行，任何小改动都触发全量类型重编译且冲突频发；
// L1 低风险拆分（纯类型/常量/函数抽取，零运行时风险）把共享类型按域隔离，既降低编译面又避免跨域误改。
// 为什么存在：对外保持 @shared/types 单一路径，按域隔离关注点并避免单一巨型 types 文件；
// 外部引用路径不变，域拆分对调用方完全无感。

// 会话与消息
export * from './chat'
// 行协议（rows 行流类型）
export * from './row-protocol'
// 工具调用可视化
export * from './tool-types'
// 会话结构（含内部会话/双层摘要）
export * from './session'
// LLM 相关
export * from './llm'
// 全局配置
export * from './app-config'
// 工具策略
export * from './tool-policy'
// 莉莉丝桌宠
export * from './lilith'
// AI 元搜索
export * from './ai-assist'
// 图像/多模态生成
export * from './generation'
// 消息接入
export * from './messaging'
// 工作区
export * from './workspace'
// MCP
export * from './mcp'
// Hooks
export * from './hooks'
// 评测
export * from './eval'
// WS 协议 / 主题
export * from './ws'
// 监控（配置 + P0 可视化 + 健康检查 + 工作流摘要）
export * from './monitor'
// 默认配置常量
export * from './defaults'