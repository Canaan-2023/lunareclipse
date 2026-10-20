/**
 * 设备发现器（ 设备接入基底）
 *
 * 为什么存在：设备管理需要先回答「当前环境有哪些设备」。三种来源：
 * - 本机（self）：复用 performance/runtime-profile 的运行时参数，把本机作为
 * 一台"设备"注册进基底——它拥有 CPU/内存/负载等只读能力接口。
 * - 局域网（lan）：os.networkInterfaces() 取本机网段 + PowerShell `arp -a` 枚举
 * 同网段活跃主机（IP + MAC），探测常见端口（80/443/8080 等）标注可服务性。
 * - 蓝牙（bluetooth）：PowerShell `Get-PnpDevice -Class Bluetooth` 枚举已配对/
 * 已连接蓝牙设备，暴露设备名/地址/状态。
 *
 * 为什么独立成模块：发现逻辑与「设备注册/调用」解耦——发现是只读探测，注册/调用
 * 是可写操作，分开便于安全审查与单独测试。
 */
import { networkInterfaces } from 'os'
import { Socket } from 'net'
import { spawn } from 'child_process'
import { getRuntimeProfile } from '../performance/runtime-profile'
import type { AbyssDevice } from './types'

/** 局域网主机端口探测的目标端口（常见服务端口，超时短） */
const LAN_PROBE_PORTS = [80, 443, 8080, 3000, 3389]
/** 端口探测单端口超时（毫秒） */
const PORT_PROBE_TIMEOUT_MS = 400
/** 蓝牙 PowerShell 命令超时（毫秒） */
const BT_CMD_TIMEOUT_MS = 8000

/** 执行 PowerShell 命令并收集 stdout（超时杀进程） */
function runPowershell(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true
    })
    let stdout = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* 忽略 */ }
      resolve('')
    }, timeoutMs)
    child.stdout.on('data', (d) => { stdout += d.toString('utf-8') })
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(stdout)
    })
    child.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve('')
    })
  })
}

/** 单端口连通性探测（TCP 握手成功即视为端口开放） */
function probePort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket()
    const timer = setTimeout(() => {
      settled = true
      try { socket.destroy() } catch { /* 忽略 */ }
      resolve(false)
    }, PORT_PROBE_TIMEOUT_MS)
    let settled = false
    socket.once('connect', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.destroy() } catch { /* 忽略 */ }
      resolve(true)
    })
    socket.once('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.destroy() } catch { /* 忽略 */ }
      resolve(false)
    })
    socket.connect(port, host)
  })
}

/** 本机设备：复用 runtime-profile 的硬件参数，暴露只读状态能力 */
export function discoverSelf(): AbyssDevice {
  const profile = getRuntimeProfile()
  return {
    id: 'self',
    name: '本机（月蚀宿主）',
    source: 'self',
    kind: '本机',
    status: `CPU ${profile.cpuUsagePct.toFixed(0)}%`,
    discoveredAt: Date.now(),
    capabilities: [
      {
        id: 'system',
        name: '系统状态',
        actions: [
          {
            id: 'system:info',
            name: '获取系统状态',
            description:
              '返回本机运行时参数：平台/CPU 型号/逻辑核/物理核/总内存/空闲内存/当前 CPU 使用率。只读，无需授权。',
            kind: 'info',
            risk: 'low'
          }
        ]
      }
    ]
  }
}

