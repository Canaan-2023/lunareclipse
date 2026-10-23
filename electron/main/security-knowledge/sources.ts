/**
 * sources.ts — 安全知识库源清单（T3 选型落地）
 * 为什么存在：攻击链能力（workflow DAG / sub-agent 阶段验证）需要确定性的战术参考来源，
 * 本项目不做知识托管的搬运工——知识体量巨大（nuclei-templates 上万模板），本地逐字节复制
 * 是灾难。这里定义三个官方权威源的结构化清单与本地挂载约定（克隆到 SECURITY_KB_ROOT/<id>），
 * 检索层（index.ts）只对已挂载目录做文件名级轻量检索，未挂载时明确报状态，不编造内容。
 *
 * 选型依据（T3 逐源核实，非编造）：
 * - hacktricks：HackTricks-wiki/hacktricks，mdBook 格式攻击手法库，MIT，2026-07 活跃
 * - mitre-cti：mitre/cti（STIX 2.0）与 mitre-attck/attack-stix-data（STIX 2.1）战术模型
 * - nuclei-templates：projectdiscovery/nuclei-templates，YAML 漏洞检测模板库
 */
import { join } from 'path'

export type KnowledgeKind =
  | 'attack-playbook' // 攻击手法步骤库（手法检索，供 playbook 编排参考）
  | 'tactics-model' // 战术/阶段分类模型（阶段验证器词表对齐源）
  | 'vuln-templates' // 漏洞检测模板（扫描/利用动作的直接素材）

export interface SecurityKnowledgeSource {
  id: string
  name: string
  kind: KnowledgeKind
  repo: string
  format: string
  license: string
  usage: string
  /** 挂载后本地目录（相对 SECURITY_KB_ROOT） */
  localDir: string
  /** 经核实的远端引用（非猜测 URL） */
  refs: string[]
}

/** 知识库根目录：环境变量可覆盖，默认用户目录下 security-knowledge */
export function getKnowledgeRoot(): string {
  const env = process.env.SECURITY_KB_ROOT
  if (env && env.trim().length > 0) return env
  return join(process.env.USERPROFILE ?? process.env.HOME ?? '.', 'security-knowledge')
}

/** 安全知识库官方源清单（全部为 T3 核实的开源官方仓库） */
export const SECURITY_KNOWLEDGE_SOURCES: SecurityKnowledgeSource[] = [
  {
    id: 'hacktricks',
    name: 'HackTricks',
    kind: 'attack-playbook',
    repo: 'https://github.com/HackTricks-wiki/hacktricks.git',
    format: 'mdBook (Markdown)',
    license: 'MIT',
    usage: '攻击手法步骤库：侦察/枚举/提权/横向/持久化手法按场景检索，供攻击链 playbook 的战术编排参考',
    localDir: join('hacktricks'),
    refs: ['https://github.com/HackTricks-wiki/hacktricks', 'https://book.hacktricks.wiki/']
  },
  {
    id: 'mitre-attack',
    name: 'MITRE ATT&CK CTI',
    kind: 'tactics-model',
    repo: 'https://github.com/mitre/cti.git',
    format: 'STIX 2.0（mitre/cti） / STIX 2.1（mitre-attck/attack-stix-data）',
    license: 'CC BY 4.0',
    usage: '战术/阶段分类模型：与 output-verifier 的 8 阶段词表同源对齐，校验阶段命名与阶段间依赖',
    localDir: join('mitre-cti'),
    refs: ['https://github.com/mitre/cti', 'https://github.com/mitre-attack/attack-stix-data']
  },
  {
    id: 'nuclei-templates',
    name: 'nuclei-templates',
    kind: 'vuln-templates',
    repo: 'https://github.com/projectdiscovery/nuclei-templates.git',
    format: 'YAML（nuclei 模板）',
    license: 'MIT',
    usage: '漏洞检测模板：扫描阶段的确定性检测动作素材（配合 run_command 灰名单审批使用，不自动执行）',
    localDir: join('nuclei-templates'),
    refs: ['https://github.com/projectdiscovery/nuclei-templates']
  }
]

/** 校验源清单结构（防御性：缺字段/id 重复/非法 kind 直接报错，供单测与启动检查复用） */
export function validateKnowledgeSources(sources: SecurityKnowledgeSource[] = SECURITY_KNOWLEDGE_SOURCES): string[] {
  const errors: string[] = []
  const ids = new Set<string>()
  for (const s of sources) {
    if (!s.id || !/^[a-z0-9-]+$/.test(s.id)) errors.push(`id 非法: ${s.id ?? '(空)'}`)
    if (ids.has(s.id)) errors.push(`id 重复: ${s.id}`)
    ids.add(s.id)
    if (!s.repo.startsWith('https://') && !s.repo.startsWith('git@')) errors.push(`${s.id}: repo 必须是 https/git 地址`)
    if (!['attack-playbook', 'tactics-model', 'vuln-templates'].includes(s.kind)) errors.push(`${s.id}: kind 非法 ${s.kind}`)
    if (!s.usage || s.usage.trim().length === 0) errors.push(`${s.id}: usage 为空`)
    if (!Array.isArray(s.refs) || s.refs.length === 0) errors.push(`${s.id}: refs 为空`)
    if (s.refs.some((r) => typeof r !== 'string' || !r.startsWith('https://'))) errors.push(`${s.id}: refs 含非 https 引用`)
  }
  return errors
}