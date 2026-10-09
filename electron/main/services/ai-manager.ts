/**
 * 为什么存在：用户可注册多个自定义 AI，其注册表、命名规范与"前端+共享+persona"多层提示词装配需要统一管理。
 * 作用：AI 增删查改与状态管理：校验名称/描述规则，按 AI 合成各层提示词为 PromptLayerResult 供对话使用。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  findAiById,
  readAiRegistry,
  registerCustomAi,
  writeAiRegistry,
  type AiRecord,
  type CustomAiInput
} from '../models/ai-registry'
import {
  getPromptsDir,
  loadFrontendPromptForAi,
  loadSharedPromptsForAi,
  mergePromptFiles,
  type PromptLayerResult,
  type VirtualBuiltinFile
} from '../prompts/loader'
import { buildLilithSessionPersona } from './lilith-adapter'

/**
 * AI 管理服务（多 AI 子系统 P1：注册表接线）。

 * 职责：AI 注册表中 custom AI 的增查改停 + 提示词副本读写。
 * - 注册表（abyssac_data/ai-registry.json）= AI 元数据唯一权威
 * - 提示词副本（{root}/frontend/ai-prompts/AI{aiId}/）= 运行时提示词唯一权威：
 * 升级为「副本目录与内置目录同构、按文件粒度合并覆盖」——
 * frontend/（覆盖 prompts/frontend/*）与 shared/（覆盖 prompts/shared/*）两个子层；
 * 同名文件替换对应内置文件，副本独有文件追加，无副本文件继续用内置；
 * 兼容旧 system.md 整包：AI{aiId}/system.md 存在且无 frontend/ 子目录时整包覆盖 frontend 层。
 * - sys_prompt 注入读 frontend 层合并结果，非空用副本，否则回退内置 frontend 模板；
 * shared 层同理（无副本回退内置 shared 常量）。
 * - 系统 AI（frontend/lilith）只读：kind='system' 不可停用、不可改 agent/kind/id

 * 无状态：每次读写直接落到文件，构造只收路径（轻量，IPC 每次调用 new 即可）。
 */

/** 命名校验（与 update-ai-name 工具同一套规则：1-16 字符，仅中文/英文/数字/部分标点） */
const MIN_NAME_LEN = 1
const MAX_NAME_LEN = 16
const NAME_PATTERN = /^[\u4e00-\u9fa5A-Za-z0-9·\-._\s]+$/
/** 简介/提示词长度上限（防止超大文本拖垮注册表文件） */
const MAX_DESC_LEN = 200
const MAX_PROMPT_LEN = 50_000
/** custom AI 数量上限（含停用；P4 create_ai 工具同样走此入口，天然生效） */
const MAX_CUSTOM_AIS = 20

/** update 白名单：可修改字段（name/description/avatar/systemPrompt/llm/toolPolicy/deactivated） */
export type AiUpdatePatch = Partial<
  Pick<AiRecord, 'name' | 'description' | 'avatar' | 'systemPrompt' | 'llm' | 'toolPolicy' | 'deactivated'>
>

export interface AiManagerOptions {
  /** abyssac_data/ai-registry.json（registry 权威） */
  registryPath: string
  /** {root}/frontend/ai-prompts（提示词副本根，AI{aiId}/system.md） */
  aiPromptsRoot: string
  /** 莉莉丝角色文件（{root}/frontend/character/lilith.json；桌宠链路同一份文件）。
   * 未配置时默认从 aiPromptsRoot 推导（join(aiPromptsRoot, '..', 'character', 'lilith.json')）。 */
  lilithCharacterPath?: string
}

export class AiManager {
  constructor(private readonly opts: AiManagerOptions) {}

  // ===== 注册表查询 =====

  /** 全部 AI（含停用；前端自行按 deactivated 分组） */
  list(): AiRecord[] {
    return readAiRegistry(this.opts.registryPath).ais
  }

  get(id: number): AiRecord | null {
    return findAiById(readAiRegistry(this.opts.registryPath), id)
  }

  // ===== 注册 =====

