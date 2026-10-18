/**
 * @category 主进程 API
 * @summary 莉莉丝 companion 会话读写（从 server.ts 抽出；sessions 文件为唯一真相源）

 * 为什么存在：莉莉丝是独立 companion 进程，月蚀要与它双向同步对话，
 * 必须直读其 %APPDATA%\LilithAI\sessions 上下文文件作为唯一真相源，
 * 且多入口并发写需串行化——独立成模块避免 server.ts 膨胀并隔离同步复杂逻辑。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ConfigStore } from './config-store'
import type { ToolDef } from './llm'
import { lilithCharacterPath } from '../services/lilith-adapter'
import type { ToolParameter } from '../tools/base-tool'

/** companion 运行时信息文件（端口 + token） */
export const LILITH_RUNTIME_PATH = join(process.env.APPDATA || '', 'LilithAI', 'runtime.json')

// ===== 莉莉丝上下文唯一真相源 =====
// 架构修正（用户反馈"两个莉莉丝不同步"）：
// 莉莉丝自己的上下文 = companion sessions 文件（%APPDATA%\LilithAI\sessions\*.json）。
// ★ 关键：LilithMod 的 session_id 不固定（每次清理/重开会话就换 session_id → 新哈希文件）
// 所以不能固定读 sha256('lilith')——必须扫描 sessions 目录取"最新活跃会话"。
// 游戏内黑框对话写的就是最新活跃会话，♥ 置顶窗口读同一份 → 完全同步（说话/清空）。
// 月蚀不再另建 lilith_chat 会话（那会导致两份文件 + 普通会话列表出现"月蚀"名的莉莉丝）。
const LILITH_SESSIONS_ROOT = join(process.env.APPDATA || '', 'LilithAI', 'sessions')

/**
 * 莉莉丝总开关（模块化）：config.lilith.enabled === false 时链路整体停用。
 * 缺省（undefined）视为 true（保留旧行为：配置了 lilith 段即启用）。
 */
export function lilithEnabled(configStore: ConfigStore): boolean {
  const lilith = configStore.getEffective().lilith
  if (!lilith) return false
  return lilith.enabled !== false
}

/** 取莉莉丝当前活跃会话文件（sessions 目录里最近修改的 .json） */
export function activeLilithSessionFile(): string {
  if (!existsSync(LILITH_SESSIONS_ROOT)) return join(LILITH_SESSIONS_ROOT, 'none.json')
  const files = readdirSync(LILITH_SESSIONS_ROOT)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ name: f, mtime: statSync(join(LILITH_SESSIONS_ROOT, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return files.length > 0
    ? join(LILITH_SESSIONS_ROOT, files[0].name)
    : join(LILITH_SESSIONS_ROOT, 'none.json')
}

/** 读取莉莉丝活跃会话（唯一真相源；格式 [{role, content}]） */
export function readLilithCompanionSession(): Array<{ role: string; content: string }> {
  const file = activeLilithSessionFile()
  if (!existsSync(file)) return []
  const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  return Array.isArray(parsed)
    ? parsed.filter(
        (m) =>
          m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
      )
    : []
}

/**
 * 莉莉丝 sessions 串行写队列（修复）：
 * sessions 文件是唯一真相源，多入口（游戏内 /chat/completions、♥ 窗口 /api/lilith/message）并发写，
 * read-modify-write 必须串行化——否则 A 读旧 → B 读旧 → A 写 → B 写，后写覆盖先写（整轮对话丢失）。
 * Promise 链保证任意时刻只有一个写任务在执行；单次任务内部对多对消息做一次原子写。
 */
let lilithSessionWriteChain: Promise<void> = Promise.resolve()

export function appendLilithCompanionMessages(
  pairs: Array<{ role: 'user' | 'assistant'; content: string }>
): Promise<void> {
  const task = lilithSessionWriteChain.then(() => {
    const file = activeLilithSessionFile()
    mkdirSync(LILITH_SESSIONS_ROOT, { recursive: true })
    const existing = existsSync(file)
      ? JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      : []
    const arr = Array.isArray(existing) ? existing : []
    writeFileSync(file, JSON.stringify([...arr, ...pairs], null, 2) + '\n', 'utf8')
  })
  lilithSessionWriteChain = task
  return task
}

/**
 * 清空莉莉丝会话（模块化）：把活跃会话文件内容清空（保留文件，写空数组）。
 * 走串行写队列，防与正在进行的对话写入交错。
 */
export function clearLilithCompanionSession(): Promise<void> {
  const task = lilithSessionWriteChain.then(() => {
    try {
      const file = activeLilithSessionFile()
      mkdirSync(LILITH_SESSIONS_ROOT, { recursive: true })
      writeFileSync(file, '[]\n', 'utf8')
    } catch (err) {
      console.error('[lilith] companion session 清空失败:', (err as Error).message)
    }
  })
  lilithSessionWriteChain = task
  return task
}

/** 读取莉莉丝人设文件（不存在返回 null） */
export function readLilithCharacterFile(dataRoot: string): Record<string, unknown> | null {
  const p = lilithCharacterPath(dataRoot)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>
}

/** 工具参数 → OpenAI function calling schema（莉莉丝工具池用） */
export const toLilithToolDef = (tool: {
  name: string
  description: string
  parameters: ToolParameter[]
}): ToolDef => {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const p of tool.parameters) {
    properties[p.name] = { type: p.type, description: p.description }
    if (p.required) required.push(p.name)
  }
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: { type: 'object', properties, required }
    }
  }
}