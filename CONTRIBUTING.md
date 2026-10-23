# 参与贡献

感谢你对 LunarEclipse 月蚀感兴趣。

## 开发环境

- Windows 10/11 x64（当前主要开发与验证平台）
- Node.js 22.13 或更高（开发使用 24）、npm
- 克隆后，仓库根目录就是应用根，直接安装依赖：

```bash
npm ci
npm run dev
```

国内网络可用 `npm ci --registry=https://registry.npmmirror.com`。

## 常用脚本

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动开发版（electron-vite） |
| `npm run typecheck` | node + web + test 三合一类型检查 |
| `npm run test:unit` | 单元测试（排除 e2e） |
| `npm run lint` | ESLint |
| `npm run build` | 构建到 `out/`（electron-vite） |

提交前请保证 `typecheck`、`test:unit`、`lint` 通过，并为新行为补上测试。

## 提交约定

- 一个提交只做一件事，提交信息写清楚动机与做法。
- 不要把 `node_modules`、`out`、`data`、日志、密钥或本地配置带进提交。
- 不要在代码里写死真实密钥、令牌、个人路径或个人信息；测试一律使用占位值。

## 代码风格

- TypeScript 严格模式，遵循仓库已有的 ESLint / Prettier 配置。
- 优先复用既有的统一工具注册表、权限闸门与 IPC 功能域，不要旁路它们。
- 任何受控动作（文件、命令、设备、局域网、采集、模型配置等）都必须经过统一的 policy
  检查点；不得新增绕过审批的路径。

## 许可证

本项目以 AGPL-3.0-or-later 发布。提交 PR 即表示你同意你的贡献以相同许可证发布。

## 行为准则

参与本项目即表示你同意遵守 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。
