/**
 * 界面快照工具：为什么存在——视觉回归与界面自检需要截图、结构提取与基线比对，
 * 是月蚀"看见并验证自己界面"的自动化通道。
 * 作用：ui_snapshot 支持 shot / structure / baseline / verify 四种动作（截图、DOM 结构、基线、像素比对）。
 */
import { BrowserWindow, nativeImage } from 'electron'
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Tool, ToolResult, ToolContext } from './base-tool'

export interface UiSnapshotParams {
  action: 'shot' | 'structure' | 'baseline' | 'verify'
  target?: 'main'
  name?: string
}

/** 截图保存目录 */
const SHOT_DIR = join(tmpdir(), 'lunareclipse-ui-snapshots')

/** 基线目录（baseline 存这里，verify 对比） */
const BASELINE_DIR = join(SHOT_DIR, 'baselines')

/** 像素差异阈值（RGB 各通道差值超过即视为变化像素） */
const PIXEL_DIFF_THRESHOLD = 20

/** 两张 PNG 像素对比（Electron NativeImage → BGRA bitmap），返回差异比例 + 变化包围盒 */
function compareImages(a: string, b: string): {
  diffRatio: number
  sameSize: boolean
  changed?: { x: number; y: number; w: number; h: number }
} {
  const imgA = nativeImage.createFromPath(a)
  const imgB = nativeImage.createFromPath(b)
  if (imgA.isEmpty() || imgB.isEmpty()) return { diffRatio: 1, sameSize: false }
  const sizeA = imgA.getSize()
  const sizeB = imgB.getSize()
  if (sizeA.width !== sizeB.width || sizeA.height !== sizeB.height) {
    return { diffRatio: 1, sameSize: false }
  }
  const bufA = imgA.toBitmap()
  const bufB = imgB.toBitmap()
  let diff = 0
  let minX = sizeA.width
  let minY = sizeA.height
  let maxX = 0
  let maxY = 0
  for (let y = 0; y < sizeA.height; y++) {
    for (let x = 0; x < sizeA.width; x++) {
      const i = (y * sizeA.width + x) * 4
      const dR = Math.abs(bufA[i] - bufB[i])
      const dG = Math.abs(bufA[i + 1] - bufB[i + 1])
      const dB = Math.abs(bufA[i + 2] - bufB[i + 2])
      if (dR > PIXEL_DIFF_THRESHOLD || dG > PIXEL_DIFF_THRESHOLD || dB > PIXEL_DIFF_THRESHOLD) {
        diff++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  const ratio = diff / (sizeA.width * sizeA.height)
  return {
    diffRatio: ratio,
    sameSize: true,
    changed: diff > 0 ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : undefined
  }
}

/**
 * 结构提取脚本：收集 data-ui 标注 + 交互元素 + 主要面板。
 * 克制收集（depth ≤ 6、只匹配面板语义 class），防 Tailwind class 爆炸。
 * 页面没有 data-ui 标注时仍能给出按钮/输入框/主要面板清单。
 */
const STRUCTURE_SCRIPT = `(() => {
  const lines = [];
  const interactiveTags = new Set(['a','button','input','select','textarea']);
  const containerTags = new Set(['nav','main','aside','header','footer','section','form','dialog']);
  const panelRe = /panel|sidebar|chat|setting|toolbar|tab|list|card|header|footer|content|status|input|menu/i;
  const walk = (el, depth) => {
    if (depth > 6) return;
    const tag = el.tagName.toLowerCase();
    const ui = el.getAttribute('data-ui') || '';
    const role = el.getAttribute('role') || '';
    const aria = el.getAttribute('aria-label') || '';
    const cls = el.getAttribute('class') || '';
    const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const isInteractive = interactiveTags.has(tag) || role || ui;
    const isContainer = containerTags.has(tag);
    const isPanelDiv = tag === 'div' && ui === '' && panelRe.test(cls) && depth < 5;
    if (isInteractive || isContainer || isPanelDiv) {
      let label = ui ? '[data-ui=' + ui + ']' : (role || tag);
      if (aria) label += ' [aria=' + aria + ']';
      if (ui && cls) label += ' .' + cls.split(' ').slice(0, 3).join('.');
      if (tag === 'button' || tag === 'a' || role === 'button') label += ': ' + text;
      if (tag === 'input') label += ' <input ' + (el.getAttribute('type') || 'text') + '>';
      if (tag === 'select' || tag === 'textarea') label += ': ' + text;
      lines.push('  '.repeat(depth) + label);
    }
    for (const child of Array.from(el.children)) walk(child, depth + 1);
  };
  if (document.body) walk(document.body, 0);
  return lines.length ? lines.join('\\n') : '(空结构：页面未加载或无可见元素)';
})()`

/** 按目标类型找窗口：仅支持 main 主窗口（优先可见） */
function findTargetWindow(_target: 'main'): BrowserWindow | null {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  return (
    wins.find((w) => w.isVisible()) ??
    wins.find(() => true) ??
    null
  )
}

function describeWindow(win: BrowserWindow): Record<string, unknown> {
  return {
    title: win.getTitle(),
    url: win.webContents.getURL(),
    visible: win.isVisible(),
    minimized: win.isMinimized(),
    size: win.getSize()
  }
}

/**
 * ui_snapshot：截取月蚀自身窗口快照（AI 感知"自己现在长什么样"）。
 * - action=shot：capturePage 截图存 PNG，返回路径（AI 用视觉工具看图 / 用户 MEDIA 内联预览）
 * - action=structure：提取当前可见 UI 结构清单（data-ui 标注 / 按钮 / 输入框 / 主要面板）
 * - action=baseline：截图存为基线（ui-snapshots/baselines/{name}.png），改 UI 前打底
 * - action=verify：重新截图并与基线像素对比，返回差异比例 + 变化区域（改 UI 后自证没改坏）
 * 改 UI 的标准闭环：baseline 打底 → 改代码 → verify 对比 → 确认只改了目标区域。
 */
export class UiSnapshotTool implements Tool<UiSnapshotParams> {
  name = 'ui_snapshot'
  description =
    '截取月蚀自身窗口快照（感知自己当前 UI 长什么样，改 UI 前后对比验证用）。' +
    'action=structure：返回当前可见 UI 结构清单（data-ui 标注/按钮/输入框/主要面板）——纯文本可读，AI 感知界面内容的首选通道；' +
    'action=shot：截图保存 PNG 返回路径（供用户 MEDIA 内联预览或存档；AI 无视觉、Read 读不了图片内容，需要图上信息时给用户看）；' +
    'action=baseline：截图存为基线（改 UI 前打底）；action=verify：重新截图与基线像素对比，返回差异比例+变化区域（改 UI 后自动校验没改坏，无需视觉）。' +
    'name=基线名（默认 main，verify 用同名基线对比）。窗口必须可见（最小化/隐藏时截图空白或报错）。'
  parameters = [
    {
      name: 'action',
      type: 'string' as const,
      description: '操作：shot（截图存 PNG 返回路径）/ structure（提取可见 UI 结构清单）/ baseline（截图存基线）/ verify（与基线像素对比）',
      required: true
    },
    {
      name: 'target',
      type: 'string' as const,
      description: '目标窗口：main 主窗口（默认）',
      required: false,
      default: 'main'
    },
    {
      name: 'name',
      type: 'string' as const,
      description: '基线名（baseline 存为 {name}.png，verify 对比同名基线；默认 target 值）',
      required: false
    }
  ]

  async execute(params: UiSnapshotParams, _ctx?: ToolContext): Promise<ToolResult> {
    const target = 'main' as const
    const action = params.action === 'structure' ? 'structure' : params.action === 'baseline' ? 'baseline' : params.action === 'verify' ? 'verify' : 'shot'
    const name = params.name && params.name.trim().length > 0 ? params.name.trim() : target

    const win = findTargetWindow(target)
    if (!win) {
      return { ok: false, error: `未找到主窗口（窗口可能已关闭）` }
    }
    const wc = win.webContents
    if (wc.isDestroyed()) {
      return { ok: false, error: '目标窗口已销毁' }
    }
    const windowInfo = describeWindow(win)

    try {
      if (action === 'structure') {
        const structure = await wc.executeJavaScript(STRUCTURE_SCRIPT)
        return { ok: true, data: { action: 'structure', structure: String(structure), window: windowInfo } }
      }

      if (!win.isVisible()) {
        return {
          ok: false,
          error: `窗口不可见（${win.isMinimized() ? '已最小化' : '已隐藏'}），无法截图。请先恢复/显示窗口再截。`,
          data: { window: windowInfo }
        }
      }
      mkdirSync(SHOT_DIR, { recursive: true })

      if (action === 'baseline') {
        mkdirSync(BASELINE_DIR, { recursive: true })
        const image = await wc.capturePage()
        const filepath = join(BASELINE_DIR, `${name}.png`)
        writeFileSync(filepath, image.toPNG())
        return { ok: true, data: { action: 'baseline', name, baselinePath: filepath, window: windowInfo } }
      }

      if (action === 'verify') {
        const baselinePath = join(BASELINE_DIR, `${name}.png`)
        if (!existsSync(baselinePath)) {
          return {
            ok: false,
            error: `基线不存在: ${baselinePath}。先调用 ui_snapshot(action=baseline, name=${name}) 打底再 verify。`,
            data: { window: windowInfo }
          }
        }
        const image = await wc.capturePage()
        const currentPath = join(SHOT_DIR, `ui-verify-${target}-${Date.now()}.png`)
        writeFileSync(currentPath, image.toPNG())
        const diff = compareImages(baselinePath, currentPath)
        const changed = diff.changed
          ? `${diff.changed.x},${diff.changed.y} ${diff.changed.w}x${diff.changed.h}px`
          : '无'
        return {
          ok: true,
          data: {
            action: 'verify',
            name,
            baselinePath,
            currentPath,
            diffRatio: Number(diff.diffRatio.toFixed(4)),
            sameSize: diff.sameSize,
            changedArea: changed,
            message: diff.diffRatio === 0
              ? '与基线完全一致（无 UI 变化）'
              : `与基线有差异（${(diff.diffRatio * 100).toFixed(2)}% 像素变化，区域 ${changed}）——确认这是你预期的改动范围`
          }
        }
      }

      // shot
      const image = await wc.capturePage()
      const filepath = join(SHOT_DIR, `ui-${target}-${Date.now()}.png`)
      writeFileSync(filepath, image.toPNG())
      return { ok: true, data: { action: 'shot', imagePath: filepath, window: windowInfo } }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }
}
