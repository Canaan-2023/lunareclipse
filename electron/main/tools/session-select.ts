/**
 * 会话选择工具（session_select）：让 AI 自己路由「当前承接的内部会话」。
 * 为什么存在：内部会话的自动路由（routeSession 后台轻量 LLM）每轮重跑、
 * 前端 AI 无法主动干预；用户明确要求「会话选择是 AI 自己路由的」——本工具把
 * 选择权交还给主 AI：list 查看逆生树三边候选（继承实线/时间延续实线 + 新话题虚线
 * 的摆放结构）与每条候选的摘要，select/create/update-summary/release 决定当前承接
 * 会话与维护摘要，选择结果经 store.activeByOwner 持久化为 active 指针，下一轮
 * resolveStreamSessionContext 直接装载所选会话。
 * 摘要契约：每条的「摘要」是 AI 自维护的会话身份说明（主题/进度/结论）——选择
 * 会话的首要依据就是它；AI 可在 create 时写初始摘要、随时用 update-summary 改写，
 * 后台维护器也会在每轮对话后自动更新。select 成功后，所选会话的摘要与近期消息
 * 随 active 指针在下一轮注入上下文（回注）。
 * 与自动路由的关系：active 指针存在时显式选择优先；从未选择过或 release 后
 * 回到自动路由兜底，二者互补而非互斥。
 */
import type { AnyTool, ToolResult, ToolContext, ToolParameter } from './base-tool'
import { describePlacement } from '../services/session-placement'
import type { InternalSessionStore } from '../services/internal-session-store'

