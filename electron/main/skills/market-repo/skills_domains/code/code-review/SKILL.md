---
name: code-review
model: reasoning
category: testing
description: 代码审查的统一技能：按安全、性能、正确性、可维护性、测试与"面向模型/用户的文本"维度审查代码、PR、diff，输出带严重级别的结构化报告。触发：用户请求代码审查、review PR/MR、检查代码质量、分析 diff、审查报错信息/日志/提示词文案（含面向 AI 的系统提示词、工具描述、技能文档）时使用；审查 TypeScript/JavaScript/Python 代码。
version: 2.0.0
author: ABYSSAC
license: MIT
domain: code
---

# 代码审查 Code Review

> **领域级技能 · 接入说明**：本技能属于「代码」领域大类（domain: `code`）。安装后存放于 `skills_domains/code/`，运行期不注入技能清单——系统只注入领域名与技能数量，AI 自行用 Grep/Glob 检索 `skills_domains/code/` 目录定位 SKILL.md（frontmatter 的 name/description 判断是否匹配），再用 `use_skill(skill_name=code-review)` 加载本技能正文后执行；正文开头的触发条件就是「何时该加载本技能」的信号。

## 为什么存在

代码评审的价值在于把"看起来对不对"变成"哪里有问题、多严重、怎么改"。本技能把审查维度、流程、输出格式固定下来：按清单逐项核实而不是泛泛而谈"代码质量"，按严重程度排序而不是平均用力，指出问题的同时给出修复方向，肯定好代码而不是只挑毛病。

## 什么时候用

- 审查 PR/MR、diff 或一段代码的改动（项目 Workflow：读 diff → 审查 → 人工确认 → 输出）
- 检查代码质量与安全反模式（调试残留、类型绕过、any 滥用、日志泄露）
- 建立团队的评审标准或培训新评审者
- 审查"面向模型与用户的文本"：系统提示词、工具 description、技能（SKILL.md）、行为手册、报错信息、日志文案、用户可见 UI 文案——这类文本的读者是模型或终端用户，不是开发者

## 审查维度总览

| Dimension | Focus | Priority |
|-----------|-------|----------|
| Security | Vulnerabilities, auth, data exposure | Critical |
| Performance | Speed, memory, scalability bottlenecks | High |
| Correctness | Logic errors, edge cases, data integrity | High |
| Maintainability | Readability, structure, future-proofing | Medium |
| Testing | Coverage, quality, reliability of tests | Medium |
| Accessibility | WCAG compliance, keyboard nav, screen readers | Medium |
| Documentation | Comments, API docs, changelog entries | Low |
| Prompt & Model-Facing Text | 面向模型/终端用户的文本：措辞、黑话、歧义、免责句式 | Medium |

---

## Security Checklist

Review every change for these vulnerabilities:

- [ ] **SQL Injection** — All queries use parameterized statements or an ORM; no string concatenation with user input
- [ ] **XSS** — User-provided content is escaped/sanitized before rendering; `dangerouslySetInnerHTML` or equivalent is justified and safe
- [ ] **CSRF Protection** — State-changing requests require valid CSRF tokens; SameSite cookie attributes are set
- [ ] **Authentication** — Every protected endpoint verifies the user is authenticated before processing
- [ ] **Authorization** — Resource access is scoped to the requesting user's permissions; no IDOR vulnerabilities
- [ ] **Input Validation** — All external input (params, headers, body, files) is validated for type, length, format, and range on the server side
- [ ] **Secrets Management** — No API keys, passwords, tokens, or credentials in source code; secrets come from environment variables or a vault
- [ ] **Dependency Safety** — New dependencies are from trusted sources, actively maintained, and free of known CVEs
- [ ] **Sensitive Data** — PII, tokens, and secrets are never logged, included in error messages, or returned in API responses
- [ ] **Rate Limiting** — Public and auth endpoints have rate limits to prevent brute-force and abuse
- [ ] **File Upload Safety** — Uploaded files are validated for type and size, stored outside the webroot, and served with safe Content-Type headers
- [ ] **HTTP Security Headers** — Content-Security-Policy, X-Content-Type-Options, Strict-Transport-Security are set

---

## Performance Checklist

