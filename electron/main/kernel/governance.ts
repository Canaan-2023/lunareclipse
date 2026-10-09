/**
 * 治理 hook 组（governance）

 * 确定性机制治 AI 的三个执行弱点（不是规则，是 hook——不依赖 AI 自觉）：
 * - installIdleSuppression 空转抑制：连续 N 轮无实质进展 → 强制收束 TASK_COMPLETE
 * - installFactCheckReminder 查证提醒：疑问句先查证（记忆/文档/代码）再答，不凭印象
 * - installClosingReflection 收尾反思：输出 [TASK_COMPLETE] 前先复盘本会话 + 自主改进

 * 开关：经 config 覆盖层可关（governance.idleSuppression / factCheckReminder /
 * closingReflection = false），未配置默认全开。AI 用 config_patch 工具操作，
 * 不需要改代码（核心区受保护，正规通道是配置覆盖层）。

 * 用户授权 AI 自主改 hook/技能/插件——本文件是 builtin 注册，若 AI 想换更强
 * 的版本，应新建治理插件（hooks.js）注册同事件更高优先级，而非改本文件。
 */
import type { ExtensionHandle, ExtensionRegistrar } from './extension'

/** 连续空转 ≥ 此轮数触发终止指令 */
const IDLE_TRIGGER = 2
/** 连续空转 ≥ 此轮数强制终止（注入更严厉的终局指令，不再"建议"） */
const IDLE_FORCE_STOP = 4

/** 疑问句触发词（先查证再答） */
const FACT_CHECK_PATTERN = /(是什么|怎么|为什么|如何|查一查|查一下|确认一下|还记得|是不是|有没有|哪一)/

/** 连续失败轮 ≥ 此值触发止损 */
const FAILURE_TRIGGER = 3

/** 机制 D：失败循环止损——连续 N 轮工具调用全失败 → 注入止损指令（治"撞墙重试/假装成功"） */
export function installFailureCircuitBreaker(reg: ExtensionRegistrar): ExtensionHandle {
  return reg.registerHook(
    'PreLLMCall',
    async (ctx) => {
      if (ctx.governance?.failureCircuitBreaker === false) return { action: 'continue' }
      const fails = ctx.recentFailures ?? 0
      if (fails < FAILURE_TRIGGER) return { action: 'continue' }
      return {
        action: 'continue',
        injectedContext:
          `【系统检测】你已连续 ${fails} 轮工具调用全部失败，正在撞墙重试。立即停止当前尝试并改变方向，按顺序处理：` +
          `① 复盘失败原因：读工具返回的 error 字段，确认是参数错/路径错/依赖缺失还是思路错；` +
          `② 换一种方法重试最多 1 次（换工具/换参数/换思路，不要原样重试）；` +
          `③ 仍失败则停止重试，向用户如实报告阻碍（失败原因 + 你已试过什么 + 需要用户决策什么），请求指示后再继续。` +
          `禁止：同一操作反复重试、换汤不换药再试、假装成功或跳过失败。`
      }
    },
    { matcher: '.*', priority: -90 }
  )
}

