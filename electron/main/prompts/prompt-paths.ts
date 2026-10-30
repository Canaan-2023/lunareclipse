/**
 * 提示词路径预替换：把提示词里的 `{记忆工作域}` 一类占位符，在注入 AI 之前替换成当前
 * 用户与 AI 作用域的真实绝对路径。
 *
 * 为什么存在：同一份提示词服务多个用户与多个 AI，写死的 `memory/U{uid}/AI{aiId}` 只能由
 * 模型自己拼接，拼错就是"找不到文件"；而单独再注入一个"路径表"段又会让模型多读一块内容、
 * 多一次对照。预替换把真实路径就地写进原句，句子长度基本不变，模型读到的就是能直接用的地址。
 *
 * 性能：占位符表每次现算——`resolveScopePaths` 只做字符串拼接，没有 IO、没有目录扫描，
 * 单次调用是微秒级，不值得为它引入缓存（缓存会带来上限、失效与作用域串味的维护成本）；
 * 替换前先做一次 `includes('{')` 快速判定，不含占位符的文本直接原样返回；替换是单次正则。
 *
 * 不删掉的理由：路径是运行时数据，不能写进提示词文件；替换集中在注入边界，才能保证
 * 提示词文本与 paths.ts 唯一真源不漂移（改目录结构只改 paths.ts）。
 */
import type { BaseDataPaths, DataPaths, MemoryScope } from '../models/paths'
import { resolveScopePaths } from '../models/paths'

/** 占位符 → 真实绝对路径。提示词只写占位符，注入前统一替换。 */
const TOKEN_KEYS = [
  '记忆工作域',
  'RAW 目录',
  'normal 目录',
  'meta 目录',
  'high 目录',
  'NNG 根',
  'NNG 一级索引',
  'NNG 一级节点目录',
  '缓存根',
  '缓存一级索引',
  '一级缓存目录',
  '日记索引目录',
  'AI.md 路径',
  'USER.md 路径'
] as const

/** 单次正则匹配所有占位符（键按长度降序，避免短键抢先匹配长键前缀） */
const TOKEN_RE = new RegExp(
  `{(${TOKEN_KEYS.slice()
    .sort((a, b) => b.length - a.length)
    .join('|')})}`,
  'g'
)

/** 解析作用域真实路径，返回占位符表（纯字符串拼接，无 IO） */
export function getPromptPathMap(base: BaseDataPaths, scope: MemoryScope): Record<string, string> {
  const p: DataPaths = resolveScopePaths(base, scope)
  const map: Record<string, string> = {
    '{记忆工作域}': p.memoryScope ?? p.memoryNormal,
    '{RAW 目录}': p.rawMemory,
    '{normal 目录}': p.memoryNormal,
    '{meta 目录}': p.memoryMeta,
    '{high 目录}': p.memoryHigh,
    '{NNG 根}': p.nngRoot,
    '{NNG 一级索引}': p.nngRootJson,
    '{NNG 一级节点目录}': p.nngLevel1Dir,
    '{缓存根}': p.cacheIndex,
    '{缓存一级索引}': p.cacheIndexJson,
    '{一级缓存目录}': p.cacheLevel1Dir,
    '{日记索引目录}': p.diary ?? '',
    '{AI.md 路径}': p.aiMd,
    '{USER.md 路径}': p.userMd
  }
  return map
}

/**
 * 按占位符表替换文本。表为空或文本不含 `{` 时原样返回（快速路径）。
 * 工作流节点用：实例 input 里带 `prompt_paths`，节点提示词渲染后按同一张表替换。
 */
export function applyPromptPathMap(text: string, map?: Record<string, string> | null): string {
  if (!text || !map || !text.includes('{')) return text
  return text.replace(TOKEN_RE, (whole, name: string) => map[`{${name}}`] ?? whole)
}

/**
 * 把文本中的路径占位符替换成当前作用域的真实绝对路径。
 * 不含 `{` 的文本直接返回（快速路径，覆盖绝大多数段）。
 */
export function applyPromptPaths(text: string, base: BaseDataPaths, scope: MemoryScope): string {
  return applyPromptPathMap(text, getPromptPathMap(base, scope))
}