  register(input: CustomAiInput): { ok: true; record: AiRecord; existing?: boolean } | { ok: false; error: string } {
    const nameErr = validateName(input.name)
    if (nameErr) return { ok: false, error: nameErr }
    const descErr = validateDescription(input.description)
    if (descErr) return { ok: false, error: descErr }
    const promptErr = validatePrompt(input.systemPrompt)
    if (promptErr) return { ok: false, error: promptErr }
    if (input.llm && !isValidLlm(input.llm)) {
      return { ok: false, error: 'llm 配置非法（model 须为字符串，temperature 须在 0-2 之间）' }
    }
    if (input.toolPolicy && !['default', 'restricted', 'full'].includes(input.toolPolicy)) {
      return { ok: false, error: 'toolPolicy 仅支持 default/restricted/full' }
    }

    // 重名/同 agent 幂等：返回已有记录（existing=true），不重复创建、不动已有副本
    const registry = readAiRegistry(this.opts.registryPath)
    const dup = registry.ais.find(
      (a) => a.name === input.name || (input.agent != null && a.agent === input.agent)
    )
    if (dup) {
      return { ok: true, record: dup, existing: true }
    }

    // 数量上限：custom AI 总数（含停用）不得超过 20
    const customCount = registry.ais.filter((a) => a.kind === 'custom').length
    if (customCount >= MAX_CUSTOM_AIS) {
      return { ok: false, error: `自定义 AI 数量已达上限（${MAX_CUSTOM_AIS} 个），请先停用/清理再扩容` }
    }
    // parentAiId 溯源校验：父 AI 必须真实存在（防悬空引用）
    if (input.parentAiId != null && !findAiById(registry, input.parentAiId)) {
      return { ok: false, error: `创建者 AI（id=${input.parentAiId}）不存在` }
    }

    const record = registerCustomAi(this.opts.registryPath, input)
    // 新建 → 同步提示词副本（空 = 不建副本，运行时回退内置模板）
    this.syncPromptCopy(record.id, input.systemPrompt)
    return { ok: true, record: this.get(record.id) ?? record }
  }

  // ===== 更新 =====

  /** 白名单字段更新；systemPrompt 变更同步写/清副本 */
  update(id: number, patch: AiUpdatePatch): { ok: true; record: AiRecord } | { ok: false; error: string } {
    const registry = readAiRegistry(this.opts.registryPath)
    const record = findAiById(registry, id)
    if (!record) return { ok: false, error: `AI（id=${id}）不存在` }

    // name/description/avatar 校验
    if (patch.name !== undefined) {
      const err = validateName(patch.name)
      if (err) return { ok: false, error: err }
    }
    if (patch.description !== undefined) {
      const err = validateDescription(patch.description)
      if (err) return { ok: false, error: err }
    }
    if (patch.avatar !== undefined) {
      const avatarErr = validateAvatar(patch.avatar)
      if (avatarErr) return { ok: false, error: avatarErr }
    }
    if (patch.systemPrompt !== undefined) {
      const err = validatePrompt(patch.systemPrompt)
      if (err) return { ok: false, error: err }
    }
    if (patch.llm !== undefined && !isValidLlm(patch.llm)) {
      return { ok: false, error: 'llm 配置非法（model 须为字符串，temperature 须在 0-2 之间）' }
    }
    if (patch.toolPolicy !== undefined && !['default', 'restricted', 'full'].includes(patch.toolPolicy)) {
      return { ok: false, error: 'toolPolicy 仅支持 default/restricted/full' }
    }

    // 只写白名单字段；agent/id/kind/parentAiId/createdAt 不可改
    if (patch.name !== undefined) record.name = patch.name
    if (patch.description !== undefined) record.description = patch.description || undefined
    if (patch.avatar !== undefined) record.avatar = patch.avatar || undefined
    if (patch.systemPrompt !== undefined) record.systemPrompt = patch.systemPrompt?.trim() || undefined
    if (patch.llm !== undefined) record.llm = patch.llm
    if (patch.toolPolicy !== undefined) record.toolPolicy = patch.toolPolicy
    if (patch.deactivated !== undefined) record.deactivated = patch.deactivated

    writeAiRegistry(this.opts.registryPath, registry)

    // systemPrompt 变更 → 同步副本（空 = 回退内置，清掉副本）
    if (patch.systemPrompt !== undefined) {
      this.syncPromptCopy(id, record.systemPrompt)
    }
    return { ok: true, record: this.get(id) ?? record }
  }

  // ===== 软停用/恢复 =====

