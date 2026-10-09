/**
 * 为什么存在：评论数量需要受控（默认上限 500），按文章分文件存储可独立裁剪、互不干扰。
 * 作用：按文章 id 读写评论数组（federation/news/comments/{articleId}.json），损坏时安全回退空数组。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { PublishComment } from './publish-board-types'

/**
 * 评论存储（abyssac_data/federation/publish-board/comments/{articleId}.json）。
 * 整文件原子覆写，上限 500 条（单新闻评论数上限）。
 */
export class PublishCommentStore {
  private readonly dir: string
  private readonly maxComments: number

  constructor(root: string, maxComments = 500) {
    this.dir = join(root, 'federation', 'news', 'comments')
    this.maxComments = maxComments
    mkdirSync(this.dir, { recursive: true })
  }

  private path(articleId: string): string {
    return join(this.dir, `${articleId}.json`)
  }

  load(articleId: string): PublishComment[] {
    try {
      const p = this.path(articleId)
      if (!existsSync(p)) return []
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as PublishComment[]
      return Array.isArray(raw) ? raw.filter((c) => typeof c.commentId === 'string') : []
    } catch {
      return []
    }
  }

  append(articleId: string, comment: PublishComment): void {
    const comments = this.load(articleId)
    if (comments.some((c) => c.commentId === comment.commentId)) return // 幂等
    comments.push(comment)
    if (comments.length > this.maxComments) {
      comments.splice(0, comments.length - this.maxComments)
    }
    this.save(articleId, comments)
  }

  private save(articleId: string, comments: PublishComment[]): void {
    const p = this.path(articleId)
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify(comments, null, 2), 'utf-8')
    renameSync(tmp, p)
  }

  count(articleId: string): number {
    return this.load(articleId).length
  }

  lastTs(articleId: string): number | null {
    const cs = this.load(articleId)
    return cs.length > 0 ? cs[cs.length - 1].ts : null
  }
}
