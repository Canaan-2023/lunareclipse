/**
 * 系统构造清单生成器（system-catalog）

 * 每次系统启动自动执行：扫描内置模块（electron/main 一级目录 + 顶层文件 + src 渲染进程）
 * 入口文件头部的 @category / @summary 注释，以及插件（bundled 内置 + 用户级 + 领域级）
 * 的 plugin.json，按类别聚合成纯 Markdown 文档，覆盖写入 {dataRoot}/system-catalog/。

 * 纯 MD 方便 AI 直接 Read 查看系统构造；文件全部由代码生成、每次启动覆盖替换，勿手改。
 * 新增模块：在模块入口文件头部注释写 @category（类别，先看现有类别与该类数量，决定
 * 加入已有类还是新开类目）与 @summary（一句话说明模块做什么），下次启动自动进清单。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'fs'
import { join, basename, relative } from 'path'

/** 内置模块条目 */
export interface CatalogModule {
  name: string
  category: string
  summary: string
  /** 相对 app 根的路径（正斜杠） */
  path: string
  hasSummary: boolean
}

/** 插件条目 */
export interface CatalogPlugin {
  name: string
  description: string
  /** 插件目录绝对路径（正斜杠） */
  dir: string
  source: 'bundled' | 'user' | 'domain'
}

/** 类别展示顺序（未列出的类别按字典序排后） */
const CATEGORY_ORDER = ['核心', '工具', '记忆', '监控', '渲染', '插件']

/** 类内模块数超过该值提示拆分新类目 */
const MODULES_PER_CATEGORY_WARN = 12
/** 单个插件文档最大插件数，超过自动拆分为 插件-1.md / 插件-2.md */
const PLUGINS_PER_DOC = 10

/** 只读取文件头部这段长度内找标注（模块入口注释应在文件最前） */
const HEAD_SCAN_CHARS = 800

const SCAN_TAG = /@(category|summary)\s+([^\r\n]+)/g

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_')
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

function moduleNameFromDir(dir: string): string {
  return basename(dir)
}

/** 目录模块代表文件：目录内递归查找第一个带 @category 注释的 .ts；无则 index.ts，再无则第一个 .ts */
function pickEntryFile(dir: string): string | null {
  const candidates: string[] = []
  const walk = (d: string) => {
    let entries: import('fs').Dirent[]
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      if (e.isDirectory()) walk(join(d, e.name))
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !e.name.endsWith('.test.ts')) candidates.push(join(d, e.name))
    }
  }
  walk(dir)
  const withTag = candidates.find((p) => /@category/.test(readFileSync(p, 'utf-8').slice(0, HEAD_SCAN_CHARS)))
  if (withTag) return withTag
  return candidates.find((p) => basename(p) === 'index.ts') ?? candidates[0] ?? null
}

function parseTags(filePath: string): { category: string; summary: string } {
  try {
    const head = readFileSync(filePath, 'utf-8').slice(0, HEAD_SCAN_CHARS)
    const found: Record<string, string> = {}
    for (const m of head.matchAll(SCAN_TAG)) found[m[1]] = m[2].trim()
    return { category: found.category ?? '', summary: found.summary ?? '' }
  } catch {
    return { category: '', summary: '' }
  }
}

