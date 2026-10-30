/**
 * @category ROOM
 * @summary AI 拟人化像素规格（声明式，唯一真源）：调色板 + 行字符串网格 + 相位帧 + **行为绑定**
 *
 * 为什么存在：用户 2026-10-18 裁决「像素指的是图像，不是字体，就好比 AI 拟人化可视化」
 * 「AI 可操作性 = AI 决定像素点怎么摆放」。ROOM 因此要有**像素房间 + AI 形象**，且这份形象
 * 由 AI 自己画。本文件是那份画作的**数据格式与校验**（纯函数，主进程与渲染进程共用）。
 *
 * 2026-10-19 扩了两处（用户：「角色要二次元风格…AI 可以自己绘制，**保存挂在某个动作上**，
 * 到时候 AI 做什么那个行为就会展示出来」）：
 * - **动画帧**：帧名 `<名字>.<序号>`（`idle.0` / `idle.1`…），渲染侧按 `tick` 循环（`pickFrame`）；
 * - **行为绑定** `behaviors`：把帧挂到**房间自己的动作**（相位 / 本轮阶段）上，
 *   由 `resolveAvatarFrames` 决定本次画哪一帧（优先级：**出错 > 阶段 > 相位**）。
 *   `behaviors` 可选——老规格（只有帧名约定）零改动继续工作。
 *
 * 形态选择（重要，勿改成位图/base64/任意代码）：
 * - **行字符串 + 调色板**：LLM 最擅长生成「ASCII art + 调色板」，且逐字符可读（改一个像素 = 改一个字符）；
 * - **可机械校验**：尺寸 / 颜色数 / 字符集 / 触发源 / 帧存在性全部可判定，越界即拒（`validateAvatarSpec`）；
 * - **可移植**：无外部资产、无 base64、无 URL（利好分发）；
 * - **渲染安全**：渲染端只按格子画 1×1 方块，不 eval、不加载资源。
 *
 * 字符约定：`'.'` = 透明；`'0'`-`'9'` / `'a'`-`'f'` = 调色板下标（0~15）。
 *
 * 不删理由：删掉即「AI 画自己」没有数据格式，房间画面只能显示写死的图。
 */

/** 一个像素精灵：w×h 像素，多帧（帧名 → 行字符串数组）。 */
export interface PixelSprite {
  /** 宽（像素） */
  w: number
  /** 高（像素） */
  h: number
  /** 调色板：`#rrggbb`，1~16 色 */
  palette: string[]
  /** 帧：帧名 → h 行 × w 字符 */
  frames: Record<string, string[]>
}

/**
 * 行为触发源：**房间自己的动作**（相位 + 本轮阶段），不是任意字符串。
 *
 * 为什么是闭集而不是自由标签：触发源是**渲染侧能观测到的事实**——闭集保证「AI 绑的行为一定
 * 播得出来」。允许自由标签会让 AI 绑一个系统永远不会触发的名字，表现为「画了但从不出现」，
 * 而这种失效**不报错**。
 *
 * 与既有「外部 LIVE2D 情绪/动画」协议的关系：那条协议控制的是**外部 LIVE2D 模型**，
 * 词汇是固定的 6 情绪 + 5 动画。这里是**像素画**，帧由 AI 自己画，触发源是房间的动作——
 * **同一种思路（声明式指令 → 表现层播放），不共用词汇**（渲染器不同，硬合并只会两边都别扭）。
 */
export const BEHAVIOR_TRIGGERS = [
  // 五态（相位 + 出错）
  'stopped',
  'standby',
  'idle',
  'running',
  'error',
  // 本轮阶段（`room/loop.ts` 的 LoopPhase）
  'collect',
  'triage',
  'recall',
  'plan',
  'execute'
] as const

export type RoomBehaviorTrigger = (typeof BEHAVIOR_TRIGGERS)[number]

/**
 * 一条**行为**：把若干帧绑到一个触发源上。
 *
 * 用户 2026-10-19：「AI 可以自己绘制，**保存挂在某个动作上**，到时候 AI 做什么那个行为就会
 * 展示出来」。`trigger` 就是「某个动作」，`frames` 就是它自己画的那几张。
 */
