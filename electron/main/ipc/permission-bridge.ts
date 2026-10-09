/**
 * @category 核心
 * @summary 权限桥接：工具授权弹窗往返 + AI 自我重启授权（主进程 ⇄ 渲染进程 IPC 往返）
 *
 * 为什么存在：这两段「推弹窗 → 等渲染进程回传 → 超时自动拒绝」的往返原先内联在
 * index.ts 的 baseCtx 字面量里（工具授权约 140 行、AI 重启授权约 30 行）。
 * 它们不是「注入能力」而是完整的协议实现（id 生成 / 监听挂载 / 超时兜底 /
 * 监听器摘除 / settled 防重入），住在装配点唯一的理由是「顺手」，且因此
 * 长期无法被测试——index.ts 是 0.21 判定「无测试网故停止深拆」的三大巨型之一。
 * 作用：把两段往返收进一个可注入依赖的工厂，baseCtx 只保留「拿到两个回调」这一行；
 * 依赖（取通道 / 绿通判定 / 落盘 / 重启）全部由调用方注入，
 * 于是本模块第一次可以被「输入 → 输出」级契约测试覆盖。
 * 不删理由：主进程侧「向用户要授权」的入口只有这里；删除则灰名单命令、
 * 系统设置、读剪贴板、AI 自我重启等全部授权链路无实现。
 *
 * 安全约束（0.30 权限链路加固。依据：Electron 官方 security 指南第 17 条
 * 「必须校验 IPC 发送方」——"All Web Frames can in theory send IPC messages
 * to the main process"；本项目 security-best-practices skill 的 references 目录
 * 无任何 Electron / contextBridge / ipc 覆盖，故本清单来自官方文档而非该 skill）：
 * 1) 应答监听挂在 WebContents.ipc 而非全局 ipcMain：监听器天然只属于本窗口的
 * webContents，既不会跨窗口串话，也不会随多次授权在 ipcMain 上累积泄漏。
 * 依据：electron.d.ts 中 WebContents.ipc 的注释（L18891-18895）建议直接在
 * 预期 frame 上注册 handler，或改用 WebFrameMain.ipc 接口精确到 frame。
 * 2) 显式拒绝「非主 frame」的应答：senderFrame 存在且 parent 非空即视为子 frame
 * 越权的应答，直接忽略。不删理由：本应用 webPreferences 未开启
 * nodeIntegrationInSubFrames（见 window.ts），子 frame 本无 preload 桥，
 * 但一旦将来页面内嵌内容具备发送能力，即可冒充用户点「允许」；守卫是纵深防御，
 * 成本仅一行，而授权弹窗正是「用户意志」的唯一表达处，被伪造后果最严重。
 * 3) 请求 id 改用 crypto.randomUUID()：原 `Date.now()+Math.random()` 可预测，
 * 被猜中即可构造「id 匹配」的伪造应答。删除则退回可预测 id。
 * 4) 窗口不可用时立即 fail-closed：不再「静默跳过弹窗 + 白等 30s 再报授权超时」
 * （该旧文案会把「窗口不可用」误导成「用户没搭理」），而是立刻拒绝并给出
 * 独立 reason。这是 0.30 有意引入的行为变更，已在 versions/0.30/MANIFEST.md 明写。
 *
 * 行为约束：除上述第 4 条（窗口缺失时的失败语义与时延）外，与抽取前的内联实现
 * 逐字节等价（含事件顺序、超时文案、失败时的 settled 语义）。
 */

import { randomUUID } from 'crypto'
import type { PermissionRequest, PermissionResponse, ToolResult } from '../tools/base-tool'

/** 弹窗事件通道（主进程 → 渲染进程）；对端为 preload domains/shell.ts 的 onPermissionRequest */
const PERMISSION_REQUEST_CHANNEL = 'permission:request'
/** 应答通道（渲染进程 → 主进程）；对端为 preload domains/shell.ts 的 permissionRespond */
const PERMISSION_RESPOND_CHANNEL = 'permission:respond'

/**
 * 授权超时（毫秒）。
 * 为什么存在：这是 fail-closed 的实现——渲染进程没有回传时必须自动拒绝，
 * 否则授权 Promise 永不落定，工具调用会永久挂起。
 * 作用：工具授权默认值（可被 PermissionRequest.timeoutMs 覆盖，故此处只在缺省时生效）；
 * AI 重启授权直接用它（该路径没有 timeoutMs 入参）。
 * 不删理由：删除则超时兜底失效，拿到授权的调用方将永久 pending。
 */
const PERMISSION_TIMEOUT_MS = 30000

