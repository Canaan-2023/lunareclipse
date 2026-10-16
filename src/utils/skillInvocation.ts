/**
 * 为什么存在：技能调用指令的「技能名列表 → 消息前缀」拼接与「消息 → 技能名列表」解析
 * 被 InputArea（生成）与 MessageBubble（渲染 chip）两端分别使用，抽成纯函数保证两端协议一致，
 * 并可被单测直接覆盖。
 * 作用：
 *  - buildSkillInvocationPrefix：把真实技能名列表合并成一条连续前缀
 *    `请使用技能「a」「b」完成下面的任务：\n\n`（多技能与 MessageBubble 解析正则兼容）；
 *  - parseSkillInvocation：从消息文本中解析技能名列表与正文（兼容历史单技能格式）。
 */

/** 空技能名视为无效输入，返回空前缀（调用方据此判断不注入前缀） */
export function buildSkillInvocationPrefix(names: string[]): string {
  const uniq = [...new Set(names)]
  if (uniq.length === 0) return ''
  return `请使用技能${uniq.map((n) => `「${n}」`).join('')}完成下面的任务：\n\n`
}

/**
 * 识别消息中的技能调用前缀（InputArea 发送时注入的连续格式）：
 * "请使用技能「a」「b」完成下面的任务：\n\n{正文}"
 * 命中时返回全部技能名与剩余正文；未命中返回 null。
 * 历史单技能格式（"请使用技能「a」完成下面的任务："）同样命中。
 */
export function parseSkillInvocation(content: string): { skillLabels: string[]; body: string } | null {
  const m = content.match(/^请使用技能((?:「.+?」)+)完成下面的任务：\s*\n+(.*)$/s)
  if (!m) return null
  const skillLabels = [...m[1].matchAll(/「(.+?)」/g)].map((x) => x[1])
  return { skillLabels, body: m[2] }
}