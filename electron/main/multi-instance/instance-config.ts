/**
 * 为什么存在：主从多开架构下各实例的角色（standalone/master/satellite）决定启动链路与行为，且角色极少变化，需持久化。
 * 作用：读写 instance.json 实例角色配置，提供 get/getRole 等角色判定与接入信息入口。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import type { InstanceConfig, InstanceRole } from './types'
import { generateJoinCode } from './join-link'

/**
 * 实例角色配置（abyssac_data/instance.json）：
 * - 无文件 → standalone（单机现状，注册自管 UID）
 * - role=master → 本机为主系统（首个实例注册时写入）
 * - role=standalone + 有账号后升级 → 设置页"升级为主系统"
 * - role=standalone + 接入配置 → 注册页"接入主系统"写入 master 接入信息
 */
export class InstanceConfigStore {
  private config: InstanceConfig

  constructor(private readonly root: string) {
    const path = join(root, 'instance.json')
    if (existsSync(path)) {
      this.config = JSON.parse(readFileSync(path, 'utf-8')) as InstanceConfig
    } else {
      this.config = { role: 'standalone' }
    }
  }

  get(): InstanceConfig {
    return this.config
  }

  getRole(): InstanceRole {
    return this.config.role
  }

  isMaster(): boolean {
    return this.config.role === 'master'
  }

  isSatellite(): boolean {
    return this.config.role === 'satellite'
  }

  becomeMaster(): void {
    const joinCode = this.config.join?.joinCode ?? generateJoinCode()
    this.save({ role: 'master', join: { joinCode } })
  }

  /** 主系统接入码（分系统注册准入凭证；非 master 返回 null） */
  getJoinCode(): string | null {
    if (this.config.role !== 'master') return null
    return this.config.join?.joinCode ?? null
  }

  /** 轮换接入码：旧码立即失效，分系统须用新链接接入 */
  rotateJoinCode(): string {
    const joinCode = generateJoinCode()
    if (this.config.role !== 'master') {
      throw new Error('仅主系统可轮换接入码')
    }
    this.save({ ...this.config, join: { joinCode } })
    return joinCode
  }

  /** 退回单机模式（satellite 未注册/弃用时；同时清掉接入配置） */
  standalone(): void {
    this.save({ role: 'standalone' })
  }

  becomeSatellite(master: NonNullable<InstanceConfig['master']>): void {
    this.save({ role: 'satellite', master })
  }

  private save(config: InstanceConfig): void {
    const path = join(this.root, 'instance.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8')
    this.config = config
  }
}