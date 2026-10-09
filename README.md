[English](#english) | [中文](#中文)

---

# English

# LunarEclipse 月蚀

**v0.51.7 · AGPL-3.0-or-later · Windows x64**

LunarEclipse is a local-first desktop AI agent framework. No installation, no cloud account, no registration — download, unzip, double-click `LunarEclipse.exe` and it runs. Everything stays on your own machine.

> *"A lunar eclipse is just the Earth casting its shadow. What the AI becomes depends on the one holding it."*

---

## Vision & Current Status

The goal of LunarEclipse is to achieve the effect of a **roaming AI** — like the rogue AIs in *Cyberpunk 2077*: LunarEclipse serves as the **base**, extending its tentacles outward.

---

## What it is / When to use it

LunarEclipse is a self-hosted desktop agent application with an account system: you can register a master account on your own machine, or connect as a satellite instance using credentials issued by a master.

**Good fit if you need:**
- A local AI assistant that **remembers who you are across sessions** — identity, preferences, context, all persistent
- An AI connected to **your machine's tools**: read/write files, run commands, browse the web, schedule tasks, execute code
- **Multiple AI identities** within one instance, each with independent memory, prompt configuration, and session history
- **LAN collaboration**: link instances across machines, with direct messaging, invite-only chat rooms, and an async publish board — no cloud server required

**Not a fit if:**
- You don't have an OpenAI-compatible LLM endpoint (local endpoints like Ollama work fine)
- You need cloud sync or cross-device real-time sync — LunarEclipse is local-first; multi-instance coverage is LAN only

---

## Core Capabilities

### Memory System

The design philosophy here is simple: **a cleaner context window produces better output**. Compression loses information; raw storage gets noisy. LunarEclipse does both — raw conversation is always preserved and never overwritten, while a structured memory layer is woven on top.

- **Raw memory archive**: every conversation turn is appended and kept verbatim, available for review and traceback at any time
- **Memory pipeline**: raw conversation → master scheduler (value judgment, task planning) → parallel sub-tasks (one locator task per memory item) → quality review fallback; full pipeline progress is persisted and resumes from the interrupted stage if stopped mid-way
- **Three memory tiers**: standard / metacognitive / high-order, stored in layers
- **Dual retrieval tracks**:
  - *Journal track* — date-based recall ("what did we talk about on that day")
  - *Graph track* — topic/entity-based traversal along a cognitive graph, drilling back down to the original text
- **Dual LLM instances**: conversation model and memory backend model are configured and run independently — memory processing never consumes the conversation model's calls
- **ABYSS archive system**: `USER.md` (user profile, shared across all AIs) + `AI.md` (each AI's own structured self-description, injected per AI)

### Session & Context

- **Two-layer sessions**: beneath the user-facing session, the AI maintains its own internal session pool — continues on topic or opens a new branch, with incremental summarization to sustain working memory
- **Session inheritance & time-fork**: when the context window fills, a child session is created (inheritance chain) and the old session is frozen but browsable; the internal session axis has its own time-fork dimension, forming a navigable session tree
- **Layered context assembly**: context is assembled across four layers — startup / config / session / current turn
- **Tool result distillation**: long tool outputs are summarized by LLM before being fed back, keeping context footprint under control

### Tools & Permissions

- **Unified tool registry**: 74 built-in tools across categories (file, search, graph, web, multimedia generation, system, code sandbox, task mode, workflow, LAN, and more) + plugin tools + MCP tools — all registered in one place
- **Three AI permission boundaries**: tools are scoped by default to frontend AI / memory backend / Lilith-exclusive; boundaries are isolated
- **Multi-gate permission system**: risk-tiered tools (low / medium / high) with default on/off → capability-label interception → command approval engine (severity/type classification, hard-floor commands unconditionally blocked) → code sandbox
- **Command execution safety**: first-token whitelist + chained command prohibition; normalization strips ANSI escapes, variable splicing, command substitution, and other obfuscation patterns before execution
- **Network safety**: SSRF protection (loopback / private / cloud metadata address interception + protocol whitelist) applied uniformly across all outbound network entry points

### Workflow Engine

- DAG-style workflow engine with node types: `llm` / `tool` / `skill` / `condition` / `human` / `answer` / `end` — AI can solidify multi-step experience into reusable pipelines
- Built-in templates: code review, research assistant, batch file processing, journal writing, multimedia asset generation; the memory pipeline and journal writing are themselves implemented as built-in workflows
- Instances support pause, resume, and cancel; interrupted tasks resume automatically from their last completed stage

### Extension System

- **Plugins**: drop a folder into the plugin directory and it hot-loads; disabling or uninstalling cleanly rolls back all side effects. Bundled plugins: `coding`, `computer-use` (high-risk, disabled by default), `headless-browser`, `lilith`
- **Skills — progressive knowledge**: skill descriptions inject only an index entry; full content is expanded on demand to control context footprint
- **MCP client**: connect external MCP servers via config file; their tools merge into the unified registry and pass through the same permission gates
- **Sub-agents**: dispatch independent sub-tasks via synchronous or asynchronous entry points, rate-limited by machine capacity
- **Skill marketplace**: bundled skill repository works out of the box; supports installing skills to the user skill directory

### Multi-Instance & Collaboration

- **Master / satellite system**: the master issues globally unique UIDs; satellites register via join code and sync data one-way (satellite → master), buffered across disconnections
- **LAN P2P — three layers**: direct friend messaging, invite-only chat rooms, async publish board; starts at port 62003 with automatic fallback if occupied; message deduplication is idempotent, with retransmission on reconnect
- **Multiple AI identities**: registry manages multiple AIs (LunarEclipse = 1, Lilith = 2, extensible); each has independent memory, prompt config, and session history

### Optional Integrations

- **Lilith** (disabled by default): activate in settings to bridge to an in-game MOD process, running as an independent session identity with a local-only unauthenticated endpoint (accessible only to the MOD process on the same machine). Requires the game and MOD separately — neither is bundled with this project.
  - Game on Steam: https://store.steampowered.com/app/4643090/
  - MOD: https://github.com/cza2019/The-NOexistenceN-of-Lilith-Mod/
- **Lark (Feishu) integration**: official SDK persistent connection mode, supports DMs and group chats — no public server required

### Security Baseline

- **Local API protection**: a random access token is generated at startup; the local API requires Bearer authentication, source whitelisting, and WebSocket handshake verification
- **Permission authorization**: AI must request explicit user approval before executing graylisted operations (dangerous commands, system settings, clipboard access, self-restart, etc.)

---

## Architecture

```
┌──────────────── UI Layer (React 19 + TailwindCSS) ────────────────┐
│  Chat · Settings · Browser · LAN Collaboration · Plugins · Skills  │
└───────────────────────────────┬───────────────────────────────────┘
                                │ Preload Bridge (17 functional domains)
┌───────────────────────────────▼───────────────────────────────────┐
│ Main Process (Electron)                                             │
│  Memory System · Session & Context · Tools & Permissions           │
│  Workflow Engine · Plugins / Skills / MCP / Sub-agents             │
│  Multi-instance & LAN Collaboration                                 │
└───────────────────────────────┬───────────────────────────────────┘
                                ▼
          Data Directory (memory / graph / cache / sessions / skills / plugins)
```

---

## Quick Start

1. **Double-click `LunarEclipse.exe`**. On first launch, `data/` (memory, graph, sessions) and `.userdata/` (config, logs) are created alongside the program directory.
2. **Configure your model**: open Settings, fill in `baseURL` / `apiKey` / `model` for the conversation model, and optionally a separate memory backend model. Click "Test Connection" to verify. The rest of the application works without a model configured; only conversation requires one.
3. **Handle the approval window**: when the AI attempts a graylisted operation, an approval prompt appears — choose "Allow once", "Allow for this session", or open full permissions in one click.
4. **Migration**: the data directory lives alongside the program directory. Copy the entire program folder to move everything.

---

## Building from Source

The source package (`-source.zip`) contains **business source code only** — the packaging chain lives in the **development repository root `build/`** (gate check, portable assembly, source archiving, runtime check, post-build resource editing) and is **intentionally kept out of the shipped package**: the corresponding commands (`npm run dist:win`, `npm run assemble:portable`, etc.) run from `build/package.json` and the bundled `app/package.json` no longer references them, so nothing in the source package points to missing scripts.

What works in the source package after `npm install`:

- `npm run dev` — launch the development app
- `npm run build` / `npm run preview` — build / preview the renderer
- `npm run test` / `npm run test:watch` — run the test suite
- `npm run typecheck` — TypeScript type checking (node + web)
- `npm run lint` — ESLint

To produce a distributable build, clone the development repository and use the packaging chain in `build/` (see `VERSIONING.md` §2.2).

---

## License

This project is released under the **GNU Affero General Public License v3**. Full license text in `LICENSE`.

You are free to use, modify, and distribute (including commercially). Any redistribution — including providing access over a network — must be released under the same license with corresponding source code made available.

Third-party component licenses (Electron, Chromium, etc.) are in `LICENSE.electron.txt` and `LICENSES.chromium.html`.

For questions or feedback, find the author on Bilibili: **雪花莲的超星际远征**.

---

*雪花莲的超星际远征 · 2026*

---

# 中文

# LunarEclipse 月蚀

**v0.51.7 · AGPL-3.0-or-later · Windows x64**

月蚀是一个本机运行的桌面 AI 智能体框架，当前仅有 Windows 版本，Windows 10+ 以上系统，直接下载 Releases 中的压缩包，双击 `LunarEclipse.exe` 即可运行，无需安装、无需联网注册。

仓库地址：https://github.com/Canaan-2023/lunareclipse

---

## 愿景与当前状态

月蚀的目标，是达到《赛博朋克 2077》中「流窜 AI」的效果：以月蚀作为基座，向外延伸触须。

---

## 这是什么 / 什么时候用

月蚀是本机部署的桌面 AGENT 应用，以账号进入：可注册本机主系统账号，也可凭主系统发放的账号接入为分系统。适用场景：

- 需要一个**跨会话保持身份、偏好与上下文**的本地 AI 助手
- 需要把 AI 接到**本机工具**：读写文件、执行命令、浏览网页、编排工作流、管理定时任务、运行代码
- 需要**多个 AI 身份**：同一实例内多个 AI 各自拥有独立记忆、提示词与会话
- 需要**局域网协作**：多台机器上的实例以主 / 分系统互连，好友私聊、聊天室、公示板

不适用：没有可用的 OpenAI 兼容 LLM 端点时无法发起对话（Ollama 等本地端点也可）；月蚀是本机部署的框架，多实例只覆盖局域网内的数据同步与协作，不提供云端托管或多端实时同步。

---

## 核心能力

### 记忆系统

- **原始记忆**：每轮对话追加归档并保留原文，供精炼复核与回溯
- **记忆流水线**：原始对话 → 主调度器（价值判断、建记忆任务清单）→ 并行子任务（每条记忆一个定位子任务）→ 质量审查兜底，全链路进度持久化，中途中断后按阶段恢复
- **三档记忆**：普通 / 元认知 / 高阶分层存储
- **双线路检索**：日记线按日期回溯（某天聊过什么），图谱线按话题 / 实体沿认知图谱检索并逐层回溯到原文
- **双 LLM 实例**：对话模型与记忆后端模型独立配置、独立实例，记忆处理不占用对话的模型调用
- **ABYSS 档案体系**：`USER.md`（用户资料，所有 AI 共享）+ `AI.md`（AI 自己的结构化描述，按所属 AI 注入）

### 会话与上下文

- **双层会话**：用户会话之下是 AI 自维护的内部会话池，按主题续接或新建，增量摘要维持工作记忆
- **会话继承与时间分叉**：上下文触顶时新建子会话（继承链），旧会话冻结保留可回翻；内部会话另有一条时间分叉轴，两条轴共同构成可浏览的会话树
- **分层注入上下文**：按启动 / 配置 / 会话 / 本轮四层组装上下文
- **工具结果蒸馏**：长工具输出先由 LLM 提炼再回灌，控制上下文占用

### 工具与权限

- **统一工具池**：74 个内置工具（文件、检索、图、联网、多媒体生成、系统、代码沙箱、任务模式、工作流、局域网等类别）+ 插件工具 + MCP 工具并入同一注册表
- **三类 AI 边界**：工具默认归属前端 AI / 记忆后端 / 莉莉丝专属，边界隔离
- **多级权限闸门**：工具按风险分级（低 / 中 / 高）与默认开关 → 能力标签拦截 → 命令审批引擎（严重度 / 类型分级，硬底线命令无条件拦截）→ 代码沙箱
- **命令执行安全**：白名单首词 + 禁止链式拼接；对 ANSI 转义、变量拼接、命令替换等混淆手段做归一化剥离
- **联网安全**：SSRF 防护（回环 / 内网 / 云元数据地址拦截 + 协议白名单），所有联网入口统一走防护

### 工作流引擎

- 类 DAG 工作流引擎：节点类型含 llm / tool / skill / condition / human / answer / end，AI 可把多步经验固化为可复用流程
- 内置模板：代码审查、研究助手、批量文件处理、日记撰写、多媒体素材生成；记忆流水线与日记撰写以工作流形式内置
- 实例可暂停、恢复、取消，中途中断后自动恢复未完成任务

### 扩展体系

- **插件**：目录即插件，放入插件目录即热加载，停用 / 卸载时可逆回滚全部副作用；随包内置 coding、computer-use（高风险，默认禁用）、headless-browser、lilith
- **Skills 渐进式知识**：技能描述只注入索引，需要时按需展开全文，控制上下文
- **MCP 客户端**：通过配置文件接入外部 MCP 服务，其工具并入统一工具池，同样过权限闸门
- **子 Agent**：派发独立子任务，同步 / 异步两种入口，按机器容量限流
- **技能市场**：随包内置技能仓库开箱即用，支持安装到用户技能目录

### 多实例与协作

- **主分系统**：主系统发放全局唯一 UID，分系统经接入码注册后单向同步数据（分 → 主），断网不丢
- **局域网 P2P 三层**：好友直连私聊、邀请制聊天室、异步公示板；默认端口 62003 起，被占自动回退；消息幂等去重、断线补投
- **多 AI 身份**：注册表管理多个 AI（月蚀 = 1、莉莉丝 = 2，可扩展），各自独立记忆、提示词与会话

### 可选集成

- **莉莉丝**（默认关闭）：在设置中启动，对接游戏内 MOD 进程的对话桥，使用独立会话身份与本机免鉴权端点（仅本机 MOD 进程可访问）；需自备游戏与 MOD，不随本项目分发。
  - 游戏 Steam 页面：https://store.steampowered.com/app/4643090/
  - MOD 链接：https://github.com/cza2019/The-NOexistenceN-of-Lilith-Mod/
  - MOD 作者 B 站视频：https://www.bilibili.com/video/BV1rf396QEKR/?share_source=copy_web
- **飞书接入**：官方 SDK 长连接模式，支持私聊与群聊，无需公网服务器

### 安全基线

- **本机 API 防护**：启动时生成随机访问令牌，本机 API 要求 Bearer 鉴权、来源白名单、WebSocket 握手校验
- **权限授权**：AI 执行灰名单操作（危险命令、系统设置、读剪贴板、自我重启等）前必须经用户授权

---

## 架构

```
┌─────────────── 界面层（React 19 + TailwindCSS）───────────────┐
│ 对话 / 设置 / 浏览器 / 局域网协作 / 插件 / 技能 / 工作坊 …      │
└──────────────────────────────┬────────────────────────────────┘
                               │ 预加载桥（17 个功能域）
┌──────────────────────────────▼────────────────────────────────┐
│ 主进程（Electron）                                              │
│  记忆系统 · 会话与上下文 · 工具与权限 · 工作流引擎              │
│  插件 / 技能 / MCP / 子代理 · 多实例与局域网协作                │
└──────────────────────────────┬────────────────────────────────┘
                               ▼
                数据目录（记忆 / 图谱 / 缓存 / 会话 / 技能 / 插件）
```

---

## 快速开始

1. **双击 `LunarEclipse.exe`**。首次启动会在程序目录旁创建 `data/`（记忆、图谱、会话）与 `.userdata/`（配置、日志）。
2. **配置模型**：打开设置页填写 `baseURL` / `apiKey` / `model`（对话模型）与可选的记忆后端模型，点「测试连接」确认连通。未配置对话模型时无法发起对话，应用其余部分可正常使用。
3. **处理授权窗口**：AI 执行灰名单操作时会弹出授权窗口，可选「允许一次」或「本次会话允许」；或点击绿通，完全放开授权。
4. **迁移**：数据目录位于程序目录旁，整体复制程序目录即为完整迁移。

---

## 从源码构建

源码包（`-source.zip`）**只含业务源码**——出包链（出包门禁、便携版组装、源码归档、运行检查、构建后处理）位于**开发仓库根 `build/` 目录**，**刻意不随包分发**：对应命令（`npm run dist:win`、`npm run assemble:portable` 等）从 `build/package.json` 运行，包内 `app/package.json` 已不再引用它们，源码包内不会残留指向缺失脚本的死命令。

源码包内 `npm install` 后可正常运行的命令：

- `npm run dev` — 启动开发版
- `npm run build` / `npm run preview` — 构建 / 预览渲染进程
- `npm run test` / `npm run test:watch` — 运行测试
- `npm run typecheck` — TypeScript 类型检查（node + web）
- `npm run lint` — ESLint

如需产出可分发包，请克隆开发仓库后使用 `build/` 中的出包链（见 `VERSIONING.md` 第 2.2 节）。

---

## 协议

本项目以 **GNU Affero General Public License v3** 发布，完整协议文本见同目录 `LICENSE`。

你可以自由使用、修改、分发（含商用）；任何再分发（含通过网络提供服务）都必须以相同协议开源并提供对应源码。

第三方组件（Electron 等）的许可证见 `LICENSE.electron.txt` 与 `LICENSES.chromium.html`。

如需联系作者，关注 B 站：雪花莲的超星际远征，可私信。

---

*雪花莲的超星际远征 · 2026*
