/**
 * 一次性迁移脚本：L8 工作流模板去 JSON 化 + 防漂移指纹补齐
 *
 * 目标：
 * 1. 磁盘 JSON 模板副本剔除 llm 节点 prompt 正文（仅保留 promptFile 引用）—— MD 为唯一真源
 * 2. 为所有 11 个 llm 节点的外置 MD 建立 .src 指纹（上次同步的内置 prompt 内容）
 * 3. 修复历史漂移：MD 与内置不一致且确认是旧内置残留（非用户编辑）→ 对齐内置
 *
 * 判定原则（与 persister.save() 五分支一致，无 .src 时用旧 JSON 内嵌 prompt 判据）：
 * - MD 缺失 → 生成 MD + .src（无副本兜底内置）
 * - MD == 内置 → 仅刷新 .src
 * - MD == .src（未编辑）且内置更新 → 自动覆盖
 * - MD != .src（用户编辑）→ 保留 + warn
 * - 无 .src（历史数据）：
 *   - MD == 旧 JSON prompt → 旧内置落地 → 对齐内置 + 建 .src
 *   - MD != 旧 JSON prompt → 已人工比对确认的旧内置残留清单 → 对齐内置 + 建 .src
 *   - 其余 → 保留 MD + warn
 *
 * 运行：node scripts/migrate-templates-md-only.mjs
 * 注意：依赖 esbuild 转译 default-templates.ts 提取内置真源，勿在生产环境反复执行。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'
import * as esbuild from 'esbuild'

const require = createRequire(import.meta.url)
const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..') // app/
const templatesDir = process.env.WF_TEMPLATES_DIR || join(appRoot, 'data', 'abyssac_data', 'workflows', 'templates')
const promptsRoot = process.env.WF_PROMPTS_DIR || join(appRoot, 'data', 'abyssac_data', 'workflows', 'prompts')

// ---- 1. 提取内置真源（esbuild 转译 default-templates.ts，写临时文件后 require 加载） ----
const tsPath = join(appRoot, 'electron', 'main', 'workflow', 'default-templates.ts')
const src = readFileSync(tsPath, 'utf-8')
const out = esbuild.transformSync(src, { loader: 'ts', format: 'cjs', platform: 'node' })
// 转译产物是纯 CJS（default-templates.ts 仅有 type-only import），写系统临时文件后以模块方式加载，
// 避免 new Function/eval 动态执行字符串——两者在语义与可审计性上等价，模块加载可被静态扫描识别。
const tmpMod = join(tmpdir(), `wf-default-templates-${process.pid}.cjs`)
writeFileSync(tmpMod, out.code, 'utf-8')
let DEFAULT_TEMPLATES
try {
  ;({ DEFAULT_TEMPLATES } = require(tmpMod))
} finally {
  // 临时转译文件清理：幂等兜底，删除失败仅残留孤儿临时文件（tmpdir 会被系统回收），
  // 不影响迁移主流程，因此显式吞掉删除异常即完成职责，故保留此空 catch 而非报错中断。
  try { unlinkSync(tmpMod) } catch { /* 见上方注释：清理失败可容忍，勿删此空分支 */ }
}
const builtinMap = new Map() // `${templateId}/${nodeId}` -> prompt
for (const t of DEFAULT_TEMPLATES) {
  for (const n of t.nodes) {
    if (n.type === 'llm' && typeof n.config?.prompt === 'string') {
      builtinMap.set(`${t.id}/${n.id}`, n.config.prompt)
    }
  }
}
console.log(`[迁移] 内置真源 llm 节点数: ${builtinMap.size}`)

// 已人工比对确认的旧内置漂移节点（MD 停在旧内置版本，非用户编辑）
const CONFIRMED_STALE = new Set([
  'wf_default_diary_writer/writer', // MD(09-10)=旧描述"更新篇目索引 index.json"，内置已演进为"登记进当月索引表"
  'wf_default_memory_agent/agent' // MD(10-46)=7497字符旧版，内置=7498（LS 用途限制缩进）+ 其他细微演进
])

