/**
 * 健康检查输出处理纯函数（从 health-check.ts 拆出，0.53.10 体量让位）。
 * 作用：中位截断、ANSI 剥离、子进程输出解码。三者在健康检查与命令执行模块共用。
 * 不删理由：这些是「AI 看到的输出」的唯一整形口径，行为由 health-check-edge.test.ts 锁定。
 */
import { TextDecoder } from 'util'

/**
 * 中位截断：超长输出保留头部（命令/运行信息）+ 尾部（vitest 的 Test Files 汇总、
 * worker 崩溃错误通常在末尾），中间省略。单纯 truncate 只留头部会把真错误截掉。
 */
export function keepTail(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.ceil(max * 0.6)
  const tail = max - head
  return `${text.slice(0, head)}\n……（中段省略，共 ${text.length} 字符）\n${text.slice(-tail)}`
}

/**
 * 剥离 ANSI 转义序列（颜色码/光标控制等）。
 * 背景：vitest/tsc 等工具在可感知 TTY 或 FORCE_COLOR 环境下会在输出中混入
 * \x1b[31m 这类转义，直接注入 AI / 落盘会变成不可读乱码。统一在解码后剥离。
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
}

/**
 * 子进程输出解码：优先 UTF-8（工具链标准输出），非法字节回退 GBK。
 * 背景：Windows 中文环境（代码页 936）下，cmd 子进程/部分工具的错误消息
 * 走 GBK 字节；默认按 utf-8 解码会把它们解成乱码（如 鏄 鏂 等）。
 * 策略：用 fatal 模式的 UTF-8 严格解码，抛错说明存在非法字节序列，
 * 回退 GBK（GB18030 兼容子集，覆盖简体中文 Windows 常见输出）。
 */
export function decodeChildOutput(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch {
      // 理论不可达（gbk 解码器接受任意字节），兜底保编译
      return buf.toString('utf-8')
    }
  }
}