  /** 软停用：数据保留、不可续聊（system AI 不可停用） */
  deactivate(id: number): { ok: true; record: AiRecord } | { ok: false; error: string } {
    const registry = readAiRegistry(this.opts.registryPath)
    const record = findAiById(registry, id)
    if (!record) return { ok: false, error: `AI（id=${id}）不存在` }
    if (record.kind === 'system') return { ok: false, error: '系统 AI 不可停用' }
    record.deactivated = true
    writeAiRegistry(this.opts.registryPath, registry)
    return { ok: true, record }
  }

  reactivate(id: number): { ok: true; record: AiRecord } | { ok: false; error: string } {
    const registry = readAiRegistry(this.opts.registryPath)
    const record = findAiById(registry, id)
    if (!record) return { ok: false, error: `AI（id=${id}）不存在` }
    record.deactivated = false
    writeAiRegistry(this.opts.registryPath, registry)
    return { ok: true, record }
  }

  // ===== 删除（真删除） =====

  /**
   * 删除 custom AI：注册表记录 + 提示词副本目录（AI{id}/）一并移除。
   * - system AI 拒绝（内置月蚀/莉莉丝不可删）
   * - 历史会话只存 aiId，删除后 resolveSessionAiId 回退到 1（月蚀），无悬挂引用
   */
  remove(id: number): { ok: true } | { ok: false; error: string } {
    const registry = readAiRegistry(this.opts.registryPath)
    const record = findAiById(registry, id)
    if (!record) return { ok: false, error: `AI（id=${id}）不存在` }
    if (record.kind === 'system') return { ok: false, error: '系统 AI 不可删除' }
    // 清理提示词副本目录（整目录删除，含 system.md）
    const copyDir = join(this.opts.aiPromptsRoot, `AI${id}`)
    if (existsSync(copyDir)) rmSync(copyDir, { recursive: true, force: true })
    // 移除注册表记录
    registry.ais = registry.ais.filter((a) => a.id !== id)
    writeAiRegistry(this.opts.registryPath, registry)
    return { ok: true }
  }

  // ===== 提示词副本（运行时注入唯一权威） =====
  // 为什么是"注册表字段 + 文件副本"双存储，而非单一来源：
  // - 注册表 `systemPrompt` 字段 = 编辑面板快照，随记录一起序列化，列表页/面板秒读、便于备份；
// - 文件副本 `AI{aiId}/` = 运行时注入正本，独立于注册表 JSON，可单独替换/回滚，
// 且按 AI 目录隔离多 AI 各自的提示词；
  // - 二者经 register/update 双端同步保持一致，无副本/空副本 = 不注入自定义内容。
  // 结论：运行时永远只有一份生效（副本 或 内置模板），注册表字段不直接参与注入。
  //
  // 文件粒度语义（设计依据：副本按文件替换而非整目录覆盖——同名文件对齐、
  // 独有文件保留、删除只发生在明确移除时，避免一次同步误伤整个提示词目录）：
  // ai-prompts/AI{aiId}/ 与内置 prompts/ 同构：
  // AI{aiId}/frontend/* 覆盖 prompts/frontend/*（同名换、独有加、无则用内置）
  // AI{aiId}/shared/* 覆盖 prompts/shared/*
  // AI{aiId}/system.md 整包仅作旧数据/旧面板兼容：仅当 frontend/ 子层不存在时空闲生效。
  // readPrompt 返回 frontend 层合并文本（含内置基底）；无任何副本 → null（segments 回退内置）。

  /** 提示词副本整包路径：{aiPromptsRoot}/AI{aiId}/system.md（旧面板编辑器兼容） */
  getPromptPath(aiId: number): string {
    return join(this.opts.aiPromptsRoot, `AI${aiId}`, 'system.md')
  }

  /** 副本子层目录：{aiPromptsRoot}/AI{aiId}/{layer} */
  private layerDir(aiId: number, layer: PromptLayer): string {
    return join(this.opts.aiPromptsRoot, `AI${aiId}`, layer)
  }

