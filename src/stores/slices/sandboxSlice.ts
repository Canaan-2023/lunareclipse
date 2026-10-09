/**
 * 为什么存在：代码沙箱是高并发流式运行场景（每次按键/输入都可能下发运行），
 * 状态多变且需定时器兜底，独立 slice 隔离运行态与 UI 其他状态。
 * @category 前端状态
 * @summary appStore 的 sandbox 域 slice：代码沙箱面板（多语言执行器、流式 stdout/stderr/done、
 * Python 可用性检测、执行器列表）。运行兜底定时器与最近一次运行信息存于 wsRuntime（cleanupApp 清理）。
 * 对应 AppState 中 sandbox* 字段与 sandbox* / initSandboxStreams actions。
 */
import type { CodeSandboxResult } from '../../../electron/main/tools/code-sandbox'
import type { AppState } from '../appStore-types'
import {
  SANDBOX_FALLBACK_TIMEOUT_MS,
  CODE_RUN_TIMEOUT_MS,
  wsRuntime,
  type SliceSet,
  type SliceGet
} from './appStore-shared'

export type SandboxSlice = Pick<AppState,
  | 'sandboxPanelOpen' | 'sandboxLanguage' | 'sandboxCode' | 'sandboxRunning' | 'sandboxOutput'
  | 'sandboxResult' | 'pythonAvailable' | 'pythonVersion' | 'sandboxExecutors'
  | 'sandboxOpen' | 'sandboxClose' | 'sandboxSetLanguage' | 'sandboxSetCode' | 'sandboxRun'
  | 'sandboxClearOutput' | 'initSandboxStreams' | 'sandboxLoadExecutors'
>

