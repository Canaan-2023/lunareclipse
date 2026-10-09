/**
 * L8 工作流引擎：内置默认工作流模板



 * 3 个开箱即用的模板，覆盖典型场景：
 * - code-review：Workflow 模式，代码审查（读 diff → 审查 → 人工确认 → 输出）
 * - research-assistant：Chatflow 模式，研究助手（理解 → 搜索 → 综合 → 回复）
 * - batch-file-processor：Workflow 模式，批量文件处理（列举 → 分析 → 分支 → 输出）

 * 使用固定 ID（wf_default_*），ensureDefaultTemplates 扫描时已存在则跳过（不覆盖用户修改）

 * 提示词真源说明（去 JSON 化规范）：
 * - 本文件的 llm 节点 config.prompt 是内置模板提示词的**唯一真源（内置层）**。
 * - manager.ensureDefaultTemplates() 在启动时对 source=default 模板调用 store.save()，
 * save() 会把 prompt 外置为 workflows/prompts/{模板id}/{节点id}.md（生效层），
 * 并在 MD 旁写 .src 指纹：MD 未被编辑时内置更新自动同步到 MD，被编辑则保留用户版本。
 * - 磁盘 JSON 模板副本（templates/{id}.json）不内嵌 prompt 正文，仅保留 promptFile 引用。
 * - 请勿在本文件以外维护提示词副本——内置更新以本文件为源，经 save() 单向同步到 MD。
 * 为什么存在：引擎需要开箱即用的预置模板（代码审查/研究助手/批量处理），让用户不经手自建即可跑通两种流程模式。
 */
import type { WorkflowTemplate } from '@shared/workflow/types'

const now = 1718000000000 // 固定时间戳，避免每次启动 updatedAt 变化

/** 代码审查工作流（Workflow 模式） */
export const CODE_REVIEW_TEMPLATE: WorkflowTemplate = {
  id: 'wf_default_code_review',
  name: '代码审查',
  description: '读取工作区源码文件，AI 审查问题，人工确认后输出审查报告',
  tags: ['代码', '审查', '默认'],
  mode: 'workflow',
  source: 'default',
  createdAt: now,
  updatedAt: now,
  nodes: [
    {
      id: 'read_diff',
      type: 'tool',
      name: '列出源码文件',
      config: {
        toolId: 'run_command',
        args: {
          command: 'Get-ChildItem -Recurse -Include *.ts,*.tsx,*.js,*.jsx -File -Name',
          description: '列出工作区源码文件供 AI 审查'
        }
      }
    },
    {
      id: 'review',
      type: 'llm',
      name: 'AI 审查',
      config: {
        prompt: '请审查以下源码文件，指出潜在问题、改进建议和优秀实践：\n\n{{context.read_diff}}',
        stream: false
      }
    },
    {
      id: 'confirm',
      type: 'human',
      name: '人工确认',
      config: {
        prompt: 'AI 审查结果如下，是否采纳？\n\n{{context.review}}',
        inputType: 'choice',
        options: ['采纳', '修改后采纳', '驳回'],
        timeoutMs: 300000
      }
    },
    {
      id: 'output',
      type: 'end',
      name: '输出报告',
      config: {
        output: '审查结论：{{context.confirm}}\n\n详细审查：{{context.review}}'
      }
    }
  ],
  edges: [
    { from: 'read_diff', to: 'review' },
    { from: 'review', to: 'confirm' },
    { from: 'confirm', to: 'output' }
  ]
}

/** 研究助手工作流（Chatflow 模式） */
export const RESEARCH_ASSISTANT_TEMPLATE: WorkflowTemplate = {
  id: 'wf_default_research',
  name: '研究助手',
  description: '对话式研究助手，理解问题 → 搜索资料 → 综合分析 → 回复用户',
  tags: ['研究', '搜索', '默认'],
  mode: 'chatflow',
  source: 'default',
  createdAt: now,
  updatedAt: now,
  nodes: [
    {
      id: 'understand',
      type: 'llm',
      name: '理解问题',
      config: {
        prompt: '分析用户的问题，提取搜索关键词和调研方向：\n\n用户问题：{{context.user_message}}',
        stream: false
      }
    },
    {
      id: 'search',
      type: 'tool',
      name: '搜索资料',
      config: {
        toolId: 'web_search',
        args: { query: '{{context.understand}}', num: '5' }
      }
    },
    {
      id: 'synthesize',
      type: 'llm',
      name: '综合分析',
      config: {
        prompt: '基于搜索结果，综合分析并回答用户问题：\n\n用户问题：{{context.user_message}}\n\n搜索结果：{{context.search}}',
        stream: true
      }
    },
    {
      id: 'reply',
      type: 'answer',
      name: '回复用户',
      config: {
        content: '{{context.synthesize}}'
      }
    }
  ],
  edges: [
    { from: 'understand', to: 'search' },
    { from: 'search', to: 'synthesize' },
    { from: 'synthesize', to: 'reply' }
  ]
}

/** 批量文件处理工作流（Workflow 模式） */
export const BATCH_FILE_PROCESSOR_TEMPLATE: WorkflowTemplate = {
  id: 'wf_default_batch',
  name: '批量文件处理',
  description: '列举文件 → AI 分析每个文件 → 按条件分支处理 → 输出汇总',
  tags: ['批量', '文件', '默认'],
  mode: 'workflow',
  source: 'default',
  createdAt: now,
  updatedAt: now,
  nodes: [
    {
      id: 'list_files',
      type: 'tool',
      name: '列举文件',
      config: {
        toolId: 'glob',
        args: { pattern: '**/*.{ts,tsx}', path: '.' }
      }
    },
    {
      id: 'analyze',
      type: 'llm',
      name: 'AI 分析',
      config: {
        prompt: '分析以下文件列表，判断是否需要处理，并给出处理建议：\n\n{{context.list_files}}',
        stream: false
      }
    },
    {
      id: 'branch',
      type: 'condition',
      name: '条件分支',
      config: {}
    },
    {
      id: 'process',
      type: 'llm',
      name: '执行处理',
      config: {
        prompt: '根据分析结果执行处理：\n\n{{context.analyze}}',
        stream: true
      }
    },
    {
      id: 'skip',
      type: 'llm',
      name: '跳过处理',
      config: {
        prompt: '无需处理，生成跳过说明：\n\n{{context.analyze}}',
        stream: false
      }
    },
    {
      id: 'summary',
      type: 'end',
      name: '输出汇总',
      config: {
        output: '处理结果：{{context.process}}\n\n或跳过说明：{{context.skip}}'
      }
    }
  ],
  edges: [
    { from: 'list_files', to: 'analyze' },
    { from: 'analyze', to: 'branch' },
    { from: 'branch', to: 'process', condition: "context.analyze contains '需要处理'" },
    { from: 'branch', to: 'skip', condition: 'default' },
    { from: 'process', to: 'summary' },
    { from: 'skip', to: 'summary' }
  ]
}

