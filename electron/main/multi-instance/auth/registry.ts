/**
 * 为什么存在：认证实例在启动时按角色装配一次，后续模块统一经此取用，避免层层传参导致散落引用。
 * 作用：模块级保存/取回全局 AuthService（未装配时为 null）。
 */

import type { AuthService } from './auth-service'

/**
 * 认证服务注册表（多实例门面注入；IPC auth handlers 经此取服务）：
 * 未注入时返回 null，auth handlers 回退为「直接操作 UserStore」的现状行为。
 */
let authService: AuthService | null = null

export function setAuthService(service: AuthService | null): void {
  authService = service
}

export function getAuthService(): AuthService | null {
  return authService
}