# -*- coding: utf-8 -*-
"""F-5 拆分：server.ts 内部会话层迁至 internal-session.ts，装配处改为 createInternalSessionLayer 调用."""
# ⚠️ 一次性迁移脚本（2026-09-28 已执行完毕，server.ts 已不再含内部会话层闭包）：
# - 为什么还存在：保留迁移过程审计留痕，维护者可核对 internal-session.ts 的出处与拆分边界。
# - 不删的理由：仓库惯例保留一次性迁移脚本供追溯（同 split-f5-server 同批拆分均有此惯例）；
#   其内容引用当年的 server.ts 旧文本（含已删除的 generateConsolidation 等符号），
#   属历史快照，不代表当前代码形态。
# - 禁止重跑：目标标记（"// 内部会话摘要/路由专用 LLMClient"）已不在 server.ts 中，
#   重跑必然 FATAL——这是设计而非缺陷。
import io, os, sys

# 目标路径按脚本自身位置推导（app/scripts/ -> app 源码根），不依赖本机绝对路径。
PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "electron", "main", "api", "server.ts")

with io.open(PATH, "r", encoding="utf-8") as f:
    lines = f.read().split("\n")

# --- 1) 删除 内部会话层闭包段（summaryLlmClient .. readMonitorCfg），原位插入 layer 装配 ---
start_mark = "  // 内部会话摘要/路由专用 LLMClient——与主对话隔离，防并发抢占。"
end_mark = "  // raw_memory 写入器"
start_idx = None
for i, ln in enumerate(lines):
    if ln.startswith(start_mark):
        start_idx = i
        break
if start_idx is None:
    print("FATAL: internal-session block start not found")
    sys.exit(1)
end_idx = None
for i in range(start_idx + 1, len(lines)):
    if lines[i].startswith(end_mark):
        # raw_memory 注释前一行的空行也一并删除
        end_idx = i - 1
        break
if end_idx is None or end_idx <= start_idx:
    print("FATAL: internal-session block end not found")
    sys.exit(1)

layer_block = (
    "  // ===== 内部会话层（F-5 拆分：摘要配置/上下文装配/两写摘要压缩维护队列）=====\n"
    "  // 见 internal-session.ts：summaryLlmClient 懒创建、getSessionSummaryCfg、buildSessionContext、\n"
    "  // internalLlmChat、enqueueInternalSessionJob、resolveStreamSessionContext 收拢为单一 Layer；\n"
    "  // server.ts 只持有 layer，runStream/lilith-endpoints 经其能力点消费，不再与主对话闭包互相纠缠。\n"
    "  const internalSessionLayer = createInternalSessionLayer({\n"
    "    configStore,\n"
    "    sessionStore,\n"
    "    sharedInternalSessionStore,\n"
    "    toolCtx,\n"
    "    makeLlmClient\n"
    "  })\n"
    "  const { internalLlmChat, enqueueInternalSessionJob, resolveStreamSessionContext } = internalSessionLayer\n"
)
lines[start_idx:end_idx] = layer_block.split("\n")
text = "\n".join(lines)

