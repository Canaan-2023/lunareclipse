---
name: webapp-qa
description: "对 Web 应用做探索式 QA 测试、找 bug 并输出结构化报告时使用。通过浏览器工具导航、交互、截图收集证据。"
version: 0.1.0
author: ABYSSAC
license: MIT
domain: qa
---

# WebApp QA：系统性 Web 应用探索式测试

> **领域级技能 · 接入说明**：本技能属于「质量」领域大类（domain: `qa`）。安装后落位 `skills_domains/qa/`，运行期不注入技能清单——系统只注入领域名与技能数量，AI 自行用 Grep/Glob 检索 `skills_domains/qa/` 目录定位 SKILL.md（frontmatter 的 name/description 判断是否匹配），再用 `use_skill(skill_name=webapp-qa)` 加载本技能正文后执行；正文开头的触发条件就是「何时该加载本技能」的信号。

## 概述

本技能指导你用浏览器工具对 Web 应用做系统性探索式 QA：导航、交互元素、捕获问题证据、输出结构化 bug 报告。

**什么时候用**：用户说"测试一下这个应用"、"帮我找找 bug"、"试试 UI 有没有问题"——尤其是被测应用自己的 UI。

## 前置条件

浏览器工具必须可用：`browser_navigate`、`browser_snapshot`、`browser_click`、`browser_type`、`browser_scroll`、`browser_evaluate`、`browser_status`。

## 输入

用户提供：
1. **目标 URL** — 测试入口
2. **范围** — 重点测哪些区域/功能（或"全站"）
3. **输出目录**（可选）— 截图和报告保存位置（默认 `./qa-output`）

## 工作流（5 阶段）

### 阶段 1：计划

1. 创建输出目录结构：
   ```
   {output_dir}/
   ├── screenshots/       # 证据截图
   └── report.md          # 最终报告（阶段 5 生成）
   ```
2. 确定测试范围。
3. 规划粗略页面地图：首页、导航（header/footer/侧边栏）、关键用户流程（登录/搜索/表单）、边缘情况（空态、404、错误页）。

### 阶段 2：探索

对计划中的每个页面/功能：

1. **导航**到页面：
   ```
   browser_navigate(url="<目标URL>/xxx")
   ```
2. **快照**理解 DOM 结构：
   ```
   browser_snapshot()
   ```
3. **检查 JS 错误**：用 browser_evaluate 探测运行时错误（浏览器无独立 console 工具，用 evaluate 读取）：
   ```
   browser_evaluate(script="window.__qaErrors ? window.__qaErrors.slice(-20) : 'no error hook'")
   ```
   如果页面没有错误钩子，用 evaluate 检查关键状态：
   ```
   browser_evaluate(script="JSON.stringify({title: document.title, bodyLen: document.body.innerHTML.length, hasRoot: !!document.getElementById('root')?.children.length})")
   ```
4. **记录页面快照**保存证据：`browser_snapshot()` 把当前 DOM 结构转成文本证据；如有截图能力（如 computer-use 插件的 `screen_capture`），可截图保存路径，报告里用 `MEDIA:<路径>` 引用。
5. **系统性测试交互元素**：
   - 点击按钮/链接：`browser_click(selector="...")`（browser_click 用 CSS 选择器，从 snapshot 找 selector）
   - 填表单：`browser_type(selector="...", text="测试输入")`
   - 滚动内容：`browser_scroll(direction="down")`
   - 非法输入测试表单校验
   - 空提交测试
6. **每次交互后检查**：
   - 页面是否变化（browser_snapshot 对比）
   - 期望 vs 实际行为
   - 控制台错误（browser_evaluate 探测）

### 阶段 3：收集证据

对每个发现的问题：

1. **取证据**：`browser_snapshot()` 记录问题时的页面文本快照；有截图能力（如 `screen_capture`）时一并截图留存。
2. **记录细节**：
   - 问题出现的 URL
   - 复现步骤
   - 期望行为
   - 实际行为
   - 相关错误信息
   - 截图路径
3. **分类**（严重度 + 类别）：
   - 严重度：Critical / High / Medium / Low
   - 类别：Functional / Visual / Accessibility / Console / UX / Content

### 阶段 4：归类

1. 回顾所有问题。
2. 去重——不同位置表现的同源 bug 合并。
3. 定最终严重度和类别。
4. 按严重度排序（Critical 优先）。
5. 统计各严重度/类别数量用于执行摘要。

### 阶段 5：报告

生成最终报告 `{output_dir}/report.md`，必须包含：

1. **执行摘要**：问题总数、严重度分布、测试范围
2. **逐问题章节**：
   - 问题编号和标题
   - 严重度和类别徽章
   - 出现 URL
   - 问题描述
   - 复现步骤
   - 期望 vs 实际行为
   - 截图引用（`MEDIA:<截图路径>` 内联展示）
   - 相关错误信息
3. **问题汇总表**
4. **测试记录**——测了什么、没测什么、阻碍项

## 工具速查

| 浏览器工具 | 用途 |
|---------|------|
| `browser_navigate` | 打开 URL |
| `browser_snapshot` | 拿页面 DOM 文本快照（结构） |
| `browser_click` | 按 CSS selector 点击元素 |
| `browser_type` | 向输入框输入文本 |
| `browser_scroll` | 上下滚动页面 |
| `browser_evaluate` | 执行 JS 探测页面状态/错误 |
| `browser_status` | 查询当前页地址、标题和快照，确认页面状态 |

## 技巧

- **每次导航和关键交互后都检查页面状态**——静默 JS 错误是最有价值的发现。
- **合法和非法输入都测**——表单校验 bug 很常见。
- **长页面滚动到底**——折叠线以下可能有渲染问题。
- **测导航流程**——多步骤流程端到端点一遍。
- **别漏边缘情况**：空态、超长文本、特殊字符、快速连点。
- **报告里截图用 `MEDIA:<路径>`**，用户能内联看到证据。
- **被测应用地址由用户提供**——测哪个应用就用哪个地址，不预设固定 URL。
