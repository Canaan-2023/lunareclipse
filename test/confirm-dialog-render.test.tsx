/**
 * ConfirmDialog 确认弹窗渲染实测（对齐 MessageBubble 渲染测试模式）。
 * 为什么用 react-dom/server：项目 vitest 环境为 node（无 jsdom），确认弹窗是纯展示
 *   结构，renderToStaticMarkup 即可验证标题/正文/危险语义按钮的输出，无需引入 jsdom。
 * 为什么存在：删除会话确认弹窗 UI 从原生 confirm 迁移到月蚀风格组件，必须实测渲染输出
 *   而不是只做类型检查；同时验证关闭态不渲染、danger 语义切换主按钮配色。
 */
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Trash2 } from 'lucide-react'
import { ConfirmDialog } from '../src/components/ConfirmDialog'

describe('ConfirmDialog 确认弹窗渲染', () => {
  // 用例1：open=false 时不渲染任何内容
  it('关闭态返回空输出', () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog open={false} title="删除会话" message="确定？" onConfirm={() => {}} onCancel={() => {}} />
    )
    expect(html).toBe('')
  })

  // 用例2：打开时渲染标题、正文、确认/取消按钮与对话框语义
  it('打开态渲染标题、正文与按钮文本', () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        open
        title="删除会话"
        message='会话「月蚀」将被永久删除'
        confirmLabel="删除"
        cancelLabel="取消"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    )
    expect(html).toContain('删除会话')
    expect(html).toContain('会话「月蚀」将被永久删除')
    expect(html).toContain('>删除<')
    expect(html).toContain('>取消<')
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
  })

  // 用例3：danger（默认）→ 红色主按钮 + 红色图标语义
  it('danger 模式主按钮为红色语义', () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        open
        title="删除会话"
        message="确定？"
        icon={<Trash2 size={14} />}
        confirmLabel="删除"
        cancelLabel="取消"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    )
    expect(html).toContain('bg-red-500/90')
    expect(html).toContain('text-red-400')
    // 关闭按钮（取消）不应误用主按钮危险样式
    expect(html).not.toContain('bg-accent')
  })

  // 用例4：danger=false（常规操作）→ accent 主按钮，标题栏语义色为 accent
  it('常规模式主按钮为 accent 语义', () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        open
        title="确认操作"
        message="常规操作确认"
        confirmLabel="确认"
        cancelLabel="取消"
        danger={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    )
    expect(html).toContain('bg-accent')
    expect(html).not.toContain('bg-red-500/90')
    expect(html).not.toContain('text-red-400')
  })
})