/**
 * 敏感信息脱敏（secret redaction）

 * 安全脱敏（默认开）：工具输出进上下文/落盘前
 * 扫描密钥形态字符串，替换为 [REDACTED]。防止：
 * - AI 读到 .env / 密钥文件后把密钥复述进会话 → 落盘会话 JSONL 留痕
 * - 密钥进入 LLM 上下文（发给第三方 API）

 * 设计原则（宁可漏不可误伤）：
 * - 只匹配高置信度形态（前缀 + 长度/字符集约束），普通文本不误伤
 * - 脱敏发生在 executeTool 结果返回前 + 会话落盘前两个挂载点
 */
export function redactSecrets(text: string): string {
  if (!text) return text
  let out = text

  // 1. 常见 API key 形态：sk- 开头长串（OpenAI/DeepSeek 等）
  out = out.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:API_KEY]')
  // 2. AWS Access Key
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:AWS_KEY]')
  // 3. Slack token
  out = out.replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, '[REDACTED:SLACK_TOKEN]')
  // 4. Bearer token（Authorization 头形态）
  out = out.replace(/\bBearer\s+[A-Za-z0-9._\-~+/]{20,}=*\b/g, '[REDACTED:BEARER_TOKEN]')
  // 5. 私钥块
  out = out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:PRIVATE_KEY]')
  // 6. 常见键值对形态：key= / key: / "key": 后跟长值（api_key/token/secret/password/access_key 等）
  out = out.replace(
    /(["']?(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|pwd)["']?\s*[:=]\s*["']?[^"'\s,;]{8,}["']?)/gi,
    (match, _g) => {
      // 保留键名，只脱敏值
      const eqIdx = match.search(/[:=]/)
      if (eqIdx < 0) return match
      return `${match.slice(0, eqIdx + 1)}[REDACTED:CREDENTIAL]`
    }
  )

  return out
}

/** 对 ToolResult 的 data/error 做脱敏（原地新建对象，不修改原对象） */
export function redactToolResult<T extends { ok: boolean; data?: unknown; error?: string }>(
  result: T
): T {
  let data = result.data
  if (typeof data === 'string') {
    data = redactSecrets(data)
  } else if (data && typeof data === 'object') {
    try {
      data = JSON.parse(redactSecrets(JSON.stringify(data)))
    } catch {
      // JSON 序列化/解析失败（循环引用等）→ 保持原样
      data = result.data
    }
  }
  const error = typeof result.error === 'string' ? redactSecrets(result.error) : result.error
  if (data === result.data && error === result.error) return result
  return { ...result, data, error }
}
