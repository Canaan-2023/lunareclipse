/**
 * 系统级电脑操控引擎（SystemInput）—— 参考开源 computer-use 方案

* 让月蚀 AI 能操作真实桌面：截屏（Electron desktopCapturer）／鼠标／键盘／窗口（Windows + 零新增原生依赖）。
 * 为什么存在：登录、安装向导等任务必须操作真实图形界面，模型需“看屏幕 →
 * 移动光标 → 点击输入 → 再验证结果”的闭环能力，本引擎提供底层输入/截图原语——

 * 坐标系统（踩坑后的稳定解，README 级注释）：
 * 这台 Windows 常见 DPI≠100%（本机 144 DPI/150%）。关键坑：
 * - `Add-Type -AssemblyName System.Windows.Forms` 会改变 PowerShell 进程的 DPI 感知，
 * 导致之后 user32 SetCursorPos 的坐标系统错乱（SetCursorPos(7,7) 落到 (1101,615)）。
 * - `SetProcessDPIAware()` 会让 SetCursorPos 返回 False（定位失效）。
 * 稳定解：鼠标/光标/分辨率**全部用纯 user32 + .NET P/Invoke（DPI-unaware逻辑坐标）**，
 * 不加载 System.Windows.Forms；仅键盘（SendKeys）单独加载它（只发键、无定位副作用）。
 * 统一坐标系 = 逻辑像素（0..GetSystemMetrics(SM_CXSCREEN)），截图 thumbnailSize 也用逻辑尺寸 → 截图坐标 = 光标坐标 1:1。

 * ⚠️ 安全：本引擎只做输入/截图，护栏在工具层 + 系统提示词。
 */
import { spawnSync } from 'child_process'
import { join } from 'path'
import { mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { desktopCapturer, screen, app } from 'electron'

const SHOT_DIR = () => join(app.getPath('userData'), 'system-shots')

/** PowerShell 临时脚本目录：钉在 userData 内（不写系统 %TEMP%，保证数据全落项目文件夹、可移植） */
const SYSIN_PS_DIR = () => join(app.getPath('userData'), 'sysin-ps')

interface ToolRet {
  ok: boolean
  data?: unknown
  error?: string
}

/** 运行 PowerShell（同步）。用 .ps1 文件方式（-Command 对跨进程坐标/脚本结构不稳定）。 */
function runPs(script: string): { ok: boolean; out: string; err: string } {
  const psDir = SYSIN_PS_DIR()
  mkdirSync(psDir, { recursive: true })
  const ps1 = join(psDir, `sysin-${Date.now()}-${Math.floor(Math.random() * 1e6)}.ps1`)
  try {
    writeFileSync(ps1, script, 'utf-8')
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
      encoding: 'utf-8',
      timeout: 20000,
      windowsHide: true
    })
    return { ok: r.status === 0, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() }
  } catch (e) {
    return { ok: false, out: '', err: (e as Error).message }
  } finally {
    try {
      unlinkSync(ps1)
    } catch {
      /* noop */
    }
  }
}

/** 纯 user32 P/Invoke（DPI-unaware 逻辑坐标）。⚠️ 不加载 System.Windows.Forms——那会改 DPI 感知导致 SetCursorPos 错位。 */
const PS_U32 = `
if (-not ('W.U32' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace W {
  public class U32 {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    public static POINT GetCursor() { POINT p; GetCursorPos(out p); return p; }
  }
}
"@
}
`

export class SystemInput {
  private _size: { width: number; height: number } | null = null

  /** 逻辑分辨率（GetSystemMetrics 主屏，与光标/截图坐标同基） */
  primarySize(): { width: number; height: number } {
    if (this._size) return this._size
    const r = runPs(`${PS_U32}; "$([W.U32]::GetSystemMetrics(0))|$([W.U32]::GetSystemMetrics(1))"`)
    const m = r.out.match(/^(\d+)\|(\d+)$/)
    this._size = m ? { width: parseInt(m[1]), height: parseInt(m[2]) } : { width: 1920, height: 1080 }
    return this._size
  }

  cursorPosition(): { x: number; y: number } {
    const r = runPs(`${PS_U32}; $p=[W.U32]::GetCursor(); "$($p.X)|$($p.Y)"`)
    const m = r.out.match(/^(-?\d+)\|(-?\d+)$/)
    if (!m) throw new Error(`光标读取失败: ${r.err || r.out}`)
    return { x: parseInt(m[1]), y: parseInt(m[2]) }
  }

  // ── 鼠标（纯 user32 逻辑坐标） ─────────────────────────
  mouseMove(x: number, y: number): ToolRet {
    // 同进程内 Set→Get 互证（DPI/多屏连接坐标偏差时返回实际落点，AI 结合截屏微调）
    const script =
      PS_U32 +
      '; [W.U32]::SetCursorPos(' + x + ', ' + y + ') | Out-Null; Start-Sleep -Milliseconds 40; $p=[W.U32]::GetCursor(); "$($p.X)|$($p.Y)"'
    const r = runPs(script)
    const m = r.out.match(/^(-?\d+)\|(-?\d+)$/)
    if (r.ok && m) {
      const ax = parseInt(m[1])
      const ay = parseInt(m[2])
      const precise = ax === x && ay === y
      return {
        ok: true,
        data: { x: ax, y: ay, requested: precise, ...(precise ? {} : { note: `实际落点 (${ax},${ay})（DPI/多屏连接坐标与截图有偏差），以最新截屏为准再微调` }) }
      }
    }
    return { ok: true, data: { x, y, requested: true } }
  }