/**
 * 渲染进程回传的授权应答载荷。
 * 为什么存在：渲染进程按 id 回传「哪一次请求 + 是否允许 + 授权范围 + 原因」，
 * 主进程必须按 id 过滤（并发的授权请求会同时挂在同一通道上）。
 * 作用：作为通道载荷的类型契约，供 onRespond 校验。
 * 不删理由：这是 preload permissionRespond 的实际载荷形状；删除即失去通道类型约束。
 */
export interface PermissionRespondPayload {
  id: string
  allowed: boolean
  scope?: 'once' | 'session'
  reason?: string
}

/**
 * 通道上的单次监听器签名。
 * 为什么存在：为了让本模块脱离 electron 运行时可测，监听器事件只能声明为 unknown。
 * 作用：event 仅用于「主 frame 守卫」（读 senderFrame），不读其它字段。
 * 不删理由：删除即必须 import electron 的 IpcMainEvent 类型，本模块将重新变为不可单测。
 */
export type PermissionIpcListener = (event: unknown, payload: PermissionRespondPayload) => void

/**
 * IPC 总线的最小结构（只声明 on / removeListener 两项能力）。
 * 为什么存在：本模块需要挂载与摘除同一通道的监听器，但不该依赖 electron 的完整
 * ipcMain 类型（node 测试环境下 electron 不可用，且完整类型面会绑死可测性）。
 * 作用：生产传该窗口的 WebContents.ipc（见 PermissionIpcChannel），测试传假实现
 * ——这是本模块可被单测的支点。
 * 不删理由：删除即必须直接 import ipcMain，本模块将重新变为不可单测。
 */
export interface PermissionIpcBus {
  on(channel: string, listener: PermissionIpcListener): unknown
  removeListener(channel: string, listener: PermissionIpcListener): unknown
}

/**
 * 弹窗目标通道：把「发事件」与「收应答」绑定在同一 webContents 上。
 * 为什么存在：0.29 里「取窗口」与「IPC 总线」是两个独立依赖，前者可能为 null
 * 而后者恒为全局 ipcMain——于是「窗口不存在」只能静默跳过弹窗、再靠 30s 超时兜底，
 * 用户看到的报错是「授权超时」而非「窗口不可用」，语义误导且白等半分钟。
 * 合并为单一 getter 后，窗口与总线要么同时可用、要么同时不可用，语义唯一。
 * 作用：send 推弹窗请求；ipc 挂/摘应答监听（生产即该 webContents 的 WebContents.ipc）。
 * 不删理由：这是「窗口缺失立即 fail-closed」与「应答监听限定在单窗口」两条安全性质的载体。
 */
export interface PermissionIpcChannel {
  send(channel: string, payload: unknown): void
  ipc: PermissionIpcBus
}

/**
 * 权限桥接的全部外部依赖。
 * 为什么存在：两段往返都需要「取通道 / 判绿通」，重启授权另外需要
 * 「标记 AI 重启中 / 落盘重启待办 / 执行重启」——这些状态都持有在 index.ts
 * （进程级生命周期与 dataPaths 派生），本模块不应反向依赖它们。
 * 作用：把状态留在调用方、把协议留在本模块，从而两者都可独立验证。
 * 不删理由：这是本模块与 index.ts 之间唯一的耦合面；删除即回到闭包直接读取外部变量。
 */
export interface PermissionBridgeDeps {
  /**
   * 取当前主窗口的 IPC 通道。
   * 为什么用 getter：主窗口可能尚未创建、已销毁或被重建（activate 分支会 createWindow），
   * 不能在构造时快照；返回 null/undefined 表示「当前无可用窗口」。
   * 作用：同时提供弹窗发送与应答监听两条能力；为空时桥接立即 fail-closed。
   * 不删理由：删除则无法感知窗口缺失，只能退回白等 30s 才报「授权超时」的旧行为。
   */
  getChannel: () => PermissionIpcChannel | null | undefined
  /** 权限绿通是否开启（绿通下工具授权直接放行、AI 重启直接执行） */
  isGreenlight: () => boolean
  /**
   * 标记「AI 自我重启进行中」。
   * 为什么需要：before-quit 据此区分「AI 重启」（保留绿通）与「用户关闭」（重置绿通）；
   * 重启失败必须复位，否则用户后续关闭会被误判为 AI 重启而保留绿通。
   */
  setAiRestarting: (restarting: boolean) => void
  /** 落盘重启待办标记（文本由本模块给出，落盘位置由调用方决定） */
  writePending: (text: string) => void
  /** 执行应用重启，返回是否成功（失败原因透传给工具结果） */
  restartApp: (reason: string) => { ok: boolean; error?: string }
}

