// ============================================================
// 渲染进程桥接：让主进程工具能向前端窗口发送 IPC 事件
// ------------------------------------------------------------
// 主窗口创建时注册 sendFn，工具通过 sendToRenderer 通知前端。
// 为什么存在：主进程工具（如 browser/file 操作）在事件完成后需要主动通知前端窗口，多处发送的 IPC 调用需要一个单点门面。
// ============================================================

let _sendFn: ((channel: string, data: unknown) => void) | null = null

export function setRendererBridge(sendFn: (channel: string, data: unknown) => void): void {
  _sendFn = sendFn
}

export function sendToRenderer(channel: string, data: unknown): void {
  _sendFn?.(channel, data)
}
