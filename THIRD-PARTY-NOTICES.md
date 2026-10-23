# 第三方组件与素材 · Third-Party Notices

月蚀以 **AGPL-3.0-or-later** 发布。AGPL 只覆盖本项目自己的代码；下列组件与素材仍归各自许可证约束。

## 运行时依赖

| 组件 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| Electron | 44.4.4 | MIT | 桌面运行时 |
| React / React DOM | 19.3.0 | MIT | 渲染层 |
| Zustand | 5.0.15 | MIT | 前端状态 |
| lucide-react | 1.47.0 | ISC | 图标 |
| motion | 13.4.1 | MIT | 过渡动画 |
| pixi.js | 6.5.10 | MIT | Live2D 渲染后端 |
| pixi-live2d-display | 0.4.0 | MIT | Cubism 3/4 模型加载与动作 |
| ws | 8.21.3 | MIT | 局域网直连 |
| express | 5.2.1 | MIT | 本地 HTTP API |
| openai | 7.22.0 | Apache-2.0 | LLM 客户端 |
| zod | 4.6.5 | MIT | 运行时校验 |
| js-yaml | 5.4.2 | MIT | YAML 解析 |
| jszip | 3.10.2 | MIT OR GPL-3.0-or-later | 压缩包处理（本项目按 MIT 使用） |
| @modelcontextprotocol/sdk | 1.30.0 | MIT | MCP 客户端/服务端 |
| @larksuiteoapi/node-sdk | 1.74.0 | MIT | 飞书接入 |
| @parcel/watcher | 2.6.0 | MIT | 文件监听 |
| @xmldom/xmldom | 0.9.12 | MIT | XML 解析 |
| async-mutex | 0.5.0 | MIT | 并发互斥 |
| ink | 8.0.0 | MIT | CLI 界面 |
| wrap-ansi | 10.0.2 | MIT | 终端换行 |
| playwright | 1.63.0 | Apache-2.0 | 浏览器自动化 |

完整许可证文本见 [`licenses/deps/`](./licenses/deps/)。

分发夹根目录另含 Electron / Chromium 的完整许可证：`LICENSE.electron.txt` 与 `LICENSES.chromium.html`。

## Live2D（运行时保留，模型与核心不随包分发）

**Live2D Cubism Core**（`live2dcubismcore.min.js`）是 Live2D Inc. 的专有软件，不是 MIT/AGPL。
它按 Live2D Proprietary Software License Agreement 作为 “Redistributable Code” 使用。

- 官方协议：<https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html>
- 本地说明：[`licenses/Live2D-Cubism-Core.txt`](./licenses/Live2D-Cubism-Core.txt)（**仅供参考，不随安装包提供该文件**）

**0.53.11 起，安装包不再内置 Live2D 模型与 Cubism Core**（用户 2026-10-23 要求：能力保留，分发版不内置）。
要把房间切到 Live2D，请把你自备的模型放到 `<data>/room/AI{aiId}/live2d/`（或全局 `<data>/room/live2d/`）：

- `live2dcubismcore.min.js`
- `model/*.model3.json` 及其 `.moc3` / 贴图 / 物理文件

然后在「形象与背景 → 形象来源」里显式选择 Live2D。模型与核心不随本项目的 AGPL 授权，
你需要自行确认模型作者条款与 Live2D 发布许可。仓库里保留的 `Live2D-Model-Tortoiseshell-Cat.txt`
只是旧示例模型的作者署名说明，**该模型不随包分发**。

## 房间背景、立绘、Q 版与图标

- `assets/room-seed/` 的两张背景（背景1 / 背景2）、`src/assets/default-character.png` 立绘、
  `assets/brand/` 的图标与 Q 版头像，均由项目方提供并确认可用于本项目。
- 不包含第三方素材包图片；不再使用旧版 SD 生成图或 RPG Maker 角色图。
- 这些美术随应用分发；如果你再分发月蚀，请保留本文件与 `licenses/`。
