/**
 * 会话存储：用户与 AI 的对话记录在磁盘的持久化与读取（按用户/AI 隔离），
 * 采用「分片文件 + meta 原子提交」布局以支撑大会话与崩溃恢复。
 * 月蚀、莉莉丝等所有对话链路都以 SessionStore 为唯一读写入口。
 * 不删掉的理由：所有会话的增删改查、迁移、压缩、AI 域隔离与 before-quit 落盘
 * 都集中在这里；移除它会导致对话无持久化、客户端重启即失忆。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, renameSync, rmSync } from 'fs'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { DEFAULT_AI_ID, type Session, type ChatMessage } from '@shared/types'
import { redactSecrets } from '../services/redact'

/**
 * 截断长字符串中间段，保留头尾（压缩存档用，UI 可读性优先头尾）。
 * 为什么存在：会话文件存储超大工具输出/思考段会无限膨胀，且单条超长文本
 * 无法靠分片解决（消息不跨片拆），必须内容级裁剪。
 * 不删掉的理由：sanitizeSession 的深度压缩全靠它实现；参数 head/tail 决定头尾保留量，
 * 中间以省略标记占位，保证历史消息可读又不撑爆磁盘。删除它会退回"要么全存要么全丢"。
 */
function truncateMiddle(text: string, head: number, tail: number): string {
  return text.slice(0, head) +
    `\n\n... [已压缩：完整内容 ${text.length} 字符，仅保留头尾] ...\n\n` +
    text.slice(text.length - tail)
}

/** 校验 sessionId 不含路径遍历字符 */
function validateSessionId(id: string): void {
  if (!id || id.includes('..') || id.includes('/') || id.includes('\\') || id.includes('\x00')) {
    throw new Error(`Invalid session id: ${id}`)
  }
}

export { validateSessionId }

/** aiId 合法性：正整数（ai-registry id；1=月蚀） */
function isValidAiId(aiId: unknown): aiId is number {
  return typeof aiId === 'number' && Number.isInteger(aiId) && aiId >= 1
}

/**
 * 会话文件夹布局（双层会话）：
 * {dir}/{sessionId}/user/meta.json ← 元数据（id/title/createdAt/updatedAt/model/…/shardCount）
 * {dir}/{sessionId}/user/{1..N}.json ← 消息分片（ChatMessage[]，单片序列化字节 ≤ userShardMaxBytes）
 * {dir}/{sessionId}/ai/ ← InternalSessionStore 管理的内部会话池
 * {dir}/{sessionId}.json ← 旧单文件形态（读取时迁移为新形态，失败保留双兼容）

 * 分片语义：读取按 meta.shardCount 合并 1..N，缺号/损坏片跳过不隔离；
 * meta.json 损坏 → 该会话用户层暂不可见（文件保留，ai/ 不受影响），不 rename 隔离。
 * 写盘顺序：分片 tmp → rename 逐片覆盖 → meta 原子写（提交点，新 shardCount 生效，
 * 读取按它截断 → 删除旧片前的崩溃残留被排除）→ 清多余旧片 → 删旧单文件。
 * 注意：meta 原子写是「本进程内」的提交点；对外部观察者（headless 测试轮询等），
 * meta 文件可见顺序并不保证最后——轮询落盘就绪应以分片 {1..N}.json 全部出现为准，
 * 再按 meta.shardCount 合并；切勿只等 meta.json 出现即假设分片已就绪。
 * 单条消息超限独立成片（消息不跨片拆）。
 */
interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** 所属 AI 编号（ai-registry.json id；旧会话/未设置时读取侧回退 1） */
  aiId?: number
  model?: string
  continuousActivation?: boolean
  summary?: string
  summaryCursorAt?: number
  shardCount: number
}

