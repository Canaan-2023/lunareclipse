/**
 * 最终全链路一致性校验（T4）：
 * 内置TS prompt == 外置MD == .src指纹；JSON 无 prompt 残留；promptFile 结构合法
 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')

const src = fs.readFileSync('electron/main/workflow/default-templates.ts', 'utf-8')
const out = esbuild.transformSync(src, { loader: 'ts', format: 'cjs', platform: 'node' })
// 转译产物是纯 CJS（default-templates.ts 仅有 type-only import），写系统临时文件后以模块方式加载，
// 避免 new Function/eval 动态执行字符串——模块加载可被静态扫描识别且语义等价。
const tmpMod = path.join(os.tmpdir(), `wf-default-templates-${process.pid}.cjs`)
fs.writeFileSync(tmpMod, out.code, 'utf-8')
let DEFAULT_TEMPLATES
try {
  ;({ DEFAULT_TEMPLATES } = require(tmpMod))
} finally {
  // 临时转译文件清理（与 migrate-templates-md-only.mjs 同策略）：
  // 删除失败只会在 tmpdir 留下孤儿文件，由系统回收，校验结果不受影响，故吞掉异常。
  try { fs.unlinkSync(tmpMod) } catch { /* 见上方注释：清理失败可容忍，勿删此空分支 */ }
}
const builtin = new Map()
for (const t of DEFAULT_TEMPLATES) for (const n of t.nodes) {
  if (n.type === 'llm' && typeof n.config?.prompt === 'string') builtin.set(`${t.id}/${n.id}`, n.config.prompt)
}
const templatesDir = 'data/abyssac_data/workflows/templates'
const promptsRoot = 'data/abyssac_data/workflows/prompts'
const SEP = /[\\/]/
let problems = 0, checked = 0
for (const f of fs.readdirSync(templatesDir).filter(x => x.endsWith('.json'))) {
  const t = JSON.parse(fs.readFileSync(templatesDir + '/' + f, 'utf-8'))
  if (t.source !== 'default') continue
  for (const n of t.nodes) {
    if (n.type !== 'llm') continue
    const key = `${t.id}/${n.id}`
    const cfg = n.config
    if ('prompt' in cfg && typeof cfg.prompt === 'string' && cfg.prompt.length > 0) {
      console.log(`❌ ${key}: JSON 仍含 prompt 正文`); problems++
    }
    const segs = String(cfg.promptFile).split(SEP)
    const okStruct = segs[segs.length - 3] === 'prompts' && segs[segs.length - 2] === t.id && segs[segs.length - 1] === n.id + '.md'
    if (!okStruct) {
      console.log(`❌ ${key}: promptFile 结构不符: ${cfg.promptFile}`); problems++
    } else {
      const md = fs.readFileSync(cfg.promptFile, 'utf-8')
      const bi = builtin.get(key)
      if (md !== bi) { console.log(`❌ ${key}: MD!=内置 (${md.length} vs ${bi && bi.length})`); problems++ }
      const srcF = cfg.promptFile + '.src'
      if (!fs.existsSync(srcF)) { console.log(`❌ ${key}: .src 缺失`); problems++ }
      else if (fs.readFileSync(srcF, 'utf-8') !== bi) { console.log(`❌ ${key}: .src 不符`); problems++ }
      if (!md.includes('{{context.')) { console.log(`⚠️ ${key}: MD 无模板变量`); problems++ }
      checked++
    }
  }
}
for (const [key] of builtin) {
  const [tid, nid] = key.split('/')
  if (!fs.existsSync(`${promptsRoot}/${tid}/${nid}.md`)) { console.log(`❌ 内置 ${key} 缺外置 MD`); problems++ }
}
console.log(`\n验证 llm 节点: ${checked} / ${builtin.size}`)
console.log(problems === 0 ? '✅ 全链路逐字符比对通过：内置TS == 外置MD == .src指纹，JSON 无 prompt 残留' : `❌ 存在 ${problems} 处问题`)
process.exit(problems === 0 ? 0 : 1)