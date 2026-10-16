import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  SECURITY_KNOWLEDGE_SOURCES,
  validateKnowledgeSources,
  getKnowledgeRoot
} from '../electron/main/security-knowledge/sources'
import {
  getKnowledgeStatus,
  isAllKnowledgeMounted,
  searchLocalSource,
  searchAllSources
} from '../electron/main/security-knowledge/index'

/**
 * T6：安全知识库挂载配置测试。
 * 覆盖：源清单结构合法性、未挂载状态如实返回（不编造 mount）、已挂载目录的文件名检索、
 * env 覆盖根目录。检索只做文件名级匹配（README 声明的边界）。
 */

describe('security-knowledge sources 清单', () => {
  it('三个官方源齐全且结构合法', () => {
    expect(SECURITY_KNOWLEDGE_SOURCES.length).toBe(3)
    const errors = validateKnowledgeSources()
    expect(errors).toEqual([])
    const ids = SECURITY_KNOWLEDGE_SOURCES.map((s) => s.id)
    expect(ids).toEqual(['hacktricks', 'mitre-attack', 'nuclei-templates'])
  })

  it('清单引用全部为 https 官方仓库', () => {
    for (const s of SECURITY_KNOWLEDGE_SOURCES) {
      expect(s.repo.startsWith('https://github.com/'), s.id).toBe(true)
      for (const r of s.refs) expect(r.startsWith('https://'), `${s.id} ref ${r}`).toBe(true)
    }
  })

  it('validateKnowledgeSources 能捕获非法清单', () => {
    const errors = validateKnowledgeSources([
      { id: 'BAD ID', name: 'x', kind: 'weird' as never, repo: 'ftp://x', usage: '', localDir: 'x', refs: [] }
    ])
    expect(errors.length).toBeGreaterThanOrEqual(4)
  })
})

describe('security-knowledge 挂载状态与检索', () => {
  let fakeRoot: string
  const originalRoot = process.env.SECURITY_KB_ROOT

  beforeEach(() => {
    fakeRoot = mkdtempSync(join(tmpdir(), 'sec-kb-test-'))
    process.env.SECURITY_KB_ROOT = fakeRoot
  })

  afterEach(() => {
    rmSync(fakeRoot, { recursive: true, force: true })
    if (originalRoot === undefined) delete process.env.SECURITY_KB_ROOT
    else process.env.SECURITY_KB_ROOT = originalRoot
  })

  it('未挂载时如实返回 not-mounted（不编造文件数）', () => {
    const status = getKnowledgeStatus()
    expect(status).toHaveLength(3)
    for (const s of status) {
      expect(s.mounted).toBe(false)
      expect(s.fileCount).toBe(0)
      expect(s.localPath.startsWith(fakeRoot)).toBe(true)
    }
    expect(isAllKnowledgeMounted()).toBe(false)
    // 未挂载目录检索返回空数组（调用方结合 status 判断，不当作「无结果」）
    expect(searchLocalSource('hacktricks', 'privesc')).toEqual([])
    expect(searchAllSources('privesc')).toEqual({})
  })

  it('挂载 hacktricks 后：状态可见、文件数正确、文件名检索命中', () => {
    const kbDir = join(fakeRoot, 'hacktricks')
    mkdirSync(join(kbDir, 'win-privilege-escalation'), { recursive: true })
    writeFileSync(join(kbDir, 'win-privilege-escalation', 'README.md'), '# Windows Privilege Escalation')
    mkdirSync(join(kbDir, 'linux-hardening'), { recursive: true })
    writeFileSync(join(kbDir, 'linux-hardening', 'README.md'), '# Linux Hardening')

    const status = getKnowledgeStatus()
    const hacktricks = status.find((s) => s.id === 'hacktricks')
    expect(hacktricks?.mounted).toBe(true)
    expect(hacktricks?.fileCount).toBe(2)
    expect(isAllKnowledgeMounted()).toBe(false) // 其余两源未挂载

    const hits = searchLocalSource('hacktricks', 'privilege-escalation')
    expect(hits.length).toBe(1)
    expect(hits[0]!.file).toMatch(/win-privilege-escalation/)
  })

  it('searchLocalSource：未知源/空关键词安全返回空', () => {
    expect(searchLocalSource('not-exist', 'x')).toEqual([])
    expect(searchLocalSource('hacktricks', '  ')).toEqual([])
  })

  it('searchAllSources 按源分组返回命中', () => {
    mkdirSync(join(fakeRoot, 'nuclei-templates', 'cves'), { recursive: true })
    writeFileSync(join(fakeRoot, 'nuclei-templates', 'cves', 'CVE-2021-44228.yaml'), 'id: CVE-2021-44228')
    const out = searchAllSources('cve-2021')
    expect(Object.keys(out)).toEqual(['nuclei-templates'])
    expect(out['nuclei-templates']![0]!.file).toMatch(/CVE-2021-44228\.yaml$/)
  })

  it('getKnowledgeRoot 默认使用用户目录，env 生效', () => {
    expect(getKnowledgeRoot()).toBe(fakeRoot)
    delete process.env.SECURITY_KB_ROOT
    const root = getKnowledgeRoot()
    expect(root).toContain('security-knowledge')
    expect(root.startsWith(process.env.USERPROFILE ?? process.env.HOME ?? '.')).toBe(true)
  })
})