export class SessionStore {
  private dir: string
  private cache: Map<string, Session> = new Map()
  private dirty: Set<string> = new Set()
  private readonly MAX_CACHED_SESSIONS = 50
  private writeQueue: Map<string, Session> = new Map()
  private writeTimer: NodeJS.Timeout | null = null
  private readonly FLUSH_DELAY_MS = 300
  /** 单片最大字节（序列化后 UTF-8），超限消息单独成片；设置页可改，默认 500K */
  private userShardMaxBytes = 500_000
  // 加固：同一会话的写盘串行化——大文件（几百 MB）写盘耗时数百 ms~数秒，
  // 若去抖窗口内连续 saveMessages 触发多个异步 writeFile 并发覆盖同一文件，写流交错
  // 会真正损坏 JSON（实测 247MB 会话高频写盘期间读到半写状态）。per-id promise 链保证
  // 同一会话同一时刻只有一个写盘在飞，不同会话仍可并行（保留异步收益）。
  private writeChains: Map<string, Promise<void>> = new Map()

  constructor(dir: string, options?: { userShardMaxBytes?: number }) {
    this.dir = dir
    if (typeof options?.userShardMaxBytes === 'number' && options.userShardMaxBytes > 0) {
      this.userShardMaxBytes = options.userShardMaxBytes
    }
    mkdirSync(dir, { recursive: true })
    this.loadAll()
  }

  /** 分片上限（配置迁移后由设置页值覆盖；纯存储布局，不截断内容与注入） */
  setShardMaxBytes(v: number): void {
    if (typeof v === 'number' && v > 0) this.userShardMaxBytes = v
  }

  /**
   * 切换用户会话目录（分层改造）：
   * 清空内存缓存/脏标记/写队列 → 重设目录 → 重新加载该用户的会话。
   * 登录哪个账号，看到的就是该账号退之前的状态（数据落盘持久化，用户间完全隔离）。
   */
  switchUser(newDir: string): void {
    if (newDir === this.dir) return
    // 落盘未刷的写（防切换丢数据）：先 flush 旧目录的 pending 写入
    this.flush()
    this.cache.clear()
    this.dirty.clear()
    this.writeQueue.clear()
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    this.writeChains.clear()
    this.dir = newDir
    mkdirSync(this.dir, { recursive: true })
    this.loadAll()
  }

  /** 当前会话目录（供外部查询当前用户归属；InternalSessionStore 用提供器模式跟随） */
  getDir(): string {
    return this.dir
  }

  private sessionDir(id: string): string {
    validateSessionId(id)
    return join(this.dir, id)
  }

  private userDir(id: string): string {
    return join(this.sessionDir(id), 'user')
  }

  private metaPath(id: string): string {
    return join(this.userDir(id), 'meta.json')
  }

  /** 旧单文件形态路径（{dir}/{id}.json），读取层兼容 + 迁移源 */
  private legacyPath(id: string): string {
    validateSessionId(id)
    return join(this.dir, `${id}.json`)
  }

  private loadAll(): void {
    if (!existsSync(this.dir)) return
    const entries = readdirSync(this.dir)
    for (const e of entries) {
      const full = join(this.dir, e)
      // 会话文件夹形态：{id}/user/meta.json 存在（只认含 meta 的目录；ai/ 等其他目录忽略）
      if (existsSync(join(full, 'user', 'meta.json'))) {
        try {
          const session = this.loadSessionFromDir(e)
          this.sanitizeSession(session)
          this.cache.set(session.id, session)
        } catch (err) {
          // meta.json 损坏 → 用户层暂不可见，文件保留（不隔离，ai/ 不受影响）
          console.error(`Failed to load session dir ${e}:`, err)
        }
        continue
      }
      // 只认会话文件。同目录还并存块树文件（{id}.blocks.json）与损坏隔离文件（.corrupt-*）：
      // 若一并当会话解析，块文件缺 id 字段 → 被误判损坏 → rename 成 .corrupt-* 隔离，
      // 块树持久化每次加载即被摧毁（只能退回懒迁移的直线链）；.corrupt-* 亦被反复再隔离成嵌套名。
      if (!e.endsWith('.json') || e.endsWith('.blocks.json') || e.startsWith('.corrupt-')) continue
      // 旧单文件形态：读进 cache + 同步迁移为新形态（迁移失败保留旧文件，下次启动重试；
      // 读取层双兼容，迁移成功/失败都不影响本次会话可用性）
      try {
        const raw = readFileSync(full, 'utf-8')
        const session = JSON.parse(raw) as Session
        if (!session.id || typeof session.id !== 'string') {
          throw new Error('session missing id field')
        }
        this.sanitizeSession(session)
        this.cache.set(session.id, session)
        try {
          this.writeSessionFilesSync(session.id, session)
        } catch (migrateErr) {
          console.error(`Failed to migrate session ${session.id}, legacy file kept:`, migrateErr)
        }
      } catch (err) {
        console.error(`Failed to load session ${e}:`, err)
        try {
          renameSync(full, join(this.dir, `.corrupt-${Date.now()}-${e}`))
        } catch (renameErr) {
          console.error(`Failed to quarantine corrupt session ${e}:`, renameErr)
        }
      }
    }
    this.evictIfNeeded()
  }

