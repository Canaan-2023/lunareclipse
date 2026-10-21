/**
 * 行协议统计：统计一轮对话中文件类工具调用造成的增/删/文件数（纯函数）
 * ------------------------------------------------------------
 * 为什么存在：`turnHeader` 行收尾需要 `fileChanges` 字段（见 stream-runner 的
 * `endedHeader` upsert），本函数是行协议里「本轮改动了几个文件」这一事实的**唯一来源**。
 * 它原先内联在 stream-runner.ts 里（曾短暂住在 server-utils.ts，后因单一消费方迁回）。
 * 抽取成独立模块的**唯一理由是「可测」**——它是一段纯逻辑，任何一处漂移（工具名清单漏项、
 * 路径键优先级写反、非 success 状态被计入）都**不会报错**，只会让 UI 上的「N 个文件变更」
 * 悄悄变成错数，而这类错误没有任何运行时信号可依赖。躺在 1400 行的流式引擎里，它既无法被
 * 单独验证，也不容易在改动工具集时被想起。与 0.33 把注入前净化链抽成
 * `context-sanitize.ts` 是同一性质的抽取（单调用点换可测性）。
 * 作用：入参是「本轮 toolCallId → ToolCallRow」的行表，出参是
 * `{ additions, deletions, files }`。只统计 `status === 'success'` 的文件类工具：
 * 写入类（Write/Edit/MoveFile/CopyFile/Mkdir）计一次增；删除类（DeleteFile）计一次删；
 * 并从 `input` 里尽量提取目标路径去重（Write/Edit 的 `file_path`、
 * Move/Copy 的 `target_path`、以及 `source_path` 兜底；DeleteFile 的 `file_paths` 数组）。
 * 不删理由：`fileChanges` 是 turnHeader 行协议的必需字段，前端「本轮改了哪些文件」的展示
 * 直接读它；删掉即字段缺失。**为什么不放回 server-utils.ts**：该文件头写明的收录策略是
 * 「只保留有多个消费方的共享项」，本函数只有 stream-runner 一个消费方；把它放到独立模块
 * 是为了可测（纯函数可脱离 electron 直接验证），而不是为了共享。
 *
 * 为什么 `WRITE_TOOLS` / `DELETE_TOOLS` 留在函数体内而不提到模块顶层：与抽取前逐字节等价
 * （原实现每次调用重建这两个 Set）。提到顶层虽是安全的（Set.has 不持有跨调用状态，不存在
 * 正则 `lastIndex` 那类泄漏），但属于「顺手改动」，需单独评估，不夹带在抽取里做。
 */
import type { ToolCallRow } from '@shared/types'

/**
 * 统计本轮文件类工具调用的增/删次数与去重后的文件数。
 *
 * 为什么存在：见文件头——turnHeader 行协议 `fileChanges` 字段的唯一来源。
 * 作用：只认 `status === 'success'`（失败/中止的调用不算改动发生）；写入类与删除类分别
 * 累加，路径提取的键优先级是 `file_path` → `target_path` → `source_path`（第一个为
 * string 的胜出），DeleteFile 读 `file_paths` 数组且逐项判 string。
 * 不删理由：删掉则 turnHeader 的 fileChanges 无处可得；而它的三个分支（状态过滤 / 工具名
 * 清单 / 路径键优先级）都是「错了也不报错」的类型，正需要契约测试钉住。
 */
export function countFileToolChanges(toolRows: Map<string, ToolCallRow>): {
  additions: number
  deletions: number
  files: number
} {
  const WRITE_TOOLS = new Set(['Write', 'Edit', 'MoveFile', 'CopyFile', 'Mkdir'])
  const DELETE_TOOLS = new Set(['DeleteFile'])
  let additions = 0
  let deletions = 0
  const files = new Set<string>()
  for (const row of toolRows.values()) {
    if (row.status !== 'success') continue
    if (WRITE_TOOLS.has(row.toolName)) {
      additions++
      // 从 input 里尽量提取目标路径（Write/Edit 的 file_path；MoveFile/CopyFile 的 target_path）
      const input = (row.input ?? {}) as Record<string, unknown>
      const p =
        typeof input.file_path === 'string'
          ? input.file_path
          : typeof input.target_path === 'string'
            ? input.target_path
            : typeof input.source_path === 'string'
              ? input.source_path
              : undefined
      if (p) files.add(p)
    } else if (DELETE_TOOLS.has(row.toolName)) {
      deletions++
      const input = (row.input ?? {}) as Record<string, unknown>
      const ps = input.file_paths
      if (Array.isArray(ps)) ps.forEach((p) => typeof p === 'string' && files.add(p))
    }
  }
  return { additions, deletions, files: files.size }
}
