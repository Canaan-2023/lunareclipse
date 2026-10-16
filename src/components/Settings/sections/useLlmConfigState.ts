/**
 * 为什么存在：前端/后端 AI 两个 Tab 的连接测试与模型发现状态必须驻留在
 * SettingsPanel 层（子组件随 Tab 切换会卸载丢状态），故抽成 hook 持有。
 * 作用：提供 LLM 配置共享状态——连接测试/模型发现（前后端各一套）、
 * provider 切换时按槽位归档/恢复配置。
 */
import { useState, useEffect } from 'react'
import type { AppConfig, LLMProvider } from '@shared/types'
import { inferProvider } from '@shared/types'
import { useT } from '../../../i18n/useT'
import { switchLlmProfile } from './llmShared'

type SetLocal = (updater: AppConfig | ((prev: AppConfig) => AppConfig)) => void

/** 前端 AI / 后端 AI 两个 Tab 共用的连接测试与模型发现状态。
 *
 *  状态必须留在 SettingsPanel 层（经本 hook 持有）而非下放到子组件：
 *  子组件随 Tab 切换卸载重挂，状态放子组件会在切 Tab 后丢失。
 *  hook 在 SettingsPanel 内调用一次，把状态对象透传给两个 Tab 组件。 */
export function useLlmConfigState(local: AppConfig, setLocal: SetLocal, open: boolean) {
  const t = useT()
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([])
  const [newModel, setNewModel] = useState('')
  const [dmnTesting, setDmnTesting] = useState(false)
  const [dmnTestResult, setDmnTestResult] = useState<string | null>(null)
  const [dmnFetchingModels, setDmnFetchingModels] = useState(false)
  const [dmnDiscoveredModels, setDmnDiscoveredModels] = useState<string[]>([])
  const [newDmnModel, setNewDmnModel] = useState('')

  // 面板打开时清空上一次的连接测试/模型发现残留
  useEffect(() => {
    if (!open) return
    setTestResult(null)
    setNewModel('')
    setDiscoveredModels([])
    setDmnDiscoveredModels([])
    setDmnTestResult(null)
    setNewDmnModel('')
  }, [open])

  // 切换 provider 时自动填充预设 baseURL（分槽：各接入方式独立存档，切回恢复不重输）
  const switchProvider = (p: LLMProvider) => {
    setLocal((prev) => switchLlmProfile(prev, 'llm', 'llmProfiles', 'llmActiveProfile', p))
    setDiscoveredModels([])
    setTestResult(null)
  }

  // 编辑 baseURL 时同步推断 provider
  const editBaseURL = (url: string) => {
    const inferred = inferProvider(url)
    setLocal({
      ...local,
      llm: { ...local.llm, baseURL: url, provider: inferred }
    })
    setDiscoveredModels([])
  }

  // 从服务端拉取可用模型列表
  const fetchModels = async () => {
    if (!window.lunareclipse?.llmListModels) return
    setFetchingModels(true)
    setTestResult(null)
    try {
      const res = await window.lunareclipse.llmListModels(local.llm)
      if (res.ok && res.models.length > 0) {
        setDiscoveredModels(res.models)
        // 自动合并到 availableModels（去重）
        const merged = Array.from(new Set([...local.availableModels, ...res.models]))
        setLocal({ ...local, availableModels: merged })
        setTestResult(t('settings.modelsFound', { n: res.models.length }))
      } else {
        setTestResult(res.error ? t('settings.noModelsError', { error: res.error }) : t('settings.noModelsHint'))
      }
    } catch (e) {
      setTestResult(t('settings.errorMsg', { msg: (e as Error).message }))
    } finally {
      setFetchingModels(false)
    }
  }

  // 测试连接
  const handleTest = async () => {
    if (!window.lunareclipse?.llmTest) return
    setTesting(true)
    setTestResult(null)
    try {
      const res = await window.lunareclipse.llmTest(local.llm)
      if (res.ok) {
        setTestResult(t('settings.connSuccess', { n: res.models?.length ?? 0 }))
      } else {
        setTestResult(t('settings.connFail', { msg: res.error ?? '' }))
      }
    } catch (e) {
      setTestResult(t('settings.errorMsg', { msg: (e as Error).message }))
    } finally {
      setTesting(false)
    }
  }

  const addModel = () => {
    const m = newModel.trim()
    if (!m) return
    if (local.availableModels.includes(m)) {
      setNewModel('')
      return
    }
    setLocal({ ...local, availableModels: [...local.availableModels, m] })
    setNewModel('')
  }

  const removeModel = (m: string) => {
    setLocal({
      ...local,
      availableModels: local.availableModels.filter((x) => x !== m)
    })
  }

  const switchDmnProvider = (p: LLMProvider) => {
    setLocal((prev) => switchLlmProfile(prev, 'dmnLlm', 'dmnLlmProfiles', 'dmnLlmActiveProfile', p))
    setDmnDiscoveredModels([])
    setDmnTestResult(null)
  }

  const editDmnBaseUrl = (url: string) => {
    const inferred = inferProvider(url)
    setLocal({
      ...local,
      dmnLlm: { ...local.dmnLlm, baseURL: url, provider: inferred }
    })
    setDmnDiscoveredModels([])
  }

  const fetchDmnModels = async () => {
    if (!window.lunareclipse?.llmListModels) return
    setDmnFetchingModels(true)
    setDmnTestResult(null)
    try {
      const res = await window.lunareclipse.llmListModels(local.dmnLlm)
      if (res.ok && res.models.length > 0) {
        setDmnDiscoveredModels(res.models)
        // 自动合并到 dmnAvailableModels（去重），与前端 AI 模型清单分离，避免污染
        const merged = Array.from(new Set([...local.dmnAvailableModels, ...res.models]))
        setLocal({ ...local, dmnAvailableModels: merged })
        setDmnTestResult(t('settings.modelsFound', { n: res.models.length }))
      } else {
        setDmnTestResult(res.error ? t('settings.noModelsError', { error: res.error }) : t('settings.noModelsHint'))
      }
    } catch (e) {
      setDmnTestResult(t('settings.errorMsg', { msg: (e as Error).message }))
    } finally {
      setDmnFetchingModels(false)
    }
  }

  const handleDmnTest = async () => {
    if (!window.lunareclipse?.llmTest) return
    setDmnTesting(true)
    setDmnTestResult(null)
    try {
      const res = await window.lunareclipse.llmTest(local.dmnLlm)
      if (res.ok) {
        setDmnTestResult(t('settings.connSuccess', { n: res.models?.length ?? 0 }))
      } else {
        setDmnTestResult(t('settings.connFail', { msg: res.error ?? '' }))
      }
    } catch (e) {
      setDmnTestResult(t('settings.errorMsg', { msg: (e as Error).message }))
    } finally {
      setDmnTesting(false)
    }
  }

  const addDmnModel = () => {
    const m = newDmnModel.trim()
    if (!m) return
    if (local.dmnAvailableModels.includes(m)) {
      setNewDmnModel('')
      return
    }
    setLocal({ ...local, dmnAvailableModels: [...local.dmnAvailableModels, m] })
    setNewDmnModel('')
  }

  const removeDmnModel = (m: string) => {
    setLocal({
      ...local,
      dmnAvailableModels: local.dmnAvailableModels.filter((x) => x !== m)
    })
  }

  return {
    testing,
    testResult,
    fetchingModels,
    discoveredModels,
    newModel,
    setNewModel,
    dmnTesting,
    dmnTestResult,
    dmnFetchingModels,
    dmnDiscoveredModels,
    newDmnModel,
    setNewDmnModel,
    switchProvider,
    editBaseURL,
    fetchModels,
    handleTest,
    addModel,
    removeModel,
    switchDmnProvider,
    editDmnBaseUrl,
    fetchDmnModels,
    handleDmnTest,
    addDmnModel,
    removeDmnModel
  }
}

export type LlmConfigState = ReturnType<typeof useLlmConfigState>