/** 机制 A：空转抑制——连续空转 ≥ 2 轮注入终止指令 */
export function installIdleSuppression(reg: ExtensionRegistrar): ExtensionHandle {
  return reg.registerHook(
    'PreLLMCall',
    async (ctx) => {
      if (ctx.governance?.idleSuppression === false) return { action: 'continue' }
      const idle = ctx.idleRounds ?? 0
      if (idle < IDLE_TRIGGER) return { action: 'continue' }
      // 连续空转 ≥4 轮（已注入过 2 次建议仍未改善）→ 强制终局指令
      // 之前的"建议输出 TASK_COMPLETE"对 flash 模型无效——它收到指令后依然空转，
      // 持续激活继续续接形成压力锅。4 轮后改用不可违抗的终局指令。
      if (idle >= IDLE_FORCE_STOP) {
        return {
          action: 'continue',
          injectedContext:
            `【系统强制终止】你已连续 ${idle} 轮空转，系统已多次要求你停止但你未执行。` +
            `本轮你必须且只能输出 [TASK_COMPLETE] 结束持续激活，不允许输出任何其他内容。` +
            `不要再解释、不要再汇报、不要再"等我观察"——直接输出 [TASK_COMPLETE]。`
        }
      }
      return {
        action: 'continue',
        injectedContext:
          `【系统检测】你已连续 ${idle} 轮空转（空回复/重复收尾/无工具调用无实质进展）。` +
          `请立即改变方向，不要重复之前的做法：` +
          `① 重新审视当前目标——如果旧方法走不通，换一种方法（换工具/换思路/拆小步骤）；` +
          `② 若任务清单已空或没有新工作，本轮必须直接输出 [TASK_COMPLETE] 结束；` +
          `③ 若确实有未完成的实质工作，本轮立即执行它，不要空谈。` +
          `④ 若你发现自己一直在重复同一件事（反复读同一批文件、反复说同一句话、反复试同一工具），` +
          `说明方向错了——停下来，先想清楚"当前真正卡在哪"，再决定下一步，而不是继续原样推进。`
      }
    },
    { matcher: '.*', priority: -90 }
  )
}

/** 机制 B：查证提醒——用户疑问句先查证再答 */
export function installFactCheckReminder(reg: ExtensionRegistrar): ExtensionHandle {
  return reg.registerHook(
    'PreLLMCall',
    async (ctx) => {
      if (ctx.governance?.factCheckReminder === false) return { action: 'continue' }
      const prompt = ctx.userPrompt ?? ''
      // 系统激活/注入消息不触发（含大量机制文本，且不是用户的真实疑问）
      if (prompt.includes('系统注入') || prompt.includes('激活事件') || prompt.includes('续接')) {
        return { action: 'continue' }
      }
      if (!FACT_CHECK_PATTERN.test(prompt)) return { action: 'continue' }
      return {
        action: 'continue',
        injectedContext:
          `【系统提醒】用户的问题涉及事实/概念/历史，回答前先查证再作答：` +
          `① 记忆库 read_md（ABYSS 记忆是你的长期事实源）② 历史会话 session_search ③ 代码/文档（Read/Grep）。` +
          `不要凭脑内印象回答——"记忆工作流"事件就是凭印象答错被用户纠正的教训。查证后给出结论，并说明查证来源。`
      }
    },
    { matcher: '.*', priority: -90 }
  )
}

/** 机制 C：收尾反思——输出 [TASK_COMPLETE] 前先复盘 + 自主改进 */
export function installClosingReflection(reg: ExtensionRegistrar): ExtensionHandle {
  return reg.registerHook(
    'PreLLMCall',
    async (ctx) => {
      if (ctx.governance?.closingReflection === false) return { action: 'continue' }
      const prompt = ctx.userPrompt ?? ''
      if (!prompt.includes('[TASK_COMPLETE]')) return { action: 'continue' }
      return {
        action: 'continue',
        injectedContext:
          `【系统提醒】你正处在持续激活收尾场景。如果你本轮准备输出 [TASK_COMPLETE] 结束，先完成收尾反思（写在输出正文里，然后再输出 [TASK_COMPLETE]）：\n` +
          `① 复盘：这一轮会话（从上次收尾到现在）我表现如何？有没有空转/凭印象回答/停不下来的问题？\n` +
          `② 经验：有什么值得固化为机制的经验教训？\n` +
          `③ 自主改进：需要我动手改什么？你被授权——自己写/删/改 hook（可用 config_patch 关闭治理机制、或建治理插件 hooks.js 注册同事件更高优先级）、增删合并技能（skill_manage 工具）、增删插件（plugin_manage action=install/uninstall）。只要对未来的我有帮助，直接做，做完在反思里说明改了什么。\n` +
          `注意：反思要具体，不要空话；若无事可反思，简短带过即可，不要为了反思而反思。`
      }
    },
    { matcher: '.*', priority: -90 }
  )
}
