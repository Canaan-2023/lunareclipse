/**
 * 路径上下文的运行时唯一来源：系统数据路径按 uid/aiId 作用域分层，
 * 各模块需要统一入口获取当前数据根目录、当前用户/AI 及分层路径，
 * 避免层层透传参数。setPathContext 启动时注入，此后各处直接取用。
 */
import { scopedDomainPath } from './paths'
import { DEFAULT_AI_ID } from '@shared/types/defaults'

/**
 * 路径上下文：uid + aiId 组合域隔离。

 * 本模块服务于调用 getScopedPath(domain) 的域（skills / skills_domains / config），
 * 产出格式一律为 {root}/{domain}/U{uid}/AI{aiId}/——U/AI 字面前缀分层，
 * 与 memory（U{uid}/AI{aiId}）、NNG/cache（AI{aiId}/U{uid}）的前缀约定同构。
 * 分层实现的唯一真源在 ../paths.ts 的 scopedDomainPath()，本模块只做
 * 未登录/缺 aiId 守卫与转发，不自行拼接路径——防止各域前缀规则再次漂移。
 * 历史欠账：本模块曾返回 {root}/{domain}/{uid}/{aiId} 裸数字分层，与 memory
 * 等域的 U/AI 前缀不一致，已统一（含磁盘数据迁移，见迁移脚本与 loader 内
 * migrateLegacyScopedData 的 U/AI 前缀迁移分支）。

 * {uid}/{aiId} 永远绑在一起，不存在只有 uid 没有 aiId 的路径。
 * 域是顶层语义文件夹，{uid}/{aiId} 在域内以 U/AI 前缀分层：
 * skills/skills_domains/config = {root}/{domain}/U{uid}/AI{aiId}/（本模块 getScopedPath → scopedDomainPath）
 * memory/NNG/cache/sessions/ABYSS = resolveScopePaths 语义（见 paths.ts，前缀规则各异）
 * plugins 例外：完全本地化，{root}/plugins/{插件名}/，不参与 {uid}/{aiId} 分层
 * （插件是程序扩展而非用户数据，本机安装一份全局共享，见 plugins/loader.ts）

 * uid 为 null（未登录）时禁止解析分层路径：系统强制登录后才可用，
 * 任何未登录状态的分层路径访问都是程序错误（曾在此回退顶层目录，
 * 导致技能装到 {root}/skills/{name} 而登录后扫 {root}/skills/{uid}/{aiId}，
 * 列表恒空——这就是"技能安装后不显示"的根因，已删除该回退）。
 * aiId 为 null 同样是程序错误：{uid}/{aiId} 永远绑在一起，
 * 不存在只有 uid 没有 aiId 的路径，一律抛错（曾回退 {root}/{domain}/U{uid}/，已删除）。
 */

let _dataRoot = ''
let _getUid: () => number | null = () => null
let _getAiId: () => number | null = () => null

/** 默认 AI（月蚀）aiId。统一来自 shared 常量（唯一真源），此处 re-export 供历史 import 兼容。 */
export { DEFAULT_AI_ID }

export function setPathContext(dataRoot: string, getUid: () => number | null, getAiId?: () => number | null): void {
  _dataRoot = dataRoot
  _getUid = getUid
  if (getAiId) _getAiId = getAiId
}

export function getDataRoot(): string {
  return _dataRoot
}

export function getCurrentUid(): number | null {
  return _getUid()
}

export function getCurrentAiId(): number | null {
  return _getAiId()
}

/** 在指定域顶层文件夹下构造 U{uid}/AI{aiId} 分层路径。未登录（uid=null）或缺少 aiId 时禁止解析。 */
export function getScopedPath(domain: string): string {
  const uid = _getUid()
  if (uid === null) {
    // 未登录一律禁止解析分层路径：系统强制登录后才可用。
    // 曾有实现回退 {root}/{domain}（顶层），导致技能/配置写到未分层目录、
    // 登录后按 U{uid}/AI{aiId} 扫描不到——列表不显示的根因，已删除。
    throw new Error(
      `[path-context] 未登录态禁止解析分层路径（domain=${domain}）：系统要求先登录`
    )
  }
  const aiId = _getAiId()
  if (aiId === null) {
    // {uid}/{aiId} 永远绑定；缺少 aiId 的结构不存在（曾回退 {root}/{domain}/U{uid}/，
    // 掩盖了 aiId 缺失这一程序错误，已删除回退，一律抛错暴露）。
    throw new Error(
      `[path-context] aiId 缺失禁止解析分层路径（domain=${domain}，uid=${uid}）：uid/aiId 必须同时存在`
    )
  }
  // 转发到 paths.ts 唯一真源：{root}/{domain}/U{uid}/AI{aiId}
  return scopedDomainPath(_dataRoot, domain, uid, aiId)
}