export interface AvatarBehavior {
  /** 触发源（闭集，见 `BEHAVIOR_TRIGGERS`） */
  trigger: RoomBehaviorTrigger
  /** 该行为的帧名序列（必须都存在于 `avatar.frames`；多帧则循环播放） */
  frames: string[]
  /** 该行为的每帧毫秒（可选；缺省 = 用相位节拍）。范围见 `BEHAVIOR_LIMITS` */
  frameMs?: number
}

/** ROOM 的像素可视化规格（AI 可整份重画）。 */
export interface RoomAvatarSpec {
  version: 1
  /** 房间背景（帧名建议 `base`） */
  room: PixelSprite
  /** AI 形象（帧名建议 `idle` / `running` / `standby` / `stopped`；缺帧回落 `idle` 再回落第一帧） */
  avatar: PixelSprite
  /** 形象左上角在房间内的像素坐标（必须完整落在房间内） */
  avatarPos: { x: number; y: number }
  /**
   * 行为绑定（可选）。**缺省 = 按帧名约定取帧**（`<相位>` 或 `<相位>.<序号>`）——
   * 老规格无需改写即可照常工作；给了 `behaviors` 就**优先按触发源匹配**，
   * 匹配不到再回落帧名约定（见 `resolveAvatarFrames`）。
   */
  behaviors?: AvatarBehavior[]
}

/** 尺寸/数量上限（防 DoS，也是 AI 生成时的硬边界）。 */
export const AVATAR_LIMITS = {
  /**
   * 单边最大像素数。
   * 64 → **128**（2026-10-19 用户裁决「**精细度差远了**…你可以用大量像素点，堆成一些画」）：
   * 64×40 画不出纵深与陈设，默认画因此升到 96×64；上限留到 128 是为了让 AI 重画时有余量，
   * 同时仍然有界（128×128 = 16384 字符，是一个 LLM 一轮能吐完的量级）。
   */
  maxDim: 128,
  /** 单精灵最大颜色数（16 色是经典像素画的常用规模；字符集 `0-9a-f` 与之等宽） */
  maxColors: 16,
  /**
   * 单精灵最大帧数。
   * 8 → **12** → **24**：动画帧按 `<姿态>.<序号>` 命名（见 `pickFrame`），
   * 用户 2026-10-19 要「**多给点姿态，预设多一点**」——默认预设库已经是 18 帧，
   * 上限必须留出余量，否则 AI 想加一组姿态就会顶到天花板。
   */
  maxFrames: 24
} as const

/** 行为绑定的边界（防 DoS，也是 AI 生成时的硬边界）。 */
export const BEHAVIOR_LIMITS = {
  /** 最多绑定多少条行为（触发源闭集只有 10 个，重复会被拒，故 10 已是上限） */
  maxBehaviors: 10,
  /** 行为自定节拍的上下限（毫秒/帧）：太快是闪烁，太慢是卡住 */
  minFrameMs: 80,
  maxFrameMs: 5000
} as const

const COLOR_RE = /^#[0-9a-fA-F]{6}$/
const CHAR_RE = /^[.0-9a-f]$/

type SpriteResult = { ok: true; sprite: PixelSprite } | { ok: false; error: string }

function validateSprite(raw: unknown, label: string): SpriteResult {
  const r = (raw ?? {}) as { w?: unknown; h?: unknown; palette?: unknown; frames?: unknown }
  const w = Number(r.w)
  const h = Number(r.h)
  if (!Number.isInteger(w) || w < 1 || w > AVATAR_LIMITS.maxDim) {
    return { ok: false, error: `${label}：宽必须是 1~${AVATAR_LIMITS.maxDim} 的整数` }
  }
  if (!Number.isInteger(h) || h < 1 || h > AVATAR_LIMITS.maxDim) {
    return { ok: false, error: `${label}：高必须是 1~${AVATAR_LIMITS.maxDim} 的整数` }
  }
  if (!Array.isArray(r.palette) || r.palette.length < 1 || r.palette.length > AVATAR_LIMITS.maxColors) {
    return { ok: false, error: `${label}：调色板需 1~${AVATAR_LIMITS.maxColors} 色` }
  }
  const palette: string[] = []
  for (const c of r.palette) {
    if (typeof c !== 'string' || !COLOR_RE.test(c)) return { ok: false, error: `${label}：颜色必须是 #rrggbb` }
    palette.push(c.toLowerCase())
  }
  if (!r.frames || typeof r.frames !== 'object' || Array.isArray(r.frames)) {
    return { ok: false, error: `${label}：缺少帧` }
  }
  const frameEntries = Object.entries(r.frames as Record<string, unknown>)
  if (frameEntries.length < 1 || frameEntries.length > AVATAR_LIMITS.maxFrames) {
    return { ok: false, error: `${label}：帧数需 1~${AVATAR_LIMITS.maxFrames}` }
  }
  const frames: Record<string, string[]> = {}
  for (const [name, rowsRaw] of frameEntries) {
    if (!Array.isArray(rowsRaw) || rowsRaw.length !== h) {
      return { ok: false, error: `${label}：帧「${name}」必须是 ${h} 行` }
    }
    const rows: string[] = []
    for (const row of rowsRaw) {
      if (typeof row !== 'string' || row.length !== w) {
        return { ok: false, error: `${label}：帧「${name}」每行必须是 ${w} 字符` }
      }
      for (const ch of row) {
        if (!CHAR_RE.test(ch)) {
          return { ok: false, error: `${label}：帧「${name}」含非法字符「${ch}」（只允许 . 与 0-9a-f）` }
        }
      }
      rows.push(row)
    }
    frames[name] = rows
  }
  return { ok: true, sprite: { w, h, palette, frames } }
}