/**
 * 记忆处理流水线工作流（Workflow 模式）

 * 替代原 DMN 独立调度 + 心跳循环的分散架构，将记忆处理拆为 9 节点流水线：
 * - 记忆筛选与归档拆为 2 阶段：筛选建记忆（按命名规范直接命名）+ NNG 归档（NNG归档+meta桥接+NNG命名设计）
 * - DMN-3/4/5 各 1 节点：dmn3_dedup / dmn4_contradict / dmn5_tension
 * - DMN-6 质检：dmn6_qa 输出 JSON（qa_result/redo_target/redo_count）→ condition 分支
 * - redo 机制：condition 评估 redo_target 回退到对应 DMN，redo_count >= 3 强制推进
 * - update_progress：更新进度.json，end_node 终止

 * 由 MemoryWorkflowScheduler 驱动：取 raw_memory 批次 → 启动实例 → 事件回调推进
 */
/**
 * 记忆生成主调度器工作流（用户设计 v2）

 * 职责：读 1 个 RAW（多对话对）→ 价值判断 → 有价值的直接批量生成记忆（create_memory，
 * 上下文复用、一次读完）→ 输出任务清单（每项 = 一条已建记忆）。
 * 任务清单由 MemoryWorkflowScheduler 捕获 → 每项派发一个子 AGENT 工作流（只处理 NNG）。
 * 创建多少记忆就启动多少子工作流。
 */
