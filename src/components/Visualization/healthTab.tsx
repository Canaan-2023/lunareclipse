/**
 * 为什么存在：系统健康检查（typecheck/test/lint 等）结果需要集中查看并对比历史，
 * 独立 Tab 承载（批次 E-5c 拆分产物）。
 * 作用：渲染健康检查 Tab——检查项列表/状态展示、重跑检查与历史对比视图。
 */
import { useState } from 'react'
import { RefreshCw, ShieldCheck, Activity, History } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import type { HealthCheckItemStatus, VisualizationData } from '@shared/types'
import { SectionTitle, EmptyHint } from './common'
import { formatDateTime } from '../../utils/time'

/** 健康检查 Tab（批次 E-5c 从 VisualizationPanel.tsx 拆出） */

const CHECK_LABELS: Record<string, string> = {
  typecheck: '类型检查',
  test: '测试',
  lint: '代码规范',
  build: '构建',
  files: '文件层',
  'code-review': '代码评审',
  uiux: 'UI/UX 审计',
  safety: '自我安全'
}

/** 工作区代码健康状态：来自主进程 HealthCheck 模块内存态快照（viz:getAll 附带） */
export function HealthTab({ data }: { data: VisualizationData | null }) {
  const loading = useAppStore((s) => s.visualizationLoading)
  const hc = data?.healthCheck ?? null

  if (!hc) {
    return (
      <div className="space-y-5">
        <SectionTitle icon={ShieldCheck} title="健康检查" />
        <EmptyHint text="健康检查模块未初始化（打包环境或模块未启动）" />
      </div>
    )
  }

  if (!hc.available) {
    return (
      <div className="space-y-5">
        <SectionTitle icon={ShieldCheck} title="健康检查" />
        <EmptyHint text="健康检查模块不可用（已关闭或初始化失败）" />
      </div>
    )
  }

  const runCheck = () => void useAppStore.getState().healthCheckRun()
  const busy = loading || hc.running

  // 总状态卡片
  const overall =
    !hc.enabled
      ? { label: '已禁用', dot: 'bg-fg-muted/50', desc: '配置 config.enabled=false，可在 {dataDir}/.health_check/config.json 开启' }
      : hc.overallOk === null
        ? { label: '尚未检查', dot: 'bg-fg-muted', desc: '应用启动 2 秒后自动检查，或点击「立即检查」' }
        : hc.overallOk
          ? { label: '全部通过', dot: 'bg-green-400', desc: '工作区代码健康' }
          : {
              label: '存在异常',
              dot: 'bg-red-400',
              desc: `${hc.checks.filter((c) => c.ok === false).length} 项异常，已注入事件待 AI 处理`
            }

  return (
    <div className="space-y-5">
      {/* 总状态 + 立即检查 */}
      <section>
        <SectionTitle icon={ShieldCheck} title="健康检查" />
        <div className="flex items-center gap-3 rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2.5">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${overall.dot} ${hc.running ? 'animate-pulse' : ''}`} />
          <div className="flex-1">
            <div className="text-body font-medium text-fg-primary">{overall.label}</div>
            <div className="text-[10px] text-fg-muted">{overall.desc}</div>
          </div>
          {hc.enabled && (
            <button
              onClick={runCheck}
              disabled={busy}
              className="flex items-center gap-1 rounded-btn border border-accent/40 px-2.5 py-1 text-caption text-accent hover:bg-accent/10 disabled:opacity-50"
              title="立即执行一轮完整检查（typecheck/test，可能耗时数秒）"
            >
              <RefreshCw size={11} className={busy ? 'animate-spin' : ''} />
              {busy ? '检查中' : '立即检查'}
            </button>
          )}
        </div>
        {/* 元信息 */}
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 px-1 text-[10px] text-fg-muted">
          <span>间隔：每 {hc.interval_minutes} 分钟</span>
          {hc.lastRunAt ? (
            <span>上次检查：{new Date(hc.lastRunAt).toLocaleString('zh-CN')}</span>
          ) : (
            <span>上次检查：尚未执行</span>
          )}
        </div>
        {/* 打包态说明：源码类检查（typecheck/test/代码评审等）依赖工作区源码与 node_modules，
            分发包无此环境，仅文件层与运行时事件监控生效——避免用户误以为系统损坏 */}
        {hc.packaged && (
          <div className="mt-1.5 px-1 text-[10px] text-fg-muted">
            打包环境：源码类检查（类型检查/测试/代码评审/UI 审计）跳过，文件层与运行时事件监控仍生效
          </div>
        )}
      </section>

      {/* 检查项列表 */}
      {hc.enabled && (
        <section>
          <SectionTitle icon={Activity} title={`检查项（${hc.checks.length}）`} />
          <div className="space-y-1.5">
            {hc.checks.length === 0 ? (
              <EmptyHint text="暂无启用的检查项（config.checks 全部关闭）" />
            ) : (
              hc.checks.map((c) => <HealthCheckItem key={c.key} item={c} />)
            )}
          </div>
        </section>
      )}

      {/* 修复记录：AI 处理过程时间线（发现异常→修复→恢复全留痕） */}
      {hc.repairLog && hc.repairLog.length > 0 && (
        <section>
          <SectionTitle icon={History} title={`修复记录（${hc.repairLog.length}）`} />
          <div className="space-y-1.5">
            {hc.repairLog.slice(0, 20).map((e, i) => {
              const kindCfg = {
                alert: { label: '发现异常', cls: 'text-red-400 border-red-400/40' },
                recovered: { label: '已恢复', cls: 'text-green-400 border-green-400/40' },
                silence: { label: '已静默', cls: 'text-fg-muted border-border-subtle' }
              }[e.kind] ?? { label: e.kind, cls: 'text-fg-muted border-border-subtle' }
              return (
                <div key={`${e.time}-${i}`} className="rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] ${kindCfg.cls}`}>{kindCfg.label}</span>
                    <span className="flex-1 text-caption text-fg-primary">{CHECK_LABELS[e.key] ?? e.key}</span>
                    <span className="shrink-0 text-[10px] text-fg-muted">{new Date(e.time).toLocaleString('zh-CN')}</span>
                  </div>
                  {e.detail && (
                    <div className="mt-1 line-clamp-2 whitespace-pre-wrap break-all font-mono text-[10px] text-fg-secondary">{e.detail}</div>
                  )}
                </div>
              )
            })}
          </div>
          <div className="mt-1 px-1 text-[10px] text-fg-muted">异常 → AI 修复 → 恢复的全过程都记录在这里（最多保留最近 50 条）</div>
        </section>
      )}
    </div>
  )
}