  /** 从会话文件夹读会话：meta + 合并 1..shardCount 分片（缺号/损坏片跳过） */
  private loadSessionFromDir(id: string): Session {
    const udir = this.userDir(id)
    const meta = JSON.parse(readFileSync(this.metaPath(id), 'utf-8')) as SessionMeta
    const messages: ChatMessage[] = []
    for (let n = 1; n <= meta.shardCount; n++) {
      const p = join(udir, `${n}.json`)
      try {
        const shard = JSON.parse(readFileSync(p, 'utf-8')) as ChatMessage[]
        messages.push(...shard)
      } catch (err) {
        console.error(`Skipping corrupt/missing shard ${id}/user/${n}.json:`, err)
      }
    }
    const session: Session = {
      id: meta.id,
      title: meta.title,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      messages,
      ...(meta.aiId !== undefined ? { aiId: meta.aiId } : {}),
      ...(meta.model !== undefined ? { model: meta.model } : {}),
      ...(meta.continuousActivation !== undefined ? { continuousActivation: meta.continuousActivation } : {}),
      ...(meta.summary !== undefined ? { summary: meta.summary } : {}),
      ...(meta.summaryCursorAt !== undefined ? { summaryCursorAt: meta.summaryCursorAt } : {})
    }
    return session
  }

  private buildMeta(session: Session, shardCount: number): SessionMeta {
    return {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      ...(session.aiId !== undefined ? { aiId: session.aiId } : {}),
      ...(session.model !== undefined ? { model: session.model } : {}),
      ...(session.continuousActivation !== undefined ? { continuousActivation: session.continuousActivation } : {}),
      ...(session.summary !== undefined ? { summary: session.summary } : {}),
      ...(session.summaryCursorAt !== undefined ? { summaryCursorAt: session.summaryCursorAt } : {}),
      shardCount
    }
  }

  /**
   * 消息切分片：按 UTF-8 序列化字节（精确增量计数：数组 = [ + 元素以 , 分隔 + ]）。
   * 超限时开新片；单条消息超限独立成片（消息不跨片）。
   */
  private splitShards(messages: ChatMessage[]): string[] {
    const maxBytes = this.userShardMaxBytes
    const shards: string[] = []
    let current: ChatMessage[] = []
    let currentBytes = 0
    for (const m of messages) {
      const mJson = JSON.stringify(m)
      const mBytes = Buffer.byteLength(mJson, 'utf-8')
      const projected = current.length === 0 ? mBytes + 2 : currentBytes + 1 + mBytes
      if (current.length > 0 && projected > maxBytes) {
        shards.push(JSON.stringify(current))
        current = []
        currentBytes = 0
      }
      current.push(m)
      currentBytes = current.length === 1 ? mBytes + 2 : currentBytes + 1 + mBytes
    }
    if (current.length > 0) shards.push(JSON.stringify(current))
    return shards
  }