type BehaviorsResult = { ok: true; behaviors: AvatarBehavior[] | undefined } | { ok: false; error: string }

/**
 * 校验行为绑定（fail-closed）。
 * 三条硬约束：**触发源必须在闭集里**（否则永远不会被触发 = 画了但不出现，且不报错）、
 * **帧必须真的存在**（否则播放时是空白）、**同一触发源不得重复**（重复即歧义，谁赢说不清）。
 */
function validateBehaviors(raw: unknown, sprite: PixelSprite): BehaviorsResult {
  if (raw === undefined) return { ok: true, behaviors: undefined }
  if (!Array.isArray(raw)) return { ok: false, error: 'behaviors 必须是数组' }
  if (raw.length > BEHAVIOR_LIMITS.maxBehaviors) {
    return { ok: false, error: `behaviors 最多 ${BEHAVIOR_LIMITS.maxBehaviors} 条` }
  }
  const known = new Set(BEHAVIOR_TRIGGERS)
  const seen = new Set<string>()
  const out: AvatarBehavior[] = []
  for (const item of raw) {
    const b = (item ?? {}) as { trigger?: unknown; frames?: unknown; frameMs?: unknown }
    const trigger = typeof b.trigger === 'string' ? b.trigger : ''
    if (!known.has(trigger as RoomBehaviorTrigger)) {
      return { ok: false, error: `行为触发源非法「${trigger}」（可选 ${BEHAVIOR_TRIGGERS.join('/')}）` }
    }
    if (seen.has(trigger)) return { ok: false, error: `行为触发源重复「${trigger}」` }
    seen.add(trigger)
    if (!Array.isArray(b.frames) || b.frames.length === 0) {
      return { ok: false, error: `行为「${trigger}」至少要一帧` }
    }
    const frames: string[] = []
    for (const f of b.frames) {
      if (typeof f !== 'string' || !Object.prototype.hasOwnProperty.call(sprite.frames, f)) {
        return { ok: false, error: `行为「${trigger}」引用了不存在的帧「${String(f)}」` }
      }
      frames.push(f)
    }
    if (b.frameMs !== undefined) {
      const ms = Number(b.frameMs)
      if (
        !Number.isInteger(ms) ||
        ms < BEHAVIOR_LIMITS.minFrameMs ||
        ms > BEHAVIOR_LIMITS.maxFrameMs
      ) {
        return {
          ok: false,
          error: `行为「${trigger}」的 frameMs 必须是 ${BEHAVIOR_LIMITS.minFrameMs}~${BEHAVIOR_LIMITS.maxFrameMs} 的整数`
        }
      }
      out.push({ trigger: trigger as RoomBehaviorTrigger, frames, frameMs: ms })
    } else {
      out.push({ trigger: trigger as RoomBehaviorTrigger, frames })
    }
  }
  return { ok: true, behaviors: out }
}

/**
 * 校验并规范化一份像素规格（纯函数）。任何越界/非法形状都返回 `{ ok:false, error }`——
 * 调用方（store / IPC / 执行器）据此 fail-closed，**不得**先落盘再校验。
 */
