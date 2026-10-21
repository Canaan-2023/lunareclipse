/**
 * @category LLM
 * @summary 把「会话级上下文 token 占比」接到 LLMClient（AUTO 模型热切换的特征来源）
 *
 * 为什么存在：AUTO 的判定特征之一「上下文占比」（§8.3）来自 `server.ts` 闭包里的
 * `lastInjectedEstimateRef` + 预算；而消费方是 `LLMClient`（它是工具循环的 host）。
 * 抽成本模块后，`server.ts` 只需**一行**接线（该文件在体量棘轮台账内，不得增行）。
 *
 * 不删理由：删掉即占比特征恒为 null，长会话下不会因上下文压力升级模型。
 */

interface ContextRatioSink {
  setContextRatioProvider?: (fn: (() => number | null) | null) => void
}

/**
 * 给客户端装上占比 provider 并**原样返回**（便于写成单行工厂）。
 * 占比 = min(1, 估算 token / 预算)；估算或预算不可得时返回 null（该规则不生效）。
 */
export function attachContextRatio<T extends ContextRatioSink>(
  client: T,
  getEstimate: () => number | null,
  getBudget: () => number
): T {
  client.setContextRatioProvider?.(() => {
    const est = getEstimate()
    if (est == null) return null
    const budget = getBudget()
    return budget > 0 ? Math.min(1, est / budget) : null
  })
  return client
}