- [ ] **N+1 Queries** — Database access patterns are batched or joined; no loops issuing individual queries
- [ ] **Unnecessary Re-renders** — Components only re-render when their relevant state/props change; memoization is applied where measurable
- [ ] **Memory Leaks** — Event listeners, subscriptions, timers, and intervals are cleaned up on unmount/disposal
- [ ] **Bundle Size** — New dependencies are tree-shakeable; large libraries are loaded dynamically; no full-library imports for a single function
- [ ] **Lazy Loading** — Heavy components, routes, and below-the-fold content use lazy loading / code splitting
- [ ] **Caching Strategy** — Expensive computations and API responses use appropriate caching (memoization, HTTP cache headers, Redis)
- [ ] **Database Indexing** — Queries filter/sort on indexed columns; new queries have been checked with EXPLAIN
- [ ] **Pagination** — List endpoints and queries use pagination or cursor-based fetching; no unbounded SELECT *
- [ ] **Async Operations** — Long-running tasks are offloaded to background jobs or queues rather than blocking request threads
- [ ] **Image & Asset Optimization** — Images are properly sized, use modern formats (WebP/AVIF), and leverage CDN delivery

---

## Correctness Checklist

- [ ] **Edge Cases** — Empty arrays, empty strings, zero values, negative numbers, and maximum values are handled
- [ ] **Null/Undefined Handling** — Nullable values are checked before access; optional chaining or guards prevent runtime errors
- [ ] **Off-by-One Errors** — Loop bounds, array slicing, pagination offsets, and range calculations are verified
- [ ] **Race Conditions** — Concurrent access to shared state uses locks, transactions, or atomic operations
- [ ] **Timezone Handling** — Dates are stored in UTC; display conversion happens at the presentation layer
- [ ] **Unicode & Encoding** — String operations handle multi-byte characters; text encoding is explicit (UTF-8)
- [ ] **Integer Overflow / Precision** — Arithmetic on large numbers or currency uses appropriate types (BigInt, Decimal)
- [ ] **Error Propagation** — Errors from async calls and external services are caught and handled; promises are never silently swallowed
- [ ] **State Consistency** — Multi-step mutations are transactional; partial failures leave the system in a valid state
- [ ] **Boundary Validation** — Values at the boundaries of valid ranges (min, max, exactly-at-limit) are tested
- [ ] **Type Safety** — `any` is not abused; type assertions are safe and justified, not used to bypass the type system

---

## Maintainability Checklist

- [ ] **Naming Clarity** — Variables, functions, and classes have descriptive names that reveal intent
- [ ] **Single Responsibility** — Each function/class/module does one thing; changes to one concern don't ripple through unrelated code
- [ ] **DRY** — Duplicated logic is extracted into shared utilities; copy-pasted blocks are consolidated
- [ ] **Cyclomatic Complexity** — Functions have low branching complexity; deeply nested chains are refactored
- [ ] **Error Handling** — Errors are caught at appropriate boundaries, logged with context, and surfaced meaningfully
- [ ] **Dead Code Removal** — Commented-out code, unused imports, unreachable branches, and obsolete feature flags are removed
- [ ] **Magic Numbers & Strings** — Literal values are extracted into named constants with clear semantics
- [ ] **Consistent Patterns** — New code follows the conventions already established in the codebase
- [ ] **Function Length** — Functions are short enough to understand at a glance; long functions are decomposed
- [ ] **Dependency Direction** — Dependencies point inward (infrastructure to domain); core logic does not import from UI or framework layers
- [ ] **Comments Explain Why** — Complex logic has comments that explain *why*, not restate *what* the code does

---

## Testing Checklist

- [ ] **Test Coverage** — New logic paths have corresponding tests; critical paths have both happy-path and failure-case tests
- [ ] **Edge Case Tests** — Tests cover boundary values, empty inputs, nulls, and error conditions
- [ ] **No Flaky Tests** — Tests are deterministic; no reliance on timing, external services, or shared mutable state
- [ ] **Test Independence** — Each test sets up its own state and tears it down; test order does not affect results
- [ ] **Meaningful Assertions** — Tests assert on behavior and outcomes, not implementation details
- [ ] **Test Readability** — Tests follow Arrange-Act-Assert; test names describe the scenario and expected outcome
- [ ] **Mocking Discipline** — Only external boundaries (network, DB, filesystem) are mocked
- [ ] **Regression Tests** — Bug fixes include a test that reproduces the original bug and proves it is resolved

