/**
 * 像素图标（ROOM 专用）：8×8 行字符串 → 单一 SVG `<path>`。
 *
 * 为什么不用 lucide：ROOM 是像素风驾驶舱，lucide 是矢量描边，与 2px 硬边 / 0 圆角的像素 chrome
 * 不同源。这里用「行字符串 + 单 path」——比每像素一个 `<rect>` 少两个数量级的 DOM 节点，
 * 且**无外部资产**（利好可移植性，见 CODE-RULES 分发边界）。
 *
 * 为什么行字符串而不是 SVG 路径常量：行字符串可直接看出画的是什么（改一处像素改一个字符），
 * 也是 AI 生成像素规格的同一种表示（见 P3 `room/avatar-spec.ts`）——图标与 AI 画作同源。
 *
 * 用法：`<PixelGlyph rows={GLYPH.eye} size={12} className="text-accent" />`
 * 不删理由：删掉即三主区导航与相位灯退回 lucide 描边图标，像素风自相矛盾。
 */

/** 8×8 图标网格：`#` = 亮像素，其它 = 透明。 */
export const GLYPH = {
  /** 执行器 = 齿轮（工具/动作面） */
  gear: [
    '..#..#..',
    '.######.',
    '########',
    '##....##',
    '##....##',
    '########',
    '.######.',
    '..#..#..'
  ],
  /** 采集器 = 眼睛（感官 / 用户输入代理） */
  eye: [
    '........',
    '..####..',
    '.##..##.',
    '##.##.##',
    '##.##.##',
    '.##..##.',
    '..####..',
    '........'
  ],
  /** 设备 = 芯片 */
  chip: [
    '.#.##.#.',
    '.######.',
    '##....##',
    '#.#..#.#',
    '#.#..#.#',
    '##....##',
    '.######.',
    '.#.##.#.'
  ],
  /** 自主开关 = 电源 */
  power: [
    '...##...',
    '..####..',
    '.##..##.',
    '.#....#.',
    '.#....#.',
    '.##..##.',
    '..#..#..',
    '...##...'
  ],
  /** 急停 = 实心方块 */
  stop: [
    '........',
    '.######.',
    '.######.',
    '.######.',
    '.######.',
    '.######.',
    '.######.',
    '........'
  ],
  /** 警示 = 三角 */
  warn: [
    '...##...',
    '..####..',
    '..####..',
    '.######.',
    '.######.',
    '########',
    '########',
    '........'
  ],
  /** 记录 = 三行文本（GALGAME 的 LOG / 回看） */
  log: [
    '........',
    '########',
    '........',
    '########',
    '........',
    '########',
    '........',
    '........'
  ],
  /** 抽屉 = 右侧面板 */
  drawer: [
    '........',
    '##.####.',
    '##.#..#.',
    '##.#..#.',
    '##.#..#.',
    '##.#..#.',
    '##.####.',
    '........'
  ]
} as const

export type GlyphRows = readonly string[]

/**
 * 把 8×8 行字符串转成单条 SVG path（每个亮像素一个 1×1 方块）。
 * 纯函数：同样的 rows 永远得到同样的 d，便于快照测试。
 */
export function rowsToPath(rows: GlyphRows): string {
  let d = ''
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y]
    for (let x = 0; x < row.length; x++) {
      if (row[x] === '#') d += `M${x} ${y}h1v1h-1z`
    }
  }
  return d
}

/** 渲染一个像素图标；`size` 为像素边长（建议 12~16，非整数倍会糊）。 */
export function PixelGlyph({
  rows,
  size = 12,
  className
}: {
  rows: GlyphRows
  size?: number
  className?: string
}) {
  const h = rows.length
  const w = rows[0]?.length ?? 0
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${w} ${h}`}
      className={className}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <path d={rowsToPath(rows)} fill="currentColor" />
    </svg>
  )
}