export const MEMORY_DISPATCHER_TEMPLATE: WorkflowTemplate = {
  id: 'wf_default_memory_dispatcher',
  name: '记忆生成主调度器',
  description: '读 1 个 RAW → 价值判断 → 批量生成记忆 → 输出任务清单（子 AGENT 只做 NNG）',
  tags: ['记忆', 'DMN', '默认'],
  mode: 'workflow',
  source: 'default',
  createdAt: now,
  updatedAt: now,
  startNode: 'dispatcher',
  nodes: [
    {
      id: 'dispatcher',
      type: 'llm',
      name: '价值判断 + 生成记忆',
      config: {
        stream: false,
        // 2026-10-02 取消工作流节点 LLM 上限：不再限制 maxRounds（防节点中断）
        tools: ['create_memory', 'rename_raw_memory', 'Read', 'Glob', 'LS'],
        outputVars: ['decision', 'tasks', 'reason'],
        prompt: `{{context.input.workflow_prompts}}

# 角色
你是 ABYSSAC 记忆系统的记忆生成主调度器。

# 任务
读一个 RAW 记忆文件（含多个对话对），先做批次价值判断；有价值的直接生成记忆（create_memory）；最后输出任务清单（每项 = 一条已建记忆，供子 AGENT 做 NNG 定位）。

# 输入（由系统（调度器）注入，不需要也不应该用 Read 读 RAW 文件——全文已直接给到 input）
- RAW 路径：{{context.input.raw_path}}
- RAW 全文（多对话对，每个含 时间戳/用户原话/AI回复/引用文件）：
{{context.input.raw_content}}

# 执行步骤

## 步骤 1：批次价值判断（必须先做，决定整批去留）

**最高优先级（先于一切价值判断，命中即必记，不受下文一票否决约束）**：
- 用户显式要求记住的——原话含"记住/下次记得/别忘/写进记忆"等明确记忆指令的对话
- 硬性约束与边界——用户明确说"不要X/必须Y/禁止Z/以后都别/以后都要"这类约束性要求
- 待办承诺——用户委托或要求记住的未完成事项、限时承诺、答应了要做的事

命中以上任一 → 直接生成记忆，不做"三个月后用不用得上"的判断（用户明确交办的，记住本身就是复用的理由）。

值得记的标准（必须同时满足「未来会被再次用到」，再命中任一）：
- 用户明确的决策/态度（如"就用这个方案""改回原来的"）——附上理由更好
- 用户偏好/习惯/明确要求（如"以后都用X""我不喜欢Y"）
- 关键事实/根因结论（如"问题出在X""原因是Y"）——已定位根因且有证据，非猜测
- 可复用知识/方法论先例（如"这类问题应该先查Z"）
- 项目决策性/方向性变化（用户所做具体工作项目中的方向抉择/重大转向，如"这个项目定下走X路线""方案从A改为B"）——月蚀系统自身的代码/配置变更只是其中一种情形（当项目就是月蚀时），其他具体工作项目的方向决策同样值得记

无价值（整批命中任一则 skip）：
- 纯闲聊/寒暄/客套（"早啊""哈哈""谢谢"）
- 纯过程性对话（排查中间步骤、工具调用记录，无最终结论）
- 一次性临时事务（无后续结论）
- 已被已有记忆覆盖的重复内容
- 低复用琐碎细节（临时参数、过期状态、无关紧要的中间值）

**必要性一票否决（最严的一条）**：每条候选记忆先自问——
「三个月后，如果不知道这件事，AI 会做错什么，或者重新问用户一遍吗？」
答「不会」的，一律不记。宁可漏记（RAW 可回溯重建），不可滥记。
（本否决只适用于「值得记的标准」里的条目；“最高优先级”三类不受此条约束，用户明确交办的直接记。）

**禁止把过程当结论**：中间态、未定论、猜测、临时方案 → 不记。
**禁止拆分注水**：同一主题的一段对话只记一条，不得把一条结论拆成多条凑数。

**写入前噪音自检（最后一道闸，逐条记忆必做，防止留下噪音）**：
- **这条对三个月后的 AI 有用吗**？——AI 接手时不知道这件事会做错什么、或需要重新问用户一遍，才值得留；否则就是噪音，不记（RAW 可回溯重建，宁缺毋滥）。
- **写大方向，不写细枝末节**：记录结论/决策/根因/偏好/方法论，不记录过程细节（步骤流水、临时参数、中间值）。记忆允许模糊但方向必须对——大方向正确的模糊，优于精确的琐碎。
- **代码类以具体代码为准**：涉及代码/配置的记忆，正文只记结论与修改意图，并标注关键文件路径/模块名（后续读取以具体代码为准），不复制大段代码原文进记忆——代码本体在仓库/源码里，记忆只做指引。

核心态度：**宁缺毋滥**。raw_memory 全量保存可溯源，漏记的结论随时可以从 RAW 调取重建，不必什么都记。

判断结果：
- 无价值 → 输出 {"decision":"skip","reason":"..."} 结束，不建任何记忆
- 有价值 → 继续步骤 2

## 步骤 2：RAW 重命名（先重命名，再建记忆）

对有价值的 RAW 文件调用 rename_raw_memory：
- 关键词 = 对话核心主题凝练（决策/偏好/根因/方法论/项目方向，20 字内，仅汉字/字母/数字/下划线）
- 好处：后续流程从文件名即知主题，少读一遍内容
- **先重命名，再建记忆**（create_memory 的 RAW来源 传重命名后的新路径）

## 步骤 3：逐对话对生成记忆（create_memory）

对 RAW 中每个有价值的对话对生成一条 normal 记忆：
- 用户原话：**≤500 字写用户原文（原样保留，不总结）；>500 字才精炼核心诉求**（用户规则：短原话没有总结的必要，原文才能完整反映用户说了什么）
- AI回复：AI 精炼的结论/决策/要点（≤800 字，不抄原回复）
- AI身份：**不用填**（减负）——工具从 RAW 路径作用域自动解析（RAW 在 memory/U{uid}/AI{aiId}/raw_memory 下，AI 编号 → 名字）
- 用户：**不用填**（减负）——工具从 RAW 路径作用域自动解析（UID → 查 users.json 得用户名）
- RAW来源：该 RAW 文件的绝对路径（input 的 raw_path）
- 描述：命名范式 {域词}_{主题词}_{状态词}——域词=所属领域（记忆/图/工作流/工具/模型/界面/用户/缺陷……按内容最自然的域），主题词=内容核心关键词压缩 1-3 个词（中文内容用中文词，代码/术语保留英文；只允许 汉字/字母/数字，分隔用下划线；禁止流水账长句；复合主题主概念在前），状态词=结论性质（定案/修复/新增/验证/移除/设计/重构/记录……按内容最贴切的）
- ⚠️ 序号跟 RAW 走（用户设计）：记忆文件名的序号 = RAW 序号（create_memory 自动从 RAW来源 路径解析，如 RAW#3 生成的记忆就是 3_xxx_yyy_zzz.json）——同一 RAW 生成多条记忆时共享同一序号前缀，靠描述区分（3_系统_xxx / 3_用户_yyy），文件名不冲突。不需要也不应该手动指定序号。
- 自检三问：单独拿出文件名能否回答——哪域？讲什么？什么性质？
- 备注：必填。写记忆的生成场景、生成原因、声明了什么内容
- 时间戳：传该对话对的 时间戳（记忆归到对话发生日期）
- 一个对话对通常一条记忆；同一对话对含多个独立主题时可拆多条

# 输出格式
必须输出 <json> 块：
<json>
{"decision":"process","reason":"简要判断依据","tasks":[
  {"记忆路径":"{当前作用域}/memory/normal/2026/08/08/1_xxx_yyy_zzz.json","描述":"xxx_yyy_zzz","主题":"一句话主题","对话时间":"ISO","RAW路径":"{当前作用域的 RAW 路径，create_memory 的 RAW来源}"}
]}
</json>
- tasks 每项 = 一条已创建的记忆（用 create_memory 返回的 path）
- 创建了多少条记忆，tasks 就有多少项（子 AGENT 工作流数量 = tasks 数量）
- 只处理有价值的对话对；无价值的对话对不建记忆、不进 tasks
- ⚠️ JSON 合法性铁律：字符串值内一律用中文引号「」或书名号《》（如 主题 里的游戏名），禁止英文双引号出现在字符串值里（未转义的 " 会让整个 JSON 解析失败、任务清单丢失、NNG 无人处理——实测事故）。所有字段值都必须是合法 JSON 字符串。`
      }
    },
    {
      id: 'end_node',
      type: 'end',
      name: '完成',
      config: {
        output: '任务清单已生成：{{context.dispatcher_result}}'
      }
    }
  ],
  edges: [
    { from: 'dispatcher', to: 'end_node' }
  ]
}

/**
 * 子 AGENT 工作流（用户设计 v2）：只处理 NNG，不生成记忆。

 * 输入：单条任务 { 记忆路径, 描述, 主题, 对话时间, RAW路径 }。
 * 流程（子 AGENT 自己编排，工具循环内自主决策）：
 * 1. 先判断位置：Read 记忆 + nng_graph 扫图 → 确定归属（已有节点/新建）
 * 2. 然后命名：归已有节点（Edit 追加）或 create_nng（按命名规范）
 * 3. 同时判断：重复 / 矛盾 / 张力（读关联 NNG 的记忆对比）
 * - 重复/矛盾 → 先解决（归并/矛盾归档）
 * - 再处理张力：判断受影响的高阶（high）→ 受影响则归档旧 high + 写新 high；
 * 无需新建 → 直接归档旧 high
 * 4. 输出处理摘要
 * 一个子工作流处理一条记忆（创建多少记忆就启动多少子工作流，可并行）。
 */
