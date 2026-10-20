/**
 * @category Workflow
 * @summary 内置工作流模板：多媒体素材生成（workflow 模式）
 *
 * 为什么独立成文件：内置模板是「随新增模板 / 修改模板节点增长」的数据表，9 个模板互相无引用却
 * 曾共处 999 行的 default-templates.ts，任一模板改动都与其它模板构成 merge 冲突热点（ADR-08）。
 * 拆出后本文件只承载单个模板字面量；聚合与对外导出面在宿主 ./../default-templates.ts。
 *
 * 不删理由：删掉即该内置模板从开箱清单消失（DEFAULT_TEMPLATES 少一项，首启不再落盘该模板）。
 * 约束：createdAt/updatedAt 必须 import 同一 `now`（./shared），禁止本地重声明——否则 updatedAt
 * 抖动会触发 store.save() 回写与 .src 指纹漂移（ADR-08 §4 `now` 单源红线）。
 */
import type { WorkflowTemplate } from '@shared/workflow/types'
import { now } from './shared'

/** 多媒体素材生成工作流（Workflow 模式）：LLM 节点挂生成工具，直接干活。
 * 说明：llm 节点 tools 声明生成工具（未配置/未启用的工具会被工具池自动跳过，不报错），
 * AI 按需求自行组合调用：image_gen / video_gen / audio_gen / create_document。
 * 产物统一存 generated/U{uid}/AI{aiId}/{分类}/{年}/{月}/{日}/，并在回复中给出路径。
 */
export const ASSET_CREATOR_TEMPLATE: WorkflowTemplate = {
  id: 'wf_default_asset_creator',
  name: '多媒体素材生成',
  description: '理解需求 → AI 按需调用 image_gen / video_gen / audio_gen / create_document 直接生成图片/视频/音频/文稿，产物按分类+日期自动归档到 generated/',
  tags: ['生成', '素材', '多模态', '默认'],
  mode: 'workflow',
  source: 'default',
  createdAt: now,
  updatedAt: now,
  nodes: [
    {
      id: 'creator',
      type: 'llm',
      name: '生成素材',
      config: {
        prompt:
          '你是多媒体创作执行者。根据需求调用可用的生成工具直接产出素材：\n' +
          '- image_gen：生成配图（需 imageGen 配置）\n' +
          '- video_gen：生成视频（需 generation.video 配置）\n' +
          '- audio_gen：生成音频/音乐（需 generation.audio 配置）\n' +
          '- create_document：把文稿/方案归档为 md/txt（无需配置，随时可用）\n\n' +
          '要求：\n' +
          '1. 先判断需求需要哪几类素材，逐一调用对应工具（工具调用失败时说明缺什么配置，改用 create_document 归档文字方案）\n' +
          '2. 每次 prompt 要具体（主体/风格/构图/时长等），一次一个工具调用\n' +
          '3. 全部完成后汇总：每个产物的分类、保存路径、file:// URL\n\n' +
          '需求：{{context.input}}',
        stream: false,
        tools: ['image_gen', 'video_gen', 'audio_gen', 'create_document']
      }
    },
    {
      id: 'end_node',
      type: 'end',
      name: '完成',
      config: {
        output: '{{context.creator}}'
      }
    }
  ],
  edges: [
    { from: 'creator', to: 'end_node' }
  ]
}