export function validateAvatarSpec(raw: unknown): { ok: true; spec: RoomAvatarSpec } | { ok: false; error: string } {
  const r = (raw ?? {}) as { version?: unknown; room?: unknown; avatar?: unknown; avatarPos?: unknown; behaviors?: unknown }
  if (r.version !== 1) return { ok: false, error: '版本必须是 1' }
  const room = validateSprite(r.room, '房间')
  if (!room.ok) return room
  const avatar = validateSprite(r.avatar, '形象')
  if (!avatar.ok) return avatar
  const pos = (r.avatarPos ?? {}) as { x?: unknown; y?: unknown }
  const x = Number(pos.x)
  const y = Number(pos.y)
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
    return { ok: false, error: '形象坐标必须是非负整数' }
  }
  if (x + avatar.sprite.w > room.sprite.w || y + avatar.sprite.h > room.sprite.h) {
    return { ok: false, error: '形象必须完整落在房间内' }
  }
  const behaviors = validateBehaviors(r.behaviors, avatar.sprite)
  if (!behaviors.ok) return behaviors
  return {
    ok: true,
    spec: {
      version: 1,
      room: room.sprite,
      avatar: avatar.sprite,
      avatarPos: { x, y },
      ...(behaviors.behaviors ? { behaviors: behaviors.behaviors } : {})
    }
  }
}

/** 正则转义（帧名可能被 AI 写成带 `.` 的形式，直接拼进正则会变成「任意字符」） */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 某相位的**帧名序列**（动画帧的真源）。
 *
 * 命名约定（2026-10-19 加动画时定）：同一相位给多帧时写成 `<相位>.<序号>`，如
 * `idle.0` / `idle.1`；序号按**数值**升序（不是字典序，`idle.10` 不会排到 `idle.2` 前面）。
 * 只给一帧（或帧名不带序号）时返回 `[该帧名]`——`tick` 因此不影响结果，
 * 行为与「加动画之前」逐字相同（老规格无需改写）。
 *
 * 回落链与加动画前一致：`preferred` → 小写形式 → `idle` → 第一帧。
 * 空精灵（没有任何帧）返回 `[]`（调用方按空处理，不抛）。
 */
export function frameNames(sprite: PixelSprite, preferred: string): string[] {
  const keys = Object.keys(sprite.frames)
  if (keys.length === 0) return []
  for (const name of [preferred, preferred.toLowerCase()]) {
    if (Object.prototype.hasOwnProperty.call(sprite.frames, name)) return [name]
    const re = new RegExp(`^${escapeRe(name)}\\.(\\d+)$`)
    const numbered: Array<{ key: string; n: number }> = []
    for (const k of keys) {
      const m = re.exec(k)
      if (m) numbered.push({ key: k, n: Number(m[1]) })
    }
    if (numbered.length > 0) {
      numbered.sort((a, b) => a.n - b.n)
      return numbered.map((x) => x.key)
    }
  }
  // 该相位一帧都没有 → 回落 idle（递归一次即到底，不会自环）
  if (preferred.toLowerCase() !== 'idle') return frameNames(sprite, 'idle')
  return [keys[0]]
}

/**
 * 取帧：按 `frameNames` 的序列，用 `tick` 在其中**循环**。
 *
 * 为什么是 `tick` 而不是时间：房间画面本来就有 rAF 循环（`Presence`），帧号由它算出来传进来——
 * 动画因此**不引入任何新定时器**（「静止时零开销」的口径不破）。`tick` 非正/非法时取第一帧。
 * 帧名大小写不敏感（AI 可能写 `Idle`）。
 */
export function pickFrame(sprite: PixelSprite, preferred: string, tick = 0): string[] {
  const names = frameNames(sprite, preferred)
  const first = names[0]
  if (first === undefined) return []
  if (!Number.isFinite(tick) || tick <= 0) return sprite.frames[first]
  return sprite.frames[names[Math.floor(tick) % names.length]]
}

// ===== 行为绑定：触发源 → 帧 =====

/** 一次取帧的上下文（渲染侧能观测到的事实） */
export interface AvatarFrameQuery {
  /** 房间相位（`stopped` / `standby` / `idle` / `running`） */
  phase: string
  /** 本轮阶段（`collect` / `triage` / `recall` / `plan` / `execute`）；不在阶段中不传 */
  stage?: string
  /** LLM 未回复（出错） */
  llmFailed?: boolean
  /** 动画帧序号（渲染侧 rAF 循环算出来；不引入新定时器） */
  tick?: number
}

