/**
 * @category 安全
 * @summary 权限授予前的「告知义务」条款（版本号 + 小节键 + 确认判定）
 *
 * 为什么存在：用户 2026-10-19 裁决「**还得有一份权限授予，所造成的损失，用户需自行承担的协议，
 * 做到告知义务**」。分层授权（ADR-11）此前只在**主进程**成立：`security:*` 通道注册了，
 * 但**渲染面整条不存在**——用户界面里没有任何地方能授予权限，于是「T1 默认关」退化成了
 * 「T1 永远关」，自主模式也就永远只能感知 + 只读。补上入口的同时必须补上**知情**：
 * 授予 = 用户把一部分风险从程序转移到自己身上，这一步不能只靠一个开关的文案。
 *
 * 什么作用：给出条款的**版本号**（唯一真源，主进程与渲染进程共用）与小节的 i18n 键清单；
 * `needsAcknowledgement` 是「是否还欠一次确认」的**纯判定**——主进程用它当授予的**前置门**，
 * 渲染进程用它决定是否显示确认区。**未确认 = 授不出去**（不是只弹个提示），
 * 这样「告知义务」是结构性的，而不是可以被绕过的装饰。
 *
 * 为什么版本号必须进判定：条款文字一改（新增风险项、改范围口径），此前确认过的用户
 * 确认的是**旧条款**——版本号不等即视为未确认，用户会被要求重新确认。改文字时同步 +1。
 *
 * 不删理由：删掉即「授予」退回一个没有任何前置说明的开关，而授予后的损失由用户承担；
 * 这既是产品责任问题，也让 §0「默认关、显式授予」失去「显式」的实质。
 */
import type { SecurityGrants } from '../types/permission'

/**
 * 告知义务条款版本。
 * **改动条款文字（含增删小节、改变风险表述）必须 +1**——否则老用户不会被要求重新确认。
 * 版本号只增不减；历史值不做映射（确认记录里存的是当时看到的版本）。
 */
export const SECURITY_NOTICE_VERSION = 1

/**
 * 条款小节的 i18n 键（顺序即展示顺序）。
 * 主进程**不读文字**，只认版本号；文字住在 `src/i18n/domains/security.ts`，
 * 因此条款可翻译，而版本判定双端一致。
 */
export const SECURITY_NOTICE_KEYS = [
  'security.notice.what',
  'security.notice.scope',
  'security.notice.risk',
  'security.notice.liability',
  'security.notice.revoke'
] as const

/**
 * 是否还欠一次「告知义务」确认（纯函数）。
 * - 从未确认 → true；
 * - 确认过但条款版本已升 → true（确认的是旧条款）；
 * - 版本相同 → false。
 *
 * 判定只依赖入参，不读时间、不读全局——主进程（授予门）与渲染进程（确认区）用同一次调用，
 * 两侧口径不可能漂移。
 */
export function needsAcknowledgement(grants: SecurityGrants | undefined): boolean {
  return grants?.acknowledged?.version !== SECURITY_NOTICE_VERSION
}
