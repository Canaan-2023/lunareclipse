/**
 * @category CLI-TUI
 * @summary 终端输入框（Ink useInput 实现，无第三方输入组件依赖）
 *
 * 支持：字符输入（含 IME 合成文本粘入）、左右移动光标、退格/删除、
 * Home/End、Esc 清空、Enter 提交。Ctrl-C 由 App 层全局处理（中止流/退出），
 * 此处不消费。
 */
import React, { useEffect, useState } from 'react'
import { Box, Text, useInput } from 'ink'

export interface PromptInputProps {
  value: string
  onChange: (next: string) => void
  onSubmit: () => void
  placeholder?: string
  /** false 时不监听按键（autopilot/非交互跑批模式），避免 Ink 在非 tty 下开启 raw mode */
  active?: boolean
}

export function PromptInput({ value, onChange, onSubmit, placeholder, active = true }: PromptInputProps): React.JSX.Element {
  const [cursor, setCursor] = useState(value.length)

  // 外部替换 value（如 /new、历史回填）后光标收敛到末尾
  useEffect(() => {
    setCursor((c) => Math.min(c, value.length))
  }, [value.length])

  useInput(
    (input, key) => {
    if (key.return) {
      onSubmit()
      return
    }
    if (key.backspace) {
      if (cursor > 0) {
        onChange(value.slice(0, cursor - 1) + value.slice(cursor))
        setCursor((c) => c - 1)
      }
      return
    }
    if (key.delete) {
      if (cursor < value.length) {
        onChange(value.slice(0, cursor) + value.slice(cursor + 1))
      }
      return
    }
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1))
      return
    }
    if (key.rightArrow) {
      setCursor((c) => Math.min(value.length, c + 1))
      return
    }
    if (key.home) {
      setCursor(0)
      return
    }
    if (key.end) {
      setCursor(value.length)
      return
    }
    if (key.escape) {
      onChange('')
      setCursor(0)
      return
    }
    // 上下箭头保留给输入历史（App 层处理），Tab/翻页暂不消费
    if (key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.tab || key.ctrl) {
      return
    }
    if (input) {
        const next = value.slice(0, cursor) + input + value.slice(cursor)
        onChange(next)
        setCursor((c) => c + input.length)
      }
    },
    { isActive: active }
  )

  const before = value.slice(0, cursor)
  const at = value[cursor] ?? ''
  const after = value.slice(cursor + 1)

  return (
    <Box>
      <Text color="green">❯ </Text>
      {value.length === 0 ? (
        <Text color="gray" dimColor>
          {placeholder ?? ''}
        </Text>
      ) : (
        <>
          <Text>{before}</Text>
          <Text inverse>{at === '' ? ' ' : at}</Text>
          <Text>{after}</Text>
        </>
      )}
    </Box>
  )
}