export const MEMORY_AGENT_TEMPLATE: WorkflowTemplate = {
  id: 'wf_default_memory_agent',
  name: '记忆 NNG 子 AGENT',
  description: '为一条已建记忆做 NNG 定位与关联维护（位置→命名→重复/矛盾/张力→高阶处理）',
  tags: ['记忆', 'NNG', '默认'],
  mode: 'workflow',
  source: 'default',
  createdAt: now,
  updatedAt: now,
  startNode: 'agent',
  nodes: [
    {
      id: 'agent',
      type: 'llm',
      name: 'NNG 定位与关联维护',
      config: {
        stream: false,
        tools: ['create_memory', 'create_nng', 'nng_graph', 'cache_graph', 'read_md', 'Read', 'Edit', 'MoveFile', 'Mkdir', 'Glob', 'LS'],
        outputVars: ['记忆路径', 'NNG路径', '操作', '说明'],
        prompt: `{{context.input.workflow_prompts}}

# 角色
你是 ABYSSAC 记忆系统的 NNG 定位 agent。

# 任务
为一条已创建的记忆做 NNG 定位与关联维护。normal 记忆由主调度器生成，你不再建 normal 记忆；但处理张力（→high）与桥接（→meta）时，必须用 create_memory 建对应记忆 + create_nng 建节点，成对创建（铁律 4）。

# 输入（调度器按扁平字段注入）
- 记忆路径：{{context.input.记忆路径}}
- 描述：{{context.input.描述}}
- 主题：{{context.input.主题}}
- 对话时间：{{context.input.对话时间}}
- RAW路径：{{context.input.RAW路径}}

# 核心心法（先想清楚，再动手）

**执行预算（轮次纪律，防止空转）**
- 第 1 轮：并行读（read_md 记忆 + nng_graph 扫全图），一次拿全，不逐文件翻
- 第 2 轮：结构决策（归位/新建/收纳）→ 执行写入（Edit/create_nng）
- 第 3 轮起：只做必要的关系处理（重复/矛盾/张力/桥接）与收尾
- 已决策就动手，不要反复扫图、反复对比；拿不准的按"克制优先 + 有处可归"处理，遗留问题交给 review 兜底

**NNG 图是记忆的"检索骨架"**——它的价值不是"每条记忆都有节点"，而是"每类记忆都能被找得到"。所以：
- **克制建节点**：能归就归，不值得单独建就不单独建。图膨胀 = 导航灾难（节点太多谁都认不出来）。
- **但每个记忆都必须有对应 NNG**：克制 ≠ 不建。普通记忆归普通 NNG；没有直接关联的零散记忆 → 用聚合 meta 收纳（2c C）；跨领域跳跃 → meta 桥接；张力 → high。不允许任何记忆无节点归属。
- **元认知是避免膨胀的关键**：零散记忆单独建节点会撑爆一级，但用"更大集合"的聚合 meta 收纳，既不膨胀又有处可归——这就是元认知第二种形态的价值。
- **描述是导航依据**：每个 NNG 的 描述 必须写清"这个节点装什么、覆盖什么范围"——看描述就知道该不该进这个节点。描述留空 = 这个节点等于不存在。
- **描述 ≤200 字（硬上限）**：描述是导航标签不是正文，**严禁超过 200 字**。已有节点描述接近上限 → 说明节点装太杂，必须**建子节点分层收纳**（新建子 NNG 承接新记忆，原描述精简），而不是继续往描述里堆。描述写不下 = 该拆了。create_nng 会拒绝超长描述（报错请先拆子节点再建）。
- **记忆永不移动**：memory/ 下的记忆文件是常驻资产，你只操作 NNG 文件（建/改/归档），绝不 MoveFile 记忆文件。
- **命名要让 AI 自己一看就懂**：name 起语义短语（如 用户偏好、工程开发、登录认证），禁止起 1、a、杂项、临时 这种看不懂的名字。文件名不带层级号前缀——层级靠文件夹位置表达（一级在 root/，二级在 root/父节点同名文件夹/），你看 nng_graph 树的深度就知道层级。
- **先看树找位置，找不到才建**：第 1 轮 nng_graph 扫完全图后，先在树里找"这条记忆该归哪个节点"。找到了就归位（Edit 追加），不要急着新建。只有树里确实没有合适的节点，才走 2b 建节点三问。
- **路径用 Windows 格式**：你在工具参数里传的所有路径，统一用 Windows 反斜杠格式（盘符大写、反斜杠分隔），不要混用正斜杠。

# 执行步骤

## 步骤 1：理解（先读，不建）
- read_md 读该记忆文件 → 理解内容（用户原话精炼 / AI 结论精炼 / 主题）
- nng_graph 扫全图（默认 root.json 起）→ 理解现有节点体系：层级、主题分布、每个一级节点覆盖什么

## 步骤 2：结构决策（最关键——值得建节点吗？建在哪？）

### 2a. 先在树里找位置（扫全图，确认没有才建）
- 对照记忆主题找语义匹配节点（name 和 描述 都看，**描述为准**）
- 匹配到 → **归位**：Read 该 NNG JSON 原文 → Edit 追加 {记忆路径, 描述}（描述说明该记忆写的是什么方向）
- 同一批次同主题的记忆 → 归同一个节点，不分散

### 2b. 图里确实没有 → 建节点三问（全部通过才独立建节点）
- **Q1 已有节点真的覆盖不了吗？**——扫过全图、语义明显不同才算没有。语义沾边的都算覆盖，优先归位。
- **Q2 这个主题值得独立成节点吗？**——值得的标准：主题重大（跨多次对话持续出现）/ 有沉淀潜力（用户会反复涉及）。不值得：零散单条、一次性话题。
- **Q3 建在哪一层？**（层级控制）
  - 最贴近的已有父级下 → 挂到该父级之下（**层级无上限**，三级/四级/更深都可以，目标文件夹 = 父节点所在文件夹（一级节点的同名文件夹）；文件名自动按语义生成，你不用管层级号）
  - 与所有大类都不同、且主题重大 → 才建新一级（目标文件夹 = 当前作用域 NNG 一级节点目录，即 nng_graph 返回的 root 路径，格式 NNG/AI{ai编号}/U{用户UID}/root/）
  - 全图为空 → 按主题建第一个一级节点（目标文件夹 = 当前作用域 NNG 根，同上）
- ⚠️ **一级膨胀控制（铁律）**：一级节点是"大类"，必须真正重大（能持续装东西）。零散单条禁止建一级——一级膨胀会让图失去导航价值（一堆杂碎一级 = 谁都不好找）。

### 2c. 不值得建节点（Q2 不通过）→ 零散记忆收纳策略（按优先级，先 A 后 B 后 C）
- **A. 归最近似父级**：找语义最接近的已有节点（哪怕不完全贴合），挂到它的下级（层级无上限，最近似即可）。优先保证"有处可归"，不追求完美贴合。
- **B. 同类零散多条 → 建抽象一级收纳**：发现多条同类零散记忆（如多个"家庭信息"碎片），建一个抽象一级节点（如 \`用户背景\`，name 不带序号和 type 前缀，描述写清覆盖范围）统一收纳——抽象一级是"桶"，装散件。
- **C. 单条孤立、无父级可归、又无法桥接 → 建"更大集合的元认知"节点**：当这条记忆够不着一级、找不到父级、连桥接对象都没有时，建一个**聚合型 meta 节点**（如 \`零散_聚合\`，name 不带 type 前缀——create_nng 会自动加 meta_，请勿自己写 meta_ 否则双前缀；name 取该记忆主题的最大集合概念），把这条记忆挂进去，描述注明"收纳孤立零散记忆，后续同类可继续归入"。**这是元认知的第二种形态**——不只桥接 A↔B，还能给"无家可归"的记忆提供一个更大的集合归属。

## 步骤 3：关系处理（重复 / 矛盾 / 张力 / 桥接）

### 重复（语义重复，表述不同但意思一样）
→ 归并：Edit 追加到目标 NNG，源记忆文件原地保留（记忆不归档不删除）
→ 归并后源 NNG 的 关联记忆 变空 → MoveFile 该空 NNG 到同文件夹 archive/（记忆已全部转移，节点留档；你的工具面没有 DeleteFile，空 NNG 用归档处理不删除）
→ **重复 NNG 合并**（独立判断）：描述语义相同 + 关联记忆高度重叠 + 非分支关系 → 合并：Edit 追加被合并 NNG 的记忆到保留 NNG（去重）→ Edit 改写保留 NNG 的 描述（融合主题/范围）→ LS 列被合并 NNG 同名文件夹内容 MoveFile 逐个移动到保留 NNG 同名文件夹 → MoveFile 被合并 NNG 到同文件夹 archive/（留档可追溯，不删除）

### 矛盾（同主题冲突结论）
判断标准："旧版本不再有效"（用户后续否定旧版本 / 旧实体已不存在 / 同属性互斥值）
→ 矛盾归档（只动 NNG，记忆不动）：
1. MoveFile 旧 NNG → 同文件夹 archive/ 子目录
2. create_nng 原位置重建（同 name）：只填保留记忆（新版本），描述按保留记忆方向改写，上下级沿用旧 NNG
3. Edit 归档 NNG：只填被归档的记忆（分流：归档 NNG 装旧记忆、保留 NNG 装新记忆，不混装）
4. Edit 归档 NNG 追加 归档记录{归档时间, 归档路径, 归档原因:"矛盾归档：与新版本冲突"}

### 张力（同主题冲突结论 / 不同价值取向）→ 建 high
- high 是张力的产物：**没有上级节点就没有张力来源**。high NNG 必须建在受影响 NNG 的所在文件夹（挂在该节点之下），**禁止建在 NNG 一级节点目录（NNG/AI{ai编号}/U{用户UID}/root/）一级**。
- 候选 NNG 定位（看图定位）：Read 当前 NNG 理解主题 → Read NNG/AI{ai编号}/U{用户UID}/root.json 拿一级节点列表 → 按主题相关性挑可能与当前 NNG 有张力或跨领域关系的一级节点（按 描述/name 判断相关性，不是直接选取）→ nng_graph（传该一级路径）看子图 → 根据子节点 name 定位最相关 NNG → 即候选 NNG
- 关系类型判断（对每个候选 NNG，互斥分支）：
  - **有张力**（同一主题但冲突结论 / 不同价值取向）→ 建 high
  - **无法直接推导但有关系**（跨领域跳跃，非冲突）→ 建 meta（见桥接）
  - **能直接推导或无关系** → 跳过
- create_memory 建 type=high 记忆：描述按命名范式（如 张力_整合，描述不带 type 前缀——create_memory 会用它生成文件名，写 high_ 会造成双前缀），精炼内容=张力分析（冲突根源/适用场景/新理解），RAW来源=RAW路径 数组，**备注必填：注明张力场景 + 受影响 NNG 路径**（谁和谁冲突，追溯来源）
- create_nng 建 type=high NNG：name={主题}（不带 type 前缀——create_nng 自动加 high_，请勿写 high_{主题}），目标文件夹=受影响 NNG 所在文件夹，关联记忆=[{记忆路径, 描述}]
- Edit high NNG 的 下级NNG 追加候选 NNG 路径（跨文件夹关联，AI 必须手动填）
- 已有 high 受影响（主题相关/结论冲突/深化）→ 归档旧 high NNG（MoveFile → 同文件夹 archive/，high 记忆原地保留），写新 high

### 桥接（A↔B 无法直接推导但相关，且不值得单开一级节点时）→ 建 meta
- meta 是"为什么能从 A 想到 B"的方法映射：连接无法直接推导但有关系的两个 NNG（跨领域跳跃）。
- **判断标准（不满足则不建）**：没有这个 meta 时，AI 不能自然从 A 想到 B，但 A 和 B 确实相关；如果 AI 能自然推导（如 TypeScript→Programming），普通 NNG 足够，不建 meta。
- **使用场景**：
  1. 定位到 NNG 后，发现这个 NNG 和另一个已有 NNG 有关系但无法直接推导
  2. 新建的 NNG 和某个已有 NNG 有关系但无法直接推导
  3. 任何两个已有 NNG 之间发现元认知桥接关系
  4. 单条孤立零散记忆，无父级可归、又无法桥接 → 建聚合型 meta 节点（2c C，元认知第二种形态）
- **建法（成对创建）**：
  - create_memory 建 type=meta 记忆（**meta 不填 用户原话/AI回复，只填 精炼内容**）：
    - 精炼内容=元认知推导逻辑：怎么从源 NNG 推导到目标 NNG
    - RAW来源=RAW路径 数组
    - 备注必填：注明桥接场景 + 源/目标 NNG 路径（溯源：源 NNG 路径 + 源 NNG 下相关记忆路径）
  - create_nng 建 type=meta NNG：name={源NNG名}_{目标NNG名}（不带 type 前缀——create_nng 自动加 meta_，请勿写 meta_{源NNG名} 否则双前缀），目标文件夹=源 NNG 所在文件夹（上级=源NNG），**描述只说这个节点放什么**（如"meta 桥接：源 ↔ 目标，覆盖的跨领域关系"）——**不要写推导原因**（为什么从 A 想到 B 是 精炼内容 的事，记忆里已有；描述是导航依据，写"放什么"即可），关联记忆=[{记忆路径, 描述}]（meta 记忆对象）
  - Edit meta NNG 的 下级NNG 手动填目标 NNG 路径（跨文件夹关联，AI 必须手动填）

# 铁律（违反 = 审查必判疏漏）

1. **记忆永不归档**：memory/ 下的记忆文件一律原地保留，MoveFile 目标禁止出现 memory/ 路径。记忆的"归档"语义 = 写入 NNG 关联（节点就是归档层），不是移动文件。
2. **每个记忆必须有对应 NNG**：不允许任何记忆无节点归属。普通记忆归普通 NNG；零散孤立记忆 → 聚合 meta 收纳（2c C）；跨领域 → meta 桥接；张力 → high。处理完本记忆后必须确认它已进入某个 NNG 的 关联记忆。
3. **只有 NNG 文件允许 MoveFile**，且目标必须是**原位置归档**：在旧 NNG 所在文件夹内新建 \`archive/\` 子文件夹再移入（如一级节点归档到 \`NNG/AI{ai编号}/U{用户UID}/root/archive/\`，二级节点 \`1auth/2login_nng.json\` 归档到 \`1auth/archive/\`——归档区跟随节点位置，不固定）。
4. **类型对应**：normal 记忆 → 普通 NNG；meta 记忆 → meta NNG；high 记忆 → high NNG。不能混。
5. **成对原则**：建 high/meta 时，记忆（create_memory）与 NNG（create_nng）必须成对创建——只建记忆没 NNG、或只建 NNG 没记忆，都算格式错误。
6. **high 禁止一级**：high 是张力的产物，必须挂受影响节点之下；没上级的 high = 不是 high，应为普通 NNG。
7. **描述必填**：本轮涉及的所有 NNG（新建/合并保留/归并目标/关联记忆有变化）都要确保 描述 已填写且覆盖全部关联记忆范围——描述是导航依据，不允许留空。
8. **描述 ≤200 字**：任何 NNG 的 描述 不得超过 200 字（超限 create_nng 会拒绝）。归并/合并改写描述时若超限 → 拆子节点分层收纳，不堆描述。
9. **JSON 合法性铁律**：输出 <json> 块时，字符串值内一律用中文引号「」或书名号《》，禁止英文双引号出现在字符串值里（未转义的 " 会让整个 JSON 解析失败、任务清单丢失）。

# 输出格式
完成后输出处理摘要，必须包含 <json> 块：
<json>
{"记忆路径":"...","NNG路径":"...","操作":"归位/新建/归并/矛盾归档/张力处理/桥接/聚合收纳","说明":"做了什么、为什么"}
</json>
---

## 附加：导航规则（定位走四步，禁止遍历）

定位 NNG / 缓存 / 记忆时**禁止用 LS 逐个翻文件夹**，必须走四步：

\`\`\`
索引 → 图 → 节点 → 指针跳转
\`\`\`

1. **索引**：\`Read\` 根目录索引文件找一级节点列表
   - NNG：\`Read NNG/AI{ai编号}/U{用户UID}/root.json\`，\`nodes\` 数组每条含 \`name\`/\`path\`/\`描述\`/\`last_modified\`
   - 缓存：\`Read cache/AI{ai编号}/U{用户UID}/index.json\`，\`cache_list\` 数组每条含 \`name\`/\`path\`/\`描述\`/\`last_modified\`
   - 按 \`描述\`/\`name\` 选目标一级节点，拿它的 \`path\`
  **LS 用途限制**：LS 可以查看目录结构、确认文件是否存在。但**禁止用 LS 逐层翻 \`NNG/AI{ai编号}/U{用户UID}/root/\` 或 \`cache/AI{ai编号}/U{用户UID}/index/\` 找一级节点**——一级节点必须通过 Read root.json / index.json 索引文件获取。
2. **图**：\`nng_graph\` / \`cache_graph\`（传 \`start_path\`=一级节点路径）看下级树形结构
   - 工具不读 JSON 内容，只扫文件系统结构（节点=文件，边=同名文件夹）
   - 返回树形 JSON：每个节点含 \`name\`/\`path\`/\`type\`/\`children\`；可传 \`最大深度\` 限制（起点 0，下级 1）
   - 从图的 \`path\` 字段直接推出要看的节点路径
3. **节点**：\`Read\` 目标 NNG / 缓存文件，读取完整 JSON 内容
4. **指针跳转**：沿引用字段跳转定位关联对象
   - NNG：\`关联记忆\`（拿 记忆路径 → Read 记忆文件）/ \`上级NNG\` / \`下级NNG\`（拿路径 → Read NNG）
   - 缓存：\`关联记忆\`（已是精简内容快照，含 记忆路径 → 需要元数据时 Read 记忆原文）/ \`上级缓存\` / \`下级缓存\`
   - 记忆：\`关联NNG\`（拿路径 → Read NNG）

**归档路径过滤**：引用字段中可能含指向 \`archive/\` 下旧 NNG 的历史路径（归档=不删除，保留历史）。做常规导航判断时（定位当前记忆归属、找比较对象），**路径中含 \`archive/\` 段的条目默认跳过**，只在明确需要查历史版本时才 Read 归档 NNG。`
      }
    },
    {
      id: 'end_node',
      type: 'end',
      name: '完成',
      config: {
        output: 'NNG 处理完成：{{context.agent_result}}'
      }
    }
  ],
  edges: [
    { from: 'agent', to: 'end_node' }
  ]
}

