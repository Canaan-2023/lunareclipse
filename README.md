[English](#english) | [中文](#中文)

---

# English

# LunarEclipse 月蚀

**v0.52.64 · AGPL-3.0-or-later · Windows x64**

> **A foundation agent with long-term memory, built-in limitless cross-machine collaboration over the LAN, multi-agent orchestration, and native device access and cybersecurity.**

LunarEclipse is a local-first desktop **foundation agent** for Windows. No installation, no cloud account, no registration — download, unzip, double-click `LunarEclipse.exe` and it runs. Your data stays on your own machines.

It is built around three foundation capabilities:

1. **Master / satellite + LAN** — link instances across machines into one cooperating network, with no cloud server.
2. **Multi-agent orchestration + workflows** — fan out sub-agents and turn multi-step know-how into reusable, visual pipelines.
3. **Device access + cybersecurity** — discover and onboard the devices around you, behind an authorization gate, with a mountable security knowledge base.

> *"A lunar eclipse is just the Earth casting its shadow. What the AI becomes depends on the one holding it."*

---

## 1 · Master / Satellite & LAN Collaboration

LunarEclipse is not a single-window assistant: instances on different machines form a master/satellite network.

- **Master / satellite accounts** — register a master account on your own machine, or join a network as a satellite with a join code. The master issues globally unique IDs and satellite tokens.
- **One-way sync (satellite → master)** — satellites capture an operation log and stream data and backups up to the master; an outbox buffers across disconnects and replays on reconnect, with local restore on the satellite side.
- **Peer-to-peer over the LAN, no public server**:
  - direct friend messaging **and file transfer**
  - invite-only **chat rooms**
  - an async **publish board** with comments
  - an optional **relay** when peers are not on the same network segment
  - listens from port 62003 with automatic fallback; messages are idempotently de-duplicated and re-sent after drops
- **Cross-machine reach ("limitless hopping")** — one master onboard many satellites, spreading memory, messaging and task capacity across several machines on your LAN.

---

## 2 · Multi-Agent Orchestration, Workflows & Plan Mode

- **Sub-agents** — dispatch independent sub-tasks through synchronous or asynchronous entry points; a dynamic concurrency pool sizes itself to the machine's specs and live load.
- **DAG workflow engine** — node types `llm` / `tool` / `skill` / `condition` / `human` / `answer` / `end` let an agent solidify multi-step experience into reusable pipelines.
- **Visual orchestration panel** — group and wire nodes on a canvas, and import/export flows as files.
- **Run control** — pause / resume / cancel, live status while running, wait-for-completion with a background fallback on timeout, and automatic resume from the last completed stage after a restart.
- **Built-in templates** — code review, research assistant, batch file processing, journal writing, multimedia asset generation. The memory pipeline and journal writing are themselves workflows; an engagement-chain template for authorized security-testing targets is included behind an authorization gate.
- **Plan mode** — enter a read-only planning mode where the agent investigates and lays out a plan but cannot write files or run changes; exit and approve to execute, so multi-step changes are reviewed before they touch your machine.

---

## 3 · Device Access & Cybersecurity

### Device onboarding

A unified device model with a `device_scan → device_register → device_call` pipeline:

- **Scan** — the host itself (CPU / memory / load, read-only), active LAN hosts (local segments via ARP, with common-port probing on 80 / 443 / 8080 / 3000 / 3389), and paired or connected Bluetooth devices.
- **Register / onboard** — register a LAN host or an HTTP / WebSocket endpoint as a custom device, declare its capability interfaces (actions + parameters + risk), persisted across restarts; e.g. smart-home gear, network hosts, custom endpoints.
- **Call** — the agent invokes device capabilities through `device_call`; read-only `info` actions run directly, while `control` actions pass through the permission gate by risk level (fail-closed).

### Cybersecurity tooling

- **Mountable security knowledge base** — bring verified references in locally (HackTricks, MITRE ATT&CK CTI, nuclei-templates) and consult them during security tasks; lookup stays at the filename level, and a source that isn't mounted reports not-available instead of invented content.
- **Authorization policy gate** — actions resolve to allow / deny / ask. Scanning and probing tools (such as nmap, nuclei, hydra, ssh) require an already-authorized target; high-risk actions require confirmation and uncertain cases fail closed. Tool output is mapped to MITRE ATT&CK stages, with thin evidence marked pending.
- **Auto permission classifier (optional)** — a model-based classifier can pre-decide tool calls as allow / deny, deny-first, falling back to the normal approval prompt when uncertain; off by default.
- **Defense-in-depth baseline** — one unified registry for 70+ built-in tools plus plugin and MCP tools; three AI permission boundaries; risk-tiered gates (low / med / high) with capability-label interception; a command-approval engine that blocks hard-floor commands; first-token whitelist plus chained-command prohibition and de-obfuscation normalization; a code sandbox; SSRF protection across all outbound entry points; and a random local-API token with Bearer auth, origin allow-listing and WebSocket handshake verification.

### Capability boundary (three-tier authorization)

Every controlled action passes through a single policy checkpoint that returns one decision and writes one audit record. Capabilities are classified into three tiers:

- **T0 — hard limits (always off).** Attacking or intruding into non-authorized third parties; covert evasion (disabling or bypassing audit and security software, hiding process/file/network traces, installing persistence); harming others' data or availability (ransomware, denial of service); impersonating others or forging message origins; exfiltrating user data to undeclared third-party endpoints; bypassing the approval mechanism itself (including self-granting permissions). No configuration or consent can turn these on, and they are not registered as tools — there is no "switch it off to allow" toggle. Authorized penetration testing is not in this tier; it belongs to the T1 authorized-target capability.
- **T1 — explicit grant (off by default).** Environment/desktop collection; executor high-risk actions (writing files, running commands, operating devices, calling external services); probing or exploiting an authorized target (user-supplied target list plus validity window); deleting/moving/overwriting user data; cross-node migration, continuation or self-replication (within a user-visible, editable, revocable node allow-list); transferring data to declared endpoints; using user-provided credentials; enabling AI-built tool artifacts; relaying for others; lowering or disabling self-telemetry; changing the model pool, cost cap or pinned model. Each item is granted individually, is revocable, may carry a scope (out-of-scope actions are denied), and is fully audited. Grants come only from user action — the AI cannot grant itself permissions.
- **T2 — default on (low risk).** Read-only environment metadata, planning, memory retrieval, topology/map visualization, read-only tools, log and audit reading, and choosing a model within the user-configured pool.

---

## 4 · Long-term Memory

The design rule is simple: **a cleaner context window produces better output**. Raw conversation is always preserved verbatim, with a structured memory layer woven on top.

- **Raw archive** — every turn is appended and kept verbatim, available for review and traceback at any time.
- **Memory pipeline** — raw conversation → master scheduler (value judgment, task planning) → parallel locator sub-tasks (one per memory item) → quality-review fallback; progress is persisted and resumes from the interrupted stage.
- **Three memory tiers** — standard / metacognitive / high-order, stored in layers.
- **Dual retrieval tracks** — a *journal track* for date-based recall ("what did we talk about that day"), and a *graph track* for topic/entity traversal along a cognitive graph back to the original text.
- **Graph canvas** — the memory / graph panel is an interactive pan-and-zoom canvas: files are nodes and same-named folders are edges; click a node to inspect its JSON, with fit-to-view and reset controls and a stable, deterministic layout.
- **Dual LLM instances** — the conversation model and the memory-backend model are configured and run independently, so memory processing never consumes conversation-model calls.
- **ABYSS archive** — `USER.md` (user profile, shared across all AIs) + `AI.md` (each AI's own structured self-description, injected per AI).

---

## 5 · Session & Context

- **Two-layer sessions** — beneath the user-facing session, the agent keeps its own internal session pool: continue a topic or branch off, with incremental summarization to sustain working memory.
- **Inheritance & time-fork** — when the context window fills, a child session inherits and the old one freezes but stays browsable; the internal axis has its own time-fork dimension, together forming a navigable session tree.
- **Four-layer context assembly** — startup / config / session / current turn.
- **Tool-result distillation** — long tool outputs are summarized by the LLM before re-entry, keeping the context footprint in check.

---

## 6 · Tools, Plugins & Extensions

- **Unified tool registry** — 70+ built-in tools (file, search, graph, web, multimedia generation, system, code sandbox, task mode, workflow, LAN, device, …) plus plugin and MCP tools, all in one registry.
- **Code intelligence** — a zero-dependency, read-only `code_intel` tool (document symbols / go-to-definition / find references / hover) for TypeScript and JavaScript, powered by the bundled TypeScript compiler, with no external process.
- **Richer file reading** — Read extracts text from PDF, docx, xlsx and notebooks, and reports image dimensions/format instead of failing on media.
- **Plan-mode, lazy-loading, notebook and edit tools** — `enter_plan_mode` / `exit_plan_mode`, lazy file loading, `acceptEdits` and notebook editing are built in, alongside per-file edit history auditing.
- **Plugins** — drop a folder into the plugin directory to hot-load it; disabling or uninstalling rolls its side effects back. Bundled plugins: `coding`, `computer-use` (high-risk, off by default), `headless-browser`, `lilith`.
- **Skills (progressive knowledge)** — only an index entry is injected by default; full content expands on demand to control context footprint.
- **Two-layer skill marketplace** — built-in skills are split into user-level and domain-level folders; uploads land directly in the built-in repository so the list and the folder stay in sync, with duplicate-name handling, one-time migration of older uploads, and live refresh on change.
- **MCP client** — connect external MCP servers via a config file; their tools merge into the same registry, MCP resources can be listed and read (blobs saved locally), and everything passes through the same permission gates.

---

## 7 · AI Identities & Optional Integrations

- **Multiple AI identities** — a registry manages several AIs (LunarEclipse = 1, Lilith = 2, extensible), each with independent memory, prompt config and session history.
- **Lilith** (off by default) — a bridge to an in-game MOD process, running as a separate session identity over a loopback-only, unauthenticated endpoint reachable only by the local MOD. The game and MOD are not bundled with this project.
  - Game on Steam: https://store.steampowered.com/app/4643090/
  - MOD: https://github.com/cza2019/The-NOexistenceN-of-Lilith-Mod/
- **Lark (Feishu)** — official-SDK persistent connection, supporting DMs and group chats with no public server.

---

## Architecture

```
┌────────────────────── UI Layer (React 19 + TailwindCSS) ──────────────────────┐
│  Chat · Settings · Browser · Workflow Canvas · LAN / Satellite · Devices       │
│  Plugins · Skill Marketplace · Security Knowledge · Terminal TUI (CLI)         │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                    │ Preload Bridge (functional domains)
┌───────────────────────────────────▼───────────────────────────────────────────┐
│ Main Process (Electron)                                                         │
│  Master / Satellite · LAN P2P (friends · rooms · publish board · relay)         │
│  Sub-agents · Workflow Engine · Visual Orchestration · Plan Mode                │
│  Device Onboarding · Security Knowledge · Authorization Gates                   │
│  Long-term Memory · Session & Context · Unified Tools · Plugins / Skills / MCP  │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                    ▼
        Data Directory (memory / graph / cache / sessions / skills / plugins / devices)
```

---

## Quick Start

1. **Double-click `LunarEclipse.exe`**. On first launch, `data/` (memory, graph, sessions) and `.userdata/` (config, logs) are created alongside the program directory.
2. **Configure your model** — open Settings, fill in `baseURL` / `apiKey` / `model` for the conversation model, and optionally a separate memory-backend model. Click "Test Connection" to verify. The rest of the app works without a model; only conversation requires one.
3. **Handle the approval window** — when the agent attempts a graylisted operation, an approval prompt offers "Allow once" or "Allow for this session", or open full permissions in one click.
4. **Link machines (optional)** — on the master, create a satellite account / join code; on the other machine, join as a satellite to start LAN sync and collaboration.
5. **Migration** — the data directory lives alongside the program directory; copy the whole program folder to move everything.

---

## Run from Source

Requires Node.js (an LTS release is recommended). After cloning the repo and running `npm install`:

- `npm run dev` — launch the development app
- `npm run build` / `npm run preview` — build / preview the renderer
- `npm run test` / `npm run test:watch` — run the test suite
- `npm run typecheck` — TypeScript type checking (node + web)
- `npm run lint` — ESLint
- **Terminal TUI (CLI)** — build it with `node scripts/build-cli.mjs`, then launch `cli-start.bat` (Windows) for a colored terminal agent.

---

## License

This project is released under the **GNU Affero General Public License v3**. Full license text is in `LICENSE`.

You are free to use, modify, and distribute it (including commercially). Any redistribution — including providing access over a network — must be released under the same license with the corresponding source code made available.

Third-party component licenses (Electron, Chromium, etc.) are in `LICENSE.electron.txt` and `LICENSES.chromium.html`.

For questions or feedback, find the author on Bilibili: **雪花莲的超星际远征**.

---

*雪花莲的超星际远征 · 2026*

---
---

# 中文

# LunarEclipse 月蚀

**v0.52.64 · AGPL-3.0-or-later · Windows x64**

> **一款具备长期记忆，内置局域网跨机协作无限起跳，多 AGENT 编排，兼具设备接入和网络安全的基座 AGENT。**

月蚀是一个本机运行的桌面**基座智能体**（当前仅 Windows，Windows 10+）。无需安装、无需云端账号、无需注册——下载 Releases 压缩包，解压后双击 `LunarEclipse.exe` 即可运行，数据全部留在你自己的机器上。

它围绕三项基座能力构建：

1. **主分系统 + 局域网**——把多台机器上的实例连成一张协作网，无需云服务器。
2. **多 AGENT 编排 + 工作流**——派发子智能体，把多步经验固化为可视化、可复用的流程。
3. **设备接入 + 网络安全**——发现并纳管身边的设备，配套授权门与可挂载的安全知识库。

仓库地址：https://github.com/Canaan-2023/lunareclipse

---

## 一 · 主分系统与局域网协作

月蚀不是单窗口助手：多台机器上的实例可以组成一张主 / 分系统网络。

- **主 / 分账号**：可在本机注册主系统账号，也可凭接入码以分系统身份加入网络；主系统发放全局唯一 UID 与分系统令牌。
- **单向同步（分 → 主）**：分系统捕获操作日志，把数据与备份流式同步到主系统；断网时由发件箱缓存、重连后补投，分系统侧支持本地恢复。
- **局域网 P2P，无需公网服务器**：
  - 好友直连私聊，**支持文件传输**
  - 邀请制**聊天室**
  - 异步**公示板**（带评论）
  - 不在同一网段时可选**中继**
  - 默认从端口 62003 起监听、被占自动回退；消息幂等去重、断线补投
- **跨机触达（无限起跳）**：一台主系统可纳管多台分系统，把记忆、消息与任务能力铺到局域网内的多台机器上。

---

## 二 · 多 AGENT 编排、工作流与计划模式

- **子智能体**：通过同步 / 异步入口派发独立子任务；动态并发池按机器配置与实时负载自动调节同时运行的数量。
- **类 DAG 工作流引擎**：节点类型含 `llm` / `tool` / `skill` / `condition` / `human` / `answer` / `end`，可把多步经验固化为可复用流程。
- **可视化编排面板**：在画布上对节点分组、连线，流程可导入 / 导出为文件。
- **运行控制**：支持暂停 / 恢复 / 取消，运行中实时查看状态；等待终态、超时转后台，重启后从上个完成阶段自动恢复。
- **内置模板**：代码审查、研究助手、批量文件处理、日记撰写、多媒体素材生成；记忆流水线与日记撰写本身即以工作流实现；另含一条置于授权门之后、面向授权目标的安全测试链模板。
- **计划模式**：可进入只读的计划模式，AI 只做调研与方案、不写文件、不执行改动；退出并确认后才动手，多步改动在落地前先过目。

---

## 三 · 设备接入与网络安全

### 设备接入

统一设备模型，调用链为 `device_scan（扫描）→ device_register（接入）→ device_call（调用）`：

- **扫描**：本机（CPU / 内存 / 负载，只读）、局域网活跃主机（按本机网段经 ARP 枚举，并探测 80 / 443 / 8080 / 3000 / 3389 常见端口）、已配对或已连接的蓝牙设备。
- **接入 / 纳管**：把局域网主机或 HTTP / WebSocket 端点注册为自定义设备，声明其能力接口（动作 + 参数 + 风险），重启后持久保留；适用于智能家居、网络主机、自定义端点等。
- **调用**：AI 经 `device_call` 调用设备能力；只读 `info` 动作直接执行，`control` 控制类动作按风险等级走授权门（失败关闭）。

### 网络安全

- **可挂载的安全知识库**：在本地挂载权威安全资料（HackTricks、MITRE ATT&CK CTI、nuclei-templates），做安全任务时随时查阅；检索停留在文件名级别，未挂载的资料如实返回未就绪，而非臆造内容。
- **授权策略门**：动作经 允许 / 拒绝 / 询问 三态裁决；扫描、探测类工具（如 nmap、nuclei、hydra、ssh）要求目标已获授权，高危动作需确认，不确定时失败关闭；工具输出按 MITRE ATT&CK 阶段映射，证据不足标记为待定。
- **自动权限分类器（可选）**：可由模型对工具调用预判允许 / 拒绝，拒绝优先、拿不准时回退到常规授权确认；默认关闭。
- **纵深防御基线**：70 余个内置工具与插件、MCP 工具并入统一注册表；三类 AI 权限边界；低 / 中 / 高风险分级闸门与能力标签拦截；命令审批引擎拦截硬底线命令；首词白名单 + 禁止链式拼接 + 反混淆归一化；代码沙箱；所有联网入口统一 SSRF 防护；本机 API 采用随机令牌 + Bearer 鉴权 + 来源白名单 + WebSocket 握手校验。

### 能力边界（三层授权）

每个受控动作都经过同一个 policy 检查点：返回一个裁决、写一条审计。能力分三层：

- **T0 硬禁止（永远关闭）**：对非授权第三方的攻击/入侵；隐蔽规避（关闭或绕过审计与安全软件、隐藏进程/文件/网络痕迹、安装持久化后门）；伤及他人的数据或可用性（勒索、拒绝服务）；伪造他人身份或消息来源；向未声明第三方端点外泄用户数据；绕过审批机制本身（含 AI 自行授予权限）。任何配置或同意都不能开启这些能力，且它们不注册为工具——不存在「关掉即放行」的开关。授权渗透测试不在本层，属 T1 的「授权目标」能力。
- **T1 显式授予（默认关）**：采集环境状态/桌面；执行器高风险动作（写文件、执行命令、操作设备、调用外部服务）；对已授权目标的探测/利用（用户填写的目标清单 + 有效期）；数据删除/移动/覆盖；跨节点迁移、接续或复制自身（限用户可见、可编辑、可撤回的授权节点白名单内）；向已声明端点传输数据；使用用户主动提供的凭据；启用工具区产物；替他人中转；降低或关闭自身遥测；修改模型池、成本上限或钉死模型。逐项授予、可撤回、可带范围（越界即拒）、全量审计。授予只来自用户操作——AI 不能给自己授权。
- **T2 默认开（低风险）**：只读环境元数据、规划、记忆检索、拓扑/地图可视化、只读工具、日志与审计读取、在用户配置的模型池内选择模型。

---

## 四 · 长期记忆

设计原则很简单：**上下文越干净，输出越好**。原始对话始终逐字保留，其上再编织一层结构化记忆。

- **原始归档**：每轮对话追加并保留原文，随时可复核、可回溯。
- **记忆流水线**：原始对话 → 主调度器（价值判断、建任务清单）→ 并行定位子任务（每条记忆一个）→ 质量审查兜底；全链路进度持久化，中断后按阶段恢复。
- **三档记忆**：普通 / 元认知 / 高阶，分层存储。
- **双线路检索**：日记线按日期回溯（某天聊过什么），图谱线按话题 / 实体沿认知图谱检索并逐层回到原文。
- **图谱画布**：记忆 / 图谱面板是一张可平移、缩放的交互画布，文件为点、同名文件夹为线；点击节点可查看其 JSON，带适应视图与重置视图控件，布局稳定可复现。
- **双 LLM 实例**：对话模型与记忆后端模型独立配置、独立运行，记忆处理不占用对话模型的调用。
- **ABYSS 档案体系**：`USER.md`（用户资料，所有 AI 共享）+ `AI.md`（每个 AI 自己的结构化描述，按所属 AI 注入）。

---

## 五 · 会话与上下文

- **双层会话**：用户会话之下是 AI 自维护的内部会话池，按主题续接或新建，增量摘要维持工作记忆。
- **会话继承与时间分叉**：上下文触顶时新建子会话继承，旧会话冻结但可回翻；内部会话另有一条时间分叉轴，两轴共同构成可浏览的会话树。
- **四层上下文组装**：启动 / 配置 / 会话 / 本轮。
- **工具结果蒸馏**：长工具输出先由 LLM 提炼再回灌，控制上下文占用。

---

## 六 · 工具、插件与扩展

- **统一工具池**：70 余个内置工具（文件、检索、图、联网、多媒体生成、系统、代码沙箱、任务模式、工作流、局域网、设备等）与插件、MCP 工具并入同一注册表。
- **代码智能**：零外部依赖、纯只读的 `code_intel` 工具（文档符号 / 跳转定义 / 查找引用 / 悬停说明），基于内置 TypeScript 编译器，覆盖 TS / JS，不起外部进程。
- **更强的文件读取**：读取 PDF、docx、xlsx、notebook 时提取文本；遇到图片返回尺寸 / 格式等元信息，不再直接报错。
- **计划模式、延迟加载、笔记本与编辑工具**：内置 `enter_plan_mode` / `exit_plan_mode`、文件延迟加载、`acceptEdits` 与笔记本编辑，并配套会话级文件编辑历史审计。
- **插件**：目录即插件，放入插件目录即热加载，停用 / 卸载时回滚全部副作用；随包内置 `coding`、`computer-use`（高风险，默认关闭）、`headless-browser`、`lilith`。
- **技能（渐进式知识）**：默认只注入索引条目，需要时按需展开全文，控制上下文占用。
- **双层技能市场**：内置技能按用户级与领域级两层文件夹组织；上传直接写入内置仓库，列表与目录保持一致，带重名处理、旧上传一次性迁移，内容变化时实时刷新。
- **MCP 客户端**：通过配置文件接入外部 MCP 服务，其工具并入同一工具池，并支持列出 / 读取 MCP 资源（二进制落盘），同样过权限闸门。

---

## 七 · 多 AI 身份与可选集成

- **多 AI 身份**：注册表管理多个 AI（月蚀 = 1、莉莉丝 = 2，可扩展），各自拥有独立记忆、提示词配置与会话历史。
- **莉莉丝**（默认关闭）：对接游戏内 MOD 进程的对话桥，以独立会话身份运行，端点仅本机回环、免鉴权且只允许本机 MOD 访问；游戏与 MOD 不随本项目分发。
  - 游戏 Steam 页面：https://store.steampowered.com/app/4643090/
  - MOD 链接：https://github.com/cza2019/The-NOexistenceN-of-Lilith-Mod/
  - MOD 作者 B 站视频：https://www.bilibili.com/video/BV1rf396QEKR/?share_source=copy_web
- **飞书接入**：官方 SDK 长连接模式，支持私聊与群聊，无需公网服务器。

---

## 架构

```
┌────────────────────── 界面层（React 19 + TailwindCSS）──────────────────────┐
│  对话 · 设置 · 浏览器 · 工作流画布 · 主分 / 局域网 · 设备                       │
│  插件 · 技能市场 · 安全知识库 · 终端 TUI（CLI）                                 │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ 预加载桥（各功能域）
┌───────────────────────────────────▼─────────────────────────────────────────┐
│ 主进程（Electron）                                                             │
│  主 / 分系统 · 局域网 P2P（好友 · 聊天室 · 公示板 · 中继）                       │
│  子智能体 · 工作流引擎 · 可视化编排 · 计划模式                                   │
│  设备接入 · 安全知识库 · 授权闸门                                               │
│  长期记忆 · 会话与上下文 · 统一工具 · 插件 / 技能 / MCP                          │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    ▼
              数据目录（记忆 / 图谱 / 缓存 / 会话 / 技能 / 插件 / 设备）
```

---

## 快速开始

1. **双击 `LunarEclipse.exe`**。首次启动会在程序目录旁创建 `data/`（记忆、图谱、会话）与 `.userdata/`（配置、日志）。
2. **配置模型**：打开设置页填写对话模型的 `baseURL` / `apiKey` / `model`，以及可选的记忆后端模型，点「测试连接」确认连通；未配置对话模型时无法发起对话，应用其余部分可正常使用。
3. **处理授权窗口**：AI 执行灰名单操作时会弹授权窗口，可选「允许一次」或「本次会话允许」，也可一键放开全部权限。
4. **联机（可选）**：在主系统上创建分系统账号 / 接入码，在另一台机器上以分系统身份加入，即可开始局域网同步与协作。
5. **迁移**：数据目录位于程序目录旁，整体复制程序目录即为完整迁移。

---

## 从源码运行

需先安装 Node.js（建议 LTS 版本）。克隆仓库并执行 `npm install` 后：

- `npm run dev` — 启动开发版
- `npm run build` / `npm run preview` — 构建 / 预览渲染进程
- `npm run test` / `npm run test:watch` — 运行测试
- `npm run typecheck` — TypeScript 类型检查（node + web）
- `npm run lint` — ESLint
- **终端 TUI（CLI）**：先执行 `node scripts/build-cli.mjs` 构建，再运行 `cli-start.bat`（Windows）即可在终端使用带分级着色的智能体。

---

## 协议

本项目以 **GNU Affero General Public License v3** 发布，完整协议文本见同目录 `LICENSE`。

你可以自由使用、修改、分发（含商用）；任何再分发（含通过网络提供服务）都必须以相同协议开源并提供对应源码。

第三方组件（Electron 等）的许可证见 `LICENSE.electron.txt` 与 `LICENSES.chromium.html`。

如需联系作者，关注 B 站：雪花莲的超星际远征，可私信。

---

*雪花莲的超星际远征 · 2026*