/** 局域网主机发现：本机各活跃网卡网段 + arp 表活跃主机 + 常见端口探测 */
export async function discoverLanDevices(): Promise<AbyssDevice[]> {
  const devices: AbyssDevice[] = []
  const now = Date.now()

  // 1. 收集本机非 127.0.0.1 的 IPv4 地址（作为"看到"的局域网设备之一）
  const ifaces = networkInterfaces()
  const localIPs: string[] = []
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) localIPs.push(iface.address)
    }
  }
  for (const ip of localIPs) {
    devices.push({
      id: `lan:self:${ip}`,
      name: `本机网卡 ${ip}`,
      source: 'lan',
      kind: '局域网（本机）',
      address: ip,
      status: '本机网卡',
      discoveredAt: now,
      capabilities: [
        {
          id: 'lan',
          name: '局域网接口',
          actions: [
            {
              id: 'lan:info',
              name: '局域网接口信息',
              description: `本机 ${ip} 的局域网接口信息（无外部能力声明）。`,
              kind: 'info',
              risk: 'low'
            }
          ]
        }
      ]
    })
  }

  // 2. arp -a 枚举活跃主机（Windows）
  const arpOut = await runPowershell('arp -a', 4000)
  const arpHosts = new Map<string, string>() // ip -> mac
  for (const line of arpOut.split(/\r?\n/)) {
    const m = line.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+([0-9a-fA-F-]{17})/)
    if (m) {
      const ip = m[1]
      const mac = m[2].toUpperCase()
      if (!localIPs.includes(ip)) arpHosts.set(ip, mac)
    }
  }

  // 3. 对 arp 活跃主机探测常见端口（并联，每台最多一次探测轮）
  const probes = await Promise.all(
    [...arpHosts.entries()].map(async ([ip, mac]) => {
      const openPorts: number[] = []
      for (const port of LAN_PROBE_PORTS) {
        if (await probePort(ip, port)) openPorts.push(port)
      }
      return { ip, mac, openPorts }
    })
  )

  for (const { ip, mac, openPorts } of probes) {
    const hasService = openPorts.length > 0
    devices.push({
      id: `lan:${ip}`,
      name: hasService ? `${ip}（${openPorts.join('/')}）` : ip,
      source: 'lan',
      kind: '局域网主机',
      address: ip,
      status: hasService ? `开放端口: ${openPorts.join(', ')}` : '在线（无已知服务端口）',
      discoveredAt: now,
      capabilities: [
        {
          id: 'lan',
          name: '局域网接口',
          actions: [
            {
              id: 'lan:info',
              name: '主机信息',
              description:
                `返回局域网主机 ${ip} 的 ARP 记录（MAC ${mac}）与开放端口 ${openPorts.join(', ') || '无'}。` +
                (hasService ? '该主机可在 device_register 中声明为 HTTP 设备后由 AI 调用。' : ''),
              kind: 'info',
              risk: 'low'
            }
          ]
        }
      ]
    })
  }

  return devices
}

/** 蓝牙设备发现：Windows 已配对/已连接蓝牙设备（Get-PnpDevice -Class Bluetooth） */
export async function discoverBluetoothDevices(): Promise<AbyssDevice[]> {
  const devices: AbyssDevice[] = []
  const cmd =
    "Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue | Select-Object FriendlyName, InstanceId, Status | Format-Table -AutoSize | Out-String -Width 512"
  const out = await runPowershell(cmd, BT_CMD_TIMEOUT_MS)
  const now = Date.now()

  const seen = new Set<string>()
  const lines = out.split(/\r?\n/)
  // 解析格式："Name InstanceId Status"（FriendlyName 可能含空格，用 InstanceId 的 BTHENUM/蓝牙 MAC 锚定）
  for (const line of lines) {
    // 蓝牙 MAC 形如 xx:xx:xx:xx:xx:xx 或 BTH\DEV_XXXXXXXXXXXX
    const macMatch = line.match(/BTH(?:ENUM)?\\DEV[ _]?([0-9A-Fa-f]{12})/)
    if (!macMatch) continue
    const macHex = macMatch[1].toUpperCase()
    const mac = [
      macHex.slice(0, 2), macHex.slice(2, 4), macHex.slice(4, 6),
      macHex.slice(6, 8), macHex.slice(8, 10), macHex.slice(10, 12)
    ].join(':')
    if (seen.has(mac)) continue
    // FriendlyName 取行首到 "BTH" 之前的非空部分
    const nameStart = line.indexOf(macMatch[0])
    const friendly = line.slice(0, nameStart).trim()
    const status = line.includes('Unknown') || /Error/i.test(line.slice(nameStart)) ? '异常' : '已连接/已配对'
    seen.add(mac)
    devices.push({
      id: `bt:${mac}`,
      name: friendly || `蓝牙设备 ${mac}`,
      source: 'bluetooth',
      kind: '蓝牙设备',
      address: mac,
      status,
      discoveredAt: now,
      capabilities: [
        {
          id: 'bluetooth',
          name: '蓝牙接口',
          actions: [
            {
              id: 'bluetooth:info',
              name: '设备信息',
              description: `返回蓝牙设备 ${friendly || mac} 的地址与连接状态。只读。`,
              kind: 'info',
              risk: 'low'
            }
          ]
        }
      ]
    })
  }

  return devices
}