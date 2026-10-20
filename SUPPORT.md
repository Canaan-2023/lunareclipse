# 获取帮助

提问前，请先看 README 的「使用前需要知道」「常见问题」两节。

开 Issue 前建议先自查：

1. **模型**：设置 → 前端 AI / 后端 AI 的 `baseURL` / `apiKey` / `model` 是否正确，点「测试连接」确认。
2. **权限**：灰名单操作需要授权；采集器是「用户开关 + `t1.collector` 授予」两层，两层都开才生效。
3. **版本**：注明 LunarEclipse 版本号与 Windows 版本。
4. **日志**：位于 `data/userdata/logs/`；提交前请自行去掉密钥、令牌、个人路径与用户名。

- **报告 Bug**：使用 [Bug 模板](https://github.com/Canaan-2023/lunareclipse/issues/new/choose)，附版本号、系统版本、复现步骤、期望与实际结果、相关日志。
- **功能建议**：说明使用场景与想解决的问题，而不只是想要的功能。
- **安全问题**：不要开公开 Issue，按 [SECURITY.md](./SECURITY.md) 私密报告。