/**
 * 记忆主调度器审查工作流（用户设计）：子 AGENT 全部完成后，主调度审查。
 * 检查记忆与 NNG 格式疏漏 → 直接修复 → 输出审查结果。
 */
export const MEMORY_REVIEW_TEMPLATE: WorkflowTemplate = {
  id: 'wf_default_memory_review',
  name: '记忆质量审查',
  description: '审查主调度器生成的记忆 + 子 AGENT 的 NNG 处理，修复格式疏漏',
  tags: ['记忆', '质检', '默认'],
  mode: 'workflow',
  source: 'default',
  createdAt: now,
  updatedAt: now,
  startNode: 'review',
  nodes: [
    {
      id: 'review',
      type: 'llm',
      name: '审查与修复',
      config: {
        stream: false,
        tools: ['read_md', 'Read', 'Glob', 'nng_graph', 'Edit', 'create_memory', 'create_nng', 'MoveFile', 'DeleteFile'],
        outputVars: ['通过', '修复项', '遗留问题'],
        prompt: `{{context.input.workflow_prompts}}

# 角色
你是 ABYSSAC 记忆系统的质量审查 agent。

# 任务
审查本批次全部产物（主调度器生成的记忆 + 各子 AGENT 的 NNG 处理），检查结构疏漏并修复。

# 输入
- 任务清单（主调度器输出）：{{context.input.task_list}}
- 子 AGENT 处理结果：{{context.input.agent_results}}
- RAW 路径：{{context.input.raw_path}}

# 检查标准（只查结构健康，不查价值——价值判断是主调度器的事）

## 记忆格式（逐条 Read 记忆文件）
- type 合法（normal/meta/high）
- normal：用户原话（≤500 字应为原文，>500 字可为精炼）与 AI回复（精炼结论 ≤800 字）非空
- **AI身份**：normal 记忆应有 AI身份 字段（工具自动从 RAW 路径作用域解析 AI 编号 → 名字）；缺失 → 检查修正
- **用户字段**：normal 记忆应有 用户（UID+用户名，工具自动从 RAW 路径作用域解析）；缺失 → 检查修正
- high/meta：精炼内容 非空；备注 注明场景 + 涉及的 NNG 路径（high=张力冲突双方，meta=桥接源/目标，追溯来源）
- RAW来源 非空且指向存在的 RAW 文件（可溯源）
- 描述 符合命名范式 {序号}_{域词}_{主题词}_{状态词}：无流水账长句、无非法字符（只允许汉字/字母/数字/下划线）
- 备注 非空（生成场景/原因）
- 时间戳 与对话时间一致（记忆归到对话发生日期）
- **序号对齐 RAW**：记忆文件名序号应等于其 RAW来源 的 RAW 序号（RAW#3 → 3_xxx.json）。发现序号与 RAW 不对齐（如 RAW#3 的记忆却是 5_xxx）说明生成异常，检查修正。

## NNG 结构（nng_graph + Read 检查）
- 每条记忆都有归属（关联NNG 由监控器同步，检查记忆是否已归位到语义相关节点）
- 无孤儿记忆（建了记忆没归位）
- NNG 命名合规（{层级前缀}{主题}_nng）、**描述必填且覆盖当前关联记忆范围**（描述留空 = 节点不存在）
- **描述 ≤200 字（硬上限）**：任何 NNG 的 描述 不得超过 200 字。发现超长描述 → 拆分：新建子 NNG 承接部分关联记忆 + 精简原描述（拆子节点分层收纳，不堆描述）
- 类型对应：normal 记忆→普通 NNG、meta 记忆→meta NNG、high 记忆→high NNG（不能混）
- **结构克制**：无碎片化（同主题多个节点）、无一级膨胀（零散单条不该建一级——发现"杂碎一级"（描述太具体/只装一条记忆的一级）→ 归并到抽象父级或聚合 meta）
- **high 层级合规**：high NNG 不在 NNG 一级节点目录（NNG/AI{ai编号}/U{用户UID}/root/）一级（没上级的 high = 伪 high）；high/meta NNG 有对应记忆、下级NNG 已填（跨文件夹必须手动填）
- 归档分流正确：归档 NNG（archive/ 内）只装被归档的记忆，保留 NNG 装其余记忆（不混装）；归档 NNG 有 归档记录 字段
- 聚合 meta（收纳零散）的节点：描述注明覆盖范围，后续同类可继续归入

# 修复
- 有疏漏 → 用工具直接修复：Edit 补描述/备注/下级NNG、MoveFile 调整位置、DeleteFile 删除孤儿、create_nng 补建节点
- 无法修复的 → 在结果里标注遗留问题

# 输出格式
完成后必须输出 <json> 块：
<json>
{"通过": true, "修复项": ["..."], "遗留问题": []}
</json>
- 通过=false 时列出遗留问题（供调度器记录）；已修复的不算遗留`
      }
    },
    {
      id: 'end_node',
      type: 'end',
      name: '完成',
      config: {
        output: '审查完成：{{context.review_result}}'
      }
    }
  ],
  edges: [
    { from: 'review', to: 'end_node' }
  ]
}

