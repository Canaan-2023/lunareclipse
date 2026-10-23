/**
 * 权限层文案域（三层授权 T0/T1/T2 + 告知义务条款）。
 *
 * 为什么单独成域：权限面是**唯一**能改变「AI 能做什么」的界面，它的文字（尤其是告知义务条款）
 * 与产品责任直接相关，不能散落在设置页与房间抽屉两处各写一份——那必然漂移。条款小节的键清单
 * 由 `shared/security/notice.ts` 的 `SECURITY_NOTICE_KEYS` 声明（顺序即展示顺序），本文件只提供文字。
 *
 * ⚠️ 条款文字一改，必须同步把 `SECURITY_NOTICE_VERSION` +1（否则已确认过的用户不会被告知新条款）。
 */
const securityDict = {
  // ===== 权限面板 =====
  'security.title': { zh: '权限', en: 'Permissions' },
  'security.loading': { zh: '读取权限…', en: 'Loading permissions…' },
  'security.loadFailed': { zh: '读取权限失败', en: 'Failed to load permissions' },
  'security.group.t0': { zh: 'T0 硬禁止（不可授予）', en: 'T0 forbidden (cannot be granted)' },
  'security.group.t1': { zh: 'T1 显式授予（默认关）', en: 'T1 explicit grant (off by default)' },
  'security.group.t2': { zh: 'T2 默认开放（无需授予）', en: 'T2 on by default (no grant needed)' },
  'security.grant': { zh: '授予', en: 'Grant' },
  'security.revoke': { zh: '撤回', en: 'Revoke' },
  'security.granted': { zh: '已授予', en: 'Granted' },
  'security.notGranted': { zh: '未授予', en: 'Not granted' },
  'security.scope.title': { zh: '授权范围', en: 'Grant scope' },
  'security.scope.hint': {
    zh: '每行一项。目标=可探测/利用的合法目标；节点=可迁移/接续的白名单；端点=可传输数据的地址。动作越界会被直接拒绝。',
    en: 'One per line. Targets = hosts you may probe/use; nodes = whitelisted peers; endpoints = addresses data may be sent to. Out-of-scope actions are rejected.'
  },
  'security.scope.targets': { zh: '目标', en: 'Targets' },
  'security.scope.nodes': { zh: '节点', en: 'Nodes' },
  'security.scope.endpoints': { zh: '端点', en: 'Endpoints' },
  // 范围编辑器（0.53.1：不再丢一个空白文本框让用户猜）
  'security.scope.manual': { zh: '手动填写', en: 'Add manually' },
  'security.scope.add': { zh: '添加', en: 'Add' },
  'security.scope.remove': { zh: '移除', en: 'Remove' },
  'security.scope.examples': { zh: '示例', en: 'Examples' },
  'security.scope.none': { zh: '尚未选择 / 填写任何条目', en: 'Nothing selected or entered yet' },
  'security.scope.selected': { zh: '已选 {n} 项；不在这里的一律拒绝', en: '{n} selected; anything else is rejected' },
  'security.scope.update': { zh: '更新范围', en: 'Update scope' },
  'security.scope.placeholder.nodes': { zh: '节点 UID（如 2）或节点地址', en: 'Node UID (e.g. 2) or node address' },
  'security.scope.placeholder.targets': { zh: 'IP / 主机名 / URL / 路径', en: 'IP / hostname / URL / path' },
  'security.scope.placeholder.endpoints': { zh: 'URL / IP:端口 / 共享路径', en: 'URL / IP:port / shared path' },
  'security.scope.lanLoading': { zh: '读取局域网节点…', en: 'Loading LAN nodes…' },
  'security.scope.lanOff': {
    zh: '读不到局域网节点（未开局域网 / 未登录）。仍可在下面手动填写。',
    en: 'Cannot read LAN nodes (LAN off / not signed in). You can still add entries manually below.'
  },
  'security.scope.lanEmpty': {
    zh: '当前没有发现其它节点。仍可在下面手动填写。',
    en: 'No other nodes found. You can still add entries manually below.'
  },
  'security.scope.nodeOnline': { zh: '在线', en: 'online' },
  'security.scope.nodeOffline': { zh: '离线', en: 'offline' },
  'security.scope.required': {
    zh: '这项能力必须圈定范围才可授予（否则动作侧一律拒绝）。',
    en: 'This capability requires a scope to be granted (otherwise every action is rejected).'
  },
  'security.grantFailed': { zh: '授予失败', en: 'Grant failed' },
  'security.revokeFailed': { zh: '撤回失败', en: 'Revoke failed' },
  'security.revoked': { zh: '已撤回', en: 'Revoked' },
  'security.honest': {
    zh: '未授予 T1 时，AI 只能感知、规划与调用只读工具——不会有任何高风险写入。',
    en: 'Without T1 grants the AI can only sense, plan and use read-only tools — no high-risk writes.'
  },
  'security.audit.title': { zh: '审计', en: 'Audit' },
  'security.audit.allow': { zh: '允许', en: 'allow' },
  'security.audit.deny': { zh: '拒绝', en: 'deny' },
  'security.audit.empty': { zh: '暂无审计记录。', en: 'No audit entries yet.' },
  'security.audit.hint': {
    zh: '每次放行与拒绝、每次授予与撤回都落一行（append-only，不可修改）。',
    en: 'Every allow/deny decision and every grant/revoke is appended here (append-only, immutable).'
  },

  // ===== 告知义务条款（键清单见 shared/security/notice.ts 的 SECURITY_NOTICE_KEYS）=====
  'security.notice.title': { zh: '权限授予告知', en: 'Permission Grant Notice' },
  'security.notice.lead': {
    zh: '在授予任何权限之前，请先读完这一段。',
    en: 'Please read the following before granting any permission.'
  },
  'security.notice.what': {
    zh: '授予的含义：授予某项能力，等于允许这个 AI 在**你不再逐次确认**的情况下执行该类动作。所有 T1 能力默认关闭，必须由你逐项打开；开启后自动放行（不再逐次弹窗），直到你撤回。',
    en: 'What granting means: granting a capability lets this AI perform that class of actions without asking you each time. All T1 capabilities are off by default and must be switched on item by item; once on, actions pass automatically until you revoke.'
  },
  'security.notice.scope': {
    zh: '授予的范围：部分能力必须圈定范围（目标 / 节点 / 端点），动作越出范围会被直接拒绝。授予**不会**改变 T0——那六类（对非授权第三方的攻击、隐蔽规避、伤及他人、伪造身份、未声明外泄、绕过审批）在任何配置下都不可开启。',
    en: 'Scope: some capabilities require an explicit scope (targets / nodes / endpoints); actions outside it are rejected. Granting never changes T0 — those six classes (attacking non-authorised third parties, covert evasion, harming others, impersonation, undeclared egress, bypassing approval) can never be enabled by any configuration.'
  },
  'security.notice.risk': {
    zh: '可能发生什么：AI 会判断失误，也可能被输入内容误导。在你授予的范围内，动作会**不经确认直接执行**。写文件、执行命令、操作设备、向外部传输数据都可能造成不可逆的后果——数据丢失、系统损坏、隐私泄露、费用支出。',
    en: 'What can happen: the AI can misjudge, and can be misled by the content it reads. Within what you grant, actions run without confirmation. Writing files, running commands, operating devices and sending data out can all cause irreversible consequences — data loss, system damage, privacy leaks, charges.'
  },
  'security.notice.liability': {
    zh: '损失承担：**因你授予权限而造成的损失，由你自行承担**。作者不对授予后发生的后果负责。如果你不确定某项能力具体会让它做什么，请不要授予。',
    en: 'Liability: any loss caused by the permissions you grant is borne by you. The author is not responsible for consequences that follow a grant. If you are not sure what a capability lets it do, do not grant it.'
  },
  'security.notice.revoke': {
    zh: '如何收回：本页随时可撤回，撤回立即生效（下一次动作即被拒绝）。但**已经发生的动作无法撤销**。',
    en: 'How to revoke: you can revoke here at any time; it takes effect immediately (the next action is rejected). Actions that already happened cannot be undone.'
  },
  'security.notice.ack': {
    zh: '我已阅读并理解上述条款，授予权限所造成的损失由我自行承担。',
    en: 'I have read and understood the notice above and accept that losses caused by granted permissions are borne by me.'
  },
  'security.notice.confirm': { zh: '确认并继续', en: 'Acknowledge and continue' },
  'security.notice.required': {
    zh: '确认上方条款后才能授予权限。撤回不受限制。',
    en: 'You must acknowledge the notice above before granting. Revoking is never blocked.'
  },
  'security.notice.confirmed': {
    zh: '已于 {time} 确认（条款 v{version}）',
    en: 'Acknowledged at {time} (notice v{version})'
  },
  'security.notice.confirmFailed': { zh: '确认失败', en: 'Acknowledgement failed' },
  'security.notice.outdated': {
    zh: '条款已更新，请重新阅读并确认。',
    en: 'The notice has been updated — please read and acknowledge again.'
  }
}

export default securityDict
