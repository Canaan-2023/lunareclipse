/** 双层会话服务（summarizer/router）共用的小工具与类型，避免与旧块树服务耦合 */

/** 轻量 LLM 通道（与 block-summarizer.LightChat 同形；由 server.ts 注入轻量 model 闭包） */
export type LightChat = (
  messages: { role: 'system' | 'user'; content: string }[],
  model?: string
) => Promise<string>

export function truncate(text: string, max: number): string {
  const t = text ?? ''
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/**
 * 路由输入的截断策略：保留开头 head + 结尾 tail，中间省略（Q5）。
 * 纯头截断（truncate 只留头）会丢掉用户输入末尾的最新补充/收尾意图——
 * 路由要判定"该续哪个内部会话"依赖主题（开头）与最近诉求（结尾），
 * 中间多为过程性细节，对匹配决策影响最小。head=2000 沿用原路由截断上限
 * （长输入过滤噪音，防止把整个粘贴件喂给路由 LLM），tail=500 保留结尾诉求。
 */
export function truncateHeadTail(text: string, head: number, tail: number): string {
  const t = text ?? ''
  if (t.length <= head + tail) return t
  return `${t.slice(0, head)}…[中间省略 ${t.length - head - tail} 字符]…${t.slice(-tail)}`
}

/** 宽松解析 LLM 输出 JSON：剥离 markdown 围栏 / 截取首尾花括号，失败返回 null（调用方按"未执行"处理） */
export function parseLooseJson<T>(raw: string): T | null {
  const text = (raw || '').trim()
  const attempts = [text]
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenced) attempts.push(fenced[1])
  const braceMatch = text.match(/\{[\s\S]*\}/)
  if (braceMatch) attempts.push(braceMatch[0])
  for (const attempt of attempts) {
    try {
      const value = JSON.parse(attempt)
      if (value && typeof value === 'object') return value as T
    } catch {
      // 尝试下一个
    }
  }
  return null
}

/** 内部会话创建时间的人读格式（"创建于 2026-09-01 14:30"；路由清单必含字段） */
export function formatSessionTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}