  mouseClick(x?: number, y?: number, button: 'left' | 'right' | 'middle' = 'left'): ToolRet {
    let ps = PS_U32
    let down = 0
    let up = 0
    if (button === 'right') { down = 8; up = 16 } else if (button === 'middle') { down = 32; up = 64 } else { down = 2; up = 4 }
    if (x !== undefined && y !== undefined) ps += ` [W.U32]::SetCursorPos(${x}, ${y}) | Out-Null; Start-Sleep -Milliseconds 20;`
    ps += ` [W.U32]::mouse_event(${down},0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 30; [W.U32]::mouse_event(${up},0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 30; "clicked"`
    const r = runPs(ps)
    return r.ok && r.out.includes('clicked') ? { ok: true, data: { button, ...(x !== undefined && y !== undefined ? { x, y } : {}) } } : { ok: false, error: `点击失败: ${r.err || r.out}` }
  }

  mouseDoubleClick(x?: number, y?: number): ToolRet {
    const a = this.mouseClick(x, y, 'left')
    if (!a.ok) return a
    const b = this.mouseClick(x, y, 'left')
    if (!b.ok) return b
    return { ok: true, data: { doubleClick: true, ...(x !== undefined && y !== undefined ? { x, y } : {}) } }
  }

  mouseDrag(fromX: number, fromY: number, toX: number, toY: number, button: 'left' | 'right' | 'middle' = 'left'): ToolRet {
    let down = 2
    let up = 4
    if (button === 'right') { down = 8; up = 16 } else if (button === 'middle') { down = 32; up = 64 }
    const ps = `${PS_U32}
      [W.U32]::SetCursorPos(${fromX}, ${fromY}) | Out-Null; Start-Sleep -Milliseconds 25
      [W.U32]::mouse_event(${down},0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 40
      $steps = 20
      for ($i=1; $i -le $steps; $i++) {
        [W.U32]::SetCursorPos([int](${fromX} + (${toX}-${fromX})*$i/$steps), [int](${fromY} + (${toY}-${fromY})*$i/$steps)) | Out-Null
        Start-Sleep -Milliseconds 8
      }
      Start-Sleep -Milliseconds 30
      [W.U32]::mouse_event(${up},0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 30
      "dragged"
    `
    const r = runPs(ps)
    return r.ok && r.out.includes('dragged') ? { ok: true, data: { from: [fromX, fromY], to: [toX, toY], button } } : { ok: false, error: `拖拽失败: ${r.err || r.out}` }
  }

  mouseScroll(deltaY: number, deltaX = 0, x?: number, y?: number): ToolRet {
    let ps = PS_U32
    if (x !== undefined && y !== undefined) ps += ` [W.U32]::SetCursorPos(${x}, ${y}) | Out-Null; Start-Sleep -Milliseconds 20;`
    ps += ` [W.U32]::mouse_event(0x0800, 0, [int](${deltaY} * 120), [UIntPtr]::Zero); Start-Sleep -Milliseconds 20; "scrolled"`
    const r = runPs(ps)
    return r.ok && r.out.includes('scrolled') ? { ok: true, data: { deltaX, deltaY } } : { ok: false, error: `滚动失败: ${r.err || r.out}` }
  }

  // ── 键盘（需 SendKeys → 单独加载 System.Windows.Forms；仅发键无定位副作用） ──
  keyPress(keys: string): ToolRet {
    const SK: Record<string, string> = {
      ctrl: '^', control: '^', shift: '+', alt: '%', enter: '{ENTER}', return: '{ENTER}', esc: '{ESC}', escape: '{ESC}',
      tab: '{TAB}', space: ' ', home: '{HOME}', end: '{END}', pgup: '{PGUP}', pagedown: '{PGDN}', delete: '{DELETE}', del: '{DELETE}',
      backspace: '{BACKSPACE}', insert: '{INSERT}', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
      f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f6: '{F6}', f7: '{F7}', f8: '{F8}', f9: '{F9}', f10: '{F10}', f11: '{F11}', f12: '{F12}',
      win: '^{ESC}', super: '^{ESC}', '.': '.', ',': ',', '/': '/', '\\': '\\', '[': '[', ']': ']', '=': '=', '-': '-', '`': '`', ';': ';', "'": "'"
    }
    const tokens = String(keys).toLowerCase().split('+').map((t) => t.trim()).filter((t) => t)
    let prefix = ''
    const mainParts: string[] = []
    for (const t of tokens) {
      if (t === 'ctrl' || t === 'control') prefix += '^'
      else if (t === 'shift') prefix += '+'
      else if (t === 'alt' || t === 'option') prefix += '%'
      else if (t === 'win' || t === 'super') prefix += '^{ESC}'
      else mainParts.push(SK[t] ?? t.toUpperCase())
    }
    const seq = prefix + (mainParts.length ? mainParts.join('') : '')
    const ps = `${PS_U32}
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.SendKeys]::SendWait('${sanitizeSendKeys(seq) || '+'}')
      Start-Sleep -Milliseconds 40
      "pressed"
    `
    const r = runPs(ps)
    return r.ok && r.out.includes('pressed') ? { ok: true, data: { keys } } : { ok: false, error: `按键失败: ${r.err || r.out}` }
  }

