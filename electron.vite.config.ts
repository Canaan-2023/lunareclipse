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