/**
 * 判定应答是否来自主 frame（top frame）。
 *
 * 为什么存在：Electron 官方 security 指南第 17 条要求校验 IPC 发送方；
 * 本应用预加载了权限应答通道，任何能发该通道的 frame 都能冒充用户「允许」。
 * 作用：senderFrame 存在且其 parent 非空 ⇒ 是子 frame ⇒ 返回 false（拒绝该应答）。
 * senderFrame 为 null（frame 已导航/销毁，官方文档明示可能为 null）时无法判定来源，
 * 此时返回 true 放行——否则窗口重建竞态下用户的真实应答会被静默丢弃，
 * 表现为「用户点了允许却仍然超时拒绝」，比伪造风险更难排查。
 * 不删理由：删除即失去对子 frame 伪造应答的唯一防线。
 */
function isMainFrameSender(event: unknown): boolean {
  const frame = (event as { senderFrame?: { parent?: unknown } | null } | null)?.senderFrame
  if (!frame) return true
  return frame.parent === null || frame.parent === undefined
}

/**
 * 一次授权往返的收尾协议：挂监听 → 按 id 过滤 → 主 frame 守卫 → 超时兜底 →
 * 落定并清理（摘监听 + 清定时器），保证回调最多被触发一次。
 *
 * 为什么存在：0.29 里两段往返各自内联一份 settled / removeListener / clearTimeout，
 * 并因此产生了不对称——工具授权路径 clearTimeout 了，AI 重启路径没有；
 * 且 onRespond 前向引用 `const timer` 属 TDZ 脆弱写法（先挂监听、后声明定时器，
 * 一旦有人把 setTimeout 挪到 ipc.on 之前就会抛 ReferenceError）。
 * 抽出单一 helper 后，这两个问题从构造上消失，而非靠「记得写」。
 * 作用：承载两段往返共用的收尾语义；差异部分（绿通、弹窗载荷、落定结果）留在调用处。
 * 不删理由：删掉则清理逻辑再次分裂成两份，前述不对称与 TDZ 脆弱性会随下次改动复发。
 */
function awaitPermissionResponse(options: {
  ipc: PermissionIpcBus
  id: string
  timeoutMs: number
  onTimeout: () => void
  onRespond: (payload: PermissionRespondPayload) => void
}): void {
  const { ipc, id, timeoutMs, onTimeout, onRespond } = options
  let settled = false
  // 为什么用 let 前置声明：settle 需要清掉这个定时器，而定时器必须等监听器挂好之后
  // 才创建（保持「先挂监听、后设超时」的原有事件顺序）——二者互相引用，无法合并成
  // 一条 const。前置声明 + 判空使用可确保「响应早于定时器创建」的极端时序下
  // settle 不会踩 TDZ（这正是 0.29 内联版把 clearTimeout 写在 const timer 之前的隐患）。
  // eslint-disable-next-line prefer-const -- 句柄在下方创建定时器时才赋值，声明处无法给初值
  let timer: ReturnType<typeof setTimeout> | undefined

  /** 唯一一次落定：摘监听 + 清定时器；返回 false 表示此前已落定过（幂等） */
  const settle = (): boolean => {
    if (settled) return false
    settled = true
    ipc.removeListener(PERMISSION_RESPOND_CHANNEL, listener)
    if (timer !== undefined) clearTimeout(timer)
    return true
  }

  const listener: PermissionIpcListener = (event, payload) => {
    // 按 id 过滤：同一通道上可能同时挂着多个并发的授权请求
    if (!payload || payload.id !== id) return
    // 主 frame 守卫：非主 frame 的应答直接忽略，且刻意不落定——
    // 让用户的真实应答仍有到达的机会（详见 isMainFrameSender）
    if (!isMainFrameSender(event)) {
      console.warn(`[permission] 已忽略来自非主 frame 的授权应答（id=${id}）`)
      return
    }
    if (!settle()) return
    onRespond(payload)
  }

  ipc.on(PERMISSION_RESPOND_CHANNEL, listener)

  // 超时自动拒绝（fail-closed）：定时器在正常路径由 settle() 摘除
  timer = setTimeout(() => {
    if (!settle()) return
    onTimeout()
  }, timeoutMs)
}

/**
 * 创建权限桥接的两个回调，供 baseCtx 装配使用。
 *
 * 为什么存在：把「授权弹窗往返」的协议实现从启动编排里移出，使其可被契约测试覆盖；
 * 这是 index.ts（2061 行 composition root）中唯一不属装配职责的一处内联逻辑。
 * 作用：返回 requestPermission（工具授权）与 requestAppRestart（AI 自我重启授权）两个回调。
 * 不删理由：baseCtx 的 requestPermission / requestAppRestart 字段是本模块的消费方，
 * 多个工具（run-command / system-setting / clipboard / skill-manage / plugin-manage /
 * abyss-md / create-ai / app-restart）依赖前者的存在性做 fail-closed 判断。
 */