export class SessionSelectTool implements AnyTool {
  name = 'session_select'
  description = `选择/新建/维护「当前承接的内部会话」，并查看逆生树候选清单。

内部会话 = AI 后台自维护的上下文池（每个覆盖一段主题/任务）。自动路由每轮用轻量模型猜测承接会话；本工具把选择权交给你（主 AI）——显式选择后，下一轮起的对话装入所选会话的上下文（摘要+近期消息），对话结果也写入该会话。选择持久化，直到你再次 select 其他会话、create 新会话或 release。

每条候选都带「摘要」：AI 自己维护的会话身份说明（主题/进展/结论），选择会话的首要依据就是它——先读摘要判断续接哪条线，标题只是辅助；摘要过时或缺失时先用 update-summary 补写/改写。

动作：
- list：列出本用户会话下全部内部会话（最新在前）。每条含摘要 + 逆生树「摆放结构」：
  【边语义】继承 = 实线（parentId/gen，压缩上下文、原样承接）；时间延续 = 实线（timeSourceId 时间分叉复制自谁 / timeBranchId 已向时间下级延续=锁定只读 / isTimeFork 是否时间副本）；AI 判定新话题 = 虚线（空白承接、不复制父内容）。
  标记 ◎ = 当前承接指针（active）、✓ = 可写尾端（无 timeBranchId 且无继承子，可继续写入）。
- select internalId：把清单中某个可写尾端会话定为当前承接（此后对话进入该会话，该会话摘要与近期消息在下一轮回注到上下文）。指向锁定会话（已有 timeBranchId）会被拒绝。
- create title（可选 parentId、可选 summary、可选 newTopic）：新建会话并承接（新主题开始）。newTopic=false/缺省 = 延续分叉（实线）：从某个可写尾端分叉，新会话原样继承该尾端的全部内容（消息/摘要/缓存位置逐字复制），你的新输入写入新会话；原尾端保持原样，作为分支基点可随时回翻。newTopic=true = AI 判定话题新开（虚线）：空白承接当前输入、不复制父会话任何内容（树形挂接仍保留，虚线从该尾端引出）。缺省从最近可写尾端分叉，仅当尚无任何会话时才建独立根。summary 可选：给新会话写一句初始摘要（一句话说明这条新线干什么），写好了选择时就能被识别；不写则沿用父会话摘要（newTopic 虚线分支无父摘要沿用，无父则留空，由后台维护器在首轮对话后生成）。
- update-summary internalId summary：改写某个可写尾端会话的摘要（AI 自己维护自己改）。仅可写尾端可改；已锁定/已继承的只读底稿不可改。
- release：释放承接指针（下一轮起恢复自动路由）。

逆生树摆放规则（选择依据）：
- 三条边相互独立：继承 = 实线（压缩上下文：超限冻结父会话、子会话承接）；时间延续 = 实线（同一话题长时间线自动分叉延伸）；AI 判定新话题 = 虚线（新开话题，空白承接、不复制父内容）；
- 可写尾端 = 自身无 timeBranchId（未向时间下级延续）+ 无继承子（未被压缩）的会话；已锁定（timeBranchId）或已被压缩（有子）的会话只能回翻，不能再承接；
- 时间副本（isTimeFork）是新的可写尾端而非旧会话的替身：承接它 = 沿该时间线继续；
- 选择原则：先读摘要（每条候选都有，AI 自维护的选择依据）——摘要与当前话题/任务匹配 → 承接该尾端；摘要不全/过时 → 先 update-summary 补写再选；引用过去时段 → 按 createdAt/updatedAt 匹配时段会话；仅需回看历史 → 用 Read/read_md 读会话文件，不定承接指针；全新主题 → create（可带 summary 描述新线）。

动作时机的明确信号（何时建新会话、何时开分支——比选择原则更早判定）：
1. 当前话题延续某条线的摘要所述主题/任务/语境（追问、继续执行、补充修改）→ 直接承接即可：select 该线；已在承接中（对话正自然流入该会话）则不需要任何动作，让自动路由/既有承接生效；
2. 用户开启了一个与所有候选摘要都不重叠的新任务/新对象（明确开始新工作，或话题切换且新话题不是旧线的延续）→ 建新会话：create（这是"什么时候建新会话"的答案——摘要匹配不到承接线时才建，不要为每个新输入都建）；
3. 新主题虽然与现有线摘要不重叠，但属于某条线的工作延续（同一项目的新阶段/新子问题，仍需要那条线的背景与历史）→ 开分支：create 并带 parentId = 那条可写尾端，让它从该线原样继承（这是"什么时候开始分支"的答案——承接线背景但换新线记录时分支，不分支时新内容会污染原线的主题纯度）；
4. 摘要与当前输入只有宽泛关联、缺少实质承接关系 → 不要 select 硬选，走 create 分支（宁开新线，不把无关历史硬挂进当前承接）；
5. 判断不了该不该动 → 保持不动：自动路由每轮会用轻量模型兜底，不干预总比乱建会话/乱分支好（多建 = 逆生树被无意义分叉稀释，后续选择更难）。`
  parameters: ToolParameter[] = [
    { name: 'action', type: 'string', description: 'list / select / create / update-summary / release（必填）', required: true },
    { name: 'internalId', type: 'string', description: 'select/update-summary 时必填：目标内部会话 id', required: false },
    { name: 'title', type: 'string', description: 'create 时可选：新会话标题（3-8 字概括主题）', required: false },
    { name: 'summary', type: 'string', description: 'create 时可选：新会话初始摘要（一句话说明新线干什么，选择时靠它识别）；update-summary 时必填：要写入的摘要文本', required: false },
    { name: 'parentId', type: 'string', description: 'create 时可选：从该可写尾端分叉出子会话；缺省自动取最近可写尾端分叉，仅无任何会话时建根', required: false },
    { name: 'newTopic', type: 'boolean', description: 'create 时可选：true = AI 判定话题新开（逆生树虚线，空白承接、不复制父内容）；false/缺省 = 延续分叉（实线，原样继承父全部内容）', required: false }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const store = ctx?.getInternalSessionStore?.() ?? null
    if (!store) {
      return { ok: false, error: '内部会话存储不可用（当前环境未注入 getInternalSessionStore）' }
    }
    const ownerSessionId = ctx?.sessionId
    if (!ownerSessionId) {
      return { ok: false, error: '无法确定用户会话（ctx.sessionId 为空，内部会话按用户会话归属）' }
    }

    const action = typeof params.action === 'string' ? params.action : ''
    switch (action) {
      case 'list':
        return this.doList(store, ownerSessionId)
      case 'select': {
        const internalId = typeof params.internalId === 'string' ? params.internalId : ''
        if (!internalId) return { ok: false, error: 'select 需要 internalId' }
        return this.doSelect(store, ownerSessionId, internalId)
      }
      case 'create': {
        const title = typeof params.title === 'string' && params.title.trim() ? params.title.trim() : undefined
        const parentId = typeof params.parentId === 'string' && params.parentId.trim() ? params.parentId.trim() : undefined
        const summary = typeof params.summary === 'string' && params.summary.trim() ? params.summary.trim() : undefined
        // newTopic=true：AI 判定话题新开（虚线，空白承接、不复制父内容）；缺省/false = 延续分叉（实线，原样继承）
        const newTopic = params.newTopic === true
        return this.doCreate(store, ownerSessionId, title, parentId, summary, newTopic)
      }
      case 'update-summary': {
        const internalId = typeof params.internalId === 'string' ? params.internalId : ''
        const summary = typeof params.summary === 'string' && params.summary.trim() ? params.summary.trim() : ''
        if (!internalId) return { ok: false, error: 'update-summary 需要 internalId' }
        if (!summary) return { ok: false, error: 'update-summary 需要 summary（要写入的摘要文本）' }
        return this.doUpdateSummary(store, ownerSessionId, internalId, summary)
      }
      case 'release':
        return this.doRelease(store, ownerSessionId)
      default:
        return { ok: false, error: `未知 action：${action}（应为 list/select/create/update-summary/release）` }
    }
  }

