/**
 * 多模态生成 provider（OpenAI 兼容媒体端点）

 * 为什么存在：生图/生视频/生音频的供应商响应形态各异（b64/url/file），
 * 收敛为 OpenAI 兼容 generations 端点统一适配，调用方不必感知各家差异——

 * 统一调用 OpenAI 兼容的 /{endpointPath}/generations 生成接口：
 * image → /images/generations
 * video → /videos/generations
 * audio → /audio/generations

 * 兼容常见响应形态：data[].b64_json / data[].url / data[].file / b64_json 顶层 /
 * {files:[...]}（部分端点用 output/url 数组）。产物体用 Buffer 返回，由调用方落盘。
 */
export interface OpenAIMediaGenRequest {
  /** OpenAI 兼容 baseURL（如 https://api.siliconflow.cn/v1），末尾斜杠会在内部清理 */
  baseURL: string
  apiKey: string
  model: string
  /** 端点路径段：images / videos / audio（最终请求 /{endpointPath}/generations） */
  endpointPath: string
  /** 生成描述（prompt） */
  prompt: string
  /** 模态专属附加参数（size / duration / fps / negative_prompt 等透传） */
  params?: Record<string, unknown>
  /** 请求超时毫秒（默认 120000；音频/视频生成较慢） */
  timeoutMs?: number
}

/** 生成成功后的原始媒体（Buffer + 推断 mime + 兜底扩展名） */
export interface OpenAIMediaGenResult {
  buf: Buffer
  mime: string
  ext: string
}

/** 从端点路径段推断默认 mime / 扩展名 */
function defaultMimeForEndpoint(endpointPath: string): { mime: string; ext: string } {
  const p = endpointPath.toLowerCase()
  if (p.includes('video')) return { mime: 'video/mp4', ext: 'mp4' }
  if (p.includes('audio') || p.includes('voice') || p.includes('music')) return { mime: 'audio/mpeg', ext: 'mp3' }
  // 默认按图片（images/wav__? 保守：图纸/logo）
  return { mime: 'image/webp', ext: 'webp' }
}

/** 从响应中提取「首个体」：b64 字符串 或 资源下载地址；找不到返回 null */
function extractFirstRef(data: unknown): { b64?: string; url?: string } | null {
  if (data == null || typeof data !== 'object') return null
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

  // 顶层 b64_json（部分端点整体返回）
  const top = data as Record<string, unknown>
  if (typeof top.b64_json === 'string') return { b64: top.b64_json }

  // data[] / output[] / files[] 数组，取第一项
  const arr = (
    Array.isArray(top.data) ? top.data
    : Array.isArray(top.output) ? top.output
    : Array.isArray(top.files) ? top.files
    : null
  )
  if (arr && arr.length > 0 && isObj(arr[0])) {
    const item = arr[0]
    if (typeof item.b64_json === 'string') return { b64: item.b64_json }
    const urlText = typeof item.url === 'string' ? item.url : typeof item.file === 'string' ? item.file : typeof item.output === 'string' ? item.output : null
    if (urlText) return { url: urlText }
  }
  return null
}

/**
 * 调用 OpenAI 兼容媒体生成端点，返回首个体 Buffer。
 * 抛出带友好 message 的错误（未配 base64/url 等）。
 */
export async function openAIMediaGeneration(opt: OpenAIMediaGenRequest): Promise<OpenAIMediaGenResult> {
  const { mime, ext } = defaultMimeForEndpoint(opt.endpointPath)
  const baseURL = opt.baseURL.trim().replace(/\/+$/, '')
  const url = `${baseURL}/${opt.endpointPath.replace(/^\/+/, '')}/generations`

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opt.apiKey}`
    },
    body: JSON.stringify({
      model: opt.model,
      prompt: opt.prompt,
      n: 1,
      ...(opt.params ?? {})
    }),
    signal: AbortSignal.timeout(opt.timeoutMs ?? 120000)
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`${opt.endpointPath} 生成 API 错误 ${resp.status}: ${errText.slice(0, 300)}`)
  }

  const data: unknown = await resp.json().catch(() => null)
  const ref = extractFirstRef(data)
  if (!ref) {
    throw new Error(`${opt.endpointPath} 生成 API 返回空结果，未找到 b64_json/url/file 字段`)
  }

  // base64 → 直接解码
  if (ref.b64) {
    return { buf: Buffer.from(ref.b64, 'base64'), mime, ext }
  }

  // url → 回源下载（优先用响应的 content-type 推断扩展名）
  if (ref.url) {
    if (!isHttp(ref.url)) {
      // 可能是纯 b64 dataUrl
      const idx = ref.url.indexOf(',')
      const dataUrl = ref.url.startsWith('data:') && idx >= 0 ? ref.url.slice(idx + 1) : null
      if (dataUrl) return { buf: Buffer.from(dataUrl, 'base64'), mime, ext }
      throw new Error(`${opt.endpointPath} 生成 API 返回非 http 的 ${ref.url.slice(0, 60)}`)
    }
    const dl = await fetch(ref.url, { signal: AbortSignal.timeout(60000) })
    if (!dl.ok) throw new Error(`下载生成结果失败: ${dl.status}`)
    const buf = Buffer.from(await dl.arrayBuffer())
    const ctype = inferredMime(dl.headers.get('content-type') ?? mime)
    return { buf, mime: ctype, ext: extFromMime(ctype) || ext }
  }

  throw new Error(`${opt.endpointPath} 生成 API 返回无法解析的响应`)
}

function isHttp(s: string): boolean {
  return /^https?:\/\//i.test(s)
}

function inferredMime(contentType: string): string {
  return (contentType.split(';')[0] || '').trim() || 'application/octet-stream'
}

function extFromMime(contentType: string): string {
  const t = inferredMime(contentType).toLowerCase()
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg'
  }
  return map[t] ?? ''
}