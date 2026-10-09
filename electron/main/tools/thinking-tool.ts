/**
 * 思考协议工具：为什么存在——思考本身是模型能力，方法论文本已在系统提示词
 * 「输出纪律」段恒注入（output_discipline，见 shared/utils/output-discipline.ts）；
 * 本工具只提供「落盘留痕」的可选出口：把思考流写入 thinking-log 供复盘，其余不干预。
 * 作用：thinking_protocol 记录思考内容到日志（含时间戳），并返回录制结果。
 */
import type { Tool, ToolResult, ToolContext } from './base-tool'
import { join } from 'path'
import { mkdirSync, appendFileSync } from 'fs'

export interface ThinkingProtocolParams {
  /**
   * 思考流（必填）：本轮要留痕的完整思考内容。方法论文本见系统提示词
   * 「输出纪律」段（立根→验底→顺推→验证 + 输出纪律），此处不再重复。
   */
  thought: string
  /** 思考主题（可选） */
  topic?: string
  /** 思考深度 1-5（可选） */
  depth?: number
}

/** 当日思考日志文件名（thinking-log/YYYY-MM-DD.md） */
function logFileName(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}.md`
}

function timeStr(): string {
  const d = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/**
 * thinking_protocol：思考的落盘出口（可选）。
 *
 * 实现原则：
 * - 工具是壳子：不调 LLM、不用子 agent、不靠代码处理——思考靠 AI 自己执行。
 * - 方法与纪律已前置到系统提示词「输出纪律」段（output_discipline 恒注入），
 * 本工具不重复声明方法论，只承接「要留痕的思考流」并落盘 thinking-log。
 * - 不是思考入口：不调用本工具时，思考仍按输出纪律段正常进行，只是不留留痕记录。
 * - 学到新方法时更新系统提示词「输出纪律」段（output-discipline.ts），不是本工具。
 */
export class ThinkingProtocolTool implements Tool<ThinkingProtocolParams> {
  name = 'thinking_protocol'
  description =
    '把一次完整思考流写入 thinking-log 日志，供以后复盘回看。' +
    '思考方法在系统提示词「输出纪律」段（四步：立根→验底→顺推→验证），按那里执行即可，本工具只负责留存。' +
    '需要留下可回看的思考记录时调用；不需要留痕时就不调用，思考照常进行。' +
    '参数：thought（必填，本轮思考流全文）、topic（选填，思考主题）、depth（选填，思考深度 1-5）。'
  parameters = [
    { name: 'thought', type: 'string' as const, description: '思考流（必填）：本轮要留痕的完整思考内容', required: true },
    { name: 'topic', type: 'string' as const, description: '思考主题（可选）', required: false },
    { name: 'depth', type: 'number' as const, description: '思考深度 1-5（可选）', required: false }
  ]

  execute(params: ThinkingProtocolParams, ctx?: ToolContext): Promise<ToolResult> {
    if (!params.thought || typeof params.thought !== 'string') {
      return Promise.resolve({ ok: false, error: 'thought 必填，且必须是字符串' })
    }
    const thought = params.thought.trim()
    if (!thought) {
      return Promise.resolve({ ok: false, error: 'thought 不能为空' })
    }

    const topic = params.topic?.trim() ?? ''
    const depth = params.depth ?? 1
    const time = timeStr()

    // 落盘：thinking-log/YYYY-MM-DD.md（工具独立上下文，与主对话分离）
    let file: string | null = null
    try {
      const dir = ctx?.paths?.root ? join(ctx.paths.root, 'thinking-log') : null
      if (dir) {
        file = join(dir, logFileName())
        mkdirSync(dir, { recursive: true })
        const lines = [
          '',
          `### [${time}] thinking_protocol${topic ? `（主题：${topic}）` : ''}（深度 ${depth}）`,
          '',
          ...thought.split('\n').map((l) => `> ${l}`),
          ''
        ]
        appendFileSync(file, lines.join('\n'), 'utf-8')
      }
    } catch (err) {
      // 落盘失败不阻断——思考已上屏，落盘是附加能力
      console.error('[thinking_protocol] 落盘失败:', err)
    }

    return Promise.resolve({
      ok: true,
      data: {
        recorded: !!file,
        file,
        time,
        thought,
        topic: topic || undefined,
        depth
      }
    })
  }
}
