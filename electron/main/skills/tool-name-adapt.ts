/**
 * 外部技能库 → 月蚀 工具名映射（市场来源适配）：
 * 从 Skill 市场安装的第三方 skill 常按通用工具名书写（read_file 等），
 * 而月蚀工具池使用自有名字（Read 等），不适配则工具调用会找不到。
 * 本文件集中维护映射并在正文中做替换，保证外部 skill 开箱即用。
 */
export const TOOL_NAME_MAP: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  search_files: 'Grep',
  apply_patch: 'Edit',
  terminal: 'run_command',
  execute_code: 'code_run',
  web_search: 'web_search',
  web_extract: 'web_search',
  glob: 'Glob',
  todo: 'todo_write',
  delegate_task: 'agent'
}

const TOOL_NAME_REPLACE_RULES = Object.entries(TOOL_NAME_MAP).map(([external, lunar]) => {
  const escaped = external.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return {
    backtick: new RegExp(`\`${escaped}\``, 'g'),
    word: external.includes('_') ? new RegExp(`\\b${escaped}\\b`, 'g') : null,
    replacement: lunar
  }
})

export function adaptToolNames(content: string): string {
  let out = content
  for (const rule of TOOL_NAME_REPLACE_RULES) {
    rule.backtick.lastIndex = 0
    out = out.replace(rule.backtick, `\`${rule.replacement}\``)
    if (rule.word) {
      rule.word.lastIndex = 0
      out = out.replace(rule.word, rule.replacement)
    }
  }
  return out
}