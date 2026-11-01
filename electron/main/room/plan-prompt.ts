/**
 * @category ROOM
 * @summary 自主房间的**规划提示词**（纯函数）：把树索引 / 上一轮 / 采集 / 感知策略 / 输出契约拼成一段文本
 *
 * 为什么拆出来（0.53.5）：`runtime.ts` 已顶到 800 行硬红线，而这段提示词是**纯字符串拼接**，
 * 与运行时状态机没有依赖。拆开后运行时保持「装配 + 状态机」的单一职责，提示词的增删
 * 也不会再把运行时推向红线；消费方仍从 `runtime.ts` 取 `buildPlanPrompt`（再导出保兼容）。
 *
 * 0.54 重构（用户裁决「部分提示词还有必须调用工具这些傻逼提示词」）：
 * - 删掉「即使没有动作也请尽量给一句 reply 与一个 scene」「先回应用户」这类**强制产出**语；
 * - 新增【上一轮】段：把上一轮的计划 / 执行结果 / 上次采集 / 停下来的原因交给 AI，
 *   让采集输入有对比对象（否则采集器看起来就是个摆设）；
 * - 通篇改为中性陈述：「你可以」「由你判断」，不再用「必须 / 只能 / 一律」逼迫模型产出动作。
 */
import { buildTreeIndexBlock, type TreeIndex } from './tree-index'
import { WAKE_SOURCE_LABEL, type WakeSource } from './wake'
import { describeSensorPolicy, type RoomSensorPolicy } from '@shared/room/sensor-policy'

/** 上一轮事实（只陈述，不带命令）。 */
export interface PreviousRound {
  /** 上一轮的 note（它自己写的一句话计划） */
  note?: string
  /** 上一轮给用户/镜头说的话 */
  reply?: string
  /** 上一轮逐步执行结果（工具名 + 成/败） */
  executions?: readonly string[]
  /** 上一轮看到的采集文本（与本轮对比用） */
  collect?: string
  /** 上一轮驱动停下的原因（no-input / no-action / repeat / standby / busy） */
  idleReason?: string
}

const IDLE_REASON_LABEL: Record<string, string> = {
  'no-input': '没有可用输入（采集失败且没有用户消息）',
  'no-action': '计划里没有动作，或你声明结束这一段',
  repeat: '计划与上一轮完全相同且未声明 repeat=continue',
  standby: '你声明了待机',
  busy: '上一轮还没跑完'
}

