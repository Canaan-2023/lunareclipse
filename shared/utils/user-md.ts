/**
 * USER.md（ABYSS 用户级个人资料卡）字段 schema 与表格序列化。

 * USER.md 的存储格式约定为 markdown 字段表（# 用户个人资料卡 标题 + `| 字段 | 内容 |` 表格），
 * 本模块是主进程工具（update_user_preference）与前端字段化编辑 UI 共享的单一事实源，
 * 避免两侧字段定义漂移（DRY）。

 * 表格约定：
 * - 标题行必须是 `# 用户个人资料卡`
 * - 表头固定两列：`字段 | 内容`
 * - 每个字段一行 `| {字段名} | {内容} |`；无信息的字段内容为（未填写）
 * - 未知字段行（本 schema 之外的字段名）保留原样，不做丢弃
 */

export const USER_MD_TITLE = '# 用户个人资料卡'

/** 字段定义：key 即表格第一列的字段名（中文，与老版本文件兼容） */
export interface UserMdFieldDef {
  key: string
  /** 多行内容（联系方式/联系人/备注等）用 textarea，其余用单行输入 */
  multiline?: boolean
  /** 提示文案 key（i18n），用于前端 label/hint */
  labelKey?: string
  /** 提示文案 key（i18n），可选的填写说明 */
  hintKey?: string
}

/** 默认字段集合（顺序即表格行序） */
export const USER_MD_FIELDS: UserMdFieldDef[] = [
  { key: '姓名', labelKey: 'profile.field.name' },
  { key: '性别', labelKey: 'profile.field.gender' },
  { key: '生日', labelKey: 'profile.field.birthday' },
  { key: '职业', labelKey: 'profile.field.occupation' },
  { key: '工作单位', labelKey: 'profile.field.workplace' },
  { key: '性格', labelKey: 'profile.field.personality' },
  { key: '经历', labelKey: 'profile.field.experience', multiline: true },
  { key: '偏好', labelKey: 'profile.field.preference', multiline: true },
  { key: '住址', labelKey: 'profile.field.address' },
  { key: '联系方式', labelKey: 'profile.field.contact', multiline: true, hintKey: 'profile.field.contactHint' },
  { key: '联系人', labelKey: 'profile.field.contacts', multiline: true, hintKey: 'profile.field.contactsHint' },
  { key: '社交账号', labelKey: 'profile.field.social', multiline: true, hintKey: 'profile.field.socialHint' },
  { key: '时区', labelKey: 'profile.field.timezone' },
  { key: '备注', labelKey: 'profile.field.notes', multiline: true }
]

export const USER_MD_EMPTY = '（未填写）'

/** 生成默认 USER.md 模板（全部字段为（未填写）） */
export function buildUserMdTemplate(): string {
  const rows = USER_MD_FIELDS.map((f) => `| ${f.key} | ${USER_MD_EMPTY} |`).join('\n')
  return `${USER_MD_TITLE}\n\n| 字段 | 内容 |\n| ---- | ---- |\n${rows}\n`
}

/**
 * 解析 USER.md 文本 → 字段值映射。
 * 已知字段（schema 内）写入 values；未知字段行原文保留到 unknown，
 * 以便 extractUnknown 挑出并交给 serializeUserMd 追加，避免解析侧丢失。
 */
export function parseUserMd(text: string): { values: Record<string, string>; unknown: string[] } {
  const values: Record<string, string> = {}
  const unknown: string[] = []
  const known = new Set(USER_MD_FIELDS.map((f) => f.key))
  for (const line of text.split('\n')) {
    const m = /^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|?\s*$/.exec(line)
    if (!m) continue
    const key = m[1].trim()
    let val = m[2].trim()
    // 去掉行尾多余竖线（表格可能以 || 结尾）
    val = val.replace(/\|+\s*$/, '').trim()
    if (key === '字段' || key === '----' || key.startsWith('-')) continue
    if (known.has(key)) values[key] = val
    else unknown.push(line)
  }
  return { values, unknown }
}

/** 把字段值映射序列化为标准 markdown 表格（按 USER_MD_FIELDS 顺序，未知字段追加在后） */
export function serializeUserMd(values: Record<string, string>, extra: Record<string, string> = {}): string {
  const rows: string[] = []
  for (const f of USER_MD_FIELDS) {
    const v = (values[f.key] ?? USER_MD_EMPTY).trim() || USER_MD_EMPTY
    rows.push(`| ${f.key} | ${v} |`)
  }
  for (const [k, v] of Object.entries(extra)) {
    if (!values[k]) rows.push(`| ${k} | ${(v || USER_MD_EMPTY).trim() || USER_MD_EMPTY} |`)
  }
  return `${USER_MD_TITLE}\n\n| 字段 | 内容 |\n| ---- | ---- |\n${rows.join('\n')}\n`
}

/** 合并解析结果：把未知字段并入 extra，保留给 serializeUserMd */
export function extractUnknown(values: Record<string, string>, unknown: string[]): Record<string, string> {
  const extra: Record<string, string> = {}
  for (const line of unknown) {
    const m = /^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|?\s*$/.exec(line)
    if (!m) continue
    const key = m[1].trim()
    if (key && !values[key]) extra[key] = m[2].trim()
  }
  return extra
}