function HealthCheckItem({ item }: { item: HealthCheckItemStatus }) {
  const [expanded, setExpanded] = useState(false)
  const label = CHECK_LABELS[item.key] ?? item.key
  const hasError = item.output.length > 0
  // 三态：null = 尚未检查（灰点"未知"），与 ModuleInfo 的 null 语义一致，避免未检查项被误报为失败
  const okState =
    item.ok === true
      ? { dot: 'bg-green-400', text: '通过', cls: 'border-border-subtle bg-bg-elevated' }
      : item.ok === false
        ? { dot: 'bg-red-400', text: '失败', cls: 'border-red-400/40 bg-red-400/5' }
        : { dot: 'bg-fg-muted/40', text: '尚未检查', cls: 'border-border-subtle bg-bg-elevated' }
  return (
    <div className={`rounded-btn border px-3 py-2 ${okState.cls}`}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${okState.dot}`} />
        <span className="flex-1 text-caption text-fg-primary">{label}</span>
        <span className="text-[10px] text-fg-muted">{okState.text}</span>
        {item.checkedAt && (
          <span className="shrink-0 text-[10px] text-fg-muted">
            {formatDateTime(item.checkedAt)}
          </span>
        )}
      </div>
      {hasError && (
        <button onClick={() => setExpanded((v) => !v)} className="mt-1 w-full text-left">
          <div className={`whitespace-pre-wrap break-all font-mono text-[10px] text-red-400 ${expanded ? '' : 'line-clamp-2'}`}>
            {item.output}
          </div>
          <div className="mt-0.5 text-[9px] text-fg-muted">{expanded ? '收起' : '展开完整错误'}</div>
        </button>
      )}
    </div>
  )
}