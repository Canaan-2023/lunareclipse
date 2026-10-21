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

## Live2D

**Live2D Cubism Core**（`live2dcubismcore.min.js`）是 Live2D Inc. 的专有软件，不是 MIT/AGPL。
它按 Live2D Proprietary Software License Agreement 作为 “Redistributable Code” 原样随包提供。

- 官方协议：<https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html>
- 本地说明与再分发条件：[`licenses/Live2D-Cubism-Core.txt`](./licenses/Live2D-Cubism-Core.txt)
- 该专有许可独立于本项目的 AGPL；AGPL 不适用于 Cubism Core。

**玳瑁猫猫 v1.0**

- 作者：路过的猫窝 / 画师 昊冕sama
- 署名：`形象：玳瑁猫猫 v1.0 / 路过的猫窝；画师：昊冕sama`
- 条款：允许个人、公会、社团及商业使用（含直播、视频、游戏）；必须署名；禁止转卖、修改、投喂 AI；最终解释权归作者。
- 完整说明：[`licenses/Live2D-Model-Tortoiseshell-Cat.txt`](./licenses/Live2D-Model-Tortoiseshell-Cat.txt)

模型与核心位于安装目录 `resources/room-seed/live2d/`，首次启动复制到数据目录的 `room/live2d/`，之后不再覆盖用户替换的素材。

## 房间背景

当前六张分区背景由**本机 Stable Diffusion WebUI** 生成，未使用第三方照片或插画作为底图。
生成参数：checkpoint `majicMIX realistic v7`、DPM++ 2M Karras、28–30 steps、CFG 5–5.5、
960×544 + R-ESRGAN 2 倍放大至 1920×1088。

生成图随应用分发；checkpoint 本身的许可证以模型发布页为准。

## 默认立绘

`src/assets/default-character.png` 以用户提供的 RPG Maker MV 标准角色图（来源：爱给网）为底图，
经本机 SD（anything-v5-PrtRE）img2img 重绘、去背与裁切。用户已确认该素材可用于本项目。
它只在没有 Live2D、也没有自定义立绘时作为兜底显示。

## 再分发

如果你再分发月蚀，请保留 `LICENSE`、本文件与 `licenses/`，并自行确认 Live2D 核心、模型与背景
在你使用场景下的条款。
