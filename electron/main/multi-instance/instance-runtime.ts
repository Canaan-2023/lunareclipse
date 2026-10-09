/**
 * instance-runtime.ts —— 当前实例运行时状态（index.ts 启动时初始化一次）。
 * 与 instance-args.ts 分离的原因：instance-args 保持纯函数可单测；
 * 运行时状态（当前实例名 / 重定向前 userData）独立存放，避免污染纯函数模块。
 */
import { DEFAULT_INSTANCE } from './instance-args'

let currentName: string = DEFAULT_INSTANCE
/** 重定向前的默认 userData（instances/ 目录的父级，扫描已建实例 & spawn 新实例用） */
let baseUserDataPath: string = ''
/** 解析后的默认 dataDir 基目录（instances/ 目录的父级；initRuntime 后注入） */
let baseDataDirPath: string = ''

/** 启动时调用一次：记录本实例名称与默认 userData */
export function initInstanceRuntime(name: string, baseUserData: string): void {
  currentName = name
  baseUserDataPath = baseUserData
}

/** dataDir 基目录在 initRuntime 解析完成后注入（晚于 initInstanceRuntime，因为 dataDir 依赖 config + 锚点） */
export function setBaseDataDir(baseDataDir: string): void {
  baseDataDirPath = baseDataDir
}

export function getInstanceRuntime(): {
  name: string
  isDefault: boolean
  baseUserData: string
  baseDataDir: string
} {
  return {
    name: currentName,
    isDefault: currentName === DEFAULT_INSTANCE,
    baseUserData: baseUserDataPath,
    baseDataDir: baseDataDirPath
  }
}