  typeText(text: string): ToolRet {
    const lines = String(text).replace(/\r/g, '').split('\n')
    const stmts: string[] = []
    lines.forEach((ln, i) => {
      const chunk = sanitizeSendKeys(ln)
      if (chunk) stmts.push(`[System.Windows.Forms.SendKeys]::SendWait('${chunk}')`)
      if (i < lines.length - 1) stmts.push('[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")')
    })
    const ps = `${PS_U32}
      Add-Type -AssemblyName System.Windows.Forms
      ${stmts.length ? stmts.join('; ') : '[System.Windows.Forms.SendKeys]::SendWait(" ") ; Start-Sleep -Milliseconds 20'}
      Start-Sleep -Milliseconds 40
      "typed"
    `
    const r = runPs(ps)
    return r.ok && r.out.includes('typed') ? { ok: true, data: { chars: String(text).length } } : { ok: false, error: `键入失败: ${r.err || r.out}` }
  }

  // ── 截屏（thumbnailSize = 逻辑分辨率，与坐标 1:1） ─────
  async captureScreen(): Promise<{ ok: boolean; imagePath?: string; width?: number; height?: number; error?: string }> {
    try {
      const { width, height } = this.primarySize()
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } })
      const primary = sources.find((s) => s.display_id === screen.getPrimaryDisplay().id.toString()) ?? sources[0]
      if (!primary || !primary.thumbnail) return { ok: false, error: '未获取到屏幕源' }
      const img = primary.thumbnail
      mkdirSync(SHOT_DIR(), { recursive: true })
      const p = join(SHOT_DIR(), `screen-${Date.now()}.png`)
      writeFileSync(p, img.toPNG())
      return { ok: true, imagePath: p, width: img.getSize().width, height: img.getSize().height }
    } catch (e) {
      return { ok: false, error: `截图失败: ${(e as Error).message}` }
    }
  }

  // ── 窗口 ──────────────────────────────────────────────
  listApps(): { ok: boolean; apps?: Array<{ title: string; pid: number }>; error?: string } {
    const ps = `
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinList {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  private delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  public static string List() {
    var sb = new StringBuilder();
    EnumWindows((h, l) => {
      if (IsWindowVisible(h)) {
        var t = new StringBuilder(256); GetWindowText(h, t, 256);
        uint pid; GetWindowThreadProcessId(h, out pid);
        if (t.Length > 0) { sb.Append(t.ToString().Replace("|"," ")).Append("|").Append(pid).Append("\\n"); }
      }
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
}
"@
[WinList]::List()
`
    const r = runPs(ps)
    if (!r.ok) return { ok: false, error: `窗口枚举失败: ${r.err || r.out}` }
    const apps = String(r.out).split('\n').map((line) => {
      const i = line.lastIndexOf('|')
      if (i <= 0) return null
      return { title: line.slice(0, i), pid: parseInt(line.slice(i + 1)) }
    }).filter(Boolean) as Array<{ title: string; pid: number }>
    return { ok: true, apps }
  }

  focusApp(title: string): ToolRet {
    const esc = title.replace(/"/g, '""')
    const ps = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Focus {
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
$h = [Focus]::FindWindow($null, "${esc}")
if ($h -eq [IntPtr]::Zero) { "notfound" }
else { [Focus]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 120; "focused" }
`
    const r = runPs(ps)
    if (r.ok && r.out.includes('notfound')) return { ok: false, error: `未找到标题含 "${title}" 的窗口（需用 app_list 确认准确标题）` }
    return r.ok && r.out.includes('focused') ? { ok: true, data: { focused: title } } : { ok: false, error: `聚焦失败: ${r.err || r.out}` }
  }
}

/** 单例：主进程启动即存在，经 ctx.getSystemInput() 注入插件 */
export const systemInput = new SystemInput()

/** SendKeys 特殊字面量转义（+ ^ % ~ ( ) { } [ ]） */
function sanitizeSendKeys(s: string): string {
   
  return s
    .replace(/\+/g, '{+}').replace(/\^/g, '{^}').replace(/%/g, '{%}').replace(/~/g, '{~}')
    .replace(/\(/g, '{(}').replace(/\)/g, '{)}').replace(/\{/g, '{{}').replace(/\}/g, '{}}')
    .replace(/\[/g, '{{}').replace(/\]/g, '{}}')
}
