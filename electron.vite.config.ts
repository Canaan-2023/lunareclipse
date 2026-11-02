import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main/index.ts'),
          // 健康检查语义扫描 worker：与主 bundle 同目录（out/main/），
          // 由 health-scan-runner.ts 以 `new Worker(join(__dirname,'health-scan-worker.js'))` 加载。
          // 单独入口是「主线程不被同步 readdir/readFile 冻结 + 可硬超时终止」的前提。
          'health-scan-worker': resolve(__dirname, 'electron/main/monitor/health-scan-worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: '.',
    server: {
      watch: {
        // 忽略 Electron 运行时目录：.userdata 下的临时文件/缓存被进程锁定，
        // chokidar 试图 watch 会触发 EBUSY 错误并作为未处理 'error' event 导致进程崩溃
        ignored: [
          '**/.userdata/**',
          '**/out/**',
          '**/.git/**',
          '**/data/**'
        ]
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html')
        },
        output: {
          // 稳定 vendor 分包：react/motion/icons/pixi 独立成 chunk，
          // 应用代码变更时这些大依赖的 chunk 哈希不变，减少无效失效与主 chunk 体积。
          // pixi 已有动态 import 路径（Live2DCharacter），这里把它的依赖也固定到同一 vendor 组。
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return undefined
            if (
              id.includes('node_modules/react/') ||
              id.includes('node_modules/react-dom/') ||
              id.includes('node_modules/scheduler/')
            ) {
              return 'vendor-react'
            }
            if (id.includes('node_modules/motion/') || id.includes('node_modules/framer-motion/')) {
              return 'vendor-motion'
            }
            if (id.includes('node_modules/lucide-react/')) {
              return 'vendor-icons'
            }
            if (
              id.includes('node_modules/pixi.js/') ||
              id.includes('node_modules/pixi-live2d-display/') ||
              id.includes('node_modules/@pixi/')
            ) {
              return 'vendor-pixi'
            }
            return undefined
          }
        }
      }
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@shared': resolve(__dirname, 'shared')
      }
    },
    plugins: [react()]
  }
})
