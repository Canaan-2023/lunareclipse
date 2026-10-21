/**
 * 命令安全策略（可配置规则层）共享类型。
 * 为什么存在：run_command 的黑白灰名单此前是模块内硬编码数组，用户无法按环境收紧/放宽；
 * 升级为配置后，主进程规则层与前端设置页/配置面板必须共享同一 schema，避免两端字段漂移。
 * 设计约束：
 * - 黑名单只增不减：默认高危黑名单与 security-engine 的硬防线（critical/hardline）不可被配置移除；
 * - 白名单可增可减：默认白名单是「工具链信任」（npm/node/只读 cmdlet 等），用户可追加自有免审批命令或收紧；
 * - 只读自动放行默认关闭：autoAllowReadonly=true 只影响「语义只读命令」的免审，危险检测永远优先；
 * - 命名遵循月蚀自身语义（blacklist/whitelist/readonly/approval/deny），不引入其他智能体产品的字段名。
 */
export interface CommandPolicy {
  /** 追加黑名单：正则字符串数组，追加到默认高危黑名单之上（默认黑名单与硬防线不可移除） */
  extraBlacklist?: string[]
  /** 追加白名单：命令首词（不含 .exe/.ps1 等扩展名，小写），追加到默认白名单 */
  extraWhitelist?: string[]
  /** 移除白名单：命令首词，从默认白名单剔除（收紧免审批面，如撤回对 npm 的直通信任） */
  removeWhitelist?: string[]
  /** 追加只读命令名：命令首词，加入语义只读判别（autoAllowReadonly 开启时免审） */
  extraReadonly?: string[]
  /** 只读命令自动放行：true 时语义只读命令不经灰名单询问直接执行（黑名单/危险检测仍拦截） */
  autoAllowReadonly?: boolean
  /**
   * 管理规则层（优先级高于 userSettings 与 builtin 基线）：按命令前缀匹配的
   * 三级行为裁决。危险检测/黑名单硬防线永远优先于本层（不能通过 allow 放行高危命令）；
   * deny 直接拒绝；ask 强制询问（即使命令在白名单/只读自动放行面内）；allow 放行
   * 灰名单命令（管理员显式信任，仍需通过危险检测）。
   */
  policyRules?: CommandPolicyRule[]
}

/** 命令级管理规则：命令前缀（命令首词，'*' = 全部）+ 可选参数子串 + 行为 */
export interface CommandPolicyRule {
  /** 命令前缀匹配（命令首词，小写；'*' 匹配所有命令） */
  command: string
  /** 可选参数子串（大小写不敏感，命中才应用；缺省 = 只按命令名） */
  argPattern?: string
  /** 行为：allow 放行 / deny 拒绝 / ask 强制询问 */
  action: 'allow' | 'deny' | 'ask'
  /** 管理备注（审计/提示展示） */
  note?: string
}

/**
 * 工具级权限覆写策略（管理策略）。
 * 为什么存在：工具默认审批由实现内建（run_command 的命令级审批、system_setting 的弹窗），
 * 管理员应能在配置层对单个工具做更严/更宽的覆写，而不必改工具代码。
 * - default：走工具自身默认审批逻辑；
 * - require-approval：每次调用都要求用户授权（比默认更严格；绿通开启时被全局授权覆盖）；
 * - deny：直接拒绝调用（比默认更严格）。
 */
export type ToolPermissionPolicy = 'default' | 'require-approval' | 'deny'