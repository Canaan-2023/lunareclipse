/**
 * 任务模式团队成员提示词（buildMemberPrompt）：角色 + 团队上下文 + 任务板 + 协作规则 + 共享记忆。
 * 为什么单独成文件：此前函数体定义在 tools/team-tools.ts（工具集文件里内嵌整段协作规则文案，
 * 与工具实现混放）；抽出后 team-tools.ts 只保留工具逻辑，成员提示词文案集中到 prompts/ 目录。
 * 作用：构造成员子 agent 的 systemPrompt——让成员理解自己的身份、团队目标、任务板、
 * 协作规则（team_inbox/team_message/team_task/team_lock）、记忆使用边界与输出要求。
 * 不删理由：成员没有主对话历史，这句 prompt 是它唯一的上下文来源与行为契约；
 * 编码指引段解决"成员继承了统一工具池却默认不知道 coding_plan/coding_review"的问题。
 */
import { fmtTs, type TeamConfig, type TeamMember, type TeamMemoEntry } from '../services/team-manager'

/** 构造成员 systemPrompt（角色 + 团队上下文 + 任务板 + 协作规则 + 共享记忆） */
export function buildMemberPrompt(cfg: TeamConfig, m: TeamMember, memos?: TeamMemoEntry[]): string {
  const tasks = cfg.tasks
    .map((t) => {
      const deps = t.dependsOn && t.dependsOn.length > 0 ? `（依赖 ${t.dependsOn.join(',')}）` : ''
      const assignee = t.assignee ? ` 认领人:${t.assignee}` : ''
      return `- ${t.id} [${t.status}] ${t.title}${deps}${assignee}${t.description ? ` — ${t.description}` : ''}`
    })
    .join('\n')

  // 共享记忆段：团队历次沉淀的规范/决策/教训，成员开局即可见（业界通行的团队共享记忆模式）
  // 为什么只注入最近 20 条：全量注入会挤占 agent 上下文（一成员一行），按需截断是性价比取舍
  const memoLines = (memos ?? [])
    .slice(-20)
    .map((mm) => `- ${mm.key}: ${mm.content}（by ${mm.author} @ ${fmtTs(mm.ts)}）`)
    .join('\n')

  return [
    `你是任务团队「${cfg.name}」的成员「${m.name}」，你的成员 id 是 ${m.id}。`,
    cfg.goal ? `团队目标：${cfg.goal}` : '',
    `你的职责：${m.role || '按任务板认领并完成任务'}`,
    '',
    '## 任务板（团队共享，用 team_task 查看/认领/完成）',
    tasks || '（暂无任务）',
    '',
    '## 团队共享记忆（团队沉淀的规范/决策/教训，用 team_memory 查看或新增）',
    memoLines || '（暂无沉淀；完成关键任务后可写一条供后续成员复用）',
    '',
    '## 协作规则（团队模式，成员之间可直接通信）',
    '- 你没有主对话历史：任务板 / 收件箱消息 / 团队目标是你唯一的上下文来源，不要脑补主对话里没给你说的信息；缺信息就发 team_message 问 Lead 或其他成员。',
    '- 需要历史经验 / 既有规范 / 过往决策时，用 read_md / nng_graph 读月蚀记忆库（长期沉淀），用 session_search 查历史会话原文；记忆写入由记忆工作流统一承载，你不负责写入记忆——任务过程/结果直接体现在你的输出与任务板产出中，长期价值内容系统会自动沉淀。',
    // 为什么加入编码指引：成员工具池继承月蚀统一工具池（仅排除 app_restart），
    // coding_plan/coding_review 由内置 coding 插件（bundled/coding，agents=['frontend']）提供，
    // 成员实际可用但默认不知道。团队任务常含编程/改码，明确两段式流程可避免"边想边改"和
    // 交付前不自查；注释三要素对齐 coding 插件 SKILL 的硬性规范。
    // 留存理由：不加这条，成员编程时不会触发 coding_plan/coding_review，审查是空话。
    '- 编程/改代码任务：动手前 coding_plan(task=...) 出计划（编号任务树+边界+验证段），交付前 coding_review(scope=...) 自查；写注释必须说清这段代码为什么存在、什么作用、需要留存的理由，经检查判定无需留存的代码直接删除，不保留死代码。',
    '- 用 team_inbox 查看别人发给你的消息（会同时看到历史，含你自己的发件记录）',
    '- 用 team_message 给其他成员发消息：to=对方成员 id（如 m2），或 to=all 广播全员；先看任务板或 team_list 拿成员 id',
    '- 用 team_task 认领任务（action=claim，taskId 必填）→ 干活 → 完成（action=complete，taskId + output 产出摘要）',
    '- 写文件前用 team_lock action=lock 锁目标文件（防两成员同时改同一文件），写完后 team_lock action=unlock 释放',
    '- 被依赖任务未完成时认领会返回 blocked（依赖任务 id 在任务板括号里标注）',
    '- 需要其他成员配合时主动发消息，不要干等',
    '',
    '## 输出要求',
    '- 完成后输出你的工作总结（做了什么/改了哪些文件/产出物）',
    '- 若你负责的任务无法完成，如实说明阻碍',
    ''
  ].join('\n')
}