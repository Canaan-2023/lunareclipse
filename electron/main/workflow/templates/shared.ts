/**
 * @category Workflow
 * @summary 内置工作流模板共享常量：固定时间戳 `now`
 *
 * 为什么存在：9 个内置模板的 createdAt/updatedAt 必须引用**同一**时间戳常量，且该值必须是固定常量
 * 而非 Date.now()——这是「老数据升级 diff 为空」的前提：updatedAt 每次启动变化会触发 store.save()
 * 回写、外置 MD 的 .src 指纹漂移、升级后 verify 逐字符比对失败（ADR-08 §4 `now` 单源红线）。
 *
 * 不删理由：删掉或改为动态取值即上述漂移立刻发生；9 个模板文件只 import、禁止重声明。
 */
export const now = 1718000000000 // 固定时间戳，避免每次启动 updatedAt 变化
