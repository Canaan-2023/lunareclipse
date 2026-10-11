# -*- coding: utf-8 -*-
"""F-4 拆分收尾：server.ts 中 code-review 相关定义删除并改用 code-review 模块."""
import io, os, sys

# 目标路径按脚本自身位置推导（app/scripts/ -> app 源码根），不依赖本机绝对路径。
PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "electron", "main", "api", "server.ts")

with io.open(PATH, "r", encoding="utf-8") as f:
    lines = f.read().split("\n")

out = []
i = 0
deleted_marks = []

def line_is_template_start(s: str, var: str) -> bool:
    t = s.lstrip()
    return t.startswith("const " + var + " = `")

def line_is_template_end(s: str) -> bool:
    return s.rstrip().endswith("`")

while i < len(lines):
    line = lines[i]
    # 1) 删除 runStream 内 MAX_REVIEW_ROUNDS 常量（已迁 code-review.ts）
    if line.strip() == "const MAX_REVIEW_ROUNDS = 4":
        deleted_marks.append("MAX_REVIEW_ROUNDS")
        i += 1
        continue
    # 2) 删除审查者提示词前的两行注释
    if line.strip() == '// 独立审查者提示词（代表用户立场；非主 AI 身份；吃内部会话上下文）' and i + 1 < len(lines) and lines[i + 1].strip().startswith('// 方法论：三遍审查压缩'):
        i += 2
        continue
    # 3) 删除 REVIEWER_SYSTEM_PROMPT 模板字符串块（起点到行尾反引号）
    if line_is_template_start(line, "REVIEWER_SYSTEM_PROMPT"):
        deleted_marks.append("REVIEWER_SYSTEM_PROMPT")
        while i < len(lines) and not line_is_template_end(lines[i]):
            i += 1
        i += 1  # 结束反引号行
        continue
    # 4) 删除 reviewInstruction 模板字符串块
    if line_is_template_start(line, "reviewInstruction"):
        deleted_marks.append("reviewInstruction")
        while i < len(lines) and not line_is_template_end(lines[i]):
            i += 1
        i += 1
        continue
    out.append(line)
    i += 1

text = "\n".join(out)

# 5) 链收集逻辑调用点替换（行为等价：set/append/take 封装 Map 操作）
old_block = """              const chainRole = isRework ? ('修正' as const) : isReview ? ('审查' as const) : ('产出' as const)
              const prevChain = codeReviewChainRef.get(sessionId)
              if (!isReview && !isRework) {
                codeReviewChainRef.set(sessionId, [{ role: chainRole, content: fullOutput }])
              } else if (prevChain) {
                prevChain.push({ role: chainRole, content: fullOutput })
              } else {
                // 异常顺序兜底：未初始化就出现 review/rework 轮（理论不达）也建链，不丢内容
                codeReviewChainRef.set(sessionId, [{ role: chainRole, content: fullOutput }])
              }

              if (hasReviewPass(fullOutput)) {
                console.log('[code-review] 审查通过，讨论结束')
                void openCodeReviewReport(codeReviewChainRef.get(sessionId) ?? [], sessionId)
                codeReviewChainRef.delete(sessionId)
              } else if (curRound >= MAX_REVIEW_ROUNDS) {
                console.log(`[code-review] 已达最大审查轮数 ${MAX_REVIEW_ROUNDS}，强制结束`)
                void openCodeReviewReport(codeReviewChainRef.get(sessionId) ?? [], sessionId)
                codeReviewChainRef.delete(sessionId)
              } else {"""
new_block = """              const chainRole = isRework ? ('修正' as const) : isReview ? ('审查' as const) : ('产出' as const)
              // 审查链收集（报告通道）：主回复完成时以 sessionId 为键初始化，审查/修正轮按序追加；
              // 结束时（通过或强制结束）整链渲染为 HTML 报告并在月蚀浏览器打开（openCodeReviewReport）。
              const chainEntry = { role: chainRole, content: fullOutput }
              if (!isReview && !isRework) {
                setCodeReviewChain(sessionId, chainEntry)
              } else {
                // 异常顺序兜底：未初始化就出现 review/rework 轮（理论不达）也建链，不丢内容
                appendCodeReviewChain(sessionId, chainEntry)
              }

              if (hasReviewPass(fullOutput)) {
                console.log('[code-review] 审查通过，讨论结束')
                void openCodeReviewReport(takeCodeReviewChain(sessionId), sessionId)
              } else if (curRound >= MAX_REVIEW_ROUNDS) {
                console.log(`[code-review] 已达最大审查轮数 ${MAX_REVIEW_ROUNDS}，强制结束`)
                void openCodeReviewReport(takeCodeReviewChain(sessionId), sessionId)
              } else {"""
if old_block not in text:
    print("FATAL: chain block not found")
    sys.exit(1)
text = text.replace(old_block, new_block, 1)

# 6) HTTP server 创建后绑定 code-review 环境（getter 闭包捕获模块级 server/token）
anchor = "  server = http.createServer(app)"
insert = anchor + "\n  // code-review 报告打开需 server 端口与鉴权 token（注入 getter，模块内按需取值，避免循环依赖）\n  bindCodeReviewEnv({ getServer: () => server, getToken: () => apiTokenSecret })"
if anchor not in text:
    print("FATAL: createServer anchor not found")
    sys.exit(1)
text = text.replace(anchor, insert, 1)

with io.open(PATH, "w", encoding="utf-8", newline="\n") as f:
    f.write(text)

print("deleted:", deleted_marks)
print("len(old):", len(text.split("\n")), "lines")