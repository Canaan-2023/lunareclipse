/**
 * RAW 来源标记（B13b）回归测试。
 *
 * 为什么存在：用户要求「标记清楚来源——局域网的好友私聊、群聊、自主模式、普通用户会话都要标清」。
 * 来源推导错一类，AI 读 RAW 时就会误判语境；且它是 §3.5「分开处理」与自主域判据的共同基础。
 *
 * 覆盖：会话 id 前缀 → 来源（八类）/ 未知与空 → user-session / 头部来源行格式 / 无来源不输出。
 */
import { describe, it, expect } from 'vitest'
import {
  sourceOfSession,
  sourceHeaderLine,
  RAW_SOURCE_LABELS,
  AUTONOMOUS_OWNER_PREFIX,
  isAutonomousOwner,
  isAutonomousSource
} from '../electron/main/services/raw-source'

describe('sourceOfSession：会话 id 前缀 → 来源', () => {
  it('局域网三类分别识别（群聊 / 好友私聊 / 公示板）', () => {
    expect(sourceOfSession('lan-chat-room-42')).toBe('lan-group')
    expect(sourceOfSession('lan-direct-chat-7')).toBe('lan-friend')
    expect(sourceOfSession('lan-direct-chat-7-2')).toBe('lan-friend')
    expect(sourceOfSession('lan-publish-board-art-1')).toBe('lan-board')
  })

  it('AI 社交 / 自主模式 / 莉莉丝 / 外部接入', () => {
    expect(sourceOfSession('ai-social-3-2')).toBe('ai-social')
    expect(sourceOfSession('room-autonomous-U1-AI1')).toBe('autonomous')
    expect(sourceOfSession('lilith-session')).toBe('lilith')
    expect(sourceOfSession('messaging-feishu-1')).toBe('messaging')
  })

  it('普通用户会话与未知/空 → user-session', () => {
    expect(sourceOfSession('sess_abc')).toBe('user-session')
    expect(sourceOfSession('')).toBe('user-session')
    expect(sourceOfSession(undefined)).toBe('user-session')
    expect(sourceOfSession(null)).toBe('user-session')
  })
})

describe('sourceHeaderLine：RAW 头部来源行', () => {
  it('有来源 → 输出可读行', () => {
    expect(sourceHeaderLine('lan-friend')).toBe(`- 来源：lan-friend（${RAW_SOURCE_LABELS['lan-friend']}）`)
  })

  it('无来源 → null（保持老文件格式兼容）', () => {
    expect(sourceHeaderLine(undefined)).toBeNull()
  })

  it('八类来源都有可读名', () => {
    const kinds = ['user-session', 'lan-friend', 'lan-group', 'lan-board', 'ai-social', 'autonomous', 'lilith', 'messaging'] as const
    for (const k of kinds) {
      expect(RAW_SOURCE_LABELS[k]).toBeTruthy()
      expect(sourceHeaderLine(k)).toContain(RAW_SOURCE_LABELS[k])
    }
  })
})

describe('自主域判据（ADR-25 支柱 3：判据用来源标记，不用路径猜）', () => {
  it('owner 前缀判据与 sourceOfSession 同源（自主会话两个判据一致）', () => {
    const owner = `${AUTONOMOUS_OWNER_PREFIX}-U1-AI2`
    expect(isAutonomousOwner(owner)).toBe(true)
    expect(sourceOfSession(owner)).toBe('autonomous')
  })

  it('非自主 owner 一律 false（含空值）', () => {
    for (const id of ['sess_abc', 'lan-chat-room-42', 'lan-direct-chat-7-2', 'ai-social-3-2', 'lilith-x', '', undefined, null]) {
      expect(isAutonomousOwner(id)).toBe(false)
    }
  })

  it('RAW 来源判据只认 autonomous', () => {
    expect(isAutonomousSource('autonomous')).toBe(true)
    for (const s of ['user-session', 'lan-friend', 'lan-group', 'lan-board', 'ai-social', 'lilith', 'messaging', undefined, null] as const) {
      expect(isAutonomousSource(s)).toBe(false)
    }
  })
})
