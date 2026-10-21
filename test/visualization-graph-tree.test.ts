/**
 * 可视化图谱树解析专门单测（上轮审查 MINOR：图解析函数 parseGraphType/readNngTree/readCacheTree
 * 无专门单元测试）。
 * 为什么存在：NNG 图谱与缓存图谱是「文件为点、同名文件夹为线」的真实关系图数据源，
 * 命名前缀（standard/meta/high）、同名文件夹关联、深度截断等规则是前端画布的数据契约，
 * 必须用真实文件系统样本锁定行为，防止目录结构调整/命名规则漂移时静默破坏图谱。
 * 路径构造：buildDataPaths(tmpDir) → resolveScopePaths(base, { uid, aiId }) 得到作用域路径；
 * NNG 一级目录 NNG/AI1/U1/root、cache 一级目录 cache/AI1/U1/index。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { buildDataPaths, resolveScopePaths, type DataPaths } from '../electron/main/models/paths'
import {
  parseGraphType,
  parseGraphName,
  readNngTree,
  readCacheTree
} from '../electron/main/api/visualization-data'

let tmpDir: string
let paths: DataPaths

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'viz-graph-tree-test-'))
  paths = resolveScopePaths(buildDataPaths(tmpDir), { uid: 1, aiId: 1 })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

/** 在指定目录下创建 {stem}_nng.json / {stem}_cache.json 与其同名文件夹（文件为点、同名文件夹为线） */
function makeGraphFile(dir: string, stem: string, kind: 'nng' | 'cache' = 'nng'): void {
  const suffix = kind === 'nng' ? '_nng.json' : '_cache.json'
  writeFileSync(join(dir, `${stem}${suffix}`), '{}')
  mkdirSync(join(dir, stem), { recursive: true })
}

/** 建一个 {stem}_nng.json 但不同名目录（验证无文件夹时 children 为空） */
function makeLonelyJson(dir: string, stem: string): void {
  writeFileSync(join(dir, `${stem}_nng.json`), '{}')
}

describe('parseGraphType', () => {
  it('无前缀文件名为 standard', () => {
    expect(parseGraphType('1auth_nng.json')).toBe('standard')
    expect(parseGraphType('auth.json')).toBe('standard')
  })

  it('meta_ 前缀为 meta（带/不带序号、nng/cache 后缀均可）', () => {
    expect(parseGraphType('2meta_反思_nng.json')).toBe('meta')
    expect(parseGraphType('meta_反思_cache.json')).toBe('meta')
    expect(parseGraphType('12meta_目标_cache.json')).toBe('meta')
  })

  it('high_ 前缀为 high', () => {
    expect(parseGraphType('3high_总结_nng.json')).toBe('high')
    expect(parseGraphType('high_总结_cache.json')).toBe('high')
  })

  it('仅在文件名开头匹配前缀（名称中间含 meta_ 不算）', () => {
    expect(parseGraphType('1sub_meta_plan_nng.json')).toBe('standard')
  })
})

describe('parseGraphName', () => {
  it('去掉序号前缀、类型前缀与 _nng.json 后缀', () => {
    expect(parseGraphName('1auth_nng.json', 'nng')).toBe('auth')
    expect(parseGraphName('2meta_反思_nng.json', 'nng')).toBe('反思')
    expect(parseGraphName('3high_总结_nng.json', 'nng')).toBe('总结')
  })

  it('cache 后缀独立处理，nng/cache 不串扰', () => {
    expect(parseGraphName('1auth_cache.json', 'cache')).toBe('auth')
    expect(parseGraphName('2meta_反思_cache.json', 'cache')).toBe('反思')
    // 实际代码不会跨 kind 调用；此处锁定实现语义：只剥离序号，后缀原样保留
    expect(parseGraphName('1auth_cache.json', 'nng')).toBe('auth_cache.json')
  })

  it('多位数序号与无序号均正确剥离', () => {
    expect(parseGraphName('12plan_cache.json', 'cache')).toBe('plan')
    expect(parseGraphName('plan_cache.json', 'cache')).toBe('plan')
  })
})

describe('readNngTree', () => {
  it('一级目录不存在时返回空数组', () => {
    expect(readNngTree(paths)).toEqual([])
  })

  it('一级目录存在但无 _nng.json 文件时返回空数组', () => {
    mkdirSync(paths.nngLevel1Dir, { recursive: true })
    writeFileSync(join(paths.nngLevel1Dir, 'readme.md'), 'x')
    expect(readNngTree(paths)).toEqual([])
  })

  it('standard/meta/high 三类一级节点按文件名解析类型与名称', () => {
    mkdirSync(paths.nngLevel1Dir, { recursive: true })
    makeGraphFile(paths.nngLevel1Dir, '1auth')
    makeGraphFile(paths.nngLevel1Dir, '2meta_反思')
    makeGraphFile(paths.nngLevel1Dir, '3high_总结')

    const tree = readNngTree(paths)
    expect(tree).toHaveLength(3)
    const auth = tree.find((n) => n.name === 'auth')!
    const meta = tree.find((n) => n.name === '反思')!
    const high = tree.find((n) => n.name === '总结')!
    expect(auth.type).toBe('standard')
    expect(meta.type).toBe('meta')
    expect(high.type).toBe('high')
    // jsonFile 记录原始文件名，path 指向可读的 json 完整路径
    expect(auth.jsonFile).toBe('1auth_nng.json')
    expect(auth.path.endsWith('1auth_nng.json')).toBe(true)
    // 同名文件夹为空时 children 为空数组
    expect(auth.children).toEqual([])
  })

  it('同名文件夹内的子文件作为边（文件为点、同名文件夹为线）', () => {
    mkdirSync(paths.nngLevel1Dir, { recursive: true })
    makeGraphFile(paths.nngLevel1Dir, '1root')
    makeGraphFile(join(paths.nngLevel1Dir, '1root'), '2child')
    makeGraphFile(join(paths.nngLevel1Dir, '1root'), '3meta_分支')

    const tree = readNngTree(paths)
    expect(tree).toHaveLength(1)
    const root = tree[0]
    expect(root.name).toBe('root')
    expect(root.children).toHaveLength(2)
    const child = root.children.find((n) => n.name === 'child')!
    const branch = root.children.find((n) => n.name === '分支')!
    expect(child.type).toBe('standard')
    expect(branch.type).toBe('meta')
    // 二级节点 jsonFile 用子文件夹内实际文件名，path 指向子 json
    expect(child.jsonFile).toBe('2child_nng.json')
  })

  it('有 json 但无同名文件夹时 children 为空且不抛错', () => {
    mkdirSync(paths.nngLevel1Dir, { recursive: true })
    makeLonelyJson(paths.nngLevel1Dir, '1solo')
    const tree = readNngTree(paths)
    expect(tree).toHaveLength(1)
    expect(tree[0].name).toBe('solo')
    expect(tree[0].children).toEqual([])
  })

  it('深度超过 3 层时截断（第 4 层不复现）', () => {
    mkdirSync(paths.nngLevel1Dir, { recursive: true })
    // root/2b/3c/4d：4d 是第 4 层，应被截断
    makeGraphFile(paths.nngLevel1Dir, '1a')
    makeGraphFile(join(paths.nngLevel1Dir, '1a'), '2b')
    makeGraphFile(join(paths.nngLevel1Dir, '1a', '2b'), '3c')
    makeGraphFile(join(paths.nngLevel1Dir, '1a', '2b', '3c'), '4d')

    const tree = readNngTree(paths)
    const a = tree.find((n) => n.name === 'a')!
    const b = a.children.find((n) => n.name === 'b')!
    const c = b.children.find((n) => n.name === 'c')!
    expect(c.children).toEqual([])
  })

  it('目录里混入无关文件（.md / 非 nng 后缀 json）时只收 _nng.json', () => {
    mkdirSync(paths.nngLevel1Dir, { recursive: true })
    makeGraphFile(paths.nngLevel1Dir, '1a')
    writeFileSync(join(paths.nngLevel1Dir, '2b_cache.json'), '{}') // cache 后缀不混入 nng 树
    writeFileSync(join(paths.nngLevel1Dir, 'note.md'), 'x')
    const tree = readNngTree(paths)
    expect(tree).toHaveLength(1)
    expect(tree[0].name).toBe('a')
  })
})

describe('readCacheTree', () => {
  it('与 readNngTree 同构：缓存根目录不同、后缀为 _cache.json', () => {
    mkdirSync(paths.cacheLevel1Dir, { recursive: true })
    makeGraphFile(paths.cacheLevel1Dir, '1conversation', 'cache')
    makeGraphFile(paths.cacheLevel1Dir, '2meta_状态', 'cache')
    makeGraphFile(join(paths.cacheLevel1Dir, '1conversation'), '2sub', 'cache')

    const tree = readCacheTree(paths)
    expect(tree).toHaveLength(2)
    const convo = tree.find((n) => n.name === 'conversation')!
    expect(convo.type).toBe('standard')
    expect(convo.jsonFile).toBe('1conversation_cache.json')
    expect(convo.children.map((c) => c.name)).toEqual(['sub'])
    expect(convo.children[0].type).toBe('standard')
    const status = tree.find((n) => n.name === '状态')!
    expect(status.type).toBe('meta')
  })

  it('一级目录不存在时返回空数组', () => {
    expect(readCacheTree(paths)).toEqual([])
  })
})