  /**
   * 写会话文件夹（同步；flush / 旧数据迁移用）：
   * 分片 tmp → rename 覆盖 → meta 原子写（提交点）→ 清多余旧片 → 删旧单文件。
   */
  private writeSessionFilesSync(id: string, session: Session): void {
    const udir = this.userDir(id)
    mkdirSync(udir, { recursive: true })
    const shards = this.splitShards(session.messages ?? [])
    const pairs: Array<{ tmp: string; final: string }> = []
    for (let i = 0; i < shards.length; i++) {
      const final = join(udir, `${i + 1}.json`)
      const tmp = final + '.tmp'
      writeFileSync(tmp, shards[i], 'utf-8')
      pairs.push({ tmp, final })
    }
    for (const { tmp, final } of pairs) renameSync(tmp, final)
    this.atomicWriteSync(join(udir, 'meta.json'), JSON.stringify(this.buildMeta(session, shards.length)))
    for (const f of readdirSync(udir)) {
      if (/^\d+\.json$/.test(f) && parseInt(f, 10) > shards.length) {
        try {
          unlinkSync(join(udir, f))
        } catch {
          /* 残留旧片清理失败不影响正确性（读取按 shardCount 截断） */
        }
      }
    }
    const legacy = this.legacyPath(id)
    if (existsSync(legacy)) {
      try {
        unlinkSync(legacy)
      } catch (err) {
        console.error(`Failed to remove legacy session file ${legacy}:`, err)
      }
    }
  }

  /** 写会话文件夹（异步；flushQueue 用，tmp 写不阻塞事件循环） */
  private async writeSessionFilesAsync(id: string, session: Session): Promise<void> {
    const udir = this.userDir(id)
    mkdirSync(udir, { recursive: true })
    const shards = this.splitShards(session.messages ?? [])
    const pairs: Array<{ tmp: string; final: string }> = []
    for (let i = 0; i < shards.length; i++) {
      const final = join(udir, `${i + 1}.json`)
      const tmp = final + '.tmp'
      await writeFile(tmp, shards[i], 'utf-8')
      pairs.push({ tmp, final })
    }
    for (const { tmp, final } of pairs) renameSync(tmp, final)
    // meta 是提交点：同步路径用 atomicWriteSync(tmp+rename) 保证原子性，
    // 异步路径原先直接 writeFile 未原子化——崩溃可能留下半截 meta → 会话用户层整体不可见。
    // 统一走原子写（先 .tmp 再 rename，正文件要么旧版完整、要么新版完整）。
    await this.atomicWrite(join(udir, 'meta.json'), JSON.stringify(this.buildMeta(session, shards.length)))
    for (const f of readdirSync(udir)) {
      if (/^\d+\.json$/.test(f) && parseInt(f, 10) > shards.length) {
        try {
          unlinkSync(join(udir, f))
        } catch {
          /* 忽略 */
        }
      }
    }
    const legacy = this.legacyPath(id)
    if (existsSync(legacy)) {
      try {
        unlinkSync(legacy)
      } catch (err) {
        console.error(`Failed to remove legacy session file ${legacy}:`, err)
      }
    }
  }

  private evictIfNeeded(): void {
    if (this.cache.size <= this.MAX_CACHED_SESSIONS) return
    const sorted = [...this.cache.entries()]
      .filter(([id]) => !this.dirty.has(id))
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    const toEvict = Math.max(0, sorted.length - (this.MAX_CACHED_SESSIONS - this.dirty.size))
    for (let i = 0; i < toEvict; i++) {
      this.cache.delete(sorted[i][0])
    }
  }