---

## Prompt & Model-Facing Text Checklist

面向模型的文本（系统提示词、工具 description、技能正文、行为手册、持续指令）与面向终端用户的文本（报错信息、日志、UI 文案）遵循同一批措辞标准：**读者是模型或用户，不是开发者**；他们只理解"做什么、何时用、不用的影响"，不理解实现细节。逐条检查：

- [ ] **读者是模型/用户，不是开发者** — 把你放在"第一次读到这段文本"的位置：这句能让我知道做什么吗？还是只让维护代码的人明白了？模型/用户不需要理解的实现细节（常量名、内部组件名、存储路径、注入机制）一律不写
- [ ] **不泄漏黑话与实现细节** — 错误消息与提示词中不出现工程实现词（出口、落盘、恒注入、盘面、违规、常量名、函数名、内部组件名）；删掉实现词后读者是否仍能完整理解该做什么？能，就删
- [ ] **不用负面许可框架** — 不写"不构成违规""不强制走它""不调用也可以"这类免责句式——它们凭空引入不存在的规则概念，读者会开始揣测"什么算违规？有没有我没看到的规则？"；改写为正面声明：做什么、何时用、不调用的影响
- [ ] **正面声明，不写规则悬念** — 每条指令回答读者的问题清单：这是什么？我用它做什么？什么时候用？不用的后果是什么？禁止只写"它是什么"而不写"何时用"
- [ ] **方法论与机制文本分层** — 方法论（怎么思考、怎么判断）是独立内容块，不与机制约束（输出格式、上下文规则）混排；混排会让读者把方法论当可选项跳过、或把规则当建议
- [ ] **消除歧义句** — "全部""所有"等全量词写清范围（本轮/本文件/整个任务）；省略主语、省略适用条件的指令补全
- [ ] **扫描高危措辞** — `grep` 开发者黑话（出口/落盘/恒注入/违规/强制/唯一/必须）与免责句式（不构成/不强制/不调用也可以），命中即作为问题项上报

---

## 审查流程

分三遍走完，每遍只聚焦该遍的层面，一遍抓完所有问题反而会漏。审查对象含"面向模型/用户的文本"时，在第三遍后追加文本扫描步骤。

| Pass | Focus | What to Look For |
|------|-------|------------------|
| First | 全貌浏览（轻量） | 架构契合度、文件组织、API 设计、整体方案 |
| Second | 逐行细节（本轮主体） | 逻辑错误、安全问题、性能瓶颈、边界条件 |
| Third | 边界加固（收尾） | 故障模式、并发、边界值、缺失的测试 |

### 第一遍 · 全貌浏览

1. 读 PR 描述与关联 issue
2. 扫文件清单——改动范围是否合理？
3. 判断整体方案——这是否是解决该问题的正确路径？
4. 确认变更没有引入架构漂移

### 第二遍 · 逐行细节（本轮主体）

1. 自上而下逐文件读 diff
2. 对照上述清单逐项核实每个函数改动，每项标记 ✅ 通过 / ⚠️ 警告 / ❌ 问题
3. 检查每个 I/O 边界的错误处理
4. 标注任何让你停顿的地方——信任直觉

### 第三遍 · 边界加固

1. 想清楚上线后可能出什么错
2. 检查你标注的路径是否缺测试
3. 验证回滚安全——该改动能否不丢数据地回退？
4. 确认文档与 changelog 是否需要同步更新

### 文本审查追加步骤（面向模型/用户的文本）

1. **通读全貌**：列出目标文本涉及的全部副本（含引用它的其他文件），建立清单
2. **追踪注入路径**：以实际注入（模型读到/用户看到）的那一份为准；其余副本为一致性也要同步
3. **扫描高危措辞**：`grep` 黑话与免责句式（见 Prompt & Model-Facing Text Checklist）
4. **以读者视角重读**：逐句问"这句话让我知道该做什么了吗"
5. **保守修订**：改措辞不改行为语义；用户定稿的方法论文本不动，只改周边引导与描述文本
6. **验证收尾**：重新通读受影响段落，确认无残留黑话、无新增歧义

