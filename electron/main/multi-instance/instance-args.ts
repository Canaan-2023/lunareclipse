/**
 * instance-args.ts —— --instance <name> 多实例参数解析与路径布局（纯函数，可单测）

 * 多开原则（与 P5 完成条件对齐）：
 * - default（未传 --instance，或 --instance=default）：行为完全不变
 * （userData / dataDir / API 端口均不重定向，保持既有启动链路逐字节等价）
 * - 具名实例：userData → {baseUserData}/instances/{name}
 * dataDir → {baseDataDir}/instances/{name}
 * API 端口 → 动态端口（由调用方传 preferredPort=0，避免与默认实例 62002 冲突）

 * 实例名校验：^[A-Za-z0-9_-]{1,32}$（防路径穿越与非法目录名；非法名按 default 回退并给出原因）
 */
import { join } from 'path'
import { cpSync, existsSync, readdirSync, renameSync, rmSync } from 'fs'

export const DEFAULT_INSTANCE = 'default'

/** 实例名白名单：字母/数字/下划线/连字符，长度 1-32（与 config 目录名、进程参数共用） */
export const INSTANCE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

export interface InstanceArg {
  /** 解析出的实例名；未传 --instance 或显式 default 时为 'default' */
  name: string
  /** 是否为默认实例（default 实例完全保持旧行为） */
  isDefault: boolean
  /** 参数非法时的回退原因（仅非法名回退时存在） */
  invalidReason?: string
}

/**
 * 从进程参数解析实例名。支持两种形态：
 * - `--instance=work`
 * - `--instance work`
 * 二者等价；多处出现时取第一个有效值。
 */
export function parseInstanceArg(argv: string[]): InstanceArg {
  let raw: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--instance') {
      raw = argv[i + 1] ?? null
      break
    }
    if (a.startsWith('--instance=')) {
      raw = a.slice('--instance='.length)
      break
    }
  }
  if (raw == null || raw === '') {
    return { name: DEFAULT_INSTANCE, isDefault: true }
  }
  const name = raw.trim()
  if (name === DEFAULT_INSTANCE) {
    return { name, isDefault: true }
  }
  if (!INSTANCE_NAME_PATTERN.test(name)) {
    return {
      name: DEFAULT_INSTANCE,
      isDefault: true,
      invalidReason: `非法实例名 "${raw}"：仅允许字母/数字/下划线/连字符，长度 1-32，已按默认实例运行`
    }
  }
  return { name, isDefault: false }
}

/** 具名实例的 userData 落点：默认 userData 下建 instances/{name} 子目录 */
export function instanceUserData(baseUserData: string, name: string): string {
  return join(baseUserData, 'instances', name)
}

/** 具名实例的 dataDir 落点：解析出的 dataDir 下建 instances/{name} 子目录 */
export function instanceDataDir(baseDataDir: string, name: string): string {
  return join(baseDataDir, 'instances', name)
}

/** 扫描默认 userData 下已创建的具名实例（instances/ 下的合法实例名目录，字典序）。
 * 不存在目录或读取失败返回空数组（首次运行无具名实例属正常）。 */
export function listInstanceNames(baseUserData: string): string[] {
  const instancesDir = join(baseUserData, 'instances')
  let entries
  try {
    entries = readdirSync(instancesDir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((d) => d.isDirectory() && INSTANCE_NAME_PATTERN.test(d.name))
    .map((d) => d.name)
    .sort()
}

/**
 * 跨设备安全移动目录：优先原子 renameSync；目标跨分区（EXDEV）时退化为
 * 复制 + 删除（userData 与 dataDir 可能落在不同磁盘，renameSync 会抛 EXDEV）。
 * 失败时返回错误信息，成功返回 null。
 */
function moveDirSafe(src: string, dst: string): string | null {
  try {
    renameSync(src, dst)
    return null
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EXDEV') return (err as Error).message
    try {
      cpSync(src, dst, { recursive: true })
      rmSync(src, { recursive: true, force: true })
      return null
    } catch (copyErr) {
      return (copyErr as Error).message
    }
  }
}

/** 删除一个具名实例：userData 与 dataDir 两处目录均移除（不存在则视为已删除）。返回是否全部成功。 */
export function removeInstanceDirs(
  baseUserData: string,
  baseDataDir: string,
  name: string
): { ok: boolean; error?: string } {
  const dirs = [instanceUserData(baseUserData, name), instanceDataDir(baseDataDir, name)]
  let firstErr: string | null = null
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      firstErr = firstErr ?? `${dir}: ${(err as Error).message}`
    }
  }
  return firstErr ? { ok: false, error: firstErr } : { ok: true }
}

/**
 * 重命名一个具名实例：userData 与 dataDir 两处目录同步改名。
 * dataDir 可能尚未创建（launch 未实际启动过），不存在则跳过。
 * 返回是否全部成功；userData 先迁、dataDir 后迁，后者失败时回滚前者。
 */
export function renameInstanceDirs(
  baseUserData: string,
  baseDataDir: string,
  oldName: string,
  newName: string
): { ok: boolean; error?: string } {
  const srcUser = instanceUserData(baseUserData, oldName)
  const dstUser = instanceUserData(baseUserData, newName)
  const srcData = instanceDataDir(baseDataDir, oldName)
  const dstData = instanceDataDir(baseDataDir, newName)

  if (!existsSync(srcUser)) return { ok: false, error: `实例 "${oldName}" 的 userData 目录不存在` }
  if (existsSync(dstUser)) return { ok: false, error: `实例 "${newName}" 的 userData 目录已存在` }
  if (existsSync(dstData)) return { ok: false, error: `实例 "${newName}" 的 dataDir 目录已存在` }

  const userErr = moveDirSafe(srcUser, dstUser)
  if (userErr) return { ok: false, error: `userData 改名失败: ${userErr}` }

  if (existsSync(srcData)) {
    const dataErr = moveDirSafe(srcData, dstData)
    if (dataErr) {
      // 回滚 userData 改名，保持两目录一致
      moveDirSafe(dstUser, srcUser)
      return { ok: false, error: `dataDir 改名失败: ${dataErr}（userData 已回滚）` }
    }
  }
  return { ok: true }
}