  /**
   * 裁剪超长字段，防止会话文件无限膨胀（加载时 + 写盘前统一走这里）。
   * 覆盖四类：toolCall 输出 / 工具参数 / 思考段 / 子 agent 输出。
   * 扩展：原仅裁 toolCall 输出，后扩展为工具调用、文件读取、思考都可压缩。
   */
  private sanitizeSession(session: Session): void {
    // 输出阈值（toolCall output.text）：UI 不消费完整输出（详情走 summary），8KB 存档足够
    const OUT_MAX = 8 * 1024
    const OUT_HEAD = 4 * 1024
    const OUT_TAIL = 2 * 1024
    // 思考段阈值（reasoning）：前端可折叠查看，16KB 足够承载关键推理
    const REASON_MAX = 16 * 1024
    const REASON_HEAD = 8 * 1024
    const REASON_TAIL = 4 * 1024
    // 工具参数阈值（inputText / args 内字符串）：参数预览用途，单值 4KB 足够
    const ARG_MAX = 4 * 1024
    const ARG_HEAD = 2 * 1024
    const ARG_TAIL = 1 * 1024
    // 子 agent 输出阈值（toolCalls[].subAgents[].output）：整段渲染无消费方，保留结论级片段即可
    // 新旧分级：最近 KEEP_RECENT 条消息保持完整渲染阈值，更旧的深度压缩（历史只看结论，不需要完整工具细节）
    const KEEP_RECENT = 20
    const OLD_OUT_MAX = 2 * 1024
    const OLD_REASON_MAX = 4 * 1024
    const OLD_ARG_MAX = 1 * 1024
    const messages = session.messages ?? []
    const oldCut = Math.max(0, messages.length - KEEP_RECENT)

    for (let mi = 0; mi < messages.length; mi++) {
      const m = messages[mi]
      const msg = m as ChatMessage & { rows?: Array<Record<string, unknown>> }
      const isOld = mi < oldCut
      const outMax = isOld ? OLD_OUT_MAX : OUT_MAX
      const outHead = isOld ? 1 * 1024 : OUT_HEAD
      const outTail = isOld ? 512 : OUT_TAIL
      const reasonMax = isOld ? OLD_REASON_MAX : REASON_MAX
      const reasonHead = isOld ? 2 * 1024 : REASON_HEAD
      const reasonTail = isOld ? 1 * 1024 : REASON_TAIL
      const argMax = isOld ? OLD_ARG_MAX : ARG_MAX
      const argHead = isOld ? 512 : ARG_HEAD
      const argTail = isOld ? 256 : ARG_TAIL
      // 1) 消息级 reasoning（深度思考字段）
      if (typeof msg.reasoning === 'string' && msg.reasoning.length > reasonMax) {
        msg.reasoning = truncateMiddle(msg.reasoning, reasonHead, reasonTail)
      }
      // 2) 消息级 toolCalls（参数 args 深裁 + 结果深裁）
      if (Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          if (tc?.args && typeof tc.args === 'object') {
            tc.args = this.sanitizeObject(tc.args, argMax, argHead, argTail, 0)
          }
          if (tc?.result) {
            if (typeof tc.result === 'object' && tc.result !== null) {
              const r = tc.result as unknown as Record<string, unknown>
              if ('data' in r) r.data = this.sanitizeValue(r.data, argMax, argHead, argTail, 0)
              if (typeof r.error === 'string' && r.error.length > argMax) {
                r.error = truncateMiddle(r.error, argHead, argTail)
              }
            }
          }
          // 子 agent 内部详情（Agent 工具）
          if (Array.isArray(tc.subAgents)) {
            for (const sa of tc.subAgents) {
              if (typeof sa.output === 'string' && sa.output.length > outMax) {
                sa.output = truncateMiddle(sa.output, outHead, outTail)
              }
              if (Array.isArray(sa.toolCalls)) {
                for (const stc of sa.toolCalls) {
                  if (stc?.args && typeof stc.args === 'object') {
                    stc.args = this.sanitizeObject(stc.args, argMax, argHead, argTail, 0)
                  }
                }
              }
            }
          }
        }
      }
      // 3) rows 行流（reasoning 行 / toolCall 行）
      const rows = msg.rows
      if (!Array.isArray(rows)) continue
      for (const row of rows) {
        if (row.kind === 'reasoning' && typeof row.text === 'string' && row.text.length > reasonMax) {
          row.text = truncateMiddle(row.text, reasonHead, reasonTail)
        }
        if (row.kind !== 'toolCall') continue
        // 3a) toolCall 行输出
        const output = row.output as { text?: string; truncated?: boolean } | undefined
        if (output && typeof output.text === 'string') {
          // 敏感信息脱敏：工具输出最可能含密钥，写盘前必扫
          output.text = redactSecrets(output.text)
          if (output.text.length > outMax) {
            output.text = truncateMiddle(output.text, outHead, outTail)
            output.truncated = true
          }
        }
        // 3b) toolCall 行参数（inputText 字符串 + input 对象）
        if (typeof row.inputText === 'string') {
          row.inputText = redactSecrets(row.inputText)
          if (row.inputText.length > argMax) {
            row.inputText = truncateMiddle(row.inputText, argHead, argTail)
          }
        }
        if (row.input && typeof row.input === 'object') {
          row.input = this.sanitizeObject(row.input as Record<string, unknown>, argMax, argHead, argTail, 0)
        }
      }
    }
  }

  /** 深裁对象：字符串超长截中、数组截前 N 项、嵌套限制 depth 层（防环） */
  private sanitizeObject(
    obj: Record<string, unknown>,
    maxStr: number,
    head: number,
    tail: number,
    depth: number
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      out[k] = this.sanitizeValue(v, maxStr, head, tail, depth)
    }
    return out
  }

  private sanitizeValue(value: unknown, maxStr: number, head: number, tail: number, depth: number): unknown {
    if (typeof value === 'string') {
      // 敏感信息脱敏：写盘前扫密钥形态，防止密钥留痕会话文件。脱敏幂等（已替换标记不再匹配）
      const redacted = redactSecrets(value)
      if (redacted.length <= maxStr) return redacted
      return truncateMiddle(redacted, head, tail)
    }
    if (Array.isArray(value)) {
      const KEEP = 100
      if (value.length <= KEEP) {
        return value.map((v) => this.sanitizeValue(v, maxStr, head, tail, depth))
      }
      return [
        ...value.slice(0, KEEP).map((v) => this.sanitizeValue(v, maxStr, head, tail, depth)),
        `... [已压缩：数组原 ${value.length} 项，仅保留前 ${KEEP} 项] ...`
      ]
    }
    if (value && typeof value === 'object' && depth < 3) {
      return this.sanitizeObject(value as Record<string, unknown>, maxStr, head, tail, depth + 1)
    }
    return value
  }

  list(): Session[] {
    return Array.from(this.cache.values())
      .map((s) => ({
        ...s,
        messages: []
      }))
      // 排除莉莉丝专属会话：莉莉丝上下文是 companion sessions 文件（唯一真相源），
      // 不出现在普通会话列表（否则出现"月蚀"名的莉莉丝，且与游戏内上下文是两份）
      .filter((s) => s.id !== 'lilith_chat')
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): Session | null {
    validateSessionId(id)
    const s = this.cache.get(id)
    return s ? { ...s } : null
  }

  create(aiId?: number): Session {
    const id = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const now = Date.now()
    const session: Session = {
      id,
      title: '新会话',
      createdAt: now,
      updatedAt: now,
      messages: [],
      // 多 AI 泛化：会话归属 AI 编号（缺省 1 = 月蚀；aiId 非法时回退 1）
      ...(isValidAiId(aiId) ? { aiId } : { aiId: DEFAULT_AI_ID })
    }
    this.cache.set(id, session)
    this.dirty.add(id)
    this.evictIfNeeded()
    this.persist(id)
    return session
  }

  /**
 * 获取或创建指定 ID 的会话（莉莉丝桥接用：固定 lilith_chat 会话，
 * 保证莉莉丝对话始终写入同一份月蚀记忆，不随"最近会话"漂移）。
 * 未指定 aiId 时沿用既有会话的归属（旧会话保持原样，不回填 1）；
 * 显式指定 aiId 时若既有归属不一致则回填修正（headless 链按确定性 sessionId
 * 复用旧会话时，确保归属跟随调用方声明，避免 AI 社交数据错落其他 AI 域）；
 * 新建且未指定 aiId 时归属 AI 1（月蚀，兼容旧行为）。
 */
  getOrCreate(id: string, title?: string, aiId?: number): Session {
    validateSessionId(id)
    const existing = this.cache.get(id)
    if (existing) {
      // 显式声明归属且与既有不同 → 回填修正（旧会话升级归属；未显式声明时保持原样）
      if (isValidAiId(aiId) && existing.aiId !== aiId) {
        existing.aiId = aiId
        existing.updatedAt = Date.now()
        this.dirty.add(id)
        this.persist(id)
      }
      return { ...existing }
    }
    const now = Date.now()
    const session: Session = {
      id,
      title: title ?? id,
      createdAt: now,
      updatedAt: now,
      messages: [],
      ...(isValidAiId(aiId) ? { aiId } : { aiId: 1 })
    }
    this.cache.set(id, session)
    this.dirty.add(id)
    this.evictIfNeeded()
    this.persist(id)
    return session
  }

  rename(id: string, title: string): void {
    validateSessionId(id)
    const s = this.cache.get(id)
    if (!s) return
    s.title = title
    s.updatedAt = Date.now()
    this.dirty.add(id)
    this.persist(id)
  }

  delete(id: string): void {
    validateSessionId(id)
    this.cache.delete(id)
    this.dirty.delete(id)
    this.writeQueue.delete(id)
    this.writeChains.delete(id)
    // 级联删整个会话文件夹（user/ 分片 + ai/ 内部会话池 + 可能的暂存残留）
    const sdir = this.sessionDir(id)
    if (existsSync(sdir)) {
      try {
        rmSync(sdir, { recursive: true, force: true })
      } catch (err) {
        console.error(`Failed to delete session folder ${id}:`, err)
      }
    }
    const legacy = this.legacyPath(id)
    if (existsSync(legacy)) {
      try {
        unlinkSync(legacy)
      } catch (err) {
        console.error(`Failed to delete session ${id}:`, err)
      }
    }
  }

  /**
   * 删除归属指定 AI 的全部会话（AI 删除时级联清域用，保证「一个 AI 一个域」）。

   * 判定规则：
   * - meta.aiId === aiId（前端 s_ 会话 + headless 确定性会话写入即带归属）
   * - 显式排除 lan- 前缀会话（聊天室 lan-chat-room-* / 公示板 lan-publish-board-* /
   * 好友私聊 lan-direct-chat-* 等公共线路）——公共内容不因单个 AI 删除而清除

   * 磁盘目录中可能含未载入缓存的会话（超出 MAX_CACHED_SESSIONS 被逐出的），
   * 因此先扫磁盘 dir 下所有会话目录读 meta.json 判定，再与缓存交集处理；
   * delete() 内部会清理写队列/写链并级联删文件夹，避免残留 pending 写回。

   * @returns 被删除的会话 id 列表（含旧单文件形态的）
   */
  deleteByAiId(aiId: number): string[] {
    const removed: string[] = []

    // 1) 扫描磁盘上的全部会话目录（含未入缓存者）
    if (existsSync(this.dir)) {
      const entries = readdirSync(this.dir)
      for (const e of entries) {
        if (!/^[A-Za-z0-9_-]+$/.test(e)) continue
        const metaFp = join(this.dir, e, 'user', 'meta.json')
        if (!existsSync(metaFp)) continue
        try {
          const meta = JSON.parse(readFileSync(metaFp, 'utf-8')) as SessionMeta
          if (meta.aiId === aiId && !e.startsWith('lan-') && !removed.includes(e)) {
            removed.push(e)
          }
        } catch {
          // meta 损坏：不误删，交给用户手动处理
        }
      }
    }

    // 2) 缓存中的（未落盘或磁盘刚建的）
    for (const [id, s] of this.cache) {
      if (s.aiId === aiId && !id.startsWith('lan-') && !removed.includes(id)) {
        removed.push(id)
      }
    }

    // 3) 逐一会话删除（含级联删文件夹 + 清写队列）
    for (const id of removed) {
      this.delete(id)
    }

    return removed
  }

  saveMessages(id: string, messages: ChatMessage[]): void {
    validateSessionId(id)
    const s = this.cache.get(id)
    if (!s) return
    s.messages = messages
    s.updatedAt = Date.now()
    // 自动标题：仅当还是默认"新会话"时，取首条用户消息截断生成（≤24 字符）
    // 纯规则零 LLM 调用——不占 llmClient 串行链路；生成过一次后 title 不再等于默认值，
    // 用户手动 rename 的标题也不会被覆盖
    if (s.title === '新会话') {
      const firstUser = messages.find((m) => m.role === 'user' && m.content && m.content.trim().length > 0)
      if (firstUser?.content) {
        const cleaned = firstUser.content.replace(/\s+/g, ' ').trim()
        s.title = cleaned.length > 24 ? cleaned.slice(0, 24) + '…' : cleaned
      }
    }
    // 立即落盘：闪退时 before-quit 的 flush() 没机会执行，
    // 只有每次 saveMessages 即时持久化才能保证上下文不丢。
    // 改：同步写盘改异步合并写——会话文件膨胀到 5MB+ 后，
    // writeFileSync 阻塞事件循环数百 ms~数秒，叠加工具调用造成前端假死。
    // 数据安全性由 flush()（before-quit 同步补写）+ 300ms 合并窗口兜底。
    this.persist(id)
  }

  setModel(id: string, model: string | null): void {
    validateSessionId(id)
    const s = this.cache.get(id)
    if (!s) return
    if (model) {
      s.model = model
    } else {
      delete s.model
    }
    s.updatedAt = Date.now()
    this.dirty.add(id)
    this.persist(id)
  }

  /** 持续激活模式开关：持久化到 session，重启后恢复 */
  setContinuousActivation(id: string, enabled: boolean): void {
    validateSessionId(id)
    const s = this.cache.get(id)
    if (!s) return
    if (enabled) {
      s.continuousActivation = true
    } else {
      delete s.continuousActivation
    }
    s.updatedAt = Date.now()
    this.dirty.add(id)
    this.persist(id)
  }

  private persist(id: string): void {
    const s = this.cache.get(id)
    if (!s) return
    // 异步合并写：入队 + 300ms 去抖。同一会话连续多次 saveMessages 只写最后一次，
    // 写盘用异步 writeFileSync→setImmediate 队列，不阻塞事件循环。
    this.writeQueue.set(id, s)
    if (this.writeTimer) clearTimeout(this.writeTimer)
    this.writeTimer = setTimeout(() => this.flushQueue(), this.FLUSH_DELAY_MS)
  }

  /** 原子写（异步）：先写 .tmp 再 rename 覆盖——进程被强杀时最多留下半截 tmp 文件，
   * 正文件保持完整，杜绝"写一半 → 截断 → .corrupt 隔离丢会话"（事故根因）。 */
  private async atomicWrite(path: string, data: string): Promise<void> {
    const tmp = path + '.tmp'
    await writeFile(tmp, data, 'utf-8')
    renameSync(tmp, path)
  }

  /** 原子写（同步，before-quit 用）：同上 */
  private atomicWriteSync(path: string, data: string): void {
    const tmp = path + '.tmp'
    writeFileSync(tmp, data, 'utf-8')
    renameSync(tmp, path)
  }

  private flushQueue(): void {
    this.writeTimer = null
    if (this.writeQueue.size === 0) return
    const entries = Array.from(this.writeQueue.entries())
    this.writeQueue.clear()
    for (const [id, s] of entries) {
      validateSessionId(id)
      this.sanitizeSession(s)
      const prev = this.writeChains.get(id) ?? Promise.resolve()
      const next = prev
        .then(() => this.writeSessionFilesAsync(id, s))
        .then(() => { this.dirty.delete(id) })
        // 写盘失败：dirty 保留（下次 flush 重写自愈），此处只记录，避免 unhandled rejection 打断主进程
        .catch((err) => console.error(`Session flush write failed ${id}:`, err))
      this.writeChains.set(id, next)
      void next.finally(() => {
        if (this.writeChains.get(id) === next) this.writeChains.delete(id)
      })
    }
  }

  /** 同步补写所有 pending（before-quit 调用，确保数据落盘） */
  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    if (this.writeQueue.size > 0) {
      for (const [id, s] of this.writeQueue.entries()) {
        this.sanitizeSession(s)
        this.writeSessionFilesSync(id, s)
      }
      this.writeQueue.clear()
    }
    for (const id of this.dirty) {
      const s = this.cache.get(id)
      if (!s) continue
      this.sanitizeSession(s)
      this.writeSessionFilesSync(id, s)
    }
    this.dirty.clear()
  }
}