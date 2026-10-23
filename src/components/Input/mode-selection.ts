/**
 * 输入区「模式选择」的纯判定（从 `InputArea` 抽出，便于单测且不给该文件加行——它在体量台账内）。
 *
 * 为什么需要这两个函数：这一个 pill 里混着**三种不同性质**的状态，直接内联三元表达式
 * 既难读也难测，且改一处容易漏另一处：
 * - `aiMode`（`coding`/`chat`/`task`）——**持久化到配置**，决定提示词、工具面与输出后处理；
 * - `plan`——**后端会话级只读闸**（`planMode:enter/exit`），不写配置；
 * - `auto`——**纯视图状态**（`chatViewMode === 'room'`），不写配置、不自动 ARM。
 *
 * 不删理由：删掉即判定退回内联三元，三种性质的优先级（room > plan > aiMode）散落在 JSX 里不可测。
 */

/** 模式 pill 上可能显示的键（前四个对应 `aiMode`/plan，`auto` 是视图态） */
export type ModeKey = 'coding' | 'chat' | 'task' | 'plan' | 'auto'

/**
 * pill 当前显示哪个模式。优先级：**房间视图 > 计划模式 > aiMode**。
 * 为什么 room 最优先：进了房间，pill 就是在说「你在自主里」，与配置里的 aiMode 无关；
 * 为什么 plan 次优先：计划模式是会话级只读闸，激活期间无论 aiMode 是什么都在只读阶段。
 */
export function resolveCurrentModeKey(o: {
  inRoom: boolean
  planModeActive: boolean
  aiMode?: string
}): ModeKey {
  if (o.inRoom) return 'auto'
  if (o.planModeActive) return 'plan'
  const m = o.aiMode
  return m === 'chat' || m === 'task' || m === 'plan' ? m : 'coding'
}

/**
 * 视图切换按钮的下一态：**普通 ↔ 会话树**。
 * 为什么不再循环到 `room`：入口去重——房间的入口收窄到模式菜单的「自主」，
 * 同一个地方不该有两个语义不同的入口（循环按钮表达的是「视图密度」，房间是「一个地方」）。
 * 从 `room` 点它 → 去会话树（用户显然是想离开房间看别的）。
 */
export function nextViewModeForToggle(current: 'normal' | 'tree' | 'room'): 'normal' | 'tree' {
  return current === 'tree' ? 'normal' : 'tree'
}

/**
 * 是否显示「自主运行中」标记（pill 上的状态点 + 菜单里的「运行中」文案与快捷入口）。
 *
 * 为什么必须有这个标记：循环生命周期归主进程（视图不持有），所以**切走视图不会停循环**。
 * 若不加标记，用户会看到「界面已经回到对话了」却不知道它还在后台干活——这是任务 §一.4 点名
 * 要避免的情况。在房间视图内不显示（房间自己就是状态显示器）。
 */
export function shouldShowRunningIndicator(o: { inRoom: boolean; roomRunning: boolean }): boolean {
  return !o.inRoom && o.roomRunning
}
