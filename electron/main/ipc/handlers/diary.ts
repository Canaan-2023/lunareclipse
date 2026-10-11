/**
 * 日记 IPC：前端「日历面板」按日期读取当天日记——diary.md 刻意存放在
 * 当天 RAW 目录（与对话原文同处，翻历史时就在旁边），由
 * DiaryWorkflowScheduler 撰写，本模块只做路径解析与读取。
 * 不删掉的理由：日记检索线（先读 diary/{年}/{月}/index.json 定位 → 读 diary.md → 再翻同日期 RAW）
 * 的前端入口是日历面板；无本 IPC 则前端无法展示日记，时间轴检索线断在展示层。
 */
import type { ipcMain as ipcMainType } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, statSync } from 'fs'
import type { BaseDataPaths } from '../../models/paths'
import type { UserStore } from '../../models/user-store'
import { resolveScopePaths } from '../../models/paths'
import { safeHandle, errorFallback } from './safe-handle'
import { DEFAULT_AI_ID } from '@shared/types'

const MAX_DIARY_FILE_SIZE = 10 * 1024 * 1024

/**
* 日记系统 IPC：前端「日历面板」按日期读取当天日记。
 * 日记正文刻意放在当天 RAW 目录下：memory/U{uid}/AI{aiId}/raw_memory/YYYY/MM/DD/diary.md
 * （和对话原文同目录——翻当天历史时日记就在旁边；由后端 DiaryWorkflowScheduler 撰写）
 */
export function resolveDiaryFile(dataPaths: BaseDataPaths, uid: number, date: string, aiId = DEFAULT_AI_ID): string {
  const scoped = resolveScopePaths(dataPaths, { uid, aiId })
  const [y, m, d] = date.split('-')
  return join(scoped.rawMemory ?? join(dataPaths.root, 'memory', `U${uid}`, `AI${aiId}`, 'raw_memory'), y, m, d, 'diary.md')
}

/** 当前登录用户 UID（无登录态返回 null） */
function currentUid(getUserStore: () => UserStore | null): number | null {
  return getUserStore()?.getCurrentUser()?.UID ?? null
}

export function registerDiaryHandlers(
  ipc: typeof ipcMainType,
  getDataPaths: () => BaseDataPaths | null,
  getUserStore: () => UserStore | null
): void {
  safeHandle(
    ipc,
    'diary:get',
    (_event, date: unknown) => {
      const paths = getDataPaths()
      const uid = currentUid(getUserStore)
      if (!paths || uid === null) return { ok: false, error: '数据路径或登录态未就绪' }
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { ok: false, error: 'date 必填，格式 YYYY-MM-DD' }
      }
      const file = resolveDiaryFile(paths, uid, date)
      if (!existsSync(file)) return { ok: true, content: null }
      const stat = statSync(file)
      if (stat.size > MAX_DIARY_FILE_SIZE) {
        return { ok: false, error: `日记文件过大（${stat.size} 字节，上限 ${MAX_DIARY_FILE_SIZE} 字节）` }
      }
      return { ok: true, content: readFileSync(file, 'utf-8') }
    },
    errorFallback('读取日记失败')
  )
}
