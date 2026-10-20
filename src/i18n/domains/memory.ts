/**
 * @category i18n
 * @summary `memory` 域文案分片（30 条 zh/en 配对）
 * 为什么存在：界面文案随 UI 域增长，全部塞进单个 `locales.ts` 会让任意 UI 域的改动
 * 都在同一文件上产生 merge 冲突；按域分片后各域独立演进（ADR-07）。
 * 不删理由：本文件是该域文案的唯一来源，宿主 barrel 用对象展开合并；条目保持
 * `{ zh, en }` 成对（按域拆、**不按语言拆**——配对是「单侧漏 key」的类型级防线）。
 */
import type { DictEntry } from '../dict-types'

const dict = {
  // ===== 记忆/图谱数据面板 =====
  'memoryGraph.title': { zh: '记忆与图谱', en: 'Memory & Graph' },
  'memoryGraph.loading': { zh: '加载中…', en: 'Loading…' },
  'memoryGraph.empty': { zh: '暂无数据', en: 'No data' },
  'memoryGraph.refresh': { zh: '刷新', en: 'Refresh' },
  'memoryGraph.close': { zh: '关闭', en: 'Close' },
  'memoryGraph.closeAria': { zh: '关闭记忆与图谱面板', en: 'Close memory & graph panel' },
  'memoryGraph.noContent': { zh: '（无内容）', en: '(No content)' },
  'memoryGraph.type.meta': { zh: '元认知', en: 'Meta' },
  'memoryGraph.type.high': { zh: '高阶', en: 'High' },
  'memoryGraph.type.standard': { zh: '普通', en: 'Standard' },
  'memoryGraph.tab.nng': { zh: 'NNG 图谱', en: 'NNG Graph' },
  'memoryGraph.tab.cache': { zh: '缓存图谱', en: 'Cache Graph' },
  'memoryGraph.hint': { zh: '滚轮平移 · Ctrl+滚轮缩放 · 拖拽画布 · 点击节点查看 JSON', en: 'Scroll to pan · Ctrl+scroll to zoom · Drag canvas · Click a node to view JSON' },
  'memoryGraph.zoomIn': { zh: '放大', en: 'Zoom in' },
  'memoryGraph.zoomOut': { zh: '缩小', en: 'Zoom out' },
  'memoryGraph.zoomFit': { zh: '适应视图', en: 'Fit view' },
  'memoryGraph.reset': { zh: '重置视图', en: 'Reset view' },
  'memoryGraph.jsonPreview': { zh: 'JSON 预览', en: 'JSON Preview' },
  'memoryGraph.closePreview': { zh: '关闭预览', en: 'Close preview' },

  // ===== Memory Workflow section =====
  'settings.fetchModelsTitle': { zh: '从服务端拉取可用模型列表', en: 'Fetch models from server' },

  // ===== 记忆工作流配置 =====
  'settings.memoryWorkflowPolicyDesc': { zh: '记忆工作流工具策略配置，已合并到记忆处理工作流。', en: 'Memory workflow tool policy config, merged into memory workflow.' },
  'settings.memoryWorkflowPromptSrc': { zh: '记忆工作流提示词从 prompts/ 目录加载。', en: 'Memory workflow prompts loaded from prompts/.' },
  'settings.memoryWorkflowResetTitle': { zh: '恢复到优化后的默认状态', en: 'Reset to optimized defaults' },
  'settings.memoryWorkflowResetBtn': { zh: '重置工具策略', en: 'Reset Tool Policy' },
  'settings.memoryWorkflowTitle': { zh: '记忆处理工作流', en: 'Memory Workflow' },
  'settings.memoryWorkflowSteps': { zh: '筛选 → 记忆生成 → NNG 定位 → 归档 → 去重 → 经验提取 → 反思', en: 'Filter → Generate → NNG → Archive → Dedup → Extract → Reflect' },
  'settings.memoryWorkflowWorkflowDesc': { zh: '工作流配置和提示词外置在 workflows/prompts/ 目录（MD 文件，可直接编辑）。', en: 'Workflow config and prompts in workflows/prompts/ (MD files, editable).' },
  'settings.memoryWorkflowToggle': { zh: '开关状态见侧边栏"记忆工作流"开关。', en: 'Toggle in sidebar "Memory Workflow".' },
  'settings.memoryWorkflowRawLimit': { zh: 'RAW 记忆字符上限（字符）', en: 'RAW Memory Char Limit' },
  'settings.memoryWorkflowRawLimitDesc': { zh: '每个 RAW 记忆文件的字符上限：对话实时追加，超限时自动开新文件。默认 20000。调小可让 RAW 更快封口。', en: 'Char limit per RAW file. Auto-splits when exceeded. Default: 20000.' },

} satisfies Record<string, DictEntry>

export default dict
