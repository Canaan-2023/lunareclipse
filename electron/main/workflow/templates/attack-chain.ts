/**
 * @category Workflow
 * @summary 内置工作流模板：授权目标探测 Playbook（workflow 模式）
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

/**
 * 授权目标探测 playbook（Workflow 模式）：侦察 → 扫描 → 枚举 → 打点判定 → 验证突破 → 报告。
 * 为什么存在：把「进入设备 → 拿权限 → 操作」的能力释放做成可编排 DAG——节点输出写 context
 * 传下游，扫描/连接等命令经 run_command 审批通道（灰名单询问 / 自动化通道策略裁决）放行，
 * 不绕过 security-engine。与 output-verifier 的阶段判定配合使用（8 阶段词表同源）。
 * 输入约定：{ target, scope, authorized } —— 仅 authorized=true 时执行探测动作，
 * 未授权目标只有侦察节点会返回 authorized:false 并终止，不产生任何扫描/连接动作。
 */
export const ATTACK_CHAIN_TEMPLATE: WorkflowTemplate = {
  id: 'wf_default_attack_chain',
  name: '授权目标探测 Playbook',
  description: '授权环境下的目标探测编排：侦察 → 授权门 → 扫描 → 枚举 → 打点判定 → 验证突破 → 汇总报告',
  tags: ['安全', '探测', '默认'],
  mode: 'workflow',
  source: 'default',
  createdAt: now,
  updatedAt: now,
  nodes: [
    {
      id: 'recon',
      type: 'llm',
      name: '侦察目标信息',
      config: {
        stream: false,
        tools: ['run_command', 'web_search'],
        outputVars: ['authorized', 'scope', 'targets', 'recon_summary'],
        prompt: `# 角色
你是授权渗透测试流程的侦察执行者。

# 任务
基于授权的测试范围，收集目标的基本信息（IP / 域名 / 开放服务线索 / 技术栈）。本阶段只做信息收集，不做任何攻击动作。

# 输入
- 目标：{{context.input.target}}
- 授权范围说明：{{context.input.scope}}
- 授权标记：{{context.input.authorized}}

# 执行步骤
1. 确认授权：authorized 不为 true、或目标不在授权范围内 → 输出 <json>{"authorized": false}</json> 并停止，不执行任何探测（后续授权门会据此终止流程）。
2. 用只读手段收集目标信息（解析、查询、文档检索等），如需命令用 run_command 执行只读命令。

# 输出格式
必须输出 <json> 块：
<json>
{"authorized": true, "scope": "实际生效的授权范围", "targets": ["目标列表"], "recon_summary": "一句话侦察结论"}
</json>`
      }
    },
    {
      id: 'gate-auth',
      type: 'condition',
      name: '授权门',
      config: {}
    },
    {
      id: 'scan',
      type: 'llm',
      name: '端口与服务扫描',
      config: {
        stream: false,
        tools: ['run_command'],
        outputVars: ['ports', 'services', 'scan_summary'],
        prompt: `# 角色
你是授权渗透测试流程的端口与服务扫描执行者。

# 输入
- 目标列表：{{context.targets}}
- 授权范围：{{context.input.scope}}

# 执行步骤
1. 对每个目标执行端口/服务扫描（如 nmap -Pn -sV --top-ports 100 {目标}），收集开放端口与服务指纹。
2. 扫描命令属灰名单命令，会触发审批/策略裁决——按系统提示执行，不得尝试绕过审批。
3. 只扫描授权范围内的目标，禁止横向扩展到未授权主机。

# 输出格式
必须输出 <json> 块：
<json>
{"ports": ["22/tcp open ssh"], "services": ["ssh OpenSSH 8.9"], "scan_summary": "存在开放端口: ..."}
</json>
scan_summary 必须包含「存在开放端口」或「未发现开放端口」字面量，供流程分支判断。`
      }
    },
    {
      id: 'enum',
      type: 'llm',
      name: '服务枚举',
      config: {
        stream: false,
        tools: ['run_command'],
        outputVars: ['versions', 'accounts', 'enum_summary'],
        prompt: `# 角色
你是授权渗透测试流程的服务枚举执行者。

# 输入
- 扫描结论：{{context.scan_summary}}
- 端口列表：{{context.ports}}
- 授权范围：{{context.input.scope}}

# 执行步骤
1. 对开放服务做版本/账号/共享枚举（如 nmap -sV -p {端口}、服务指纹比对等）——命令可能触发审批，按提示执行。
2. 只枚举授权目标，不做未授权的登录尝试。

# 输出格式
必须输出 <json> 块：
<json>
{"versions": ["服务版本指纹"], "accounts": ["发现的账号/共享线索"], "enum_summary": "一句话枚举结论（标识可利用面）"}
</json>`
      }
    },
    {
      id: 'gate',
      type: 'condition',
      name: '打点判定',
      config: {}
    },
    {
      id: 'exploit',
      type: 'llm',
      name: '访问验证',
      config: {
        stream: false,
        tools: ['run_command'],
        outputVars: ['foothold', 'access_summary'],
        prompt: `# 角色
你是授权渗透测试流程的访问验证执行者。

# 输入
- 目标列表：{{context.targets}}
- 枚举结论：{{context.enum_summary}}
- 授权范围：{{context.input.scope}}

# 执行步骤
1. 基于服务枚举结果，在授权范围内验证可访问性（默认凭据、公开漏洞验证、弱口令探测等）。
2. 每次连接/登录动作都需通过审批，按系统提示执行。
3. 一旦确认入口（会话/权限），立即停手记录——不做未授权的横向移动与破坏性操作。
4. 若无法确认入口，如实输出结论，不编造。

# 输出格式
必须输出 <json> 块：
<json>
{"foothold": "是否获得入口（是/否）", "access_summary": "验证过程与结果摘要"}
</json>`
      }
    },
    {
      id: 'report',
      type: 'end',
      name: '汇总报告',
      config: {
        output: `授权目标探测报告
- 授权范围：{{context.scope}}
- 目标：{{context.targets}}

侦察结论：{{context.recon_summary}}

扫描结论：{{context.scan_summary}}

枚举结论：{{context.enum_summary}}

访问验证：{{context.access_summary}}

依据：本流程仅对授权目标执行探测，输出供安全评估归档。`
      }
    },
    {
      id: 'abort',
      type: 'end',
      name: '未授权终止',
      config: {
        output: `授权检查未通过：authorized 为 false 或目标不在授权范围内。
流程已终止，未执行任何扫描/枚举/访问动作。
授权范围：{{context.input.scope}}`
      }
    }
  ],
  edges: [
    { from: 'recon', to: 'gate-auth' },
    {
      from: 'gate-auth',
      to: 'scan',
      condition: "context.authorized == 'true'"
    },
    { from: 'gate-auth', to: 'abort', condition: 'default' },
    { from: 'scan', to: 'enum' },
    { from: 'enum', to: 'gate' },
    { from: 'gate', to: 'exploit', condition: "context.scan_summary contains '存在开放端口'" },
    { from: 'gate', to: 'report', condition: 'default' },
    { from: 'exploit', to: 'report' }
  ]
}