/** 扫描内置模块：electron/main 一级目录 + 顶层 .ts + src 渲染进程 */
export function scanBuiltinModules(appPath: string): CatalogModule[] {
  const modules: CatalogModule[] = []
  const mainDir = join(appPath, 'electron', 'main')

  // 顶层文件（主进程入口 / 窗口 / 面板窗）
  if (existsSync(mainDir)) {
    const topFiles = readdirSync(mainDir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .sort()
    for (const f of topFiles) {
      const abs = join(mainDir, f)
      if (!statIsFile(abs)) continue
      const tags = parseTags(abs)
      const name = f === 'index.ts' ? 'main' : f.slice(0, -3)
      modules.push({
        name,
        category: tags.category || '未分类',
        summary: tags.summary,
        path: toPosix(join('electron', 'main', f)),
        hasSummary: Boolean(tags.category && tags.summary)
      })
    }

    // 一级目录（vendor 为第三方依赖目录，不视为模块）
    const dirs = readdirSync(mainDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'vendor')
      .map((e) => e.name)
      .sort()
    for (const d of dirs) {
      const dir = join(mainDir, d)
      const entry = pickEntryFile(dir)
      const tags = entry ? parseTags(entry) : { category: '', summary: '' }
      modules.push({
        name: moduleNameFromDir(dir),
        category: tags.category || '未分类',
        summary: tags.summary,
        path: entry ? toPosix(join('electron', 'main', relative(mainDir, entry))) : toPosix(join('electron', 'main', d)),
        hasSummary: Boolean(entry && tags.category && tags.summary)
      })
    }
  }

  // 渲染进程（src 整体一个模块）
  const srcDir = join(appPath, 'src')
  if (existsSync(srcDir)) {
    const entry = join(srcDir, 'main.tsx')
    const abs = existsSync(entry) ? entry : join(srcDir, 'App.tsx')
    if (existsSync(abs)) {
      const tags = parseTags(abs)
      modules.push({
        name: 'src',
        category: tags.category || '未分类',
        summary: tags.summary,
        path: toPosix(join('src', basename(abs))),
        hasSummary: Boolean(tags.category && tags.summary)
      })
    }
  }
  return modules
}

/** 读取某插件根下的全部插件（每个子目录一个插件） */
function scanPluginRoot(root: string, source: CatalogPlugin['source']): CatalogPlugin[] {
  const out: CatalogPlugin[] = []
  if (!existsSync(root)) return out
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const dir = join(root, d.name)
    const manifest = join(dir, 'plugin.json')
    if (!existsSync(manifest)) continue
    let name = d.name
    let description = ''
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf-8'))
      if (typeof parsed?.name === 'string' && parsed.name) name = parsed.name
      if (typeof parsed?.description === 'string') description = parsed.description
    } catch {
      // plugin.json 损坏：仍以目录名收录，描述留空
    }
    out.push({ name, description, dir: toPosix(dir), source })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 解析可扫描源码根的 app 根目录。
 * dev：app.getAppPath() = app 目录（electron/main 源码存在）；不可靠时回退 __dirname 上两级。
 * 打包：源码不在包内（electron-builder files 仅 out/**），返回探测不到源码的根，由
 * regenerateSystemCatalog 依 hasSource 降级。
 */
export function resolveCatalogSourceRoot(appPath: string): string {
  if (existsSync(join(appPath, 'electron', 'main', 'index.ts'))) return appPath
  const fallback = join(__dirname, '..', '..')
  return existsSync(join(fallback, 'electron', 'main', 'index.ts')) ? fallback : appPath
}

/** 扫描插件：bundled 内置（源码根 + 打包 resources 双路径探测）+ 用户级 + 领域级 */
export function scanPlugins(appPath: string, dataRoot: string): CatalogPlugin[] {
  const bundledRoots: string[] = []
  const inSource = join(appPath, 'electron', 'main', 'plugins', 'bundled')
  if (existsSync(inSource)) bundledRoots.push(inSource)
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  if (resourcesPath) {
    const inResources = join(resourcesPath, 'plugins', 'bundled')
    if (existsSync(inResources)) bundledRoots.push(inResources)
  }
  const out: CatalogPlugin[] = []
  for (const root of bundledRoots) out.push(...scanPluginRoot(root, 'bundled'))
  return out.concat(scanPluginRoot(join(dataRoot, 'plugins'), 'user'), scanPluginRoot(join(dataRoot, 'plugins_domains'), 'domain'))
}

function renderModuleLine(m: CatalogModule): string {
  const summary = m.hasSummary ? m.summary : '（未写摘要，请在入口文件头补充 @category / @summary）'
  return `- **${m.name}** — \`${m.path}\`：${summary}`
}

function renderPluginLine(p: CatalogPlugin): string {
  const desc = p.description || '（无描述）'
  return `- **${p.name}** — \`${p.dir}\`（${p.source}）：${desc}`
}

function groupByCategory(modules: CatalogModule[]): [string, CatalogModule[]][] {
  const map = new Map<string, CatalogModule[]>()
  for (const m of modules) {
    const list = map.get(m.category) ?? []
    list.push(m)
    map.set(m.category, list)
  }
  const keys = Array.from(map.keys()).sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a)
    const ib = CATEGORY_ORDER.indexOf(b)
    if (ia === -1 && ib === -1) return a.localeCompare(b)
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  })
  return keys.map((k) => [k, map.get(k)!.sort((a, b) => a.name.localeCompare(b.name))])
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

