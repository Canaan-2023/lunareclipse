/**
 * AI 管理（多 AI 子系统 P1：注册表接线）preload 域。
 * 为什么存在：AI 注册表（ai-registry.json）与提示词副本由主进程持久化持有，前端管理面板
 * 与会话切换器必须经此桥读写注册表，渲染进程不能直接访问主进程文件系统。
 * 作用：暴露 window.lunareclipse.ai.* 的注册表列/建/改/停用/恢复/删除与提示词读写等
 * 方法（调用面见下方原注释）。
 */
import { ipcRenderer } from 'electron'
import type { AiRecord, CustomAiInput } from '../../main/models/ai-registry'
import type { AiUpdatePatch } from '../../main/services/ai-manager'

/**
 * AI 管理 preload 域（多 AI 子系统 P1：注册表接线）。
 * window.lunareclipse.ai.* 由本域暴露（spread 组合进主 api 对象）。

 * 调用面：AiManagerPanel（列表/创建/编辑/提示词/停用）+ 会话切换器（选 AI 建会话）。
 */
export const api = {
  // ===== AI 注册表管理 =====
  /** 全部 AI（含停用；前端按 deactivated 分组） */
  aiList: () => ipcRenderer.invoke('ai:list') as Promise<{ ok: boolean; ais?: AiRecord[]; error?: string }>,
  /** 新建 custom AI（重名/同 agent 返回已有，existing=true） */
  aiRegister: (input: CustomAiInput) =>
    ipcRenderer.invoke('ai:register', input) as Promise<{ ok: boolean; record?: AiRecord; existing?: boolean; error?: string }>,
  /** 白名单字段更新（name/description/avatar/systemPrompt/llm/toolPolicy/deactivated） */
  aiUpdate: (id: number, patch: AiUpdatePatch) =>
    ipcRenderer.invoke('ai:update', id, patch) as Promise<{ ok: boolean; record?: AiRecord; error?: string }>,
  /** 软停用（system AI 拒绝） */
  aiDeactivate: (id: number) =>
    ipcRenderer.invoke('ai:deactivate', id) as Promise<{ ok: boolean; record?: AiRecord; error?: string }>,
  /** 恢复停用 */
  aiReactivate: (id: number) =>
    ipcRenderer.invoke('ai:reactivate', id) as Promise<{ ok: boolean; record?: AiRecord; error?: string }>,
  /** 删除 custom AI（system 拒绝；注册表记录 + 提示词副本 + 级联清除该 AI 全部工作域；removed=清除统计） */
  aiRemove: (id: number) =>
    ipcRenderer.invoke('ai:remove', id) as Promise<{
      ok: boolean
      removed?: { dirs: string[]; files: string[]; sessions: string[] }
      error?: string
    }>,
  /** 读提示词副本（null = 无自定义，回退内置模板） */
  aiGetPrompt: (id: number) =>
    ipcRenderer.invoke('ai:getPrompt', id) as Promise<{ ok: boolean; content?: string | null; path?: string; error?: string }>,
  /** 直接保存提示词副本（同步回注册表 systemPrompt） */
  aiSavePrompt: (id: number, content: string) =>
    ipcRenderer.invoke('ai:savePrompt', id, content) as Promise<{ ok: boolean; error?: string }>,
  /** 文件粒度：列出 AI frontend/shared 层参与合并的文件清单（source: builtin|override） */
  aiListPromptFiles: (id: number) =>
    ipcRenderer.invoke('ai:listPromptFiles', id) as Promise<{
      ok: boolean
      layers?: {
        frontend: Array<{ name: string; source: 'builtin' | 'override' }>
        shared: Array<{ name: string; source: 'builtin' | 'override' }>
      }
      error?: string
    }>,
  /** 文件粒度：读某层某文件运行时详情（content=副本内容 null=走内置；builtin=内置基底；source=当前生效来源） */
  aiReadPromptFile: (id: number, layer: string, name: string) =>
    ipcRenderer.invoke('ai:readPromptFile', id, layer, name) as Promise<{
      ok: boolean
      content?: string | null
      builtin?: string | null
      source?: 'override' | 'builtin'
      error?: string
    }>,
  /** 文件粒度：写某层某文件副本（空内容 = 删除副本恢复内置），frontend 层同步注册表快照 */
  aiSavePromptFile: (id: number, layer: string, name: string, content: string) =>
    ipcRenderer.invoke('ai:savePromptFile', id, layer, name, content) as Promise<{ ok: boolean; error?: string }>,
  /** 文件粒度：删除某层某文件副本（恢复内置） */
  aiClearPromptFile: (id: number, layer: string, name: string) =>
    ipcRenderer.invoke('ai:clearPromptFile', id, layer, name) as Promise<{ ok: boolean; error?: string }>,
  /** 保存 AI 头像图片（dataURL → avatars/ai/{id}/avatar.ext），返回 img: 引用（再经 ai:update 写回 avatar 字段） */
  aiSaveAvatarImage: (id: number, dataUrl: string) =>
    ipcRenderer.invoke('ai:saveAvatarImage', id, dataUrl) as Promise<{ ok: boolean; ref?: string; error?: string }>
}