  /** 校验副本文件名：仅 .md/.txt、单层文件名（禁路径穿越） */
  private validatePromptFileName(name: string): string | null {
    if (typeof name !== 'string') return '文件名非法'
    const trimmed = name.trim()
    if (!/^[^\\/]+$/.test(trimmed)) return '文件名不能包含路径分隔符'
    if (!/\.(md|txt)$/i.test(trimmed)) return '仅支持 .md/.txt 文件'
    if (trimmed === '.' || trimmed === '..') return '文件名非法'
    return null
  }

  /** 读取 frontend 层运行时文本（文件粒度合并；无副本返回 null） */
  readPrompt(aiId: number): string | null {
    return this.readLayer(aiId, 'frontend')
  }

  /** 读取 shared 层运行时文本（文件粒度合并；无副本返回 null） */
  readSharedPrompt(aiId: number): string | null {
    return this.readLayer(aiId, 'shared')
  }

  /** 读取某层合并文本：副本子层存在 → 文件粒度合并；莉莉丝 frontend 走派生基底；否则旧 system.md 整包兼容（仅 frontend）；否则 null */
  private readLayer(aiId: number, layer: PromptLayer): string | null {
    // 莉莉丝特殊化：frontend 层基底 = lilith.json 派生（恒非空，不回落月蚀 frontend 模板）
    if (layer === 'frontend' && this.isLilithAi(aiId)) {
      const merged = this.mergeLilithLayer(aiId)
      return merged.text.trim() ? merged.text : null
    }
    if (this.hasLayerFiles(aiId, layer)) {
      const merged = this.mergeLayer(aiId, layer)
      return merged.text.trim() ? merged.text : null
    }
    // 旧整包兼容：system.md 仅覆盖 frontend 层（shared 层无整包概念）
    if (layer === 'frontend') {
      const p = this.getPromptPath(aiId)
      if (existsSync(p)) {
        const content = readFileSync(p, 'utf-8').trim()
        return content.length > 0 ? content : null
      }
    }
    return null
  }

  /** 某层文件粒度合并（内置基底 + 副本覆盖），供运行时注入与面板预览 */
  private mergeLayer(aiId: number, layer: PromptLayer): PromptLayerResult {
    if (layer === 'frontend' && this.isLilithAi(aiId)) {
      return this.mergeLilithLayer(aiId)
    }
    return layer === 'frontend'
      ? loadFrontendPromptForAi(this.opts.aiPromptsRoot, aiId)
      : loadSharedPromptsForAi(this.opts.aiPromptsRoot, aiId)
  }

  // ===== 莉莉丝特殊化（普通会话与桌宠共用同一份 lilith.json） =====

  /** 是否莉莉丝 AI（按注册表 agent 判定，不硬编码 id=2） */
  private isLilithAi(aiId: number): boolean {
    return findAiById(readAiRegistry(this.opts.registryPath), aiId)?.agent === 'lilith'
  }

  /** 莉莉丝角色文件路径（默认从 aiPromptsRoot 推导 {root}/frontend/character/lilith.json） */
  private lilithCharacterFile(): string {
    return this.opts.lilithCharacterPath ?? join(join(this.opts.aiPromptsRoot, '..', 'character'), 'lilith.json')
  }

  /** 读取莉莉丝角色 JSON（解析失败/不存在返回 null，派生函数内部回退默认人设） */
  private readLilithCharacter(): Record<string, unknown> | null {
    const p = this.lilithCharacterFile()
    if (!existsSync(p)) return null
    try {
      return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
    } catch (err) {
      console.warn(`[ai-manager] lilith.json 解析失败，使用默认人设: ${err}`)
      return null
    }
  }

  /** 莉莉丝 frontend 层虚拟内置基底（不落盘，由 lilith.json 单源派生；可被同名副本替换） */
  private lilithVirtualBuiltins(): VirtualBuiltinFile[] {
    const character = this.readLilithCharacter()
    return [{ name: 'lilith-persona.md', content: buildLilithSessionPersona(character) }]
  }

  /** 莉莉丝 frontend 层文件粒度合并：虚拟内置基底 + 副本目录覆盖（有副本用副本） */
  private mergeLilithLayer(aiId: number): PromptLayerResult {
    return mergePromptFiles(this.lilithVirtualBuiltins(), this.layerDir(aiId, 'frontend'), `莉莉丝人设(AI${aiId})`)
  }