---

## 审查报告格式

输出结构固定为以下模板，结论与问题都按严重程度排序：

```markdown
## 审查结论

[APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION] + 一句话理由

## 严重问题（[CRITICAL]/[MAJOR]，必须修改）

- **[文件:行号]** 问题描述 + 建议修复方式

## 警告（[MINOR]，建议修改）

- **[文件:行号]** 问题描述

## 建议（[NIT]，可选优化）

- 简短建议

## 做得好

- 值得肯定的实现、边界处理或测试
```

---

## 严重级别

每条评论必须以严重级别标签开头，让作者立刻知道什么阻塞合并：

| Level | Label | Meaning | Blocks Merge? |
|-------|-------|---------|---------------|
| Critical | `[CRITICAL]` | Security vulnerability, data loss, or crash in production | Yes |
| Major | `[MAJOR]` | Bug, logic error, or significant performance regression | Yes |
| Minor | `[MINOR]` | Improvement that would reduce future maintenance cost | No |
| Nitpick | `[NIT]` | Style preference, naming suggestion, or trivial cleanup | No |

---

## 反馈原则

- **Be specific** — 指向确切行号并解释问题，不要只说"这有问题"
- **Explain why** — 说明风险或后果，不要只报规则
- **Suggest a fix** — 尽可能给出具体的替代方案或代码片段
- **Ask, don't demand** — 主观点用提问："你觉得……怎么样？"
- **Acknowledge good work** — 明确肯定好代码、巧妙优化或完整测试
- **Separate blocking from non-blocking** — 用严重级别标签区分

### 示例

**Bad:**
> This is wrong. Fix it.

**Good:**
> `[MAJOR]` This query interpolates user input directly into the SQL string (line 42), which is vulnerable to SQL injection. Consider using a parameterized query:
> ```sql
> SELECT * FROM users WHERE id = $1
> ```

**Bad:**
> Why didn't you add tests?

**Good:**
> `[MINOR]` The new `calculateDiscount()` function has a few branching paths — could we add tests for the zero-quantity and negative-price edge cases to prevent regressions?

**Bad:**
> I would have done this differently.

**Good:**
> `[NIT]` This works well. An alternative approach could be extracting the retry logic into a shared `withRetry()` wrapper — but that's optional and could be a follow-up.

### Gotchas

- **不要审查风格**：除非违反团队规范，否则不评论代码风格（用 linter 管）
- **不要要求完美**：找到真问题即可，不要为了审查而审查
- **给修复建议**：指出问题时同时给建议修复方式，不要只说"这有问题"
- **区分严重程度**：不是所有问题都同等重要，输出必须排序
- **肯定好代码**：看到优秀实践时简要肯定，不要让报告全是问题

---

## 审查反模式

| Anti-Pattern | Description |
|--------------|-------------|
| **Rubber-Stamping** | 不读就通过。制造虚假信心、放跑 bug |
| **Bikeshedding** | 纠结变量命名等琐事，却放过竞态条件 |
| **Blocking on Style** | 因格式化拒绝合并——那是 linter 的职责 |
| **Gatekeeping** | 强推个人偏好，尽管提交的方案是正确的 |
| **Drive-by Reviews** | 留一条含糊评论就消失。承诺跟进到底 |
| **Scope Creep Reviews** | 要求无关重构，应当拆成独立 PR |
| **Stale Reviews** | PR 久久无人评审，问题会过时。及时评审，没空就明确移交他人 |
| **Emotional Language** | "这太烂了""显然不对"。批评代码，不批评人 |

---

## 兜底合规 Fallback Discipline

兜底（fallback、降级路径、超时保护、默认值分支）是审查重点之一，也是写代码时最容易"好心办坏事"的地方。按三条核对每个兜底：

- **不要为了兜底而兜底**：没有真实失败场景的兜底不写；兜底必须解决主路径实际会遇到的问题，不能为了"保险"凭空制造新的行为分支。
- **兜底不得改变实际使用逻辑**：兜底分支与主路径必须语义一致——同样的输入给出同样的结果口径（状态、返回值、比较基准、计数方式、验收标准）。绝对禁止因为走了兜底就让结果逻辑、口径或验收标准发生变化。
- **兜底必须可观测**：触发兜底时返回可感知的状态/信号（状态码、日志、提示），AI 能明确知道当前走的是兜底路径，不得静默吞掉失败。