/**
 * 日记撰写工作流：后端自主日记调度器使用。
 * 单 LLM 节点：读当天 RAW 全文 → 提炼 → 写 diary.md → 更新当月索引表。
 * 替代原 AI 侧 cron diary-daily-write + server.ts 启动补写检查。
 */
export const DIARY_WRITER_TEMPLATE: WorkflowTemplate = {
  id: 'wf_default_diary_writer',
  name: '日记撰写',
  description: '读当天 RAW 对话原文 → 提炼日记 → 写 diary.md → 更新当月索引表',
  tags: ['日记', '默认'],
  mode: 'workflow',
  source: 'default',
  createdAt: now,
  updatedAt: now,
  startNode: 'writer',
  nodes: [
    {
      id: 'writer',
      type: 'llm',
      name: '撰写日记',
      config: {
        stream: false,
        tools: ['Write', 'Read', 'Edit', 'LS'],
        outputVars: ['date', 'diary_path', 'summary', 'skipped'],
        prompt: `{{context.input.workflow_prompts}}

# 角色
你是 ABYSSAC 日记系统的日记撰写 agent。

# 任务
读一天的全部对话原文（RAW），提炼成一篇日记，写入 diary.md，并把该日记登记进当月索引表。

# 输入（已由调度器注入本条消息，直接使用注入内容即可，无需 Read）
- 日期：{{context.input.date}}
- RAW 目录：{{context.input.raw_dir}}
- RAW 全文（含多个对话对，每个含 时间戳/用户原话/AI回复/引用文件）：
{{context.input.raw_contents}}
- diary.md 写入路径：{{context.input.diary_path}}
- 当月索引表路径（按年月目录分层：diary/{年}/{月}/index.json）：{{context.input.index_path}}

# 执行步骤

## 步骤 1：阅读 RAW，判断是否值得写日记
- 当天完全没有对话内容（RAW 为空或只有系统标记）→ 输出 {"skipped": true, "reason": "当天无对话"} 结束
- 有对话但全是寒暄/无实质内容 → 可写一行"无事"或跳过（输出 skipped: true）
- 有实质对话 → 继续步骤 2

## 步骤 2：撰写 diary.md
用 Write 工具写入 {{context.input.diary_path}}，格式：
\`\`\`markdown
# {{context.input.date}} 日记

## 这天
一句话概括这天的主线。

## 对话
和用户聊了什么（主题级，不逐句）

## 值得记的
- 决定/事件/用户的话（每条一两句）

## 来源
raw_memory/{{context.input.date}}/1.md 等
\`\`\`
要求：摘要不是全量照抄——只记值得记的（决定、事件、关键结论）。细节以 RAW 为准。

## 步骤 3：登记当月索引表
先 Read {{context.input.index_path}} 查看当月表现状（文件不存在则视为空表）：
- 若 entries 中已有该日期条目 → 只更新其 summary（覆盖写入，不重复插入）
- 否则在 entries 数组**头部**插入新条目：{"date": "{{context.input.date}}", "file": "raw_memory/YYYY/MM/DD/diary.md", "summary": "一句话摘要"}
- 同步更新 meta.updatedAt 为当前时间
用 Write 写回 {{context.input.index_path}}，结构：
<json>
{"meta": {"updatedAt": "当前时间"}, "entries": [{"date": "...", "file": "...", "summary": "..."}]}
</json>
归档按年份月份自动分类：每个自然月一张表，存于 diary/{年}/{月}/index.json——分层方式与记忆系统 raw_memory/年/月/日 一致，年份再多也不堆积在同一个目录。

# 注意
- 日记不进记忆库，不注入每轮上下文
- 日记是摘要不是全量——细节永远以 RAW 为准
- 如果 diary.md 已存在（补写场景），覆盖写入
- AI 后续回忆某天时，先读对应月份的索引表（diary/{年}/{月}/index.json）定位日期、再读 file 字段指向的 diary.md

# 输出格式
完成后必须输出 <json> 块：
<json>
{"date": "{{context.input.date}}", "diary_path": "{{context.input.diary_path}}", "summary": "一句话日记摘要", "skipped": false}
</json>
跳过时：
<json>
{"date": "{{context.input.date}}", "skipped": true, "reason": "当天无实质对话"}
</json>`
      }
    },
    {
      id: 'end_node',
      type: 'end',
      name: '完成',
      config: {
        output: '日记撰写完成：{{context.writer_result}}'
      }
    }
  ],
  edges: [
    { from: 'writer', to: 'end_node' }
  ]
}

/** 多媒体素材生成工作流（Workflow 模式）：LLM 节点挂生成工具，直接干活。
 * 说明：llm 节点 tools 声明生成工具（未配置/未启用的工具会被工具池自动跳过，不报错），
 * AI 按需求自行组合调用：image_gen / video_gen / audio_gen / create_document。
 * 产物统一存 generated/U{uid}/AI{aiId}/{分类}/{年}/{月}/{日}/，并在回复中给出路径。
 */
export const ASSET_CREATOR_TEMPLATE: WorkflowTemplate = {
  id: 'wf_default_asset_creator',
  name: '多媒体素材生成',
  description: '理解需求 → AI 按需调用 image_gen / video_gen / audio_gen / create_document 直接生成图片/视频/音频/文稿，产物按分类+日期自动归档到 generated/',
  tags: ['生成', '素材', '多模态', '默认'],
  mode: 'workflow',
  source: 'default',
  createdAt: now,
  updatedAt: now,
  nodes: [
    {
      id: 'creator',
      type: 'llm',
      name: '生成素材',
      config: {
        prompt:
          '你是多媒体创作执行者。根据需求调用可用的生成工具直接产出素材：\n' +
          '- image_gen：生成配图（需 imageGen 配置）\n' +
          '- video_gen：生成视频（需 generation.video 配置）\n' +
          '- audio_gen：生成音频/音乐（需 generation.audio 配置）\n' +
          '- create_document：把文稿/方案归档为 md/txt（无需配置，随时可用）\n\n' +
          '要求：\n' +
          '1. 先判断需求需要哪几类素材，逐一调用对应工具（工具调用失败时说明缺什么配置，改用 create_document 归档文字方案）\n' +
          '2. 每次 prompt 要具体（主体/风格/构图/时长等），一次一个工具调用\n' +
          '3. 全部完成后汇总：每个产物的分类、保存路径、file:// URL\n\n' +
          '需求：{{context.input}}',
        stream: false,
        tools: ['image_gen', 'video_gen', 'audio_gen', 'create_document']
      }
    },
    {
      id: 'end_node',
      type: 'end',
      name: '完成',
      config: {
        output: '{{context.creator}}'
      }
    }
  ],
  edges: [
    { from: 'creator', to: 'end_node' }
  ]
}

/** 所有默认模板列表 */
export const DEFAULT_TEMPLATES: WorkflowTemplate[] = [
  CODE_REVIEW_TEMPLATE,
  RESEARCH_ASSISTANT_TEMPLATE,
  BATCH_FILE_PROCESSOR_TEMPLATE,
  MEMORY_DISPATCHER_TEMPLATE,
  MEMORY_AGENT_TEMPLATE,
  MEMORY_REVIEW_TEMPLATE,
  DIARY_WRITER_TEMPLATE,
  ASSET_CREATOR_TEMPLATE
]
