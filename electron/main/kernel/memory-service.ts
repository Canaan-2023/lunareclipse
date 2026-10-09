/**
 * ctx.memory：记忆系统服务壳
 *
 * 记忆系统本体（raw_memory/NNG/缓存）是用户亲手设计——本服务只做【壳】：
 * - 未来记忆读写统一入口在此扩展（仍不触碰 RAW/NNG 内部结构）。
 */

import { Context, Service } from '../vendor/cordis/index.ts'
import type { DataPaths } from '../models/paths'

declare module '../vendor/cordis/context.ts' {
  interface Context {
    memory: MemoryService
  }
}

export class MemoryService extends Service {
  private paths: DataPaths | null = null

  constructor(ctx: Context) {
    super(ctx, 'memory')
  }

  init(paths: DataPaths): DataPaths {
    this.paths = paths
    return paths
  }

  get dataPaths(): DataPaths | null {
    return this.paths
  }
}
