/**
 * 为什么存在：消息气泡 / Markdown / 记忆面板需要在任意位置打开「文件工坊」的只读预览，
 * 但工坊面板本身是重组件（编辑器 + 预览 + 沙箱）。若 opener 留在面板文件里，
 * 任何静态 import 都会把整块面板拉进主 chunk，懒加载失效。
 * 作用：提供轻量的预览入口注册表——入口只依赖 store，不依赖面板实现。
 */
import { useAppStore } from '../../stores/appStore'

type PreviewOpener = (path: string) => void

let opener: PreviewOpener | null = null
let pendingPath: string | null = null

/** 面板未挂载时先记下路径并打开抽屉；挂载后由面板消费（行为与原实现一致） */
export function openFilePreview(path: string): void {
  if (opener) {
    opener(path)
  } else {
    pendingPath = path
    useAppStore.getState().openDrawer('workshop')
  }
}

/** 面板挂载时注册 opener；卸载时传 null 注销 */
export function registerFilePreviewOpener(fn: PreviewOpener | null): void {
  opener = fn
}

/** 面板挂载时取走并清空待处理的预览路径 */
export function consumePendingFilePreview(): string | null {
  const path = pendingPath
  pendingPath = null
  return path
}
