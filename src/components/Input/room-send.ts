/**
 * 房间模式发送：先交给房间运行时的**第一类输入**（不触发普通 AI、不产生隐藏的第二份回复）；
 * 房间未启动（`ok:false`）才退回普通会话发送——尊重自主开关，但消息不丢。
 *
 * 为什么独立成文件：`InputArea.tsx` 在体量台账里（硬上限），这段逻辑放进去会破棘轮；
 * 且「房间消息怎么发」只应有一份实现（输入框 / 未来其它入口共用）。
 */
import { DEFAULT_AI_ID } from '@shared/types'
import { useAppStore } from '../../stores/appStore'

export async function sendRoomMessage(
  content: string,
  fallback: () => Promise<void>
): Promise<void> {
  const { currentSessionId, sessions } = useAppStore.getState()
  if (!currentSessionId) {
    await fallback()
    return
  }
  const aiId = sessions.find((s) => s.id === currentSessionId)?.aiId ?? DEFAULT_AI_ID
  const r = await window.lunareclipse?.roomUserMessage?.({
    aiId,
    sessionId: currentSessionId,
    content
  })
  if (r?.ok) {
    useAppStore.getState().appendRoomMessage(content, 'user', Date.now())
    return
  }
  await fallback()
}