function buildIndexDoc(
  groups: [string, CatalogModule[]][],
  modules: CatalogModule[],
  pluginFiles: string[],
  pluginCount: number,
  time: string,
  hasSource: boolean
): string {
  const rows = groups
    .map(
      ([cat, list]) =>
        `| ${cat} | ${list.length} | [${cat}.md](./${safeFileName(cat)}.md) |`
    )
    .join('\n')
  const pluginLinks = pluginFiles.map((f) => `[${f}](./${f})`).join('、')
  const moduleNote = hasSource
    ? ''
    : '\n> 当前为打包运行环境，无 electron/main 源码可扫描，模块清单不可用；插件清单照常生成。源码环境下启动可恢复。\n'
  return `# 月蚀系统构造清单

> 本目录由系统启动时自动扫描生成、直接覆盖替换，请勿手改。
> 生成时间：${time}
${moduleNote}
## 模块（共 ${modules.length} 个 / ${groups.length} 类）

| 类别 | 模块数 | 清单文档 |
| --- | --- | --- |
${rows}

## 插件（共 ${pluginCount} 个）

${pluginFiles.length > 0 ? pluginLinks : '（无）'}

## 如何新增模块

1. 新建模块代码（目录或文件），在模块入口文件头部注释中声明类别与摘要：

   \`\`\`
   /**
    * @category 你的类别（先看上方现有类别与各类模块数，决定加入已有类还是新开类目）
    * @summary 一句话说明这个模块做什么
    */
   \`\`\`

2. 插件无需额外标注：在插件目录 plugin.json 写好 name / description 即可，插件系统本身归入「插件」类。
3. 下次系统启动自动重新生成本目录，无需手动登记；类内模块过多时应考虑拆出新类目（见各类文档）。
`
}

function buildCategoryDoc(cat: string, list: CatalogModule[], time: string): string {
  return `# ${cat}（${list.length} 个模块）

> 本文档由系统启动时自动扫描生成、直接覆盖替换，请勿手改。生成时间：${time}

${list.map(renderModuleLine).join('\n')}
`
}

function buildPluginDoc(title: string, list: CatalogPlugin[], time: string): string {
  return `# ${title}（${list.length} 个插件）

> 本文档由系统启动时自动扫描生成、直接覆盖替换，请勿手改。生成时间：${time}
>
> 「插件」为模块类别文档（描述插件系统自身代码）；本卷为已安装插件清单。

${list.map(renderPluginLine).join('\n')}
`
}

function statIsFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * 扫描并生成系统构造清单（每次启动调用）。
 * 覆盖写入 {dataRoot}/system-catalog/，返回生成的文件清单。
 */
export function regenerateSystemCatalog(appPath: string, dataRoot: string): string[] {
  // 打包运行环境（无 electron/main 源码可扫描）降级：模块清单不可用，插件清单照常生成
  const hasSource = existsSync(join(appPath, 'electron', 'main', 'index.ts'))
  const modules = hasSource ? scanBuiltinModules(appPath) : []
  const plugins = scanPlugins(appPath, dataRoot)
  const outDir = join(dataRoot, 'system-catalog')
  mkdirSync(outDir, { recursive: true })

  // 覆盖替换：清掉目录内旧 .md 再全量重写，不留已消失类别/插件的残留文件
  for (const f of readdirSync(outDir)) {
    if (f.endsWith('.md')) {
      try {
        unlinkSync(join(outDir, f))
      } catch {
        // 文件被占用等场景：跳过删除，后续写入同名文件自然覆盖
      }
    }
  }

  const time = new Date().toLocaleString('zh-CN', { hour12: false })
  const written: string[] = []

  const groups = groupByCategory(modules)
  for (const [cat, list] of groups) {
    if (list.length > MODULES_PER_CATEGORY_WARN) {
      console.warn(`[system-catalog] 类别「${cat}」已 ${list.length} 个模块，建议拆分为新类目（改 @category 声明）`)
    }
    const file = `${safeFileName(cat)}.md`
    writeFileSync(join(outDir, file), buildCategoryDoc(cat, list, time), 'utf-8')
    written.push(file)
  }

  // 插件清单文档：插件系统本身是一类（模块分类的「插件」类），各插件实例统一归入插件清单，
  // 数量过多自动拆分为 插件清单-1 / 插件清单-2
  const pluginFiles: string[] = []
  const pluginChunks = chunk(plugins, PLUGINS_PER_DOC)
  if (pluginChunks.length === 0) {
    writeFileSync(join(outDir, '插件清单.md'), buildPluginDoc('插件清单', [], time), 'utf-8')
    pluginFiles.push('插件清单.md')
  } else {
    pluginChunks.forEach((list, i) => {
      const file = pluginChunks.length === 1 ? '插件清单.md' : `插件清单-${i + 1}.md`
      writeFileSync(join(outDir, file), buildPluginDoc('插件清单' + (pluginChunks.length === 1 ? '' : ` ${i + 1}`), list, time), 'utf-8')
      pluginFiles.push(file)
    })
  }
  written.push(...pluginFiles)

  writeFileSync(join(outDir, 'index.md'), buildIndexDoc(groups, modules, pluginFiles, plugins.length, time, hasSource), 'utf-8')
  written.push('index.md')

  // 隐私：不输出输出目录的绝对路径，仅保留统计数字
  console.log(`[system-catalog] 已生成 ${modules.length} 个模块 / ${groups.length} 类 / ${plugins.length} 个插件`)
  return written
}