// ---- 2. 原子写（与 persister.ts atomicWrite 一致） ----
function atomicWrite(filePath, content) {
  const tmp = `${filePath}.tmp`
  writeFileSync(tmp, content, 'utf-8')
  try {
    renameSync(tmp, filePath)
  } catch {
    // 跨设备/被占用时 rename 失败，回退为「删旧 + 再 rename」：
    // 若旧文件本就不存在（首次写入），unlink 抛错也属预期，直接吞掉继续 rename 即可，
    // 故保留空 catch —— 无论旧文件是否存在，最终都要以 renameSync 落盘为准。
    try {
      unlinkSync(filePath)
    } catch { /* 见上方注释：旧文件不存在属预期，勿删此空分支 */ }
    renameSync(tmp, filePath)
  }
}
// ---- 3. 逐模板迁移 ----
const jsonFiles = readdirSync(templatesDir).filter((f) => f.endsWith('.json'))
let aligned = 0, refreshed = 0, generated = 0, preserved = 0, warned = 0
for (const f of jsonFiles) {
  const fp = join(templatesDir, f)
  const template = JSON.parse(readFileSync(fp, 'utf-8'))
  if (template.source !== 'default') {
    console.log(`[迁移] 跳过非 default 模板: ${template.id}`)
    continue
  }
  // 迁移前旧 JSON 内嵌 prompt（历史判定参照）
  const prevPromptOf = new Map()
  for (const n of template.nodes) {
    if (n.type === 'llm' && typeof n.config?.prompt === 'string' && n.config.prompt.length > 0) {
      prevPromptOf.set(n.id, n.config.prompt)
    }
  }

  for (const node of template.nodes) {
    if (node.type !== 'llm') continue
    const key = `${template.id}/${node.id}`
    const builtinPrompt = builtinMap.get(key)
    if (builtinPrompt === undefined) {
      console.warn(`[迁移] 警告: 内置真源缺少节点 ${key}，跳过`)
      warned++
      continue
    }
    // MD 路径：优先沿用 JSON 里记录的 promptFile；缺失则按规范构造
    const rel = `${template.id}/${node.id}.md`
    const mdPath = typeof node.config?.promptFile === 'string' && existsSync(node.config.promptFile)
      ? node.config.promptFile
      : join(promptsRoot, rel)
    const srcPath = `${mdPath}.src`
    mkdirSync(dirname(mdPath), { recursive: true })

    const mdExists = existsSync(mdPath)
    const mdContent = mdExists ? readFileSync(mdPath, 'utf-8') : null
    const srcContent = existsSync(srcPath) ? readFileSync(srcPath, 'utf-8') : null

    if (!mdExists) {
      // 无副本 → 用内置生成 MD + .src（兜底路径）
      atomicWrite(mdPath, builtinPrompt)
      atomicWrite(srcPath, builtinPrompt)
      generated++
      console.log(`[迁移] 生成 MD + 指纹: ${rel}`)
    } else if (mdContent === builtinPrompt) {
      // MD == 内置：未编辑，刷新指纹即可
      if (srcContent !== builtinPrompt) atomicWrite(srcPath, builtinPrompt)
      refreshed++
    } else if (srcContent !== null && srcContent === mdContent) {
      // 有指纹且未编辑、内置已更新 → 自动覆盖（正常防漂移路径）
      atomicWrite(mdPath, builtinPrompt)
      atomicWrite(srcPath, builtinPrompt)
      aligned++
      console.log(`[迁移] 防漂移自动覆盖（MD==指纹，内置更新）: ${rel}`)
    } else if (srcContent !== null && srcContent !== mdContent) {
      // 用户编辑过 → 保留
      preserved++
      console.warn(`[迁移] 保留用户编辑 MD: ${rel}`)
    } else {
      // 无 .src 历史数据：用旧 JSON prompt 判定
      const prevPrompt = prevPromptOf.get(node.id)
      if (prevPrompt !== undefined && mdContent === prevPrompt) {
        atomicWrite(mdPath, builtinPrompt)
        atomicWrite(srcPath, builtinPrompt)
        aligned++
        console.log(`[迁移] 历史旧内置落地对齐内置: ${rel}`)
      } else if (CONFIRMED_STALE.has(key)) {
        // 人工比对确认：MD 是旧内置残留（非用户编辑）→ 对齐内置 + 建指纹
        atomicWrite(mdPath, builtinPrompt)
        atomicWrite(srcPath, builtinPrompt)
        aligned++
        console.log(`[迁移] 已确认旧内置漂移，对齐内置并建指纹: ${rel}`)
      } else {
        preserved++
        warned++
        console.warn(
          `[迁移] 无法判定来源，保留现有 MD（建议人工核对 ${mdPath}，可编辑生效）: ${rel}`
        )
      }
    }
    // 去 JSON 化：剔除 prompt 正文，仅保留 promptFile 引用
    if (node.config && typeof node.config.prompt === 'string') {
      delete node.config.prompt
    }
    node.config.promptFile = mdPath
  }
  atomicWrite(fp, JSON.stringify(template, null, 2))
}

console.log('\n[迁移] 完成汇总：')
console.log(`  生成 MD: ${generated}  刷新指纹: ${refreshed}  对齐内置: ${aligned}  保留用户编辑: ${preserved}  警告数: ${warned}`)