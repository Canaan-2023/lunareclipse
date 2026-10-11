import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      { find: '@shared', replacement: resolve(__dirname, 'shared') },
      // vendor 生态兼容验收：外部插件 `import { Service } from 'cordis'` 以本地 vendor 为兼容锚
      // （架构依据：本地 vendor 即为对齐对象，npm 版 API 与本地有出入）
      { find: /^cordis$/, replacement: resolve(__dirname, 'electron/main/vendor/cordis/index.ts') }
    ]
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    globals: false,
    // Vitest 5 默认 clearMocks: true（清空 mock 调用记录），而 startApiServer 等装配发生在
    // import 时一次性完成，测试体内不再 beforeEach 重装 —— 恢复 Vitest 2 的 false 行为
    clearMocks: false,
    testTimeout: 10000
  }
})
