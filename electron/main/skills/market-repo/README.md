# LunarEclipse Skill Market（月蚀技能市场仓库）

本目录是**技能市场（Skill Market）的本地源（dir 源）**：包含一组通用、可分发、与宿主实现解耦的领域技能。内容不引用任何绝对路径；涉及宿主工具的地方分两类：一是以通用工具名书写（`read_file` / `write_file` / `search_files` 等），安装时由市场自动适配为宿主工具名（`adaptToolNames`）；二是明确标注依赖宿主 bundled 插件（如 `computer-use`、`webapp-qa` 使用浏览器/桌面工具），安装前需确保对应插件可用。两类技能均可在任意实例开箱即用。

## 目录结构

**文件夹即领域**：市场技能按目录层级分组存放，**领域 = 技能目录相对 `skills/` 根的父路径**（正斜杠拼接，数量与层级不限，如 `code`、`design/web`）；`SKILL.md` frontmatter 不声明领域（保留的 `domain:` 字段仅为展示，不参与判定）：

> 本仓库是**分发源**：条目经安装后复制进各自 AI 的工作域（用户级 `skills/{name}/`、领域级 `skills_domains/{领域路径}/{name}/`）才被引擎加载与调用。市场仓库本身不承载运行态技能，也不作为技能生成/编辑的落点。

```
market-repo/
├── README.md
└── skills/                 # 市场扫描目录：skills/{领域路径}/{skillName}/
    ├── code/               # 领域：code（代码）
    │   ├── code-review/
    │   ├── codebase-inspection/
    │   ├── codebase-recon/
    │   ├── complexity-optimizer/
    │   ├── simplify-code/
    │   ├── systematic-debugging/
    │   └── test-driven-development/
    ├── qa/                 # 领域：qa（质量）
    │   └── webapp-qa/
    ├── security/           # 领域：security（安全）
    │   └── security-review/
    ├── system/             # 领域：system（系统）
    │   └── computer-use/
    ├── writing/            # 领域：writing（写作）
    │   ├── content-research-writer/
    │   ├── humanizer/
    │   └── writing/
    ├── ai-perspective-prompting/   # 方法论/用户级（平铺，无领域）
    └── skill-creator/              # 技能创建/用户级（平铺，无领域）
```

市场扫描规则（`market.ts` → `scanRepoForSkills`）：

- 根 `SKILL.md`，或 `skills/{skillName}/SKILL.md`（平铺 → 用户级），或 `skills/{领域路径}/{skillName}/SKILL.md`（目录层级即领域，推荐；可多级如 `design/web`）。
- 条目的领域 = 技能目录的父路径（`domainOfSubdir` 推导），frontmatter 的 `domain:` 声明不参与判定。
- 安装落位（运行期两个独立文件夹，`loader.ts` / `market.ts` 同口径）：
  - 有领域 → `skills_domains/{领域路径}/{skillName}/`（领域级，`skills_domains` 为领域级根）
  - 平铺 → `skills/{skillName}/`（用户级，`skills` 为用户级根）
  - 即：市场仓库内「平铺」= 用户级、「目录层级」= 领域级，对应运行期 `skills/` 与 `skills_domains/` 两个文件夹分别落位。

## 使用方式（在宿主应用内）

1. 打开「技能市场」面板（内置市场源已随包自动注册，或手动添加源）：
   - **本地目录源**：选择本目录（`.../skills/market-repo`）
2. 在列表中按大类浏览并安装需要的技能。
3. 安装即热重载，无需重启。

## 技能命名与分发约束

- 技能 `name` 必须为 kebab-case，且不含保留词 `lunareclipse` / `moon`（`frontmatter.ts` 校验）。
- 领域：由目录路径决定，任意数量与层级（如 `code`、`design/web`）；`frontmatter.ts` 对 frontmatter 中保留的 `domain:` 展示值仍校验 kebab-case 且 ≤32 字符（旧格式温和约束，不参与领域判定）。
- 正文引用工具的分类与规则：
  - **通用工具名**（`read_file` / `write_file` / `search_files` / `apply_patch` / `terminal` / `glob` 等）：安装时自动适配为宿主工具名，编写第三方技能时优先使用。
  - **宿主插件工具**（`browser_*` / `screen_*` / `mouse_*` 等）：仅在技能需要浏览器或桌面操控能力时引用，必须在「前置条件」中写明依赖的宿主 bundled 插件（如 `headless-browser`、`computer-use`），且只引用插件实际注册的工具（可在宿主插件面板核对）。
  - 不写绝对路径、不依赖宿主私有文件。
- 每个技能是一个独立 `SKILL.md`，可单独安装、更新、卸载；领域级技能还应在正文头部写明「接入说明」（运行期不注入清单，AI 用 Grep/Glob 检索 `skills_domains/{领域路径}/` 定位 SKILL.md 后 use_skill 加载）。

## 版本与作者

- 版本：`0.1.0`（随宿主版本归档）
- 作者：ABYSSAC

技能内容遵循宿主仓库的既有注释与健康检查纪律：修改代码须配套测试，注释须说明「为什么存在 / 什么作用 / 留存的理由」。