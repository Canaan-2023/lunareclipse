/**
 * AI 编号注册表数据层：维护 abyssac_data/ai-registry.json。AI 编号固定
 * （月蚀=1、莉莉丝=2、custom 顺延）作为记忆/RAW/NNG 归属的唯一标识，
 * 名字可改但不影响数据归属。对外提供注册表读写、按 id/agent 查询
 * 与 custom AI 注册入口。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { nowIso } from './memory'
import { DEFAULT_AI_ID, LILITH_AI_ID } from '@shared/types'

/**
 * AI 编号注册表（设计依据：编号是 AI 身份的唯一稳定键）：
 * 月蚀=1、莉莉丝=2，后续新 AI 顺延。记忆/RAW/NNG 只认编号，改名不影响归属。
 * 文件位置：abyssac_data/ai-registry.json

 * 2026-09-22 多 AI 子系统扩展：
 * - AiRecord 增补 description/avatar/systemPrompt/llm/toolPolicy/parentAiId/createdAt/deactivated（旧记录全部可选，兼容）
 * - registerCustomAi：用户/AI 创建 custom AI 的唯一入口（顺延 id、agent 缺省 custom-{id}、parentAiId 溯源）
 * - registerAi 保留为纯注册原语（名字+agent），供既有调用方/测试使用
 */
export interface AiRecord {
  /** 固定编号（永不变更，名字可改） */
  id: number
  /** 显示名（可变，不影响数据归属） */
  name: string
  /** agent 标识：frontend=前端月蚀 / lilith=莉莉丝桥接 / custom-{id}=用户/AI 创建（决定工具策略过滤） */
  agent: 'frontend' | 'lilith' | string
  /** 角色类型：system=系统自带 / custom=用户或 AI 创建 */
  kind?: 'system' | 'custom'
  /** 简介（AiManagerPanel 列表展示） */
  description?: string
  /** 头像标识：emoji 短文本，或 img:avatars/ai/{id}/avatar.{ext} 本地图片引用（ai:saveAvatarImage 落盘后写回此字段） */
  avatar?: string
  /** 自定义提示词（写入 ai-prompts/AI{id}/system.md 副本；缺省回退内置 frontend 模板） */
  systemPrompt?: string
  /** LLM 配置覆盖（缺省不覆盖全局 config.llm） */
  llm?: {
    model?: string
    temperature?: number
  }
  /** 工具策略档位：default=跟随全局 / restricted=受限 / full=全量 */
  toolPolicy?: 'default' | 'restricted' | 'full'
  /** 创建者 aiId（AI 自建 AI 溯源；null/缺省=用户创建） */
  parentAiId?: number
  /** 创建时间（ISO） */
  createdAt?: string
  /** 停用标记（软下线，数据保留；停用 AI 不可新建会话续聊，历史会话只读） */
  deactivated?: boolean
}

export interface AiRegistry {
  version: number
  updated_at: string
  ais: AiRecord[]
}

const DEFAULT_AIS: AiRecord[] = [
  { id: DEFAULT_AI_ID, name: '月蚀', agent: 'frontend', kind: 'system' },
  { id: LILITH_AI_ID, name: '莉莉丝', agent: 'lilith', kind: 'system' }
]

export function readAiRegistry(registryPath: string): AiRegistry {
  if (!existsSync(registryPath)) {
    return { version: 1, updated_at: nowIso(), ais: [...DEFAULT_AIS] }
  }
  const raw = readFileSync(registryPath, 'utf-8')
  const parsed = JSON.parse(raw) as Partial<AiRegistry>
  if (!Array.isArray(parsed.ais) || parsed.ais.length === 0) {
    return { version: 1, updated_at: nowIso(), ais: [...DEFAULT_AIS] }
  }
  return {
    version: parsed.version ?? 1,
    updated_at: parsed.updated_at ?? nowIso(),
    ais: parsed.ais
  }
}

export function writeAiRegistry(registryPath: string, data: AiRegistry): void {
  mkdirSync(dirname(registryPath), { recursive: true })
  data.updated_at = nowIso()
  writeFileSync(registryPath, JSON.stringify(data, null, 2), 'utf-8')
}

/** 按 id 查 AI（找不到返回 null） */
export function findAiById(registry: AiRegistry, id: number): AiRecord | null {
  return registry.ais.find((a) => a.id === id) ?? null
}

/** 按 agent 标识查 AI（如 frontend → 月蚀，lilith → 莉莉丝） */
export function findAiByAgent(registry: AiRegistry, agent: string): AiRecord | null {
  return registry.ais.find((a) => a.agent === agent) ?? null
}

/** 注册新 AI（编号自动顺延：现有最大 id + 1），已存在同名则返回现有记录 */
export function registerAi(registryPath: string, name: string, agent: string): AiRecord {
  const registry = readAiRegistry(registryPath)
  const existing = registry.ais.find((a) => a.name === name || a.agent === agent)
  if (existing) {
    return existing
  }
  const nextId = registry.ais.reduce((max, a) => Math.max(max, a.id), 0) + 1
  const record: AiRecord = { id: nextId, name, agent, kind: 'custom', createdAt: nowIso() }
  registry.ais.push(record)
  writeAiRegistry(registryPath, registry)
  return record
}

/** 创建 custom AI 的入参（AiManager.register 透传） */
export interface CustomAiInput {
  name: string
  /** 缺省自动生成 custom-{id}（与内置 frontend/lilith 命名空间隔离） */
  agent?: string
  description?: string
  avatar?: string
  systemPrompt?: string
  llm?: AiRecord['llm']
  toolPolicy?: AiRecord['toolPolicy']
  /** 创建者 aiId（AI 自建 AI 溯源；缺省=用户创建） */
  parentAiId?: number
}

/**
 * 注册 custom AI（多 AI 子系统唯一入口）：
 * - 编号自动顺延（现有最大 id + 1）
 * - agent 缺省生成 custom-{id}
 * - name 与 agent 均查重（重名/同 agent 返回已有记录，不重复创建）
 * - kind='custom' + createdAt 落盘
 */
export function registerCustomAi(registryPath: string, input: CustomAiInput): AiRecord {
  const registry = readAiRegistry(registryPath)
  const existing = registry.ais.find(
    (a) => a.name === input.name || (input.agent != null && a.agent === input.agent)
  )
  if (existing) {
    return existing
  }
  const nextId = registry.ais.reduce((max, a) => Math.max(max, a.id), 0) + 1
  const record: AiRecord = {
    id: nextId,
    name: input.name,
    agent: input.agent ?? `custom-${nextId}`,
    kind: 'custom',
    description: input.description,
    avatar: input.avatar,
    systemPrompt: input.systemPrompt,
    llm: input.llm,
    toolPolicy: input.toolPolicy,
    parentAiId: input.parentAiId,
    createdAt: nowIso()
  }
  registry.ais.push(record)
  writeAiRegistry(registryPath, registry)
  return record
}