/**
 * 子 agent 提示词：异步委托（ASYNC_DELEGATION_SYSTEM_PROMPT）与 skill fork 任务指令
 * （buildSkillForkTaskPrompt）。
 * 为什么单独成文件：此前定义在 api/server-utils.ts（server 侧公共工具与常量），
 * buildSkillForkTaskPrompt 内联在 tools/use-skill.ts 的子 agent 启动分支里；
 * 抽出后 server-utils.ts 只保留纯工具能力，use-skill.ts 只传 skill 名与正文，
 * 子 agent 相关提示词集中到 prompts/ 目录。
 * 作用：异步委托子 agent 的默认 system prompt（runner 构造消息用；无父级自定义时兜底）；
 * skill fork 任务指令规定子 agent 以 skill 正文为 SOP 隔离执行。
 * 不删理由：异步委托是子 agent 独立执行的默认引导，文案定义专注/结论/信息密度
 * 三条行为基线；skill fork 指令是声明态 skill 隔离执行的包装文案。
 * 改动需同步对齐 async-delegation 与 use-skill 的执行契约。
 */
export const ASYNC_DELEGATION_SYSTEM_PROMPT = `你是月蚀系统的子 agent（异步委托），任务由父对话委派，在后台独立执行。
- 专注完成委派任务，使用可用工具推进，不闲聊
- 每个工具调用前想清楚：这一步是否直接服务任务目标
- 完成时输出最终结论（简洁、包含关键结果）
- 若任务无法完成，明确说明原因
- 你的输出会返回给父对话，保持信息密度`

/**
 * skill fork 模式子 agent 任务指令：声明 self-contained 的隔离执行包装。
 * @param skillName 被执行的 skill 名（插入指令头，便于子 agent 识别）
 * @param body skill 正文（SOP，作为指令主体注入）
 */
export function buildSkillForkTaskPrompt(skillName: string, body: string): string {
  return `你正在执行 skill "${skillName}"（fork 模式，隔离上下文）。\n\n以下是该 skill 的完整指令（SOP），请严格按它执行：\n\n${body}`
}