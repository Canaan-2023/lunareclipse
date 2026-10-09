/**
 * 为什么存在：索引是 AI 读取记忆的目录，若与实际文件失步会查错/漏查，须按实际文件状态校准索引。
 * 作用：对变更路径执行 NNG root.json 与 cache index.json 的 upsert/remove，并联动孤儿检查。
 */

import { existsSync, statSync } from 'fs'
import { normalizePath } from '../models/paths'
import { OrphanCheck } from './orphan-check'
import { ErrorLog } from './error-log'

export class IndexSync {
  private nngRootJson: string
  private cacheIndexJson: string
  private orphan: OrphanCheck
  private errorLog: ErrorLog

  constructor(
    nngRootJson: string,
    cacheIndexJson: string,
    orphan: OrphanCheck,
    errorLog: ErrorLog
  ) {
    this.nngRootJson = normalizePath(nngRootJson)
    this.cacheIndexJson = normalizePath(cacheIndexJson)
    this.orphan = orphan
    this.errorLog = errorLog
  }

  sync(path: string): void {
    const p = normalizePath(path)
    // 分层：任意作用域的 root.json/index.json 都是索引文件
    if (p.endsWith('/root.json') || p === this.nngRootJson) {
      this.orphan.checkNngRoot(p)
      return
    }
    if (p.endsWith('/index.json') || p === this.cacheIndexJson) {
      this.orphan.checkCacheIndex(p)
      return
    }
  }

  handleModified(path: string): void {
    this.sync(path)
  }

  handleDeleted(path: string): void {
    const p = normalizePath(path)
    if (!this.isIndexFile(p)) return
    // 为什么存在：root.json / cache index.json 被外部删除后若放任不管，
    // 条目只会被"下一次恰好变更的文件"通过 upsert 零星补回，其余节点条目长期缺失，
    // AI 按索引导航时会漏查大量已存在的记忆，索引修订从此永久偏离。
    // 作用：把删除事件注册为 startup_check 重试任务，由重试链路触发
    // runFullCheck 全量校准——逐文件 sync 后，root.json / index.json 从磁盘
    // 一级节点重新生成完整条目。
    // 不删掉的理由：索引删除是失步根因，必有收敛路径；全量校准在其后 5 分钟
    // 重试周期内完成，可接受且不影响正常事件流（入队非同步扫描）。
    this.errorLog.add(`index removed, full rebuild scheduled: ${p}`, {
      type: 'startup_check',
      path: p
    })
  }

  isIndexFile(path: string): boolean {
    const p = normalizePath(path)
    // 分层：索引文件按特征判断（各作用域 root.json / index.json 都在其根下）
    if (p.endsWith('/root.json') || p === this.nngRootJson) return true
    if (p.endsWith('/index.json') || p === this.cacheIndexJson) return true
    return false
  }

  fileMtime(path: string): number | null {
    const p = normalizePath(path)
    if (!existsSync(p)) return null
    try {
      return statSync(p).mtimeMs
    } catch {
      return null
    }
  }
}
