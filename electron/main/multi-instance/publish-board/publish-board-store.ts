/**
 * 为什么存在：板块清单与文章正文的数据量和生命周期不同，分开持久化便于独立读写与清理。
 * 作用：读写板块清单（boards.json）与文章正文（articles/ 目录），提供文章增删改查与列表。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { PublishBoard, PublishArticle } from './publish-board-types'

/**
 * 发布板存储：板块 + 条目，按板块分目录。
 * 目录结构：
 * abyssac_data/federation/publish-board/
 * ├── boards.json # 板块列表（整文件原子覆写）
 * └── articles/{boardId}/ # 按板块分目录
 * └── {articleId}.json # 发布条目（整文件原子覆写）
 */
export class PublishBoardStore {
  private readonly dir: string

  constructor(root: string) {
    this.dir = join(root, 'federation', 'news')
    mkdirSync(this.dir, { recursive: true })
    mkdirSync(join(this.dir, 'articles'), { recursive: true })
  }

  // ===== 板块 CRUD =====

  private boardsPath(): string {
    return join(this.dir, 'boards.json')
  }

  loadBoards(): PublishBoard[] {
    try {
      const p = this.boardsPath()
      if (!existsSync(p)) return []
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as PublishBoard[]
      return Array.isArray(raw) ? raw : []
    } catch {
      return []
    }
  }

  private saveBoards(boards: PublishBoard[]): void {
    const p = this.boardsPath()
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify(boards, null, 2), 'utf-8')
    renameSync(tmp, p)
  }

  addBoard(board: PublishBoard): void {
    const boards = this.loadBoards()
    boards.push(board)
    this.saveBoards(boards)
  }

  loadBoard(boardId: string): PublishBoard | null {
    return this.loadBoards().find((b) => b.boardId === boardId) ?? null
  }

  /** 覆盖写入板块（本地创建/远端同步共用；远端同步时传入对方 updatedAt 不变） */
  saveBoard(board: PublishBoard): void {
    const boards = this.loadBoards()
    const idx = boards.findIndex((b) => b.boardId === board.boardId)
    if (idx >= 0) {
      boards[idx] = board
    } else {
      boards.push(board)
    }
    this.saveBoards(boards)
  }

  updateBoard(boardId: string, patch: Partial<Pick<PublishBoard, 'name' | 'desc'>>): void {
    const boards = this.loadBoards()
    const idx = boards.findIndex((b) => b.boardId === boardId)
    if (idx < 0) return
    boards[idx] = { ...boards[idx], ...patch, updatedAt: Date.now() }
    this.saveBoards(boards)
  }

  deleteBoard(boardId: string): void {
    const boards = this.loadBoards().filter((b) => b.boardId !== boardId)
    this.saveBoards(boards)
    // 级联删除该板块下的所有新闻
    const d = join(this.dir, 'articles', boardId)
    if (existsSync(d)) {
      try {
        for (const f of readdirSync(d)) {
          unlinkSync(join(d, f))
        }
      } catch { /* ignore */ }
    }
  }

  // ===== 发布条目 CRUD =====

  private articleDir(boardId: string): string {
    const d = join(this.dir, 'articles', boardId)
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
    return d
  }

  private articlePath(boardId: string, articleId: string): string {
    return join(this.articleDir(boardId), `${articleId}.json`)
  }

  loadArticle(boardId: string, articleId: string): PublishArticle | null {
    try {
      const p = this.articlePath(boardId, articleId)
      if (!existsSync(p)) return null
      return JSON.parse(readFileSync(p, 'utf-8')) as PublishArticle
    } catch {
      return null
    }
  }

  saveArticle(article: PublishArticle): void {
    const p = this.articlePath(article.boardId, article.articleId)
    const tmp = `${p}.tmp`
    // 远端同步的文章须保留其原始 updatedAt（跨端一致性比较依赖它）
    writeFileSync(tmp, JSON.stringify(article, null, 2), 'utf-8')
    renameSync(tmp, p)
  }

  deleteArticle(boardId: string, articleId: string): void {
    try {
      const p = this.articlePath(boardId, articleId)
      if (existsSync(p)) unlinkSync(p)
    } catch { /* ignore */ }
  }

  /** 加载某板块全部新闻（原始无序，调用方排序） */
  listArticles(boardId: string): PublishArticle[] {
    const d = this.articleDir(boardId)
    try {
      return readdirSync(d)
        .filter((f) => f.endsWith('.json'))
        .map((f) => this.loadArticle(boardId, f.replace(/\.json$/, '')))
        .filter((a): a is PublishArticle => a !== null)
    } catch {
      return []
    }
  }

  /** 加载全部新闻（跨板块，调用方排序） */
  listAllArticles(): PublishArticle[] {
    const boards = this.loadBoards()
    return boards.flatMap((b) => this.listArticles(b.boardId))
  }

  /** 跨板块按 articleId 查找文章（墓碑比对用，未找到返回 null） */
  findArticleById(articleId: string): PublishArticle | null {
    return this.listAllArticles().find((a) => a.articleId === articleId) ?? null
  }

  // ===== 删除墓碑（保证跨端同步干净删除） =====

  private deletedPath(): string {
    return join(this.dir, 'deleted.json')
  }

  /** 已删除文章墓碑：{articleId: {deletedAt, authorUid}} */
  private loadDeleted(): Record<string, { deletedAt: number; authorUid: number }> {
    try {
      const p = this.deletedPath()
      if (!existsSync(p)) return {}
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, { deletedAt: number; authorUid: number }>
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }

  private saveDeleted(map: Record<string, { deletedAt: number; authorUid: number }>): void {
    const p = this.deletedPath()
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf-8')
    renameSync(tmp, p)
  }

  /** 记录删除墓碑（文章从任意板块删除时调用） */
  markDeleted(articleId: string, at: number, authorUid: number): void {
    const map = this.loadDeleted()
    map[articleId] = { deletedAt: at, authorUid }
    this.saveDeleted(map)
  }

  /** 全部删除墓碑（articleId → deletedAt，同步用） */
  listDeleted(): Array<{ articleId: string; deletedAt: number; authorUid: number }> {
    return Object.entries(this.loadDeleted()).map(([articleId, v]) => ({ articleId, deletedAt: v.deletedAt, authorUid: v.authorUid }))
  }

  /** 提取失败文章时尝试按墓碑移除（幂等） */
  applyDelete(articleId: string): void {
    const boards = this.loadBoards()
    for (const b of boards) {
      this.deleteArticle(b.boardId, articleId)
    }
  }
}
