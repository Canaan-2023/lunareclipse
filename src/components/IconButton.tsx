/**
 * 为什么存在：全仓约 570 个按钮里大量是"只有图标、没有文字"的按钮，可访问名称只能靠 title 或 aria-label；
 * title 不能可靠充当可访问名称（读屏器与触屏/键盘路径不一定暴露它），纯图标按钮因此容易变成"未命名按钮"。
 * 作用：纯图标按钮的统一出口——把 aria-label 提到类型层作为必填 prop，漏写直接编译失败，从源头挡住新增缺口。
 * 视觉与行为完全由调用方的 className / onClick / disabled 决定，本组件只补可访问名称与 ref 透传。
 * 不删理由：这是"仅图标按钮必须有可访问名称"这条约束的唯一强制点；若删掉，后续新增按钮会重新回到无名称状态。
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  /** 可访问名称（必填）：读屏器朗读的按钮名，通常与 title 同文案 */
  'aria-label': string
  children: ReactNode
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { children, ...rest },
  ref
) {
  return (
    <button ref={ref} {...rest}>
      {children}
    </button>
  )
})
