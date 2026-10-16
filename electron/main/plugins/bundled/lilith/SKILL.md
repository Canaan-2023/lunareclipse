---
name: lilith
description: 莉莉丝能力插件（lilith）：角色记忆读写 / 世界观知识库查询 / 情绪指令——了解 lilith 有哪些专属能力及其数据源
---

# 莉莉丝能力插件

打包内置插件，莉莉丝专属工具（宿主 AI 不可调用，agents=['lilith'] 隔离）。

## 工具清单

- **lilith_player_memory**：读写用户记忆（喜好/约定/忌讳）。数据源 `%APPDATA%\LilithAI\players\{sha256(playerName)}.json`（companion 同源唯一真相）。action=get/set，key 为记忆键，set 需 value。
- **lilith_lore_query**：查询世界观知识库（设定/世界观/共同经历）。数据源 `{paths.root}/frontend/character/lore/index.json`。keyword 匹配标题/别名/关键词/摘要/事实；无精确匹配时回退 canon_context 世界观总纲。
- **lilith_emotion**：莉莉丝控制自己的 LIVE2D 表达（一次性情绪/动画指令，5 分钟过期）。写 `{paths.root}/.lilith_emotion.json`，下一条回复生成时消费注入。emotion ∈ neutral/happy/sad/angry/surprised/shy，animation ∈ idle/smile/listen/think/music。

## 使用场景

- 用户问"她记得我吗/我的喜好" → 宿主 AI 无需干预，莉莉丝自己调 player_memory
- 用户追问剧情细节 → 莉莉丝自己调 lore_query 回想
- 想让表达更贴合心情 → 莉莉丝自己调 lilith_emotion（宿主 AI 不可调用，agents=['lilith'] 隔离；宿主侧由内建 lilith_emotion 工具负责）