  /** 逆生树候选清单渲染（可写尾端过滤与摆放结构同一 describePlacement 口径） */
  private doList(store: InternalSessionStore, ownerSessionId: string): ToolResult {
    const all = store.list(ownerSessionId)
    const activeId = store.getActive(ownerSessionId)
    if (all.length === 0) {
      return {
        ok: true,
        data: { activeInternalId: activeId, sessions: [], hints: '暂无内部会话——新输入请用 create 建档（可带 summary 写初始摘要），或先让自动路由建档后再次 list' }
      }
    }
    const childIds = new Set<string>()
    for (const c of all) {
      if (c.parentId) childIds.add(c.parentId)
    }
    const sessions = all.map((c) => {
      const placement = describePlacement(c, {
        // 时间线上游回溯：从候选集内查找（候选按 updatedAt 取最近，上游会话一般也在集内；
        // 极端情况不在集内则 lineage 链自然中断，只显示直接 timeSourceId——口径与注入锚点一致）
        get: (id) => all.find((x) => x.id === id) ?? null,
        listSiblings: () => all
      })
      const isActive = c.id === activeId
      const isTail = !childIds.has(c.id) && !c.timeBranchId
      return {
        id: c.id,
        title: c.title,
        active: isActive,
        writableTail: isTail,
        locked: Boolean(c.timeBranchId),
        placement: [placement.genLine, placement.timeLineBlock].filter(Boolean).join('；'),
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        messageCount: c.messageCount,
        totalChars: c.totalChars,
        summary: c.summary
      }
    })
    const tails = sessions.filter((s) => s.writableTail)
    return {
      ok: true,
      data: {
        activeInternalId: activeId,
        writableTails: tails.map((s) => s.id),
        sessions,
        hints:
          '规则：先读每条候选的「摘要」（AI 自维护的选择依据，主题/进展/结论）——摘要与当前话题匹配 → select 承接；摘要缺失/过时 → 先 update-summary 补写再选；全新主题 → create（可带 summary 描述新线）；仅回看历史 → Read 会话文件，不要 select。'
      }
    }
  }

