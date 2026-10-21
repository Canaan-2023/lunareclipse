import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { regenerateSystemCatalog, resolveCatalogSourceRoot } from '../electron/main/services/system-catalog'

let root: string

function writeAppLayout(tmp: string): void {
  // electron/main/index.ts（顶层入口，类别核心）
  mkdirSync(join(tmp, 'electron', 'main', 'api'), { recursive: true })
  writeFileSync(
    join(tmp, 'electron', 'main', 'index.ts'),
    ['/**', ' * @category 核心', ' * @summary 主进程入口', ' */', 'export {}'].join('\n'),
    'utf-8'
  )
  // api/server.ts（目录模块带注释）
  writeFileSync(
    join(tmp, 'electron', 'main', 'api', 'server.ts'),
    ['/**', ' * @category 核心', ' * @summary 后端服务', ' */', 'export {}'].join('\n'),
    'utf-8'
  )
  writeFileSync(join(tmp, 'electron', 'main', 'api', 'helper.ts'), 'export const x = 1\n', 'utf-8')
  // tools/scheduler.ts（无注释目录 → 未分类 + 未写摘要标注）
  mkdirSync(join(tmp, 'electron', 'main', 'tools'), { recursive: true })
  writeFileSync(join(tmp, 'electron', 'main', 'tools', 'scheduler.ts'), 'export const y = 2\n', 'utf-8')
  // vendor（第三方依赖，不视为模块）
  mkdirSync(join(tmp, 'electron', 'main', 'vendor', 'lib'), { recursive: true })
  writeFileSync(join(tmp, 'electron', 'main', 'vendor', 'lib', 'index.ts'), 'export const v = 3\n', 'utf-8')
  // src/main.tsx（渲染进程）
  mkdirSync(join(tmp, 'src'), { recursive: true })
  writeFileSync(
    join(tmp, 'src', 'main.tsx'),
    ['/**', ' * @category 渲染', ' * @summary 渲染进程入口', ' */', 'export {}'].join('\n'),
    'utf-8'
  )
}

function writePlugin(source: 'bundled' | 'user' | 'domain', name: string, desc = 'desc'): void {
  const base =
    source === 'bundled'
      ? join(root, 'electron', 'main', 'plugins', 'bundled')
      : source === 'user'
        ? join(root, 'plugins')
        : join(root, 'plugins_domains')
  mkdirSync(join(base, name), { recursive: true })
  writeFileSync(join(base, name, 'plugin.json'), JSON.stringify({ name, description: desc }), 'utf-8')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'system-catalog-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('system-catalog 生成器', () => {
  it('无源码环境降级：不生成模块类别文档，index 含降级说明，插件清单照常', () => {
    writePlugin('user', 'demo-plugin')
    const files = regenerateSystemCatalog(join(root, 'not-exist'), root)
    expect(files).toContain('插件清单.md')
    expect(files).not.toContain('核心.md')
    const index = readFileSync(join(root, 'system-catalog', 'index.md'), 'utf-8')
    expect(index).toContain('打包运行环境')
    const list = readFileSync(join(root, 'system-catalog', '插件清单.md'), 'utf-8')
    expect(list).toContain('demo-plugin')
  })

  it('扫描模块注释并分类生成文档', () => {
    writeAppLayout(root)
    const files = regenerateSystemCatalog(root, root)
    expect(files).toContain('index.md')
    expect(files).toContain('核心.md')
    expect(files).toContain('未分类.md')

    const index = readFileSync(join(root, 'system-catalog', 'index.md'), 'utf-8')
    expect(index).toContain('模块（共 4 个 / 3 类）') // main/api/src + tools(未分类)
    const core = readFileSync(join(root, 'system-catalog', '核心.md'), 'utf-8')
    expect(core).toContain('**api** — `electron/main/api/server.ts`：后端服务')
    expect(core).toContain('**main** — `electron/main/index.ts`：主进程入口')
    // 未分类标注
    const unclassified = readFileSync(join(root, 'system-catalog', '未分类.md'), 'utf-8')
    expect(unclassified).toContain('未写摘要')
    expect(unclassified).toContain('electron/main/tools/scheduler.ts')
    // vendor 不出现
    expect(index).not.toContain('vendor')
  })

  it('插件三源并入插件清单，超过阈值拆分为多卷', () => {
    writeAppLayout(root)
    writePlugin('bundled', 'b1', '内置插件')
    for (let i = 0; i < 12; i++) writePlugin('user', `u${i}`)
    writePlugin('domain', 'd1')
    regenerateSystemCatalog(root, root)
    const files = readdirSync(join(root, 'system-catalog'))
    expect(files).toContain('插件清单-1.md')
    expect(files).toContain('插件清单-2.md')
    const total = ['插件清单-1.md', '插件清单-2.md']
      .map((f) => readFileSync(join(root, 'system-catalog', f), 'utf-8'))
      .join('')
    expect(total).toContain('b1')
    expect(total).toContain('d1')
  })

  it('覆盖替换：二次生成后旧类别文档不残留', () => {
    writeAppLayout(root)
    regenerateSystemCatalog(root, root)
    // 删除 tools 后重跑：未分类.md 应消失
    rmSync(join(root, 'electron', 'main', 'tools'), { recursive: true, force: true })
    regenerateSystemCatalog(root, root)
    const files = readdirSync(join(root, 'system-catalog'))
    expect(files).not.toContain('未分类.md')
    expect(files).toContain('核心.md')
    const index = readFileSync(join(root, 'system-catalog', 'index.md'), 'utf-8')
    expect(index).toContain('模块（共 3 个 / 2 类）')
  })

  it('resolveCatalogSourceRoot：有源码返回原路径', () => {
    writeAppLayout(root)
    expect(resolveCatalogSourceRoot(root)).toBe(root)
  })
})