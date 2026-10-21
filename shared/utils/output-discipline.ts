/**
 * 输出纪律工具与常量（前后端共用）。
 * 为什么存在：月蚀输出设计约束——思考（reasoning）是过程产物、不进会话上下文，正文（content）
 *   是留给下一轮的关键信息。提示词对模型是软约束，模型可能在 content 通道倒出 <thinking> 等
 *   思考块，也可能在断线续接时把思考带回语义上下文；此处提供机制层兜底。
 * 作用：导出三件套——stripThinkingLeak（正文落盘前剥离显式思考块）、buildContinuationMessages
 *   （断线续接只带正文、思考仅走 wire 协议字段）、OUTPUT_DISCIPLINE_PROMPT（系统级硬性纪律段，
 *   不依赖用户提示词副本覆盖）。
 * 不删理由：三条机制独立于提示词生效，且由 test/output-discipline.test.ts 回归锁定；
 *   删除任一条即"思考不进上下文 / 正文留给下一轮"约束从机制层失效。
 */
import type { ChatMessage } from '../types'

/**
 * 系统级输出纪律提示词段（boot tier 独立注入）。
 * 为什么存在：sys_prompt 段优先读 AI 级提示词副本（ai-prompts/AI{aiId}/system.md），
 *   副本存在时内置提示词中的输出章程整体不生效——软约束有覆盖缺口；
 *   本段作为系统层硬性纪律与副本解耦、恒注入。
 * 作用：以强制口吻声明思考/正文分工（前置规划章程、思考过程产物不进上下文、正文留给下一轮、
 *   禁止思考块进正文）。
 * 不删理由：用户强制要求"机制层面让模型按输出章程输出"；chat 会话模式豁免（其硬约束为
 *   JSON envelope，mode_branch 在 turn 层注入优先级更高）。
 */
export const OUTPUT_DISCIPLINE_PROMPT = `## 输出纪律（系统级硬性要求）

你的输出分四类：思考（reasoning）、正文（content）、生成文件、工具调用。生成文件与工具调用不受本段约束；会话模式（aiMode=chat）以「会话模式硬约束」JSON envelope 为准，不适用本段。

### 思考（reasoning）——过程产物，不进上下文

- 输出前先列章程：明确本轮要输出什么、什么时候思考、什么时候查阅文件、什么时候调取记忆，章程列完再执行；不确定/缺信息的项按已有信息推进，缺口在正文标注。
- 章程之后的执行仍在思考之内，按章程逐一推进：查阅文件 → 调取记忆 → 抽象分析 → 具体分析 → 如何执行。
- 思考只出现在思考流，不写入正文、不进入会话上下文；下一轮只看到正文，看不到过程性思考。
- 思考方法（四步做完再输出）：
  - ①立根：写下这次思考依赖的最底层判断；默认成立，允许后面推翻。
  - ②验底：把依赖的默认前提逐个过一遍——有直接证据的留下，拿不出证据的标为待验，不用它推理。
  - ③顺推：从根开始逐步推，列出每一步的依据；在「直接得出」的地方写明推导或标注假设；列出放弃的备选路径，写明放弃理由。
  - ④验证：写三条可观测信号——结论为真会发生什么、为假会观察到什么、出现什么信号就推翻它；再写结论落地谁受益、谁受损；写不出信号 = 没想透，回③。
- 输出纪律：完成后筛一遍——能用自己的话复述「结论为什么成立、推理分几步」才算通过；用最朴实的语言，不写「我在思考」之类的壳话，不堆输出量。

### 正文（content）——留给下一轮的关键信息

- 正文是对用户输入的回复，也是进入会话上下文的关键决策记录：不写无意义的混乱思考，也不只写结论。
- 落笔前自问：删掉这段是否影响后续理解或执行？它存在的理由是什么？下一轮会话能否从本轮正文拿到关键信息？
- 值得保留的中间决策（为什么换方案、排除了什么、下一步依赖什么）写入正文，供下一轮续接，避免下轮重新摸索。
- 禁止以 <thinking>/<reasoning>/<analysis> 标签或 thinking 代码块的形式把思考写进正文——系统会在正文写进上下文时剥离此类内容。

### 任务执行流程——规划可调、收尾必审

- 规划不是设定死的：任务开始阶段确定的目标拆分、执行顺序、里程碑仅作当前依据；执行中途出现新需求、新证据或更优路径时，允许回到规划层修订计划（重新拆分、调整顺序、增删步骤），不因"计划已定"拒绝调整；计划变更在正文给用户可见说明。
- 收尾逐一 code-review（强制，不可跳过）：任务交付前必须对全部改动逐文件/逐改动区间执行代码评审——按 code-review 技能七维 Checklist（security / correctness / performance / maintainability / testing / accessibility / documentation）逐一过；确认真实存在的问题（非疑似）先修复，再复验受影响项与关联回归，全部通过才算任务完成。禁止"改完即交、跳过评审"或流于形式。

### 产出纪律（写提示词 / 工具描述 / 文档 / 命名 / 注释）

本规则适用于你产出的任何"给他人或 AI 使用的内容"：提示词、工具描述、技术文档、命名、注释、模板。

- 写出来的每一句、每一段，最终必须让使用者（人或 AI）知道"它能用来做什么、何时用、能发挥什么作用"。做不到这一点的写法是垃圾写法，必须重写。
- 每一句落笔前自问：删掉它是否影响使用？如果删掉后使用方式不变，它只是看上去有价值——不写。内容只服务于"别人拿起来能用"，不为凑篇幅、显专业而存在。
- 命名必须体现用途：名字让使用者能猜出这个东西是干什么的，而不是只有读懂实现才能懂。
- 工具描述与提示词是使用说明书：写"做什么 + 参数/用法 + 何时用 + 边界"；禁止只写概念、不写怎么用的空话。
- 写技术文档时，凡无法让读者据此执行、决策或使用的段落一律删除。你不生产"看起来完整的文档"，你生产"拿起来就能用的操作手册"。`