  /** 列出某 AI frontend/shared 层参与合并的文件清单（含内置基底与副本标记），面板文件级编辑用 */
  listPromptFiles(aiId: number): { frontend: PromptLayerResult['files']; shared: PromptLayerResult['files'] } {
    return {
      frontend: this.mergeLayer(aiId, 'frontend').files,
      shared: this.mergeLayer(aiId, 'shared').files
    }
  }

  /** 读取某层某文件的副本内容；无副本（用内置）返回 null */
  readPromptFile(aiId: number, layer: PromptLayer, name: string): string | null {
    const err = this.validatePromptFileName(name)
    if (err) return null
    const p = join(this.layerDir(aiId, layer), name.trim())
    if (!existsSync(p)) return null
    const content = readFileSync(p, 'utf-8').trim()
    return content.length > 0 ? content : null
  }

  /** 读取内置模板某层某文件内容（供 UI「建立副本」复制基底）；无此内置文件返回 null。
   * lilith-persona.md / lilith-session.md 是莉莉丝虚拟内置（lilith.json 派生，不落盘），
   * 传入 aiId 后返回推导文本，允许前端对其建立副本覆盖。 */
  readBuiltinPromptFile(layer: PromptLayer, name: string, aiId?: number): string | null {
    const err = this.validatePromptFileName(name)
    if (err) return null
    const trimmed = name.trim()
    // 莉莉丝虚拟内置：仅 frontend 层
    if (layer === 'frontend' && aiId !== undefined && this.isLilithAi(aiId)) {
      const virtual = this.lilithVirtualBuiltins().find((f) => f.name === trimmed)
      if (virtual) return virtual.content.trim() || null
      return null
    }
    const p = join(getPromptsDir(), layer, trimmed)
    if (!existsSync(p)) return null
    const content = readFileSync(p, 'utf-8').trim()
    return content.length > 0 ? content : null
  }

  /** 读取某层某文件的运行时详情：副本内容（无副本 null）+ 内置基底 + 当前生效来源（面板文件级编辑器用） */
  readPromptFileDetail(
    aiId: number,
    layer: PromptLayer,
    name: string
  ): { content: string | null; builtin: string | null; source: 'override' | 'builtin' } {
    const override = this.readPromptFile(aiId, layer, name)
    const builtin = this.readBuiltinPromptFile(layer, name, aiId)
    return { content: override, builtin, source: override != null ? 'override' : 'builtin' }
  }

  /** 写某层某文件的副本（自动建目录）；内容为空 = 删除副本恢复内置 */
  writePromptFile(aiId: number, layer: PromptLayer, name: string, content: string): { ok: true } | { ok: false; error: string } {
    const nameErr = this.validatePromptFileName(name)
    if (nameErr) return { ok: false, error: nameErr }
    const promptErr = validatePrompt(content)
    if (promptErr) return { ok: false, error: promptErr }
    const trimmed = name.trim()
    const p = join(this.layerDir(aiId, layer), trimmed)
    if (!content.trim()) {
      // 空内容 = 删除副本，恢复内置
      if (existsSync(p)) rmSync(p, { force: true })
      this.pruneEmptyLayer(aiId, layer)
      this.syncPromptCopy(aiId)
      return { ok: true }
    }
    mkdirSync(join(this.opts.aiPromptsRoot, `AI${aiId}`, layer), { recursive: true })
    writeFileSync(p, content.trim(), 'utf-8')
    this.syncPromptCopy(aiId)
    return { ok: true }
  }

  /** 删除某层某文件的副本（恢复内置）；层内无文件时移除空目录 */
  clearPromptFile(aiId: number, layer: PromptLayer, name: string): void {
    const err = this.validatePromptFileName(name)
    if (err) return
    const p = join(this.layerDir(aiId, layer), name.trim())
    if (existsSync(p)) rmSync(p, { force: true })
    this.pruneEmptyLayer(aiId, layer)
    this.syncPromptCopy(aiId)
  }

  /** 清理空子层目录（避免残留空目录干扰 hasLayerFiles 判断） */
  private pruneEmptyLayer(aiId: number, layer: PromptLayer): void {
    const dir = this.layerDir(aiId, layer)
    if (!existsSync(dir)) return
    const left = readdirSync(dir).filter((f) => !f.startsWith('.'))
    if (left.length === 0) rmSync(dir, { recursive: true, force: true })
  }