export function createSandboxSlice(set: SliceSet, get: SliceGet): SandboxSlice {
  return {
    // 代码沙箱初始状态
    sandboxPanelOpen: false,
    sandboxLanguage: 'javascript',
    sandboxCode: '// 在这里写 JavaScript 代码\nconsole.log("Hello, LunarEclipse!");\n1 + 2',
    sandboxRunning: false,
    sandboxOutput: '',
    sandboxResult: null,
    pythonAvailable: null,
    pythonVersion: '',
    sandboxExecutors: [],

    // ===== 代码沙箱面板 actions =====
    sandboxOpen: async () => {
      const api = window.lunareclipse
      if (!api?.codeRunStream) return
      set({ sandboxPanelOpen: true })
      // 加载可用执行器列表
      void get().sandboxLoadExecutors()
      // 首次打开检测 Python 可用性
      if (get().pythonAvailable === null) {
        try {
          const res = await api.codeDetectPython()
          set({ pythonAvailable: res.ok, pythonVersion: res.version })
        } catch {
          set({ pythonAvailable: false, pythonVersion: '' })
        }
      }
    },

    sandboxClose: () => {
      set({ sandboxPanelOpen: false })
    },

    sandboxSetLanguage: (lang) => {
      const cur = get().sandboxLanguage
      if (cur === lang) return
      const templates: Record<string, string> = {
        javascript: '// 在这里写 JavaScript 代码\nconsole.log("Hello, LunarEclipse!");\n1 + 2',
        python: '# 在这里写 Python 代码\nprint("Hello, LunarEclipse!")\n2 ** 10',
        go: '// Go 代码\npackage main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("Hello, LunarEclipse!")\n}',
        bash: '# Bash 脚本\necho "Hello, LunarEclipse!"\ndate',
        node: '// Node.js 代码\nconsole.log("Hello, LunarEclipse!")'
      }
      const tpl = templates[lang] ?? `# ${lang} 代码\n# 在这里写代码`
      set({ sandboxLanguage: lang, sandboxCode: tpl, sandboxOutput: '', sandboxResult: null })
    },

    sandboxSetCode: (code) => {
      set({ sandboxCode: code })
    },

    sandboxRun: async () => {
      const api = window.lunareclipse
      if (!api?.codeRunStream) return
      const { sandboxLanguage, sandboxCode, sandboxRunning } = get()
      if (sandboxRunning) return
      if (!sandboxCode.trim()) {
        set({ sandboxOutput: '[错误] 代码不能为空', sandboxResult: null })
        return
      }
      set({
        sandboxRunning: true,
        sandboxOutput: '',
        sandboxResult: null
      })
      wsRuntime.lastSandboxRunInfo = { language: sandboxLanguage, code: sandboxCode }
      // sandboxRunning 复位全靠主进程 code:done 事件——
      // done 丢失（IPC 流中断/子进程被杀/主进程异常）时永久 running，运行按钮锁死。
      // 兜底：超时后强制复位；onDone 正常到达时清除。
      if (wsRuntime.sandboxRunFallbackTimer) clearTimeout(wsRuntime.sandboxRunFallbackTimer)
      wsRuntime.sandboxRunFallbackTimer = setTimeout(() => {
        wsRuntime.sandboxRunFallbackTimer = undefined
        set((s) =>
          s.sandboxRunning
            ? {
                sandboxRunning: false,
                sandboxOutput: s.sandboxOutput + '\n[超时] 执行状态丢失，已复位（代码可能仍在后台运行）\n'
              }
            : {}
        )
      }, SANDBOX_FALLBACK_TIMEOUT_MS)
      try {
        await api.codeRunStream(sandboxLanguage, sandboxCode, CODE_RUN_TIMEOUT_MS)
      } catch (err) {
        if (wsRuntime.sandboxRunFallbackTimer) { clearTimeout(wsRuntime.sandboxRunFallbackTimer); wsRuntime.sandboxRunFallbackTimer = undefined }
        set((s) => ({
          sandboxOutput: s.sandboxOutput + `[执行失败] ${(err as Error).message}\n`,
          sandboxRunning: false
        }))
      }
    },

    sandboxClearOutput: () => {
      set({ sandboxOutput: '', sandboxResult: null })
      void window.lunareclipse?.workspaceSetSandboxState?.(null)
    },

    initSandboxStreams: () => {
      const api = window.lunareclipse
      if (!api?.onCodeStream) return () => {}

      const unsubscribe = api.onCodeStream({
        onStdout: (chunk: string) => {
          set((s) => ({ sandboxOutput: s.sandboxOutput + chunk }))
        },
        onStderr: (chunk: string) => {
          set((s) => ({ sandboxOutput: s.sandboxOutput + chunk }))
        },
        onDone: (result: CodeSandboxResult) => {
          if (wsRuntime.sandboxRunFallbackTimer) { clearTimeout(wsRuntime.sandboxRunFallbackTimer); wsRuntime.sandboxRunFallbackTimer = undefined }
          const runInfo = wsRuntime.lastSandboxRunInfo
          set((s) => ({
            sandboxRunning: false,
            sandboxResult: result,
            // 末尾追加结果摘要
            sandboxOutput: s.sandboxOutput +
              `\n[完成] 耗时 ${result.durationMs}ms${result.timedOut ? ' (超时)' : ''}${result.ok ? '' : ' 失败'}\n`
          }))
          // 推送到主进程 workspace-state，供 AI 下一轮上下文注入
          if (runInfo) {
            const outputSnapshot = get().sandboxOutput || ''
            void window.lunareclipse?.workspaceSetSandboxState?.({
              language: runInfo.language,
              code: runInfo.code,
              ok: result.ok,
              durationMs: result.durationMs,
              timedOut: result.timedOut,
              outputSummary: outputSnapshot.slice(0, 500)
            })
          }
        }
      })
      return unsubscribe
    },

    sandboxLoadExecutors: async () => {
      const api = window.lunareclipse
      if (!api?.codeListExecutors) return
      try {
        const res = await api.codeListExecutors()
        if (res.ok && res.executors) {
          set({ sandboxExecutors: res.executors })
        }
      } catch {
        // 加载失败不阻塞，使用内置默认
      }
    }
  }
}