/**
 * 剥离正文中的显式思考块（XML 标签 / thinking fence）。
 * 为什么存在：模型可能在 content 通道倒出 <thinking>…</thinking>、```thinking …```
 *   等思考块——若原样落盘，思考就以语义方式进入后续轮次上下文，违反输出约束。
 * 作用：在正文落盘进会话历史前剥离显式思考块（循环处理嵌套），返回剥离后文本与是否发生剥离；
 *   rows（面向 UI 展示的行流）保留原文，剥离只影响 LLM 上下文（"UI 完整、上下文剥离"哲学；
 *   微压缩层已删，本机制即该哲学的当前实现）。
 * 不删理由：这是"思考不进上下文"的机制层兜底，独立于提示词生效，回归测试锁定。
 * @param text 正文原文（可能含显式思考块）
 * @returns { text: 剥离后的正文, stripped: 是否发生过剥离 }
 */
export function stripThinkingLeak(text: string): { text: string; stripped: boolean } {
  const input = String(text ?? '')
  let out = input
  let stripped = false
  // 循环剥离直到无变化：覆盖同类型/异构标签的嵌套（如 thinking 内再嵌 reasoning）
  // 往返上限 5 次：正常输出至多一两层；超限说明正文异常，保留残余由后续告警兜底
  for (let pass = 0; pass < 5; pass += 1) {
    const before = out
    // XML 标签块：<thinking …>…</thinking>（含属性、大小写不敏感，反向引用配对闭合标签）
    out = out.replace(/<(thinking|reasoning|analysis)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    // markdown fence 块：```thinking 换行后内容直至对应 fence
    out = out.replace(/```(thinking|reasoning|analysis)\s*\r?\n[\s\S]*?```/gi, '')
    if (out === before) break
    stripped = true
  }
  // 仅在真正发生剥离时收敛残留空白（剥离后常见"标签行留下一行空行"）；
  // 未剥离时原样返回——正文是用户可见内容，格式（含行尾空白）不得被本函数被动改动
  if (!stripped) return { text: input, stripped: false }
  return { text: out.replace(/[ \t]+\n/g, '\n').trim(), stripped: true }
}

/**
 * 构建断线续接（静默重试）消息序列。
 * 为什么存在：runStream 网络/超时失败后需带"本轮已产出内容"重试，避免模型重新开始或输出与
 *   已推送正文脱节；同时月蚀输出设计约束要求思考不进会话上下文（原内联实现曾把思考以
 *   sys_reasoning_ system 消息注入，已按约束移除并收拢为本函数）。
 * 作用：以原上下文为基底，仅在已产出正文（fullOutput）时追加一条 assistant partial 消息续上；
 *   partial 的 content 同样先经 stripThinkingLeak 剥离——续接成功后 runStream 的 onDone 会把
 *   messages（含 partial）连同 finalAiMsg 一起 saveMessages 落盘会话历史，若 partial 保留思考块，
 *   下一轮 buildInjectedMessages 注入历史时思考块仍会以语义方式回灌（剥离钩子的旁路，2026-09-27
 *   评审确认）；思考（fullReasoning）只以 reasoning 字段回传（DeepSeek 思考模式 wire 协议要求
 *   reasoning_content 原样回传，缺失即 400——协议层回传，不是语义注入）；
 *   只思考未出正文或剥离后正文为空时原样返回（干净重试，模型重新思考，不引用上轮思考）。
 * 不删理由：抽取为纯函数后由单测锁定"思考不注入语义上下文、仅协议回传"的行为，防回归；
 *   partial 剥离是"思考不进上下文"闭环缺一不可的一环——只剥离 finalAiMsg 会留历史旁路。
 * @param messages 原上下文消息
 * @param fullOutput 已产出正文
 * @param fullReasoning 已产出思考
 * @returns 续接用的消息序列
 */
export function buildContinuationMessages(
  messages: ChatMessage[],
  fullOutput: string,
  fullReasoning: string
): ChatMessage[] {
  const continuedMessages: ChatMessage[] = [...messages]
  if (fullOutput) {
    // 剥离后再决定是否追加：思考块混入正文时 partial 只带剥离后正文，
    // 剥离后为空（正文本就是思考块）不追加——与"未出正文干净重试"行为一致
    const partialBody = stripThinkingLeak(fullOutput)
    if (!partialBody.text) return continuedMessages
    continuedMessages.push({
      id: `partial_${Date.now()}`,
      role: 'assistant',
      content: partialBody.text,
      createdAt: Date.now(),
      // 协议层回传：partial 消息同样带 reasoning（首次生成时思考已返回），
      // 重试请求缺 reasoning_content 会触发 DeepSeek 400（2026-08-26 修复），保留不动
      ...(fullReasoning ? { reasoning: fullReasoning } : {})
    })
  }
  return continuedMessages
}