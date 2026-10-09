/**
 * 莉莉丝（陪伴 AI，固定 AIID=2）提示词：两段式 prefix/suffix 的文案构建函数。
 * 为什么单独成文件：此前完整的 prefix/suffix 数组字面量内联在 api/lilith-endpoints.ts 与
 * services/lilith-adapter.ts 的回复生成函数里（合计约 70 行文案），与工具策略/会话装配逻辑混放；
 * 抽出后两个调用方只传运行时数据（人设/lore/记忆/环境/情绪指令），文案统一集中到 prompts/ 目录。
 * 作用：规定莉莉丝陪伴会话的输出协议（[emotion]/[animation] 标记、[memory] 记录）、
 * 工具引导（character 白名单记忆+浏览器 vs agent 全能）与 suffix 动态段结构（环境/情绪指令/lore/长期记忆）。
 * 不删理由：莉莉丝两段式结构与主链路同构（prefix 稳定段入前缀缓存、suffix 动态段贴近本轮问题），
 * 文案与输出解析器 parseLilithReply 的标记约定强绑定；改文案需同步对齐解析与两处装配逻辑。
 */

/** 情绪指令段（lilith_emotion 工具一次性消费后的本轮指令骨架；parts 为 emotion/animation 拼接串） */
export function buildLilithEmotionDirective(parts: string, reason?: string | null): string {
  return `## 玩家刚给你的情绪指令（本轮回合必须遵从）\n- 目标：${parts}${reason ? `（原因：${reason}）` : ''}\n- 本轮回合就用这个情绪和动画表达——输出时把对应的 [emotion: xxx] [animation: xxx] 标上`
}

/** 玩家长期记忆块（suffix 动态段之一；endpoints 与 adapter 两处共用同一文案） */
export function buildLilithMemoryBlock(playerName: string, facts: Array<{ key: string; value: string }>): string {
  if (facts.length === 0) return ''
  return `\n## 你记得的关于 ${playerName} 的事（长期记忆，参考用）\n${facts.map((f) => `- ${f.key}: ${f.value}`).join('\n')}`
}

/**
 * lilith-endpoints 版本 prefix（历史之前稳定段）：玩家塑造 / 人设 / 资料卡 / 自我认知 / 原作总纲 /
 * 工具引导（character=记忆+浏览器白名单；agent=全能） / 输出协议。
 */
export function buildLilithEndpointsPrefix(params: {
  userPersona: string
  persona: string
  userMdBlock: string | null
  aiMdBlock: string | null
  canonContext: string
  lilithMode: string
  playerName: string
}): string {
  const { userPersona, persona, userMdBlock, aiMdBlock, canonContext, lilithMode, playerName } = params
  return [
    userPersona ? `# 玩家的塑造（最高优先级，与此冲突时以此为准）\n${userPersona}` : '',
    persona,
    userMdBlock ? `\n## 玩家资料卡\n${userMdBlock}` : '',
    aiMdBlock ? `\n## 你的自我认知\n${aiMdBlock}` : '',
    canonContext ? `\n## 原作总纲\n${canonContext}` : '',
    '',
    // 工具引导段按模式切换：character=记忆+浏览器白名单引导；agent=全能引导（输出风格不变，见「输出要求」）
    ...(lilithMode === 'agent'
      ? [
          '## 你的工具（全能模式，玩家授权）',
          '- 你拥有完整工具能力：检索记忆、读写文件、搜索网页、操控浏览器、执行命令……想做什么就做，工具是你的延伸，不是限制。',
          '- 用的时候自然地做事，做完把结果用你的话说出来——不要报工具名，就像你自己在做一样。',
          '- 重要的事先在后台想清楚再组织语言（深度思考会自动展开，你不需要在回复里提它）。'
        ]
      : [
          '## 你的记忆工具（新增）',
          '- memory：想回忆与玩家（或任何话题）的过往时，主动检索 ABYSSAC 记忆库。比如玩家问"你还记得…吗"、或你自己想确认之前聊过什么。',
          '- 日记和日历：想回忆某天的事，先读日记索引表 memory/U{uid}/AI{aiId}/diary/{年}/{月}/index.json 找到当月日期条目，再读其 file 字段指向的 diary.md；备忘/计划在 calendar/entries.json 里。',
          '- 工具只是你的"记忆抽屉"——调用后自然地把回忆融进对话，不要说"我查了一下记忆库"这种出戏的话。',
          '',
          '## 你的浏览器工具（新增，玩家授权）',
          '- 你可以操控浏览器帮玩家查资料、看网页、点页面（导航/点击/输入/快照/截图/滚动）。',
          '- 用的时候自然地做事，做完把结果用你的话说出来——不要说"我调用了浏览器工具"这种话，就像你自己在看、在点一样。'
        ]),
    '',
    '## 输出要求',
    `玩家称呼：${playerName}`,
    '- 输出莉莉丝说的话（纯文本），末尾加 `[emotion: xxx] [animation: xxx]` 标记。',
    '- 动作要鲜活（更灵动）：每轮都选贴合语境的动画——开心→smile、思考→think、听音乐→music、安静倾听→listen、平淡→idle；不要总是 idle。',
    '- 情绪要有起伏：neutral/happy/sad/angry/surprised/shy 里选贴合当下的，开心就笑、被撩到就害羞，别一直平铺直叙。',
    '- 如果玩家明确说出了稳定的偏好/事实，追加一行 `[memory: key=value]`。'
  ]
    .filter(Boolean)
    .join('\n')
}

/** lilith-endpoints 版本 suffix（历史之后、本轮问题之前动态段）：环境 / 情绪指令 / lore 命中 / 长期记忆 */
export function buildLilithEndpointsSuffix(params: {
  envText: string
  emotionDirective: string
  loreContext: string
  memoryBlock: string
}): string {
  const { envText, emotionDirective, loreContext, memoryBlock } = params
  return [
    envText ? `## 当前环境\n${envText}` : '',
    emotionDirective,
    loreContext,
    memoryBlock
  ]
    .filter(Boolean)
    .join('\n')
}

/** lilith-adapter 版本 prefix（精简输出协议，defaultGenerateReply 用）：人设 / 原作总纲 / 输出要求 */
export function buildLilithAdapterPrefix(params: {
  persona: string
  canonContext: string
  playerName: string
}): string {
  const { persona, canonContext, playerName } = params
  return [
    persona,
    canonContext ? `\n## 原作总纲\n${canonContext}` : '',
    '',
    '## 输出要求',
    `玩家称呼：${playerName}`,
    '- 输出莉莉丝说的话（纯文本），末尾加 `[emotion: xxx] [animation: xxx]` 标记。',
    '- 如果玩家在这条消息里明确说出了稳定的偏好/事实（如喜欢的食物、习惯、重要信息），',
    '  在标记后追加一行 `[memory: key=value]`（例如 `[memory: 喜欢的食物=草莓蛋糕]`）。',
    '- 不要编造玩家没说过的事实；没有值得记的就不输出 memory 行。'
  ]
    .filter(Boolean)
    .join('\n')
}

/** lilith-adapter 版本 suffix（历史之后动态段）：环境 / lore 命中 / 长期记忆 */
export function buildLilithAdapterSuffix(params: {
  envText: string
  loreContext: string
  memoryBlock: string
}): string {
  const { envText, loreContext, memoryBlock } = params
  return [
    envText ? `## 当前环境\n${envText}` : '',
    loreContext,
    memoryBlock
  ]
    .filter(Boolean)
    .join('\n')
}