export function createPermissionBridge(deps: PermissionBridgeDeps): {
  requestPermission: (req: PermissionRequest) => Promise<PermissionResponse>
  requestAppRestart: (reason: string) => Promise<ToolResult>
} {
  /**
   * 工具授权：绿通直接放行；否则推弹窗等渲染进程回传，超时自动拒绝。
   * 注意事件顺序与抽取前一致：先发弹窗、再挂监听、最后设超时。
   * （发弹窗早于挂监听不会丢应答：webContents.send 跨进程投递是异步的，
   * 应答不可能早于当前同步块结束。）
   */
  const requestPermission = (req: PermissionRequest): Promise<PermissionResponse> =>
    new Promise<PermissionResponse>((resolve) => {
      // 绿通开启：直接放行，不弹窗。黑名单拦截优先于本函数（run_command 内部先判黑名单）
      if (deps.isGreenlight()) {
        resolve({ allowed: true, scope: 'session', reason: '权限绿通模式开启，自动放行' })
        return
      }

      // 窗口不可用 → 立即 fail-closed（0.30 行为变更，见文件头「安全约束」第 4 条）
      const channel = deps.getChannel()
      if (!channel) {
        resolve({
          allowed: false,
          reason: '授权失败：主窗口不可用（未创建或已销毁），已自动拒绝'
        })
        return
      }

      // id 用 crypto.randomUUID：不可预测，防止伪造「id 匹配」的应答（见「安全约束」第 3 条）
      const id = `perm_${randomUUID()}`
      const timeoutMs = req.timeoutMs ?? PERMISSION_TIMEOUT_MS

      channel.send(PERMISSION_REQUEST_CHANNEL, {
        id,
        type: req.type,
        description: req.description,
        content: req.content,
        risk: req.risk
      })

      awaitPermissionResponse({
        ipc: channel.ipc,
        id,
        timeoutMs,
        onTimeout: () => resolve({ allowed: false, reason: `授权超时（${timeoutMs}ms）自动拒绝` }),
        onRespond: (payload) =>
          resolve({
            allowed: payload.allowed,
            scope: payload.scope,
            reason: payload.reason
          })
      })
    })

  /**
   * AI 自我重启授权：绿通开启直接重启；绿通关闭先弹窗请求用户授权。
   * 重启前标记 aiRestarting=true，before-quit 据此区分「AI 重启」（保留绿通）
   * 与「用户关闭」（重置绿通）。
   */
  const requestAppRestart = (reason: string): Promise<ToolResult> =>
    new Promise<ToolResult>((resolve) => {
      const doRestart = (): void => {
        try {
          deps.setAiRestarting(true)
          // 重启待办持久化：内存里的持续激活状态随进程销毁，必须落盘才能「重启后自己激活自己」。
          // 落盘失败不阻断重启——待办丢失只影响续接唤醒，重启本身仍应继续。
          try {
            deps.writePending(`重启完成，待续接：${reason}`)
          } catch (writeErr) {
            console.error('[restart-pending] 写入重启待办标记失败:', writeErr)
          }
          // dev 模式走 BAT 重启完整 dev 链；打包模式 relaunch（内部已 logError + console.log）
          const result = deps.restartApp(reason)
          if (result.ok) {
            resolve({ ok: true, data: { restarted: true, reason } })
          } else {
            deps.setAiRestarting(false)
            resolve({ ok: false, error: result.error ?? '重启失败' })
          }
        } catch (err) {
          deps.setAiRestarting(false)
          resolve({ ok: false, error: `重启失败: ${(err as Error).message}` })
        }
      }

      if (deps.isGreenlight()) {
        // 绿通开启：直接重启，不打扰用户
        doRestart()
        return
      }

      // 窗口不可用 → 立即 fail-closed（0.30 行为变更，见文件头「安全约束」第 4 条）
      const channel = deps.getChannel()
      if (!channel) {
        resolve({
          ok: false,
          error: '重启授权失败：主窗口不可用（未创建或已销毁），已自动拒绝'
        })
        return
      }

      const id = `restart_${randomUUID()}`
      channel.send(PERMISSION_REQUEST_CHANNEL, {
        id,
        type: 'command',
        description: `AI 请求重启应用: ${reason}`,
        content: reason,
        risk: 'medium'
      })

      awaitPermissionResponse({
        ipc: channel.ipc,
        id,
        timeoutMs: PERMISSION_TIMEOUT_MS,
        onTimeout: () =>
          resolve({ ok: false, error: `重启授权超时（${PERMISSION_TIMEOUT_MS}ms）自动拒绝` }),
        onRespond: (payload) => {
          if (payload.allowed) {
            doRestart()
          } else {
            resolve({ ok: false, error: '用户拒绝重启应用' })
          }
        }
      })
    })

  return { requestPermission, requestAppRestart }
}