# --- 2) runStream 路由段替换为 layer.resolveStreamSessionContext ---
old_route = """      // ===== 内部会话上下文组装）=====
      // 主回复轮：路由（continue → 装载内部会话；create → 立即建空会话）→ sessionContext 锚点注入
      // 审查轮（systemOverride）：沿用主回复轮路由选中的内部会话（activeInternalContext，摘要+当前 messages）
      // 任何未启用/路由失败 → sessionContext=null → 线性管线（不截断）
      let sessionContext: SessionContext | null = null
      const sumCfg = getSessionSummaryCfg()
      if (sumCfg.enabled && sessionId) {
        try {
          if (opts?.systemOverride) {
            // 审查轮：不路由、不新建，沿用主回复轮选中的内部会话上下文
            const act = activeInternalContext
            if (act && act.sessionId === sessionId) {
              const internal = internalSessionStore.get(sessionId, act.internalId)
              if (internal) sessionContext = buildSessionContext(internal)
            }
          } else {
            // 主回复轮：路由选会话（continue/create）
            const candidates = internalSessionStore.list(sessionId)
            const lastUser = [...messages].reverse().find((m) => m.role === 'user' && !m.activation)
            const userInput =
              lastUser && typeof lastUser.content === 'string' ? lastUser.content : ''
            const route = await routeSession(internalLlmChat, { userInput, now: Date.now(), candidates }, sumCfg)
            if (route) {
              if (route.action === 'continue' && route.internalId) {
                const internal = internalSessionStore.get(sessionId, route.internalId)
                if (internal) {
                  sessionContext = buildSessionContext(internal)
                  activeInternalContext = { sessionId, internalId: internal.id }
                }
              } else if (route.action === 'create') {
                // 立即创建空会话：两写把本轮写入它；本轮注入空锚点（仅有标题，无消息）
                const internal = internalSessionStore.create(sessionId, { title: route.title ?? DEFAULT_INTERNAL_SESSION_TITLE })
                sessionContext = buildSessionContext(internal)
                activeInternalContext = { sessionId, internalId: internal.id }
              }
            }
          }
        } catch (err) {
          console.error('[session] 内部会话路由/装载失败，回退线性管线:', err)
          activeInternalContext = null
        }
      }
"""
new_route = """      // ===== 内部会话上下文组装）=====
      // 主回复轮：路由（continue → 装载内部会话；create → 立即建空会话）→ sessionContext 锚点注入
      // 审查轮（systemOverride）：沿用主回复轮路由选中的内部会话（activeInternalContext，摘要+当前 messages）
      // 任何未启用/路由失败 → sessionContext=null → 线性管线（不截断）
      // F-5 拆分：路由/装载逻辑迁至 internal-session.ts（resolveStreamSessionContext），
      // 此处只消费返回值，便于未来替换路由策略（阈值/优先级/多语言意图识别）。
      const resolvedCtx = await resolveStreamSessionContext({
        opts,
        sessionId,
        messages,
        activeInternalContext
      })
      let sessionContext = resolvedCtx.sessionContext
      activeInternalContext = resolvedCtx.activeInternalContext
"""
if old_route not in text:
    print("FATAL: route block not found")
    sys.exit(1)
text = text.replace(old_route, new_route, 1)

# --- 3) import 调整：删除已迁出模块的 import，新增 internal-session import ---
removals = [
    "import { LLMClient, getCurrentToolCallId } from './llm'",
]
# 保留 LLMClient（server.ts 仍在用？检查后决定）
import re

def drop_import(text, fragment):
    # 删除包含 fragment 的单行 import
    for line in text.split("\n"):
        if fragment in line:
            return text.replace("\n" + line, "", 1) if text.startswith(line) is False else text.replace(line + "\n", "", 1)
    return text

text = text.replace("import { routeSession } from '../services/session-router'\n", "")
text = text.replace("import { formatSessionTime } from '../services/session-utils'\n", "")
text = text.replace("""import {
  generateSummaryUpdate,
  generateConsolidation,
  buildConsolidationPatch
} from '../services/session-summarizer'
""", "")
text = text.replace("import type { LightChat } from '../services/session-utils'\n", "")
text = text.replace(
    "import { InternalSessionStore, DEFAULT_INTERNAL_SESSION_TITLE } from '../services/internal-session-store'",
    "import { InternalSessionStore } from '../services/internal-session-store'"
)

# 新增 internal-session import：插到 code-review import 之前（同类 api/ 模块）
anchor = "// 代码审查通道独立模块（F-4 拆分）：审查链存储/HTML 报告渲染/独立审查提示词。"
internal_import = (
    "// 内部会话层独立模块（F-5 拆分）：摘要配置/上下文装配/两写摘要压缩单飞队列。\n"
    "import { createInternalSessionLayer, type InternalSessionJob } from './internal-session'\n"
)
if anchor not in text:
    print("FATAL: import anchor not found")
    sys.exit(1)
text = text.replace(anchor, internal_import + anchor, 1)

with io.open(PATH, "w", encoding="utf-8", newline="\n") as f:
    f.write(text)

print("OK: F-5 server.ts updated,", len(text.split("\n")), "lines")