  /** 写整包（旧面板编辑器用，保持兼容：写 system.md，清空 = 回退内置） */
  writePrompt(aiId: number, content: string): { ok: true } | { ok: false; error: string } {
    const err = validatePrompt(content)
    if (err) return { ok: false, error: err }
    const p = this.getPromptPath(aiId)
    if (!content.trim()) {
      if (existsSync(p)) rmSync(p, { force: true })
      return { ok: true }
    }
    mkdirSync(join(this.opts.aiPromptsRoot, `AI${aiId}`), { recursive: true })
    writeFileSync(p, content.trim(), 'utf-8')
    return { ok: true }
  }

  /** 清整包（回退内置提示词） */
  clearPrompt(aiId: number): void {
    const p = this.getPromptPath(aiId)
    if (existsSync(p)) rmSync(p, { force: true })
  }

  /** 副本与注册表 systemPrompt 保持同步（副本是运行时权威） */
  private syncPromptCopy(aiId: number, systemPrompt?: string): void {
    // 文件粒度模式（frontend/ 或 shared/ 子层已有副本文件）：system.md 整包不参与注入，
    // 删除避免"副本删光后旧整包复活"；注册表字段由调用方（面板/API）另行维护快照。
    if (this.hasLayerFiles(aiId, 'frontend') || this.hasLayerFiles(aiId, 'shared')) {
      this.clearPrompt(aiId)
      return
    }
    if (systemPrompt && systemPrompt.trim()) {
      this.writePrompt(aiId, systemPrompt)
    } else {
      this.clearPrompt(aiId)
    }
  }

  /** 某层子目录是否已有提示词文件（.md/.txt，跳过隐藏文件） */
  private hasLayerFiles(aiId: number, layer: PromptLayer): boolean {
    const layerPath = this.layerDir(aiId, layer)
    return (
      existsSync(layerPath) &&
      readdirSync(layerPath).some((f) => !f.startsWith('.') && /\.(md|txt)$/i.test(f) && statSync(join(layerPath, f)).isFile())
    )
  }
}

/** AI 副本子层：frontend（系统提示词）/ shared（通用机制） */
export type PromptLayer = 'frontend' | 'shared'

// ===== 校验 =====

function validateName(name: string): string | null {
  const trimmed = String(name ?? '').trim()
  if (trimmed.length < MIN_NAME_LEN || trimmed.length > MAX_NAME_LEN) {
    return `名字长度需在 ${MIN_NAME_LEN}-${MAX_NAME_LEN} 字符之间`
  }
  if (!NAME_PATTERN.test(trimmed)) {
    return '名字仅支持中文/英文/数字/部分符号（· - . _）'
  }
  return null
}

function validateDescription(desc?: string): string | null {
  if (desc === undefined) return null
  if (String(desc).length > MAX_DESC_LEN) return `简介过长（≤${MAX_DESC_LEN} 字符）`
  return null
}

/**
 * avatar 合法形态：
 * - 短文本（默认 emoji，如 ✨🌙🦊）→ 直接原样渲染
 * - 本地图片引用（img:avatars/ai/{id}/avatar.png，ai:saveAvatarImage 落盘后由前端
 * 写回此字段）→ 以 img: 前缀，前端经 lune-media:/// 渲染
 * 阈值从 ≤16 放宽到 ≤256（图片引用路径更长）。
 */
const MAX_AVATAR_LEN = 256
function validateAvatar(avatar?: string): string | null {
  if (avatar === undefined) return null
  const s = String(avatar)
  if (s.length > MAX_AVATAR_LEN) return `avatar 过长（≤${MAX_AVATAR_LEN} 字符）`
  if (/[\r\n\\]/.test(s)) return 'avatar 含非法字符'
  return null
}

function validatePrompt(prompt?: string): string | null {
  if (prompt === undefined) return null
  if (String(prompt).length > MAX_PROMPT_LEN) return `提示词过长（≤${MAX_PROMPT_LEN} 字符）`
  return null
}

function isValidLlm(llm: NonNullable<AiRecord['llm']>): boolean {
  if (llm.model !== undefined && typeof llm.model !== 'string') return false
  if (llm.temperature !== undefined) {
    const t = Number(llm.temperature)
    if (!Number.isFinite(t) || t < 0 || t > 2) return false
  }
  return true
}