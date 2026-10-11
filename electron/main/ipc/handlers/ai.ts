/**
 * AI 管理 IPC（多 AI 子系统 P1 注册表接线）：渲染进程的 AI 面板与
 * 会话切换器经 ai:* 通道完成注册/更新/启停/删除与提示词读写，
 * 无状态服务每次调用现构造，避免初始化时序问题。
 */
import type { IpcMainInvokeEvent } from 'electron'
import { join } from 'path'
import type { BaseDataPaths } from '../../models/paths'
import type { CustomAiInput } from '../../models/ai-registry'
import { AiManager, type AiUpdatePatch } from '../../services/ai-manager'
import { purgeAiWorkspace } from '../../services/ai-workspace-purge'
import { saveAvatarImage } from '../../models/avatars'
import type { SessionStore } from '../../api/session-store'

/**
 * AI 管理 IPC handler（多 AI 子系统 P1：注册表接线）。
 *
 * 前端调用面（AiManagerPanel / 会话切换器）：
 * ai:list → { ok, ais } 全部 AI（含停用，前端分组）
 * ai:register → { ok, record, existing?, error? } 新建 custom AI（重名返回已有）
 * ai:update → { ok, record, error? } 白名单字段更新（提示词同步副本）
 * ai:deactivate → { ok, record, error? } 软停用（system 拒停）
 * ai:reactivate → { ok, record, error? } 恢复
 * ai:remove → { ok, removed?, error? } 真删除 custom AI（system 拒绝；级联清空该 AI 全部工作域）
 * ai:getPrompt → { ok, content: string|null, path } 读提示词副本
 * ai:savePrompt → { ok, error? } 直接保存提示词副本（面板编辑器）
 *
 * 依赖仅为 getDataPaths + getSessionStore + getUserStore（无状态服务，每次调用现构造，无初始化时序问题）。
 */