const PHASE_TRIGGERS: readonly string[] = ['stopped', 'standby', 'idle', 'running']
const STAGE_TRIGGERS: readonly string[] = ['collect', 'triage', 'recall', 'plan', 'execute']

/**
 * 本次该用哪个触发源。**优先级：出错 > 本轮阶段 > 相位**。
 *
 * 为什么阶段优先于相位：阶段是**更具体的动作**（「正在执行」比「在跑」说得准），
 * 而相位是兜底。出错优先于一切，与全仓其它地方（月相红月 / 画面五态 / 状态词）同口径。
 */
export function behaviorTriggerFor(q: AvatarFrameQuery): RoomBehaviorTrigger | null {
  if (q.llmFailed) return 'error'
  if (q.stage && STAGE_TRIGGERS.includes(q.stage)) return q.stage as RoomBehaviorTrigger
  if (PHASE_TRIGGERS.includes(q.phase)) return q.phase as RoomBehaviorTrigger
  return null
}

/** 命中的行为（未绑定 behaviors、或该触发源没绑 → `undefined`） */
export function matchBehavior(spec: RoomAvatarSpec, q: AvatarFrameQuery): AvatarBehavior | undefined {
  const trigger = behaviorTriggerFor(q)
  if (!trigger || !spec.behaviors) return undefined
  return spec.behaviors.find((b) => b.trigger === trigger)
}

/**
 * **本次该画哪一帧的「帧名」**（渲染侧的唯一判定，`resolveAvatarFrames` 与图片看板娘共用）。
 *
 * 顺序：① 命中的 `behaviors` 条目 → ② 帧名约定 `<触发源>` / `<触发源>.<序号>`
 * → ③ 阶段触发源没绑行为时回落**相位**帧名 → ④ `idle` → ⑤ 第一帧。
 *
 * 第 ③ 步是有意的：AI 只给 `plan` 绑了行为、没给 `execute` 绑，那它在执行时就该用
 * `running` 的帧（而不是掉回站立）——**部分绑定不该让其它动作失去动画**。
 *
 * 为什么把「帧名」单独暴露出来：图片看板娘（`@shared/room/mascot`）是**按帧名找图**的
 * （`idle.0.png` → 帧 `idle.0`）。如果只暴露行字符串，渲染侧就没法把「该画哪一帧」
 * 映射到「该贴哪张图」，只能自己再推一遍——**那就是第二份判定，必然漂移**。
 */
export function resolveAvatarFrameName(spec: RoomAvatarSpec, q: AvatarFrameQuery): string | null {
  const tick = q.tick ?? 0
  const bound = matchBehavior(spec, q)
  if (bound) {
    if (bound.frames.length === 0) return null
    const i = Number.isFinite(tick) && tick > 0 ? Math.floor(tick) % bound.frames.length : 0
    return bound.frames[i]
  }
  const trigger = behaviorTriggerFor(q)
  const fallback = trigger && PHASE_TRIGGERS.includes(trigger) ? trigger : q.phase
  const names = frameNames(spec.avatar, fallback)
  if (names.length === 0) return null
  const i = Number.isFinite(tick) && tick > 0 ? Math.floor(tick) % names.length : 0
  return names[i]
}

/**
 * **本次该画哪一帧**（纯函数，渲染侧取帧入口）。
 * 实现在 `resolveAvatarFrameName` 之上——**帧名解析只有一份**，本函数只负责把名字换成行。
 */
export function resolveAvatarFrames(spec: RoomAvatarSpec, q: AvatarFrameQuery): string[] {
  const name = resolveAvatarFrameName(spec, q)
  return name ? (spec.avatar.frames[name] ?? []) : []
}

/**
 * 本次的每帧毫秒：命中的行为自定节拍优先，否则用相位的默认节拍。
 *
 * **静止态一律不动**：`stopped` / `error` 直接返回 `null`——不管 behaviors 怎么说。
 * 这是 ADR-31 §4.4「静止时零开销」在行为层的延伸：**它熄灯了 / 出事了就不该有动作**。
 */
export function resolveAvatarFrameMs(
  spec: RoomAvatarSpec | null,
  q: AvatarFrameQuery,
  phaseMs: number | null
): number | null {
  if (q.phase === 'stopped' || q.llmFailed) return null
  if (!spec) return phaseMs
  return matchBehavior(spec, q)?.frameMs ?? phaseMs
}
