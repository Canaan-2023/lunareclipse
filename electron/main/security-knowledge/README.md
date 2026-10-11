# 安全知识库挂载（security-knowledge）

攻击链能力（workflow DAG / sub-agent 阶段验证）的确定性战术参考层。本项目**不搬运**知识内容，
只定义三个官方权威源的结构化清单与本地挂载约定；检索层只对已挂载目录做路径级（文件名+目录名）轻量检索，
未挂载时明确返回 `not-mounted`，不编造内容。

## 源清单（sources.ts，T3 逐源核实）

| id | 名称 | 用途 | 官方仓库 | 格式 |
| --- | --- | --- | --- | --- |
| `hacktricks` | HackTricks | 攻击手法步骤库（playbook 战术参考） | HackTricks-wiki/hacktricks | mdBook（Markdown），MIT |
| `mitre-attack` | MITRE ATT&CK CTI | 战术/阶段分类模型（阶段验证器词表对齐源） | mitre/cti + mitre-attack/attack-stix-data | STIX 2.0 / 2.1，CC BY 4.0 |
| `nuclei-templates` | nuclei-templates | 漏洞检测模板（扫描动作素材） | projectdiscovery/nuclei-templates | YAML，MIT |

## 挂载（一次性，按需）

默认根目录：`%USERPROFILE%\security-knowledge`（可用环境变量 `SECURITY_KB_ROOT` 覆盖）。

```bash
# git-bash / PowerShell 均可
export SECURITY_KB_ROOT="$USERPROFILE/security-knowledge"   # 可选覆盖
mkdir -p "$SECURITY_KB_ROOT"

git clone --depth 1 https://github.com/HackTricks-wiki/hacktricks.git   "$SECURITY_KB_ROOT/hacktricks"
git clone --depth 1 https://github.com/mitre/cti.git                     "$SECURITY_KB_ROOT/mitre-cti"
git clone --depth 1 https://github.com/projectdiscovery/nuclei-templates.git "$SECURITY_KB_ROOT/nuclei-templates"
```

> 体积提示：nuclei-templates 模板超 1 万条、hacktricks 数千页面，勿在低配环境全量检索；
> 检索层限深 6 层、限文件数，必要时按 `searchLocalSource(id, kw, limit)` 定向使用单个源。

## 接入点

- `getKnowledgeStatus()`：逐源返回 `{ mounted, fileCount, localPath }`，无假数据
- `isAllKnowledgeMounted()`：全部源挂载校验（启动检查/playbook 前置门）
- `searchLocalSource(sourceId, keyword, limit)`：单源路径关键词检索（文件名+目录名）
- `searchAllSources(keyword)`：全局分组检索（按源分组）

### 与攻击链的衔接

- workflow 攻击链模板（`wf_default_attack_chain`）的侦察/枚举节点如需手法参考，
  在 llm 节点里以只读方式读取 `getKnowledgeStatus()` 的结果；未挂载则明确跳过，
  不伪造参考。
- 阶段验证器（sub-agent-engine/output-verifier.ts）的阶段词表与 MITRE ATT&CK
  （`mitre-attack` 源）同源；扩展阶段时先比对 `attack-stix-data` 的 tactic 定义。
- nuclei 模板仅作**检测素材**：执行扫描必须走 run_command 灰名单审批通道，
  不因知识库挂载而获得任何免审批权限。