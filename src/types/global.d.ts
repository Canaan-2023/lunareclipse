import type { LunareclipseAPI } from '../../electron/preload/index'

declare global {
  interface Window {
    lunareclipse: LunareclipseAPI
  }
}

export {}
