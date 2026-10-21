import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

/**
 * 内置（bundled）插件分发契约测试：
 * bundled 目录（electron/main/plugins/bundled）随安装包分发
 * （electron-builder extraResources → resources/plugins/bundled），
 * 是面向外部用户的打包产物，因此必须满足：
 * - 每个插件目录均有 plugin.json，且 name 字段与目录名一致
 *   （manifest.name 作为展示名/兜底名，目录名是插件身份键 `source:dirName`）
 * - 自带 SKILL.md 的插件，SKILL frontmatter name 与目录名（或明确的契约名）一致
 * - 源码/描述/注释中不含「月蚀」字样（宿主名不得进入分发物）
 * - 不包含绝对路径硬编码（C:\、D:\、/c/ 等）
 * 本用例守护上述打包契约，防止后续改动重新引入宿主耦合。
 */
const BUNDLED = join(process.cwd(), 'electron', 'main', 'plugins', 'bundled')

/** 插件名 → SKILL 名契约（SKILL name 可省略，则只要求 plugin.json 一致性） */
const SKILL_NAME_CONTRACT: Record<string, string> = {
  coding: 'coding',
  lilith: 'lilith'
}

function listBundledPlugins(): string[] {
  if (!existsSync(BUNDLED)) return []
  return readdirSync(BUNDLED).filter((d) => {
    try {
      return statSync(join(BUNDLED, d)).isDirectory() && existsSync(join(BUNDLED, d, 'plugin.json'))
    } catch {
      return false
    }
  })
}

describe('bundled 插件分发契约', () => {
  const plugins = listBundledPlugins()

  it('bundled 目录存在且包含预期插件集合', () => {
    expect(plugins.length).toBeGreaterThanOrEqual(4)
    for (const name of ['coding', 'computer-use', 'headless-browser', 'lilith']) {
      expect(plugins, `应包含插件 ${name}`).toContain(name)
    }
  })

  it('每个插件 plugin.json name 与目录名一致', () => {
    for (const dir of plugins) {
      const json = JSON.parse(readFileSync(join(BUNDLED, dir, 'plugin.json'), 'utf-8'))
      expect(json.name, `${dir}/plugin.json name 应与目录一致`).toBe(dir)
      expect(typeof json.description).toBe('string')
      expect(json.description.trim().length).toBeGreaterThan(0)
    }
  })

  it('带 SKILL.md 的插件，SKILL name 与插件名契约一致', () => {
    for (const [plugin, skillName] of Object.entries(SKILL_NAME_CONTRACT)) {
      const mdPath = join(BUNDLED, plugin, 'SKILL.md')
      if (!existsSync(mdPath)) continue
      const raw = readFileSync(mdPath, 'utf-8')
      const m = raw.match(/^name:\s*(\S+)/m)
      expect(m, `${plugin}/SKILL.md 应有 name 字段`).toBeTruthy()
      expect(m![1], `${plugin}/SKILL.md name 契约`).toBe(skillName)
    }
  })

  it('全部 bundled 文件不含「月蚀」宿主词', () => {
    const offenders: string[] = []
    const scan = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) { scan(p); continue }
        if (!/\.(md|json|js|ts|txt)$/.test(entry.name)) continue
        const content = readFileSync(p, 'utf-8')
        if (content.includes('月蚀')) offenders.push(p)
      }
    }
    scan(BUNDLED)
    expect(offenders).toEqual([])
  })

  it('全部 bundled 文件无 Windows 绝对路径硬编码', () => {
    const offenders: string[] = []
    const scan = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) { scan(p); continue }
        if (!/\.(md|json|js|ts|txt)$/.test(entry.name)) continue
        const content = readFileSync(p, 'utf-8')
        // C:\ D:\ 盘符绝对路径；排除 %APPDATA%（运行时占位符，由 ctx 注入）
        if (/[A-Za-z]:\\/.test(content)) offenders.push(p)
      }
    }
    scan(BUNDLED)
    expect(offenders).toEqual([])
  })

  it('web-llm-gateway 不得重新出现（删除组件的回归红线）', () => {
    // 【为什么存在】用户已主动删除 web-llm-gateway（含逆向凭据模块源码），
    //   且曾发生「从 0.46 归档误恢复」事故（见 versions/DELETED-COMPONENTS-20261001.md）。
    // 【什么作用】bundled 是随包分发的目录，该插件一旦被误恢复/误引入，
    //   本用例立即失败，形成分发侧的回归防线。
    // 【留存理由】删除决策是用户明确的不可逆动作，需测试守护；与出包前的本机自动检查
    //   的 deleted-component 检查构成双保险。
    expect(plugins.some((p) => p.toLowerCase().includes('web-llm-gateway'))).toBe(false)
  })

  it('novel-writing 不得重新出现（删除组件的回归红线）', () => {
    // 【为什么存在】用户已主动删除 novel-writing（bundled 写作插件），
    //   且其写小说页面/服务/协议均已在代码库彻底移除（见
    //   versions/DELETED-COMPONENTS-20261001.md）。
    // 【什么作用】bundled 是随包分发的目录，该插件一旦被误恢复/误引入，
    //   本用例立即失败；与出包前的本机自动检查构成双保险。
    // 【留存理由】删除决策是用户明确的不可逆动作，需测试守护，防止
    //   历史归档（versions/*-source.zip）被误恢复回代码库。
    expect(plugins.some((p) => p.toLowerCase().includes('novel-writing'))).toBe(false)
  })
})

/** 说明：cygwin/msys 路径 /c/ 形态不在本用例扫描范围（工程使用盘符绝对路径形态为 C:\）。 */