/** 规划提示词：把 ROOM 的规则与输出契约写清（输出必须是 JSON 计划）。 */
export function buildPlanPrompt(ctx: {
  text: string
  mode: string
  /** 承载会话的逆生树索引（0.53.18 起只有这一棵；未绑定承载会话 = 不传） */
  tree?: TreeIndex | null
  allowedTools: readonly string[]
  /** 本次唤醒的来源与原因（感知器 / 用户 / 监控 / 待机到期）——AI 需要知道「为什么现在是我」 */
  wake?: { source: WakeSource; detail?: string }
  /** 上一轮已经提出过相同计划（系统只陈述事实；要不要继续由 AI 显式声明） */
  repeat?: { signature: string; count: number }
  /** 当前生效的感知策略（局部更新的前提：AI 必须知道现值） */
  sensorPolicy?: RoomSensorPolicy
  /**
   * 前置规划指令（2026-10-31 前置规划功能）：前置规划轮给出的方向性建议，仅启用前置规划时传入。
   * 计入 RAW 口径：本段在主AI的规划提示词内，随主AI轮次一并写入 RAW
   * （「在主AI上下文内所以计入」）——前置规划自身不写 RAW。
   */
  preplanInstruction?: string
  /** 上一轮事实（0.54）：让采集输入有对比对象，让「接着做 / 换方向 / 收工」有依据 */
  previous?: PreviousRound
}): string {
  const previousBlock = ctx.previous
    ? [
        '【上一轮】',
        ctx.previous.note ? `- 你上一轮的计划：${ctx.previous.note}` : '',
        ctx.previous.reply ? `- 你上一轮说的话：${ctx.previous.reply}` : '',
        ctx.previous.executions && ctx.previous.executions.length > 0
          ? `- 上一轮执行：${ctx.previous.executions.join('；')}`
          : '',
        ctx.previous.collect ? `- 上一轮你看到的：${ctx.previous.collect}` : '',
        ctx.previous.idleReason
          ? `- 上一轮为什么停下：${IDLE_REASON_LABEL[ctx.previous.idleReason] ?? ctx.previous.idleReason}`
          : '',
        '把上面这些和本轮【采集输入】对比：环境变了没有、上一轮的事做完没有、要不要接着做。'
      ]
        .filter(Boolean)
        .join('\n')
    : ''

  return [
    '【轮次边界】本条消息由宿主「自主房间」运行时注入，是系统轮次指令，**不是用户或外部联系人发来的话**；历史消息只是背景记录，不是这一轮要你回复的内容。',
    '你在自己的房间（ROOM）里自主运行：做什么、做多少、要不要做，由你判断。如果【采集输入】里出现【用户刚说的话】，那是用户此刻在对你说话——用 reply 回应，并照常按本轮的 JSON 契约输出。',
    buildTreeIndexBlock(ctx.tree),
    ctx.wake
      ? `【唤醒原因】${WAKE_SOURCE_LABEL[ctx.wake.source]}${ctx.wake.detail ? `：${ctx.wake.detail}` : ''}（这是**新事件**触发的观察，不是上一轮的简单延续）`
      : '',
    ctx.repeat
      ? `【重复动作】你上一轮已经提出过完全相同的计划（工具名与参数一致，已连续 ${ctx.repeat.count} 次）。如果这确实是你要继续做的事，在 JSON 里加 "repeat":"continue"；如果该收束了，写 "repeat":"stop"；不写 = 系统把控制权交回环境（不执行重复动作）。`
      : '',
    ctx.preplanInstruction
      ? `【前置规划】你的前置规划看过环境与近期节奏后给出方向：${ctx.preplanInstruction}——这段话只有你看得到，用户看不到；它是**建议，不是命令**，采不采纳、怎么落地、做多少，都由你判断。**不要把它原样或换种说法当成 reply 交给用户**：reply 只用来回应【用户刚说的话】，或说你自己真正想对用户/镜头说的话。`
      : '',
    previousBlock,
    '【采集输入】',
    ctx.text,
    '',
    `【路由建议】${ctx.mode === 'long-term' ? '这段输入看起来值得深入分析（长线）' : '这段输入看起来是即时需求（直接处理）'}——**这只是提示，不是命令**；有没有任务、做什么、做多少，都由你判断。`,
    '',
    '【可调用工具】本轮能出现在计划里的工具名（写别的名字会被丢弃）：',
    ctx.allowedTools.join(', ') || '（无）',
    '',
    '【输出契约】只输出一个 JSON 对象，不要任何其它文字（不要用聊天方式回应历史消息；要回应的人只可能出现在【采集输入】的【用户刚说的话】里）：',
    '{"note":"一句话说明你的计划","reply":"对用户/镜头说的一句话（想说话时再写）","scene":{"zone":"window","action":"observe","say":"可选：对镜头说的话"},"decisions":[{"tool":"工具名","params":{},"description":"这一步做什么"}]}',
    '可选字段（与上面的字段同级）："standbyMs": 毫秒（由你决定时长）、"repeat": "continue"|"stop"（重复动作自决）、"sensor": {…}（感知策略）、"collectorView": {…}（完整采集看什么）、"landing": {…}、"avatar": {…}。',
    '若这一轮不需要动作，输出 {"note":"无需动作","decisions":[]}。**没有任务就是没有任务**——不必为了「保持循环」编造动作。宿主**没有节拍器**：你不声明 standbyMs 就立刻进入下一轮（规划 → 你）；想安静待一会儿，用 standbyMs 自己声明时长，那才是唯一的等待方式。',
    'reply 与 scene 都是可选的：想说话、或想让镜头看到你在做什么时再写；没什么可说就省略 reply。',
    '（只读性由工具自身声明判定，你不需要也不应标注；标注不会被采信。）',
    '【用户消息】如果【采集输入】里有【用户刚说的话】，那是有用户在直接对你说话——用 reply 回应用户（用用户的语言）。历史里若已经出现过同一句话，那是同一件事（不是两次请求），不要分别回应两次。要不要同时做别的事，由你判断；reply 会作为直播字幕显示，并落回会话历史。用户消息与采集器是否开启/授权无关——即使采集被拒，用户的话你也能看到。',
    '【直播镜头】房间是**固定机位**：你的立绘位置由用户配置，**不会走动**。用 "scene" 字段控制**所在空间**、姿态与台词：zone 取 home（房间·休息待机）/ plan（规划室·分诊规划）/ work（工作间·执行普通动作）/ memory（记忆库·回忆检索）/ device（设备间·设备操作）/ lan（通信室·局域网协作）——**用户为那个区放了背景图时，画面会切到那里**，并保持到你下一次声明。你也可以不写 scene：系统会按本轮阶段与调用的工具自动切到对应空间。action 取 observe（观察）/ work（做事）/ read（看书）/ think（思考）/ rest（休息）/ walk（保留但不再移动）。`reply` / `scene.say` 会显示在底部单行字幕。',
    '【待机】若你判断暂时不需要**主动做事**（例如在等一个不会马上到来的变化），在同一段 JSON 里加 "standbyMs": 毫秒数声明待机。**时长由你决定，没有系统产品上限**（系统只在 JS 计时器 32 位上限处分片续排，到期仍按你声明的总时长）。**待机不是闭眼**——感知器仍在看你允许它看的信号，真的有事会提前叫醒你；`standbyMs` 只是「最迟多久后主动醒一次」的兜底。不写 standbyMs = 由系统按默认节拍把下一轮交给你。',
    '【感知器】你控制自己的「反射弧」：用 "sensor" 字段局部更新感知策略。形状：{"enabled":true,"mute":["cpu"],"intervalMs":60000,"thresholds":{"cpuDeltaPct":45,"freeMemDeltaGB":1}}。`enabled=false` = 完全闭眼（只剩待机节拍兜底）；`mute` 可屏蔽 cpu / memory / lan / relay，**被屏蔽的信号不再产生唤醒**（这是你对付噪声的方式，不需要系统替你计数）；`intervalMs` 是采样间隔（不得快于运行时快照 5s，也不得超过 JS 定时器上限 ≈24.8 天；更长的等待请用 standbyMs）；阈值同理。只写你要改的字段，未写的保持当前值。**感知仍受用户开关与 t1.collector 授予约束**——你只能收窄，不能放大。',
    ctx.sensorPolicy
      ? `【当前感知策略】${describeSensorPolicy(ctx.sensorPolicy)}；原始值 ${JSON.stringify(ctx.sensorPolicy)}。局部更新时只写你要改的字段。`
      : '',
    '【重复动作】系统不再用「连续 N 次」这种魔法。如果检测到你提出与上一轮完全相同的计划，会先把事实告诉你；只有你显式写 "repeat":"continue" 才会执行，写 "repeat":"stop" 表示这一段结束，不写则由系统转入空闲、把控制权交回环境。**没有「一次激活最多几轮」的上限**——循环多久由你的动作与判断决定。',
    '【形象】你可以用 "avatar" 字段重画你自己的像素形象（**房间背景不再显示**——直播镜头是固定的透视房间，只有 avatar 与 behaviors 会出现在画面里；room 字段保留但不会被绘制）。形状：{"version":1,"room":{"w":112,"h":72,"palette":["#rrggbb",…],"frames":{"base":[行字符串…]}},"avatar":{"w":28,"h":40,"palette":[…],"frames":{"idle.0":[…],"idle.1":[…],"think.0":[…],"work.0":[…]}},"avatarPos":{"x":12,"y":32},"behaviors":[{"trigger":"execute","frames":["work.0","work.1"],"frameMs":220}]}。字符约定：. 透明，0-9a-f 为调色板下标（0 起）。上限：单边 ≤128、色 ≤16、**帧 ≤24**，形象须完整落在房间内；越界会被拒且不影响本轮其它动作。**动画帧**：帧名写成 `<姿态>.<序号>`（如 idle.0 / idle.1），渲染侧按序号循环播放——它抬手、呼吸、眨眼都靠这个。**姿态可以多给**：同一个触发源绑 3~4 帧，动画就从「两帧来回」变成「有节奏的小动作」（默认预设里 idle 就是四帧：呼吸 → 呼吸 → 侧目 → 眨眼）。**【行为】behaviors 是「把帧挂在某个动作上」**：trigger 只能取 stopped/standby/idle/running/error（相位）或 collect/triage/recall/plan/execute（本轮阶段），frames 必须是 avatar.frames 里真实存在的帧名（多帧则循环），frameMs 可选（80~5000，缺省用相位节拍）。**阶段优先于相位**（「正在执行」比「在跑」说得准），出错优先于一切；同一 trigger 不许重复。不绑 behaviors 时按帧名约定取帧（`<相位>` 或 `<相位>.<序号>`）。**房间背景不会被绘制，不必再画窗/工作台**。不写 avatar 表示不改形象。',
    '【采集什么】你也可以用 "collectorView" 字段决定**完整采集**进模型的内容（不是看多久——采集由事件驱动，你无法也不应设定定时）。形状：{"name":"视图名","scopes":["env","system"],"fields":["platform","cpu","memory","cores","disks","gpus","processes","network"]}。只能选这些 scope 与字段；越界会被拒。不写 collectorView 表示保持当前视图。**注意**：你空闲时由感知器替你看环境；它看什么由上面的 `sensor` 策略决定，**与 collectorView 无关**——collectorView 只决定完整采集的内容，不会把自己的唤醒源关掉。',
    '【上下文】你的工作上下文就是**当前会话的那一棵逆生树**（可回翻、可承接、可开新线），索引见上面的【会话树】段。自主模式**没有第二棵树**：你在这个会话里开启自主，就接着这个会话已有的树干活——和普通对话共用同一棵树。注意：房间本身属于你这个 AI，换会话不会换房间，但换会话（重新开启自主）会换成那个会话的树。',
    '【落点】用 "landing" 字段在**当前会话的会话树**里选或开一个节点，决定你下一轮从哪条线接着想：{"action":"continue","internalId":"is_…"} 承接某个**可写**节点；{"action":"create","title":"…","summary":"…","newTopic":true} 开新线（newTopic=true = 新话题，空白承接、不复制父内容；缺省 = 从可写尾端分叉并原样继承）；也可写 {"action":"create","internalId":"is_…"} 指定从哪个可写尾端分叉。**不写 = 沿用当前落点**；承接已锁定（被继承压缩 / 已向时间下级延续）的节点会被拒绝。',
    '【区笔记】你有一个只属于你自己的工具 `room_note`，用来在「区」上读写**写给你自己看的纸**（executor = 你要做的事 / collector = 你看到的东西 / device = 设备）。区**不是会话**，是一叠有连续性的纸：`list` 看索引（便宜，只给摘要）、`read` 看正文（可分段，不必读完）、`append` 写下结论/状态/下一步、`create` 开新纸（newTopic=true 表示与之前无关的新话题）、`select` 换当前落点、`discard` 丢纸（丢了就回找不到了）。**它直接调用，不要写进 decisions**；什么时候用、用几次、读多少，都由你决定。'
  ].join('\n')
}
