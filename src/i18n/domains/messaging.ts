/**
 * @category i18n
 * @summary `messaging` 域文案分片（36 条 zh/en 配对）
 * 为什么存在：界面文案随 UI 域增长，全部塞进单个 `locales.ts` 会让任意 UI 域的改动
 * 都在同一文件上产生 merge 冲突；按域分片后各域独立演进（ADR-07）。
 * 不删理由：本文件是该域文案的唯一来源，宿主 barrel 用对象展开合并；条目保持
 * `{ zh, en }` 成对（按域拆、**不按语言拆**——配对是「单侧漏 key」的类型级防线）。
 */
import type { DictEntry } from '../dict-types'

const dict = {
  // ===== 消息接入 =====
  'settings.msgConnStatus': { zh: '连接状态', en: 'Connection Status' },
  'settings.msgFeishu': { zh: '飞书长连接', en: 'Feishu Long-Connection' },
  'settings.msgConnected': { zh: '已连接（已处理 {n} 条消息）', en: 'Connected ({n} messages)' },
  'settings.msgNotConnected': { zh: '未连接（长连接建立中/失败）', en: 'Not connected (establishing/failed)' },
  'settings.msgNotStarted': { zh: '未启动（开启并填凭证后自动连接）', en: 'Not started (enable + credentials to connect)' },
  'settings.msgLastError': { zh: '上次错误：{error}', en: 'Last error: {error}' },
  'settings.msgRouteDesc': { zh: '外部消息进来时：默认走月蚀（完整工具，可指挥干活）。', en: 'Incoming messages → app (full tools, can command tasks).' },
  'settings.msgEnableLabel': { zh: '启用消息接入', en: 'Enable Messaging' },
  'settings.msgDisableDesc': { zh: '关闭时飞书机器人不响应任何消息', en: 'When off, Feishu bot does not respond.' },
  'settings.msgCredentials': { zh: '飞书凭证（开放平台免费申请）', en: 'Feishu Credentials (free)' },
  'settings.msgAppIdPh': { zh: 'App ID（如 cli_xxxxxxxx）', en: 'App ID (e.g. cli_xxxxxxxx)' },
  'settings.msgApplyHint': { zh: '申请：open.feishu.cn → 创建企业自建应用（免费）→ 应用凭证页拿 App ID / App Secret → 添加「机器人」能力 → 事件与回调选长连接模式并订阅 im.message.receive_v1（接收消息）→ 发布版本。', en: 'Apply: open.feishu.cn → create app (free) → get App ID / App Secret → add Bot → select long-connection mode → subscribe im.message.receive_v1 (receive messages) → publish.' },
  'settings.msgLongConnHint': { zh: '长连接不需要公网服务器 / 内网穿透，本地应用直接连。', en: 'Long-connection needs no public server / tunnel.' },
  'settings.msgWhitelist': { zh: '白名单（默认开放）', en: 'Whitelist (open by default)' },
  'settings.msgWhitelistPh': { zh: '每行一个。私聊填发送者 open_id，群聊填群 chat_id。\n留空 = 开放全部（任何人可触发）。', en: 'One per line. DM: sender open_id. Group: chat_id.\nEmpty = open to all (anyone can trigger).' },
  'settings.msgWhitelistDesc': { zh: '白名单开启后：私聊校验发送者 open_id，群聊校验群 chat_id。不在白名单的消息被忽略（不回复）。', en: 'When enabled: checks sender open_id for DM, chat_id for groups. Unlisted messages ignored (no reply).' },
  'settings.msgContactMap': { zh: '联系人 / 群映射', en: 'Contact / Group Mapping' },
  'settings.msgGroup': { zh: '群', en: 'Group' },
  'settings.msgPrivate': { zh: '私聊', en: 'DM' },
  'settings.msgAgentXi': { zh: '月蚀', en: 'LunarEclipse' },
  'settings.msgAddBtn': { zh: '添加', en: 'Add' },
  'settings.msgNamePh': { zh: '备注名', en: 'Label' },
  'settings.msgSaving': { zh: '保存中…', en: 'Saving…' },
  'settings.msgSaveBtn': { zh: '保存配置', en: 'Save config' },
  'settings.msgReconnect': { zh: '重连', en: 'Reconnect' },
  'settings.msgReconnectOk': { zh: '已重新连接', en: 'Reconnected' },
  'settings.msgReconnectFail': { zh: '重连失败', en: 'Reconnect failed' },
  'settings.msgSavedExtra': { zh: '已保存{extra}', en: 'Saved{extra}' },
  'settings.msgSaveExtraFeishu': { zh: '，飞书长连接已生效（无需重启）', en: '. Feishu long-connection active.' },
  'settings.msgSaveExtraHint': { zh: '。配置完整（开启 + 凭证齐全）后自动连接飞书。', en: '. Auto-connects when config is complete (enabled + credentials).' },
  'settings.msgSaveFail': { zh: '保存失败：{error}', en: 'Save failed: {error}' },
  'settings.msgContactSaveFail': { zh: '联系人保存失败：{error}', en: 'Contact save failed: {error}' },
  'settings.msgUnknownError': { zh: '未知错误', en: 'Unknown error' },
  'settings.msgDelete': { zh: '删除', en: 'Delete' },

} satisfies Record<string, DictEntry>

export default dict
