/**
 * sub-agent-engine 审批裁决 + 阶段验证器单元测试
 * 覆盖：ApprovalManager.resolveByPolicy 策略裁决语义（allow/deny/ask fail-closed/ask create 复用）、
 * 输出解析（nmap/nuclei/ping/curl/ssh/generic）、阶段验证（passed/failed/pending 三分支）。
 */
import { describe, it, expect } from 'vitest'
import { ApprovalManager } from '../electron/main/tools/sub-agent-engine/engine'
import { parseToolOutput, verifyStage, ATTACK_STAGES } from '../electron/main/tools/sub-agent-engine/output-verifier'

const NMAP_OUT = `Starting Nmap 7.94 ( https://nmap.org )
Nmap scan report for 192.168.1.1
Host is up (0.0021s latency).
PORT     STATE SERVICE
22/tcp   open  ssh
80/tcp   open  http
Nmap done: 1 IP address (1 host up) scanned in 3.5 seconds`

const PING_OUT = `Pinging 192.168.1.1 with 32 bytes of data:
Reply from 192.168.1.1: bytes=32 time=3ms TTL=64`

const SSH_OUT = `Last login: Mon Jan 1 00:00:00 2026 from 10.0.0.2
Welcome to Ubuntu 22.04
Entering interactive session.`

describe('ApprovalManager.resolveByPolicy', () => {
  it('默认 ask 策略在自动化通道 fail-closed 拒绝', () => {
    const am = new ApprovalManager()
    am.defaultPolicy = 'ask'
    const v = am.resolveByPolicy('a1', 'agent1', 'run_command', { command: 'x' })
    expect(v.status).toBe('denied')
    expect(v.reason).toBe('ask_unavailable_fail_closed')
  })

  it('allow 策略自动放行并记 auto_approved', () => {
    const am = new ApprovalManager()
    am.setToolPolicy('run_command', 'allow')
    const v = am.resolveByPolicy('a1', 'agent1', 'run_command', { command: 'nmap -sV h' })
    expect(v.status).toBe('approved')
    expect(v.reason).toBe('auto_approved')
  })

  it('deny 策略自动拒绝', () => {
    const am = new ApprovalManager()
    am.setToolPolicy('run_command', 'deny')
    const v = am.resolveByPolicy('a1', 'agent1', 'run_command', {})
    expect(v.status).toBe('denied')
  })

  it('ask + create 建 pending 且同 agent 同工具复用，父级可 decide', () => {
    const am = new ApprovalManager()
    am.setToolPolicy('run_command', 'ask')
    const v1 = am.resolveByPolicy('a1', 'agent1', 'run_command', {}, { askMode: 'create' })
    expect(v1.status).toBe('pending')
    expect(v1.reqId).toBeTruthy()
    const v2 = am.resolveByPolicy('a1', 'agent1', 'run_command', {}, { askMode: 'create' })
    expect(v2.reqId).toBe(v1.reqId)
    expect(am.decide(v1.reqId!, true)).toBe(true)
    expect(am.get(v1.reqId!)?.status).toBe('approved')
  })
})

describe('parseToolOutput', () => {
  it('nmap：解析目标与开放端口，扫描完成为成功', () => {
    const out = parseToolOutput('nmap', NMAP_OUT)
    expect(out.ok).toBe(true)
    expect(out.exitHint).toBe('scan_completed')
    expect(out.records.filter((r) => r.event === 'port')).toHaveLength(2)
    const ports = out.records.filter((r) => r.event === 'port')
    expect(ports[0]).toMatchObject({ port: '22/tcp', service: 'ssh' })
  })

  it('nuclei：解析 severity/target/template 并统计', () => {
    const out = parseToolOutput('nuclei', '[critical] http://192.168.1.1/index.php [cve-2023-XXXX]')
    expect(out.records[0]).toMatchObject({ severity: 'critical', template: 'cve-2023-XXXX' })
    expect(out.summary.critical).toBe(1)
  })

  it('ping：解析回包；curl：有错误则整体视为失败', () => {
    const ping = parseToolOutput('ping', PING_OUT)
    expect(ping.records).toHaveLength(1)
    expect(ping.summary.replies).toBe(1)
    const curl = parseToolOutput('curl', '< HTTP/1.1 200 OK\ncurl: (7) Failed to connect')
    expect(curl.ok).toBe(false)
    expect(curl.exitHint).toContain('curl_error')
  })

  it('ssh：建立会话为成功；generic 文本弱结构化兜底', () => {
    const ssh = parseToolOutput('ssh', SSH_OUT)
    expect(ssh.ok).toBe(true)
    expect(ssh.summary.session).toBe('established')
    const g = parseToolOutput('generic', 'a: 1\nb: 2\n')
    expect(g.summary.lines).toBe(2)
  })
})

describe('verifyStage', () => {
  it('scan：nmap 开放端口 → passed', () => {
    const v = verifyStage('scan', [parseToolOutput('nmap', NMAP_OUT)])
    expect(v.status).toBe('passed')
    expect(v.evidence.length).toBeGreaterThan(0)
  })

  it('scan：ping 无端口信号 → pending（不误判失败）', () => {
    expect(verifyStage('scan', [parseToolOutput('ping', PING_OUT)]).status).toBe('pending')
  })

  it('access：ssh 会话 → passed；失败信号输出 → failed', () => {
    expect(verifyStage('access', [parseToolOutput('ssh', SSH_OUT)]).status).toBe('passed')
    const fail = verifyStage('access', [parseToolOutput('curl', 'curl: (7) Failed to connect')])
    expect(fail.status).toBe('failed')
  })

  it('空输出 → pending；阶段词表完整 8 项', () => {
    expect(verifyStage('enum', []).status).toBe('pending')
    expect(ATTACK_STAGES).toHaveLength(8)
  })
})