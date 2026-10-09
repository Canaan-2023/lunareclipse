import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // 第三方/生成目录不参与 lint：构建产物、运行时数据、vendored 库、浏览器二进制、分发插件
    ignores: [
      'out/**',
      'dist/**',
      'release/**',
      '.tmppack/**',
      'node_modules/**',
      '.playwright-browsers/**',
      '.userdata/**',
      'data/**',
      'electron/main/vendor/**',
      'electron/main/plugins/bundled/**',
      'plugins/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node 脚本（scripts/*.mjs、cjs 工具等）补 Node 全局，消除 no-undef 误报
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        WebAssembly: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly'
      }
    }
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        location: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        AbortController: 'readonly'
      }
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['error', 'warn'] }],
      // eslint 10 新增 recommended 规则。no-useless-assignment 对
      // 「声明 + 初值，try 块内立即覆盖」的既有容错惯用法误报率高，
      // 且原代码依赖该初值安抚 TS 控制流推断，逐一改写反而引入风险，此处置关。
      'no-useless-assignment': 'off'
    }
  },
  {
    // Electron 主进程与测试运行在 Node 侧，stdout 即日志通道（启动/请求/状态日志），
    // console.log 是标准输出方式，不视为违规；渲染进程源码（src/**）仍保持零容忍。
    files: ['electron/**/*.ts', 'test/**/*.ts'],
    rules: {
      'no-console': 'off'
    }
  },
  {
    // .cjs 脚本是 CommonJS 模块，require 是 Node 原生加载机制（非 TS 工程内 require 反模式），
    // 此处放行 @typescript-eslint/no-require-imports，否则脚本须靠 createRequire 曲折加载才能通过 lint；
    // 保留该规则对 .ts/.mjs(ESM) 的约束力不变，静态导入规范不受影响。
    files: ['scripts/**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  }
)