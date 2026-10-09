/**
 * 为什么存在：分系统重启后不应要求重新登录主系统，缓存主系统签发的令牌即可恢复身份。
 * 作用：加载/保存分系统认证令牌（UID/用户名/accessToken/exp），字段缺失视为损坏返回 null，原子写入。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'

export interface SatelliteToken {
  UID: number
  用户名: string
  accessToken: string
  exp: number
}

/**
 * 分系统本地令牌缓存（abyssac_data/satellite-token.json）：
 * 记录 {uid, 用户名, accessToken, exp}，无密码哈希——账号本体只在主系统。
 * 离线用缓存令牌照常登录、不降级；令牌过期/被拒时清除并转在线登录。
 */
export class SatelliteTokenCache {
  constructor(private readonly filePath: string) {}

  load(): SatelliteToken | null {
    if (!existsSync(this.filePath)) return null
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as SatelliteToken
      if (typeof raw.UID !== 'number' || typeof raw.accessToken !== 'string') return null
      return raw
    } catch {
      return null
    }
  }

  save(token: SatelliteToken | null): void {
    if (!token) {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(null), 'utf-8')
      return
    }
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(token, null, 2), 'utf-8')
  }
}