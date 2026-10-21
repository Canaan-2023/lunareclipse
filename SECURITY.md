# 安全策略 · Security Policy

## 报告安全漏洞

请不要为安全漏洞开公开 Issue。

- 优先使用 GitHub 的私密漏洞报告（Private Vulnerability Reporting）：
  <https://github.com/Canaan-2023/lunareclipse/security/advisories/new>
- 也可以在 B 站私信作者「雪花莲的超星际远征」。

报告请尽量包含：受影响版本、复现步骤、影响范围，以及你认为的修复思路。
确认后我会回复；修复发布后，如果你愿意，我会公开致谢。

## 支持的版本

只维护最新发布版本（见 [Releases](https://github.com/Canaan-2023/lunareclipse/releases)）。

## 安全边界

- 受控动作经三层授权（T0 / T1 / T2）；T0 硬禁止不可授予，也不注册为工具。
- 本机 API 使用随机令牌 + Bearer 鉴权 + 来源白名单 + WebSocket 握手校验。
- 应用不主动收集或上传你的数据；使用云端模型时，请求只发往你自己配置的服务商。

---

## Reporting a vulnerability

Please do not open a public issue for security vulnerabilities.

- Preferred: GitHub private vulnerability reporting —
  <https://github.com/Canaan-2023/lunareclipse/security/advisories/new>
- Or DM the author on Bilibili (雪花莲的超星际远征).

Please include the affected version, reproduction steps, the impact, and a suggested fix.

## Supported versions

Only the latest published release (see
[Releases](https://github.com/Canaan-2023/lunareclipse/releases)) is maintained.
