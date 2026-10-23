# Contributing to LunarEclipse

Thanks for your interest in LunarEclipse.

## Development environment

- Windows 10/11 x64 (the primary development and test platform today)
- Node.js 22.13 or later (Node 24 is also used in development) and npm
- The repository root is the app root. After cloning, install dependencies from the root:

```bash
npm ci
npm run dev
```

## Automated checks (CI)

Every pull request and every push to `main` runs the checks automatically on Windows via GitHub Actions:

- `npm run typecheck` — type checking for node, web, and tests
- `npm run lint` — ESLint
- `npm run test:unit` — the unit test suite (e2e excluded)

A pull request must pass these checks before it can be merged. Please run them locally before pushing.

## Common scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the dev build (electron-vite) |
| `npm run build` | Build into `out/` (electron-vite) |
| `npm run typecheck` | node + web + test type checking |
| `npm run test:unit` | Unit tests (excluding e2e) |
| `npm run lint` | ESLint |

## Before you submit

- One commit does one thing; the commit message should state the motive and the change.
- Keep `node_modules`, `out`, `data`, logs, secrets, and local config out of commits.
- Never hard-code real keys, tokens, personal paths, or personal information; tests must use placeholders.
- Add tests for new behavior and make sure `typecheck`, `test:unit`, and `lint` pass.
- Reuse the existing unified tool registry, permission gate, and IPC domains; do not bypass them.
- Every controlled action (files, commands, devices, LAN, collection, model config, etc.) must pass the single policy check; do not add a path that skips approval.

## License

Released under AGPL-3.0-or-later. Opening a pull request means you agree to license your contribution under the same license.

## Code of conduct

Participating means you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

---

# 参与贡献

感谢你对 LunarEclipse 月蚀感兴趣。

## 开发环境

- Windows 10/11 x64（当前主要开发与验证平台）
- Node.js 22.13 或更高（开发也使用 24）与 npm
- 仓库根目录就是应用根，克隆后在根目录直接安装依赖：

```bash
npm ci
npm run dev
```

## 自动检查（CI）

每个 Pull Request 与每次推送到 `main`，都会在 Windows（GitHub Actions）上自动运行：

- `npm run typecheck` —— node、web、test 三合一类型检查
- `npm run lint` —— ESLint
- `npm run test:unit` —— 单元测试（不含 e2e）

PR 必须通过这些检查才能合并，推送前请先在本地跑一遍。

## 常用脚本

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动开发版（electron-vite） |
| `npm run build` | 构建到 `out/`（electron-vite） |
| `npm run typecheck` | node + web + test 三合一类型检查 |
| `npm run test:unit` | 单元测试（排除 e2e） |
| `npm run lint` | ESLint |

## 提交前

- 一个提交只做一件事，提交信息写清动机与做法。
- 不要把 `node_modules`、`out`、`data`、日志、密钥或本地配置带进提交。
- 不要在代码里写死真实密钥、令牌、个人路径或个人信息；测试一律使用占位值。
- 为新行为补上测试，并确保 `typecheck`、`test:unit`、`lint` 通过。
- 优先复用既有的统一工具注册表、权限闸门与 IPC 功能域，不要旁路它们。
- 任何受控动作（文件、命令、设备、局域网、采集、模型配置等）都必须经过统一的 policy 检查点；不得新增绕过审批的路径。

## 许可证

本项目以 AGPL-3.0-or-later 发布。提交 PR 即表示你同意你的贡献以相同许可证发布。

## 行为准则

参与本项目即表示你同意遵守 [行为准则](./CODE_OF_CONDUCT.md)。