  private doSelect(store: InternalSessionStore, ownerSessionId: string, internalId: string): ToolResult {
    const summary = store.list(ownerSessionId).find((c) => c.id === internalId)
    if (!summary) {
      return { ok: false, error: `内部会话 ${internalId} 不存在（id 可能已过期，请先 list 获取最新清单）` }
    }
    if (summary.timeBranchId) {
      return {
        ok: false,
        error: `会话 ${internalId} 已向时间下级 ${summary.timeBranchId} 延续并被锁定（只读）——承接应进入时间尾端（无 timeBranchId 的会话），不要选择锁定会话，需要时用 create 开启新时间线`
      }
    }
    // 有继承子的父会话已被压缩锁定（虽无 timeBranchId 也不可写）——list 已据此过滤可写尾端，
    // 此处兜底拒绝：承接被压缩的父会话会把冻结历史重新注入，破坏继承语义。
    const childIds = new Set<string>()
    for (const c of store.list(ownerSessionId)) {
      if (c.parentId) childIds.add(c.parentId)
    }
    if (childIds.has(internalId)) {
      return {
        ok: false,
        error: `会话 ${internalId} 已被继承压缩（有子会话承接）——冻结会话只供回翻，不可再承接；要继续该话题请承接其最新后继叶子会话（gen 最大者）`
      }
    }
    const ok = store.setActive(ownerSessionId, internalId)
    if (!ok) return { ok: false, error: `设置承接指针失败：会话 ${internalId} 加载校验未通过` }
    return {
      ok: true,
      data: {
        action: 'select',
        internalId,
        title: summary.title,
        // 回注该会话摘要：选定后下一轮上下文将注入该会话的摘要+近期消息，
        // 回执里先回显摘要，让 AI 确认自己选中的是这条线（而非凭 id 盲选）。
        summary: summary.summary || '（无摘要——可先用 update-summary 补写）',
        message: `已把会话 ${internalId}（${summary.title}）设为当前承接会话，下一轮起的对话将装入该会话摘要与近期消息并写入该会话`
      }
    }
  }

  private async doUpdateSummary(
    store: InternalSessionStore,
    ownerSessionId: string,
    internalId: string,
    summary: string
  ): Promise<ToolResult> {
    const all = store.list(ownerSessionId)
    const target = all.find((c) => c.id === internalId)
    if (!target) {
      return { ok: false, error: `内部会话 ${internalId} 不存在（id 可能已过期，请先 list 获取最新清单）` }
    }
    // 摘要可改范围与 select 的可写尾端同口径：只有无 timeBranchId 且无继承子的
    // 可写尾端才能改自己的摘要（AI 自己维护自己改）；已锁定/被压缩的只读底稿
    // 只能回翻，改摘要会破坏「冻结历史自述」的语义（其内容不可再被修改）。
    if (target.timeBranchId) {
      return {
        ok: false,
        error: `会话 ${internalId} 已向时间下级 ${target.timeBranchId} 延续并被锁定（只读）——摘要随会话冻结，不可修改；需要承接请选其时间尾端`
      }
    }
    const childIds = new Set<string>()
    for (const c of all) {
      if (c.parentId) childIds.add(c.parentId)
    }
    if (childIds.has(internalId)) {
      return {
        ok: false,
        error: `会话 ${internalId} 已被继承压缩（有子会话承接）——摘要随冻结底稿不可修改；要继续该话题请承接其最新后继叶子会话（gen 最大者）`
      }
    }
    await store.update(ownerSessionId, internalId, { summary })
    return {
      ok: true,
      data: {
        action: 'update-summary',
        internalId,
        title: target.title,
        summary,
        message: `已更新会话 ${internalId}（${target.title}）的摘要为：「${summary}」——后续 list/路由选择将按新摘要识别该会话`
      }
    }
  }

  private async doCreate(
    store: InternalSessionStore,
    ownerSessionId: string,
    title?: string,
    explicitParentId?: string,
    initialSummary?: string,
    newTopic = false
  ): Promise<ToolResult> {
    // 父选择（与自动路由同一口径的可写尾端判定）：
    // 1. explicitParentId——工具参数显式指定（AI 明确决定挂在哪个可写尾端下）；
    // 2. active 指针——当前正承接的会话（若仍为可写尾端）；
    // 3. 最近可写尾端——更新最晚的可继续写入会话；
    // 4. 以上皆无（首个会话）→ 建根，成为逆生树第一棵树的根。
    // 分支语义（0.31 定稿「新会话=虚线 / 延续=实线」，工具与自动路由同口径）：
    // - newTopic=false（延续实线）：有父时把父会话全部内容【原样继承】进新会话
    //   （messages/summary/cacheLocations 逐字复制），新会话挂继承轴向下（parentId，
    //   gen = 父 gen+1）并承接后续对话；父会话完全不动（不改 timeBranchId、不另造副本）。
    // - newTopic=true（新话题虚线）：AI 判定话题新开——空白承接当前输入，【不复制】
    //   父会话任何内容（无父时即独立根），树形挂接仍保留（虚线从该尾端引出）。
    // 新会话均经 computeFilePath 锚定落入父同名文件夹（一个会话文件 + 一个同名文件夹的 NNG 结构）。
    const all = store.list(ownerSessionId)
    const childIds = new Set<string>()
    for (const c of all) {
      if (c.parentId) childIds.add(c.parentId)
    }
    const isWritableTail = (id: string) => {
      const c = all.find((x) => x.id === id)
      return Boolean(c) && !childIds.has(id) && !c!.timeBranchId
    }
    let parentId = explicitParentId
    if (parentId) {
      if (!isWritableTail(parentId)) {
        return { ok: false, error: `create 的 parentId 必须是可写尾端（无 timeBranchId 且无继承子）；${parentId} 已锁定或已被压缩——先 list 取最新清单` }
      }
    } else {
      const activeId = store.getActive(ownerSessionId)
      if (activeId && isWritableTail(activeId)) parentId = activeId
      if (!parentId && all.length > 0) {
        const tail = all.find((c) => isWritableTail(c.id))
        if (tail) parentId = tail.id
      }
    }
    // 取父会话全量（list() 只回摘要；原样继承需要完整 messages，newTopic 虚线路径无需复制只取身份）
    const parent = parentId ? store.get(ownerSessionId, parentId) : null
    const internal = newTopic
      ? store.create(ownerSessionId, {
          title: title ?? '新内部会话',
          // 新话题线（虚线）：空白承接，不复制父的摘要/消息/缓存位置；初始摘要仅取 AI 显式提供
          ...(initialSummary ? { summary: initialSummary } : {}),
          ...(parent ? { parentId: parent.id, gen: (parent.gen ?? 1) + 1 } : {}),
          isNewTopic: true
        })
      : parent
        ? store.create(ownerSessionId, {
            title: title ?? parent.title,
            // 摘要契约：AI 可写初始摘要；不写则沿用父会话摘要（新线与父同源，识别需要时再改写）。
            summary: initialSummary ?? parent.summary,
            messages: parent.messages,
            cacheLocations: parent.cacheLocations,
            parentId: parent.id,
            gen: (parent.gen ?? 1) + 1
          })
        : store.create(ownerSessionId, {
            title: title ?? '新内部会话',
            ...(initialSummary ? { summary: initialSummary } : {})
          })
    store.setActive(ownerSessionId, internal.id)
    return {
      ok: true,
      data: {
        action: 'create',
        internalId: internal.id,
        title: internal.title,
        ...(internal.summary ? { summary: internal.summary } : {}),
        ...(parent ? { parentId: parent.id, gen: internal.gen } : {}),
        ...(internal.isNewTopic ? { isNewTopic: true } : {}),
        createdAt: internal.createdAt,
        updatedAt: internal.updatedAt,
        message: newTopic
          ? `已新建【新话题】会话 ${internal.id}（${internal.title}）${parent ? `，虚线从「${parent.title}」引出、不复制其内容` : '（独立根）'}，并设为当前承接会话${internal.summary ? `；摘要：「${internal.summary}」` : '（未写摘要，首轮对话后自动生成）'}`
          : parent
            ? `已从「${parent.title}」分叉出新会话 ${internal.id}（${internal.title}，第 ${internal.gen ?? 1} 代，原样继承父会话内容），父会话保持原样作为分支基点；新会话设为当前承接会话${internal.summary ? `；摘要：「${internal.summary}」` : '（未写摘要）'}`
            : `已新建空白内部会话 ${internal.id}（${internal.title}）并设为当前承接会话（当前无既有可写尾端，作为独立根）${internal.summary ? `；摘要：「${internal.summary}」` : '（未写摘要，首轮对话后自动生成）'}`
      }
    }
  }

  private doRelease(store: InternalSessionStore, ownerSessionId: string): ToolResult {
    const prev = store.getActive(ownerSessionId)
    store.clearActive(ownerSessionId)
    return {
      ok: true,
      data: {
        action: 'release',
        releasedInternalId: prev,
        message: prev
          ? `已释放承接指针（原承接会话 ${prev} 不再自动装载），下一轮起恢复自动路由`
          : '当前无承接指针，无需释放（自动路由保持）'
      }
    }
  }
}

/** 引用类型防未使用告警（类型仅用于文档） */
export type { InternalSessionStore }