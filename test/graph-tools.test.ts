import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { NngGraphTool } from '../electron/main/tools/nng-graph'
import { CacheGraphTool } from '../electron/main/tools/cache-graph'
import type { ToolContext } from '../electron/main/tools/base-tool'

// 图工具单元测试：为什么存在——nng_graph/cache_graph 是 ABYSS 记忆检索的定位入口，
// 此前零测试覆盖。作用：用临时目录模拟 NNG/cache 工作域（root.json + 一级节点目录 + 同名文件夹层级），
// 验证「文件为点、同名文件夹为线」的树结构、任意起点（文件/文件夹）、深度限制与错误分支。
// 不删掉的理由：图结构推断直接决定 AI 能否在节点数量大时定位子树，测试锁定行为防止静默回归。

let root: string
let nngDir: string
let cacheDir: string

const nngCtx = {
  paths: {
    nngRootJson: ''
  }
} as unknown as ToolContext

const cacheCtx = {
  paths: {
    cacheIndexJson: ''
  }
} as unknown as ToolContext

beforeAll(() => {
  // 临时工作域布局（与 create-nng/cache-sync 的真实写入契约一致）：
  // NNG: root.json + root/ 一级目录；一级节点 auth → auth/ 内二级 login → login/ 内三级 deep
  // cache: index.json + index/ 一级目录；同构镜像 + injection/ 注入区（默认树不应涉及）
  root = mkdtempSync(join(tmpdir(), 'graph-tools-'))
  nngDir = join(root, 'NNG', 'AI1', 'U1')
  mkdirSync(join(nngDir, 'root', 'auth', 'login'), { recursive: true })
  writeFileSync(join(nngDir, 'root.json'), '{"version":"1.0","nodes":[]}')
  writeFileSync(join(nngDir, 'root', 'auth_nng.json'), '{"描述":"auth"}')
  writeFileSync(join(nngDir, 'root', 'auth', 'login_nng.json'), '{"描述":"login"}')
  writeFileSync(join(nngDir, 'root', 'auth', 'login', 'deep_nng.json'), '{"描述":"deep"}')
  writeFileSync(join(nngDir, 'root', 'user_nng.json'), '{"描述":"user"}')

  cacheDir = join(root, 'cache', 'AI1', 'U1')
  mkdirSync(join(cacheDir, 'index', 'auth', 'login'), { recursive: true })
  mkdirSync(join(cacheDir, 'injection', 'sub'), { recursive: true })
  writeFileSync(join(cacheDir, 'index.json'), '{"version":"1.0","entries":[]}')
  writeFileSync(join(cacheDir, 'index', 'auth_cache.json'), '{"描述":"auth"}')
  writeFileSync(join(cacheDir, 'index', 'auth', 'login_cache.json'), '{"描述":"login"}')
  writeFileSync(join(cacheDir, 'index', 'user_cache.json'), '{"描述":"user"}')
  writeFileSync(join(cacheDir, 'index', 'ignore_me.txt'), 'plain text')
  writeFileSync(join(cacheDir, 'injection', 'inj_cache.json'), '{"描述":"注入区"}')
  writeFileSync(join(cacheDir, 'injection', 'sub', 'sub_inj_cache.json'), '{"描述":"注入区子级"}')

  ;(nngCtx.paths as { nngRootJson: string }).nngRootJson = join(nngDir, 'root.json').replace(/\\/g, '/')
  ;(cacheCtx.paths as { cacheIndexJson: string }).cacheIndexJson = join(cacheDir, 'index.json').replace(/\\/g, '/')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('NngGraphTool 默认起点 root.json：文件为点、同名文件夹为线', () => {
  it('一级节点为 root/ 中的 *_nng.json 文件（按名排序）', async () => {
    const tool = new NngGraphTool()
    const res = await tool.execute({}, nngCtx)
    expect(res.ok).toBe(true)
    const data = (res as { ok: true; data: { tree: { name: string; path: string; type: string; children: unknown[] } } }).data
    expect(data.tree.name).toBe('root.json')
    expect(data.tree.type).toBe('root')
    expect(data.tree.children.map((c) => (c as { name: string }).name)).toEqual(['auth_nng.json', 'user_nng.json'])
  })

  it('同名文件夹为线：auth_nng.json 的 children 来自 auth/ 文件夹（login_nng.json）', async () => {
    const tool = new NngGraphTool()
    const res = await tool.execute({}, nngCtx)
    expect(res.ok).toBe(true)
    const data = (res as { ok: true; data: { tree: { children: { name: string; children: { name: string }[] }[] } } }).data
    const auth = data.tree.children.find((c) => c.name === 'auth_nng.json')!
    expect(auth.children.map((c) => c.name)).toEqual(['login_nng.json'])
  })

  it('三级 deep 节点经 login/ 文件夹继续下钻', async () => {
    const tool = new NngGraphTool()
    const res = await tool.execute({}, nngCtx)
    expect(res.ok).toBe(true)
    const data = (res as { ok: true; data: { tree: never } }).data
    const auth = (data.tree as { children: { name: string; children: { name: string; children: { name: string }[] }[] }[] }).children.find(
      (c) => c.name === 'auth_nng.json'
    )!
    const login = auth.children[0]
    expect(login.name).toBe('login_nng.json')
    expect(login.children.map((c) => c.name)).toEqual(['deep_nng.json'])
    expect((res as { ok: true; data: { 最大深度: number } }).data.最大深度).toBe(3)
  })
})

describe('NngGraphTool 任意位置起点', () => {
  it('start_path 传二级 _nng.json 文件：以该文件为根（文件为点）', async () => {
    const tool = new NngGraphTool()
    const start = join(nngDir, 'root', 'auth', 'login_nng.json').replace(/\\/g, '/')
    const res = await tool.execute({ start_path: start }, nngCtx)
    expect(res.ok).toBe(true)
    const data = (res as { ok: true; data: { tree: { name: string; type: string; children: unknown[] }; 起点: string } }).data
    expect(data.tree.name).toBe('login_nng.json')
    expect(data.tree.type).toBe('file')
    expect(data.tree.children.map((c) => (c as { name: string }).name)).toEqual(['deep_nng.json'])
    expect(data.起点).toBe(start)
  })

  it('start_path 传文件夹（root/auth/）：以该文件夹为根展示其下树（回归：修复前返回空树）', async () => {
    const tool = new NngGraphTool()
    const start = join(nngDir, 'root', 'auth').replace(/\\/g, '/')
    const res = await tool.execute({ start_path: start }, nngCtx)
    expect(res.ok).toBe(true)
    const data = (res as { ok: true; data: { tree: { name: string; type: string; children: unknown[][] | unknown[] } } }).data
    expect(data.tree.name).toBe('auth')
    expect(data.tree.type).toBe('root')
    const children = data.tree.children as { name: string; children: { name: string }[] }[]
    expect(children.map((c) => c.name)).toEqual(['login_nng.json'])
    expect(children[0].children.map((c) => c.name)).toEqual(['deep_nng.json'])
  })

  it('start_path 传一级节点目录 root/：展开其全部一级 _nng.json（回归：修复前返回空树）', async () => {
    const tool = new NngGraphTool()
    const start = join(nngDir, 'root').replace(/\\/g, '/')
    const res = await tool.execute({ start_path: start }, nngCtx)
    expect(res.ok).toBe(true)
    const data = (res as { ok: true; data: { tree: { children: unknown[] } } }).data
    expect((data.tree.children as { name: string }[]).map((c) => c.name)).toEqual(['auth_nng.json', 'user_nng.json'])
  })

  it('start_path 不存在：返回 ok=false 与起点不存在错误', async () => {
    const tool = new NngGraphTool()
    const start = join(nngDir, 'root', 'no_such_nng.json').replace(/\\/g, '/')
    const res = await tool.execute({ start_path: start }, nngCtx)
    expect(res.ok).toBe(false)
    expect((res as { ok: false; error: string }).error).toContain('起点不存在')
  })
})

describe('NngGraphTool 最大深度', () => {
  it('最大深度=1：一级节点不再展开 children', async () => {
    const tool = new NngGraphTool()
    const res = await tool.execute({ 最大深度: 1 }, nngCtx)
    expect(res.ok).toBe(true)
    const data = (res as { ok: true; data: { tree: { children: { children: unknown[] }[] }; 最大深度: number } }).data
    for (const c of data.tree.children) {
      expect(c.children).toEqual([])
    }
    expect(data.最大深度).toBe(1)
  })

  it('最大深度=2：deep 不再出现（深度 3 被截断）', async () => {
    const tool = new NngGraphTool()
    const res = await tool.execute({ 最大深度: 2 }, nngCtx)
    expect(res.ok).toBe(true)
    const data = (res as { ok: true; data: { tree: { children: { name: string; children: { name: string; children: unknown[] }[] }[] } } }).data
    const auth = data.tree.children.find((c) => c.name === 'auth_nng.json')!
    const login = auth.children[0]
    expect(login.children).toEqual([])
  })
})

describe('CacheGraphTool 默认起点 index.json：同构镜像 + 不涉及 injection', () => {
  it('一级节点为 index/ 中 *_cache.json（忽略非 _cache.json 文件）', async () => {
    const tool = new CacheGraphTool()
    const res = await tool.execute({}, cacheCtx)
    expect(res.ok).toBe(true)
    const data = (res as { ok: true; data: { tree: { name: string; children: unknown[] } } }).data
    expect(data.tree.name).toBe('index.json')
    expect((data.tree.children as { name: string }[]).map((c) => c.name)).toEqual(['auth_cache.json', 'user_cache.json'])
  })

  it('默认树不涉及 cache/injection/ 注入区（除非显式指定起点）', async () => {
    const tool = new CacheGraphTool()
    const res = await tool.execute({}, cacheCtx)
    expect(res.ok).toBe(true)
    const flat: string[] = []
    const walk = (n: { name: string; children: unknown[] }): void => {
      flat.push(n.name)
      for (const c of n.children as { name: string; children: unknown[] }[]) walk(c)
    }
    walk((res as { ok: true; data: { tree: { name: string; children: unknown[] } } }).data.tree)
    expect(flat).not.toContain('inj_cache.json')
    expect(flat).not.toContain('sub_inj_cache.json')
  })

  it('显式 start_path 指向 injection 内文件时才会涉及注入区', async () => {
    const tool = new CacheGraphTool()
    const start = join(cacheDir, 'injection', 'inj_cache.json').replace(/\\/g, '/')
    const res = await tool.execute({ start_path: start }, cacheCtx)
    expect(res.ok).toBe(true)
    const data = (res as { ok: true; data: { tree: { name: string } } }).data
    expect(data.tree.name).toBe('inj_cache.json')
  })

  it('start_path 传 cache 文件夹（index/auth/）：以文件夹为根（回归：修复前返回空树）', async () => {
    const tool = new CacheGraphTool()
    const start = join(cacheDir, 'index', 'auth').replace(/\\/g, '/')
    const res = await tool.execute({ start_path: start }, cacheCtx)
    expect(res.ok).toBe(true)
    const data = (res as { ok: true; data: { tree: { children: unknown[] } } }).data
    expect((data.tree.children as { name: string }[]).map((c) => c.name)).toEqual(['login_cache.json'])
  })
})