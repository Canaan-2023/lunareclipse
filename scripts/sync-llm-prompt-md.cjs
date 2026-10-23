/**
 * 从 default-templates.ts（真源）同步四份外置 MD + .src 指纹。
 * 用法：node scripts/sync-llm-prompt-md.cjs （在 app/ 下运行）
 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tsPath = 'electron/main/workflow/default-templates.ts'
// bundle 化（ADR-08 前置硬条件）：default-templates.ts 现为聚合 barrel（import ./templates/*）。
// 单文件 transformSync 的产物里 require('./templates/x') 从 tmpdir 解析会 MODULE_NOT_FOUND；
// buildSync 打包整张依赖图，产物为自包含 CJS。
const out = esbuild.buildSync({
  entryPoints: [tsPath],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  write: false,
  logLevel: 'silent'
})
const tmpMod = path.join(os.tmpdir(), `wf-sync-prompts-${process.pid}.cjs`)
fs.writeFileSync(tmpMod, out.outputFiles[0].text, 'utf-8')
let DEFAULT_TEMPLATES
try {
  ;({ DEFAULT_TEMPLATES } = require(tmpMod))
} finally {
  try { fs.unlinkSync(tmpMod) } catch { /* tmpdir 清理失败可容忍 */ }
}

const promptsRoot = 'data/abyssac_data/workflows/prompts'
let n = 0
for (const t of DEFAULT_TEMPLATES) {
  if (t.source !== 'default') continue
  for (const node of t.nodes) {
    if (node.type !== 'llm' || typeof node.config?.prompt !== 'string') continue
    const mdPath = path.join(promptsRoot, t.id, `${node.id}.md`)
    fs.mkdirSync(path.dirname(mdPath), { recursive: true })
    fs.writeFileSync(mdPath, node.config.prompt, 'utf-8')
    fs.writeFileSync(`${mdPath}.src`, node.config.prompt, 'utf-8')
    console.log(`[sync] ${t.id}/${node.id}.md (+.src) ${node.config.prompt.length}B`)
    n++
  }
}
console.log(`synced ${n} llm prompts`)