审查他人代码时按此三条核对每个 fallback；自己编写兜底时同样遵守。

---

## 可读性与结构纪律 Readability & Structure Discipline

写代码与审查代码都遵守同一条铁律：**代码首先是写给下一个维护者（包括未来的你自己）读的，然后才是给机器执行的**。可读性不是风格偏好，是长期维护成本的核心变量：不可读的代码隐藏 bug、放大改动成本、让每次换人都变成重写。按以下四点核对：

- **代码可读性优先**：命名揭示意图（不缩写成无意义单词）、函数短到一眼能懂、职责单一、控制流平直。审查时把「这段代码我要反复读几遍才懂」记作问题项，级别不低于 [MINOR]。
- **拒绝屎山代码**：不堆临时补丁、不复制粘贴后微调、不留注释掉的死代码、不用「先跑通再重构」骗自己。每次改动顺手清理路过的脏东西（改到哪、清到哪）。审查时发现明显可清理的屎山区块，指出清理路径，不要用「以后再说」放过。
- **拒绝上帝模块（God Module）**：一个文件/函数/类承担过多不相关职责、动辄上千行的模块、把状态与逻辑搅在一起的巨型对象，都是上帝模块的征兆。出现征兆必须拆分：按职责抽取独立函数/模块，用依赖注入替代全局共享。审查时对上帝模块给出具体拆分建议，而不只是「这个文件太大了」。
- **可读性优先于聪明**：不写炫技的一行流、不滥用高级语法压缩表达；当可读性与「省几行代码」冲突时，选择可读的写法。性能敏感路径例外，但必须注释说明为什么必须这样写。

自己编写代码时按此四条自查；审查他人代码时按此四条核对，命中即上报。

---

## NEVER Do

1. **NEVER approve without reading every changed line** — rubber-stamping is worse than no review
2. **NEVER block a PR solely for style preferences** — use a linter; humans review logic
3. **NEVER leave feedback without a severity level** — ambiguity causes wasted cycles
4. **NEVER request changes without explaining why** — "fix this" teaches nothing
5. **NEVER review a whole large PR in one pass** — comprehension drops sharply on long inputs; split it into batches with a verdict per batch
6. **NEVER skip the security checklist** — one missed vulnerability outweighs a hundred style nits
7. **NEVER make it personal** — review the code, never the coder; assume good intent

---

## 深度判断方法论

评审中需要作出关键判断时（区分真实缺陷与误报、判定是否阻塞合并、选择修复方向），按四步走完再下结论。方法论是独立思考工具，不是输出格式约束：

- **①立根**：写下这次判断依赖的最底层依据；默认成立，允许后面推翻。
- **②验底**：把依赖的默认前提逐个过一遍——有直接证据（代码行为、数据流、规范）的留下，拿不出证据的标为待验，不用它推理。
- **③顺推**：从根开始逐步推，列出每一步的依据；在「直接得出」的地方写明推导或标注假设；列出放弃的备选路径与放弃理由。
- **④验证**：写三条可观测信号——结论为真会发生什么、为假会观察到什么、出现什么信号就推翻它；再写结论落地谁受益、谁受损。写不出信号 = 没想透，回③。

**输出纪律**：下结论后筛一遍——能用最朴实的话复述「为什么成立、推理分几步」才算通过；不堆输出量，不写思考过程的壳话。

---

## 完成标准

审查结束后逐项核对，全部满足才交付结论：

- [ ] 已按三遍流程（全貌 → 逐行 → 边界）走完，没有跳遍
- [ ] 安全清单逐项核对，任一命中已给出修复建议
- [ ] 所有评论带严重级别（`[CRITICAL]/[MAJOR]/[MINOR]/[NIT]`），结论按严重程度排序
- [ ] 报告含「做得好」部分，不只报问题
- [ ] 每个 fallback 已按兜底合规三条核对（不改口径、可观测）
- [ ] 审查对象含面向模型/用户的文本时，已完成黑话与免责句式扫描
- [ ] 结论明确：`APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION`