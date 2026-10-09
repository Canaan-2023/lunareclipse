/**
 * @category 工具
 * @summary 提示词加载器：目录扫描注入与 segment 声明式组装
 * @note 为什么存在：系统提示词需要"出厂默认 + 用户按 AI 个性化覆盖"的能力且目录结构
 * 可审计；本模块把目录扫描/合并/组装收敛为唯一入口（前端 AI 与 DMN 共用）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { basename, join } from 'path'

/**
 * 提示词加载器（前端 AI 与 DMN 共用）

 * 内置模板唯一权威目录：prompts/（dev 直接读源码目录；打包经 extraResources 进 resources/prompts，
 * asar 外只读——为什么只读：打包后 prompts/ 只随安装包发布，改它需要重打包，故它只承担"出厂默认"）。
 * 
 * 运行时注入的优先级（ 文件粒度副本体系，不再是二选一"整包替换"）：
 * ai-prompts/AI{aiId}/{frontend,shared}/ 副本目录与内置 prompts/{frontend,shared}/ 目录同构，
 * 按文件粒度合并：同名文件 = 副本替换内置；副本独有文件 = 追加；无副本文件 = 用内置。
 * - 有副本 → 副本覆盖内置对应文件（用户按 AI 个性化，只改想改的那份）；
 * - 无副本 → 回退内置模板（默认/还原语义：删副本即还原出厂）。
 * 副本目录不存在/为空 → 整层回退内置（与旧 system.md 语义等价）。

 * prompts/
 * ├── shared/ 前端 AI 通用层：仅前端 AI 会话注入（会话机制/工具机制说明）
 * │   ├── 1-工具调用机制.md 文件名前缀自然数排序
 * │   └── 2-工具行为手册.md 未来新增文件直接扔进来就自动注入
 * ├── frontend/ 前端 AI 专属（系统能力/记忆检索）
 * │   └── 1-系统能力.md
 * ├── workflow/ DMN 工作流共享层：仅工作流节点注入（后台工具机制，不含前端能力）
 * │   └── 1-工作流执行机制.md 记忆/日记调度器注入 shared 位置的提示词
 * └── character/ 对话模式角色定义（运行时复制到 abyssac_data/frontend/character/ 供用户编辑）

 * 注入规则（文件夹扫描 + 文件粒度合并）：
 * 前端 AI = shared/* + frontend/*（每层各自合并内置与副本，见 mergePromptDir）
 * DMN 工作流节点 = workflow/*（loadWorkflowSharedPrompts，无副本体系，与前端完全分离）
 * 按需块 = frontend/topics/* + shared/topics/*（不常驻，任务开扫清单披露，read_md 读全文）

 * 前端 AI 与 DMN 提示词完全分离：
 * shared/ 描述前端会话能力（会话锚点/session_search/联网/浏览器等），DMN 节点工具面没有这些；
 * workflow/ 只描述后台工作流机制（文件操作/JSON 输出/记忆域结构），保证工作流节点不接触前端内容。
 */

/** 提示词文件扩展名白名单（character 目录混了 .json 数据文件，需过滤） */
const PROMPT_EXTS = ['.md', '.txt']

/**
 * 自然数排序比较器。
 * `1_xxx.md` < `2_yyy.md` < `10_zzz.md`（而非字母序 `1` < `10` < `2`）。
 */
function naturalCompare(a: string, b: string): number {
  const ax = a.split(/(\d+)/)
  const bx = b.split(/(\d+)/)
  for (let i = 0; i < Math.min(ax.length, bx.length); i++) {
    if (ax[i] !== bx[i]) {
      const an = parseInt(ax[i], 10)
      const bn = parseInt(bx[i], 10)
      if (!isNaN(an) && !isNaN(bn)) return an - bn
      return ax[i].localeCompare(bx[i])
    }
  }
  return ax.length - bx.length
}

/**
 * 探测 prompts/ 目录路径。
 * dev: __dirname = out/main → ../../electron/main/prompts
 * packaged: process.resourcesPath/prompts（extraResources 复制位置，asar 外）
 */
export function getPromptsDir(): string {
  const candidates = [
    join(__dirname, '..', '..', 'electron', 'main', 'prompts'),
    join(__dirname, 'prompts'),
    join(process.cwd(), 'electron', 'main', 'prompts')
  ]
  // 打包环境：prompts 经 extraResources 复制到 resources/prompts（asar 内无此目录）
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'prompts'))
  }
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  throw new Error('Prompts directory not found in candidates: ' + candidates.join(', '))
}

/**
 * 扫描目录下的提示词文件名（.md/.txt，跳过隐藏文件），按自然数排序。
 * @param dir 目录路径（不存在返回空数组）
 */
function listPromptFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => {
      if (f.startsWith('.')) return false
      if (!PROMPT_EXTS.some((ext) => f.endsWith(ext))) return false
      return statSync(join(dir, f)).isFile()
    })
    .sort(naturalCompare)
}

/**
 * 扫描目录下所有提示词文件（.md/.txt），按自然数排序读取并拼接。
 * 不锁文件名——把文件扔进目录就自动注入。

 * @param dir 目录路径
 * @param label 日志标签
 */
function loadDirAsPrompt(dir: string, label: string): string {
  if (!existsSync(dir)) throw new Error('Prompts dir not found: ' + dir)
  const files = listPromptFiles(dir)
  if (files.length === 0) {
    console.warn(`[prompts] ${label}目录为空: ${basename(dir)}`)
    return ''
  }
  const parts: string[] = []
  for (const f of files) {
    const content = readFileSync(join(dir, f), 'utf-8')
    if (content.trim()) {
      parts.push(content)
    }
  }
  return parts.join('\n\n---\n\n')
}

/** 提示词层：文件粒度清单 + 拼接文本（ 副本体系：内置为基底，副本同名替换/独有追加） */
export interface PromptLayerResult {
  /** 按文件名自然序拼接后的整段文本（\n\n---\n\n 分隔） */
  text: string
  /** 参与拼接的文件清单（含来源标记），供 UI 展示与逐文件编辑 */
  files: Array<{
    /** 文件名（如 1-系统能力.md） */
    name: string
    /** builtin=内置模板 / override=AI 副本（含同名替换与独有新增） */
    source: 'builtin' | 'override'
  }>
}

/** 虚拟内置文件（ 莉莉丝人设派生用：基底不落盘，由 lilith.json 运行时生成） */
export interface VirtualBuiltinFile {
  /** 文件名（如 lilith-persona.md，副本可用同名文件替换） */
  name: string
  /** 文件内容（派生文本） */
  content: string
}

/**
 * 按文件粒度合并「内置基底 + AI 副本目录」（ 核心语义的泛化版）：
 * - 内置基底 = 文件列表（可来自真实目录或运行时派生，见 mergePromptDir / mergeLilithPromptDir）；
 * - 副本目录同名文件 → 替换内置文件内容（source 标记为 override）；
 * - 副本独有文件 → 追加进清单（source 标记为 override）；
 * - 全部按文件名自然序拼接（\n\n---\n\n），与 loadDirAsPrompt 同构。

 * @param builtinFiles 内置基底文件（name 唯一，后写的覆盖先写的）
 * @param overrideDir AI 副本目录（不存在或为空 = 纯内置，仍返回基底拼接）
 * @param label 日志标签
 */
export function mergePromptFiles(
  builtinFiles: VirtualBuiltinFile[],
  overrideDir: string | null | undefined,
  label: string
): PromptLayerResult {
  const overrides = overrideDir ?? ''
  const overrideNames = listPromptFiles(overrides)
  const contentOf = new Map<string, string>()
  for (const f of builtinFiles) {
    contentOf.set(f.name, f.content)
  }
  for (const n of overrideNames) {
    contentOf.set(n, readFileSync(join(overrides, n), 'utf-8'))
  }
  if (contentOf.size === 0) {
    console.warn(`[prompts] ${label}内置基底与副本目录均为空: ${overrides}`)
    return { text: '', files: [] }
  }
  // 全部按文件名全局自然序：text 与 files 清单顺序严格一致（同名=副本覆盖内置）
  const names = Array.from(contentOf.keys()).sort(naturalCompare)
  const files: PromptLayerResult['files'] = names.map((n) => ({
    name: n,
    source: overrideNames.includes(n) ? 'override' : 'builtin'
  }))
  const parts: string[] = []
  for (const n of names) {
    const content = contentOf.get(n)!
    if (content.trim()) parts.push(content)
  }
  return { text: parts.join('\n\n---\n\n'), files }
}

/**
 * 按文件粒度合并内置目录与 AI 副本目录（ 核心语义，mergePromptFiles 的目录版封装）：
 * - 内置目录 = 基底：全部文件参与拼接；
 * - 副本目录同名文件 → 替换内置文件内容（source 标记为 override）；
 * - 副本独有文件 → 追加进清单（source 标记为 override）；
 * - 全部按文件名自然序拼接（\n\n---\n\n），与 loadDirAsPrompt 同构。

 * @param builtinDir 内置模板目录（必须是存在的官方目录）
 * @param overrideDir AI 副本目录（不存在或为空 = 纯内置，仍返回基底拼接）
 * @param label 日志标签
 */
export function mergePromptDir(builtinDir: string, overrideDir: string | null | undefined, label: string): PromptLayerResult {
  const baseFiles: VirtualBuiltinFile[] = listPromptFiles(builtinDir).map((n) => ({
    name: n,
    content: readFileSync(join(builtinDir, n), 'utf-8')
  }))
  return mergePromptFiles(baseFiles, overrideDir, label)
}

/**
 * 加载 frontend 层：内置 prompts/frontend/* + AI 副本 {aiPromptsRoot}/AI{aiId}/frontend/* 文件粒度合并。
 * 副本目录不存在/为空 → 返回纯内置结果（调用方可据此回退顶层常量）。

 * @param aiPromptsRoot {root}/frontend/ai-prompts（AI 副本根）
 * @param aiId AI id（副本目录 AI{aiId}/frontend）
 * @param dir 内置提示词根目录（默认 getPromptsDir()，测试可传临时目录）
 */
export function loadFrontendPromptForAi(aiPromptsRoot: string, aiId: number, dir?: string): PromptLayerResult {
  const builtinDir = join(dir ?? getPromptsDir(), 'frontend')
  const overrideDir = join(aiPromptsRoot, `AI${aiId}`, 'frontend')
  return mergePromptDir(builtinDir, overrideDir, `前端 AI 提示词(AI${aiId})`)
}

/**
 * 加载 shared 层：内置 prompts/shared/* + AI 副本 {aiPromptsRoot}/AI{aiId}/shared/* 文件粒度合并。
 * 副本目录不存在/为空 → 返回纯内置结果。

 * @param aiPromptsRoot {root}/frontend/ai-prompts（AI 副本根）
 * @param aiId AI id（副本目录 AI{aiId}/shared）
 * @param dir 内置提示词根目录（默认 getPromptsDir()，测试可传临时目录）
 */
export function loadSharedPromptsForAi(aiPromptsRoot: string, aiId: number, dir?: string): PromptLayerResult {
  const builtinDir = join(dir ?? getPromptsDir(), 'shared')
  const overrideDir = join(aiPromptsRoot, `AI${aiId}`, 'shared')
  return mergePromptDir(builtinDir, overrideDir, `通用提示词(AI${aiId})`)
}

/**
 * 加载共享层 shared/：仅前端 AI 会话注入（会话锚点/session_search/联网等前端机制）。
 * DMN 工作流节点不注入这里，走 workflow/ 目录（loadWorkflowSharedPrompts）。

 * @param dir 提示词根目录（默认 getPromptsDir()，测试可传临时目录）
 */
export function loadSharedPrompts(dir?: string): string {
  return loadDirAsPrompt(join(dir ?? getPromptsDir(), 'shared'), '通用提示词')
}

/**
 * 加载 DMN 工作流共享层：workflow/ 下所有文件拼接。
 * 仅后台工作流节点（记忆三节点/日记撰写）使用，内容只描述工作流机制，
 * 不含任何前端会话能力——前端 AI 与 DMN 提示词完全分离。

 * @param dir 提示词根目录（默认 getPromptsDir()，测试可传临时目录）
 */
export function loadWorkflowSharedPrompts(dir?: string): string {
  return loadDirAsPrompt(join(dir ?? getPromptsDir(), 'workflow'), 'DMN 工作流提示词')
}

/**
 * 加载前端 AI 专属提示词：frontend/ 下所有文件拼接。

 * @param dir 提示词根目录（默认 getPromptsDir()，测试可传临时目录）
 */
export function loadFrontendPrompt(dir?: string): string {
  return loadDirAsPrompt(join(dir ?? getPromptsDir(), 'frontend'), '前端 AI 提示词')
}

/**
 * 按需提示词块清单：扫描 frontend/topics 与 shared/topics。

 * 分层设计：frontend|shared 根下的 .md = 常驻（每轮注入，铁律/机制）；
 * topics/ 子目录 = 按需块（分领域提示词，不常驻注入）——任务开始时由
 * buildInjectedMessages 的「任务开扫清单」列出 {名称: 摘要}，AI 判断当前
 * 任务匹配哪个块，用 read_md 读该文件全文。首行 `>` 引用为摘要（触发时机）。

 * @param dir 提示词根目录（默认 getPromptsDir()，测试可传临时目录）
 * @returns [{ name, summary, path }] 按自然数排序；目录不存在返回空数组
 */
export interface TopicPromptEntry {
  /** 文件名（不含扩展名，如 01-执行任务） */
  name: string
  /** 首行摘要（`>` 引用行内容，无则空串） */
  summary: string
  /** 绝对路径（AI 用 read_md 读取全文） */
  path: string
}

export function listTopicPrompts(dir?: string): TopicPromptEntry[] {
  const base = dir ?? getPromptsDir()
  const readTopics = (dir: string): TopicPromptEntry[] => {
    if (!existsSync(dir)) return []
    const files = readdirSync(dir)
      .filter((f) => {
        if (f.startsWith('.')) return false
        if (!PROMPT_EXTS.some((ext) => f.endsWith(ext))) return false
        return statSync(join(dir, f)).isFile()
      })
      .sort(naturalCompare)
    return files.map((f) => {
      const full = join(dir, f)
      let summary = ''
      const firstLine = readFileSync(full, 'utf-8').split(/\r?\n/).find((l) => l.trim().length > 0)
      if (firstLine) summary = firstLine.replace(/^>\s*/, '').replace(/^#+\s*/, '').trim()
      return { name: f.replace(/\.(md|txt)$/i, ''), summary, path: full }
    })
  }
  const out: TopicPromptEntry[] = []
  out.push(...readTopics(join(base, 'frontend', 'topics')))
  out.push(...readTopics(join(base, 'shared', 'topics')))
  return out
}