export function registerAiHandlers(
  ipc: typeof import('electron').ipcMain,
  getDataPaths: () => BaseDataPaths | null,
  getSessionStore?: () => SessionStore | null,
  getUserStore?: () => import('../../models/user-store').UserStore | null
): void {
  const makeManager = (): AiManager | null => {
    const paths = getDataPaths()
    if (!paths) return null
    return new AiManager({
      registryPath: paths.aiRegistryJson,
      aiPromptsRoot: join(paths.frontend, 'ai-prompts'),
      // 莉莉丝虚拟内置（lilith-persona.md/lilith-session.md）派生自同一份 lilith.json
      lilithCharacterPath: join(paths.frontend, 'character', 'lilith.json')
    })
  }

  // 列表（全部 AI，含停用；不含提示词正文，正文按需 getPrompt 拉取）
  ipc.handle('ai:list', () => {
    const mgr = makeManager()
    if (!mgr) return { ok: false, error: '数据路径未就绪' }
    try {
      return { ok: true, ais: mgr.list() }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // 注册 custom AI
  ipc.handle('ai:register', (_e: IpcMainInvokeEvent, input: CustomAiInput = { name: '' }) => {
    const mgr = makeManager()
    if (!mgr) return { ok: false, error: '数据路径未就绪' }
    try {
      const r = mgr.register(input)
      if (r.ok && !r.existing) {
        // 新 AI 已入注册表 → 立即补建该用户的作用域目录骨架（skills/config/skills_domains/memory/sessions 等）。
        // 为什么需要：骨架创建（ensureScope）原本只在登录/注册时按当时注册表遍历一次，运行期新增 AI
        // 不触发；若此刻不补，用户切到新 AI 立即安装 skill / 读写 config 会撞上目录不存在的 ENOENT。
        // 幂等：mkdirSync recursive，已存在目录跳过。
        const store = getUserStore?.()
        const uid = store?.getCurrentUser()?.UID
        if (store && uid != null) {
          try {
            store.ensureScope(uid)
          } catch (err) {
            console.error(`[ai:register] 为新 AI 补建作用域骨架失败 (uid=${uid}, aiId=${r.record.id}):`, err)
          }
        }
      }
      return r.ok ? { ok: true, record: r.record, existing: r.existing === true } : { ok: false, error: r.error }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // 白名单更新
  ipc.handle('ai:update', (_e: IpcMainInvokeEvent, id: number, patch: AiUpdatePatch = {}) => {
    const mgr = makeManager()
    if (!mgr) return { ok: false, error: '数据路径未就绪' }
    if (!Number.isInteger(id)) return { ok: false, error: 'id 必须为整数' }
    try {
      const r = mgr.update(id, patch)
      return r.ok ? { ok: true, record: r.record } : { ok: false, error: r.error }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // 软停用
  ipc.handle('ai:deactivate', (_e: IpcMainInvokeEvent, id: number) => {
    const mgr = makeManager()
    if (!mgr) return { ok: false, error: '数据路径未就绪' }
    try {
      const r = mgr.deactivate(id)
      return r.ok ? { ok: true, record: r.record } : { ok: false, error: r.error }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // 恢复
  ipc.handle('ai:reactivate', (_e: IpcMainInvokeEvent, id: number) => {
    const mgr = makeManager()
    if (!mgr) return { ok: false, error: '数据路径未就绪' }
    try {
      const r = mgr.reactivate(id)
      return r.ok ? { ok: true, record: r.record } : { ok: false, error: r.error }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // 删除（真删除 custom AI：注册表记录 + 提示词副本目录 + 该 AI 全部工作域一并移除；system 拒绝）
  ipc.handle('ai:remove', (_e: IpcMainInvokeEvent, id: number) => {
    const mgr = makeManager()
    if (!mgr) return { ok: false, error: '数据路径未就绪' }
    if (!Number.isInteger(id)) return { ok: false, error: 'id 必须为整数' }
    try {
      const r = mgr.remove(id)
      if (!r.ok) return r
      // 级联清除该 AI 的工作域内容（记忆/RAW/NNG/自我认知/头像/会话/社交私聊等），
      // 保证「一个 AI 一个域」——AI 删除后数据不留到其他 AI（尤其月蚀 AI1）域。
      const paths = getDataPaths()
      const removedDirs: string[] = []
      let removedFiles: string[] = []
      let removedSessions: string[] = []
      if (paths) {
        const purged = purgeAiWorkspace(paths, id)
        removedDirs.push(...purged.removedDirs)
        removedFiles = purged.removedFiles
      }
      // 会话级联删除：SessionStore 内存缓存 + 磁盘目录中 meta.aiId===id 的会话
      const ss = getSessionStore?.()
      if (ss) {
        removedSessions = ss.deleteByAiId(id)
      }
      return { ok: true, removed: { dirs: removedDirs, files: removedFiles, sessions: removedSessions } }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // 读提示词副本（null = 无自定义，回退内置模板）
  ipc.handle('ai:getPrompt', (_e: IpcMainInvokeEvent, id: number) => {
    const mgr = makeManager()
    if (!mgr) return { ok: false, error: '数据路径未就绪' }
    try {
      if (mgr.get(id) == null) return { ok: false, error: `AI（id=${id}）不存在` }
      return { ok: true, content: mgr.readPrompt(id), path: mgr.getPromptPath(id) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // 直接保存提示词副本（面板编辑器用，同步回注册表 systemPrompt）
  ipc.handle('ai:savePrompt', (_e: IpcMainInvokeEvent, id: number, content: string) => {
    const mgr = makeManager()
    if (!mgr) return { ok: false, error: '数据路径未就绪' }
    try {
      const w = mgr.writePrompt(id, content)
      if (!w.ok) return { ok: false, error: w.error }
      // 副本更新后回写注册表 systemPrompt（保持双端一致）
      const u = mgr.update(id, { systemPrompt: content })
      if (!u.ok) return { ok: false, error: u.error }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // 文件粒度副本：列出 AI frontend/shared 层的文件清单（含内置基底与副本标记）
  ipc.handle('ai:listPromptFiles', (_e: IpcMainInvokeEvent, id: number) => {
    const mgr = makeManager()
    if (!mgr) return { ok: false, error: '数据路径未就绪' }
    try {
      if (mgr.get(id) == null) return { ok: false, error: `AI（id=${id}）不存在` }
      return { ok: true, layers: mgr.listPromptFiles(id) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // 文件粒度副本：读取某层某文件（副本内容 null=无副本走内置；附内置基底与生效来源，供面板「建立副本」）
  ipc.handle('ai:readPromptFile', (_e: IpcMainInvokeEvent, id: number, layer: string, name: string) => {
    const mgr = makeManager()
    if (!mgr) return { ok: false, error: '数据路径未就绪' }
    if (layer !== 'frontend' && layer !== 'shared') return { ok: false, error: '层名非法' }
    try {
      return { ok: true, ...mgr.readPromptFileDetail(id, layer, name) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // 文件粒度副本：写某层某文件副本（空内容 = 删除副本恢复内置）
  ipc.handle('ai:savePromptFile', (_e: IpcMainInvokeEvent, id: number, layer: string, name: string, content: string) => {
    const mgr = makeManager()
    if (!mgr) return { ok: false, error: '数据路径未就绪' }
    if (layer !== 'frontend' && layer !== 'shared') return { ok: false, error: '层名非法' }
    try {
      const w = mgr.writePromptFile(id, layer, name, content)
      if (!w.ok) return { ok: false, error: w.error }
      // frontend 层保存后同步注册表 systemPrompt（保持旧面板快照字段可用）
      if (layer === 'frontend') {
        const u = mgr.update(id, { systemPrompt: mgr.readPrompt(id) ?? '' })
        if (!u.ok) return { ok: false, error: u.error }
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // 文件粒度副本：删除某层某文件副本（恢复内置）
  ipc.handle('ai:clearPromptFile', (_e: IpcMainInvokeEvent, id: number, layer: string, name: string) => {
    const mgr = makeManager()
    if (!mgr) return { ok: false, error: '数据路径未就绪' }
    if (layer !== 'frontend' && layer !== 'shared') return { ok: false, error: '层名非法' }
    try {
      mgr.clearPromptFile(id, layer, name)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // 保存 AI 头像图片（dataURL → avatars/ai/{id}/avatar.ext），返回 img: 引用（前端经 ai:update 写回 avatar 字段）
  ipc.handle('ai:saveAvatarImage', (_e: IpcMainInvokeEvent, id: number, dataUrl: string) => {
    const paths = getDataPaths()
    if (!paths) return { ok: false, error: '数据路径未就绪' }
    if (!Number.isInteger(id)) return { ok: false, error: 'id 必须为整数' }
    if (typeof dataUrl !== 'string') return { ok: false, error: '图片数据格式错误' }
    try {
      const r = saveAvatarImage(paths.root, 'ai', id, dataUrl)
      return r.ok ? { ok: true, ref: r.ref } : { ok: false, error: r.error }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
}