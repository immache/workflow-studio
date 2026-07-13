import { REVIEW_RESPONSE_BYTE_LIMIT, type ReviewMessage } from './agent-review'

export type EndpointValidationError = 'invalid-url' | 'unsupported-protocol' | 'userinfo-not-allowed' | 'fragment-not-allowed'
export type ReviewTransportError = EndpointValidationError
  | 'mixed-content-blocked'
  | 'invalid-configuration'
  | 'canceled'
  | 'timeout'
  | 'network'
  | 'unauthorized'
  | 'rate-limited'
  | 'not-found'
  | 'server-error'
  | 'http-error'
  | 'empty-response'
  | 'invalid-response'
  | 'response-too-large'

export type RequestStage = 'connecting' | 'sending' | 'waiting' | 'validating'

export type ReviewTransportResult =
  | { ok: true; content: string }
  | { ok: false; code: ReviewTransportError }

export function validateReviewEndpoint(value: string): { ok: true; endpoint: URL } | { ok: false; code: EndpointValidationError } {
  if (!value.trim()) return { ok: false, code: 'invalid-url' }
  if (value.includes('#')) return { ok: false, code: 'fragment-not-allowed' }
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    return { ok: false, code: 'invalid-url' }
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)) return { ok: false, code: 'unsupported-protocol' }
  if (endpoint.username || endpoint.password) return { ok: false, code: 'userinfo-not-allowed' }
  return { ok: true, endpoint }
}

export function classifyTransport(pageProtocol: string, endpointProtocol: string): 'allowed' | 'mixed-content-blocked' {
  return pageProtocol === 'https:' && endpointProtocol === 'http:' ? 'mixed-content-blocked' : 'allowed'
}

function errorForStatus(status: number): ReviewTransportError {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 429) return 'rate-limited'
  if (status === 404) return 'not-found'
  if (status >= 500) return 'server-error'
  return 'http-error'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function contentFromResponse(text: string): { kind: 'content'; content: string } | { kind: 'empty' | 'invalid' } {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { kind: 'invalid' }
  }
  if (!isRecord(body) || !Array.isArray(body.choices) || !isRecord(body.choices[0])) return { kind: 'invalid' }
  const message = body.choices[0].message
  if (!isRecord(message) || typeof message.content !== 'string') return { kind: 'invalid' }
  return message.content.trim() ? { kind: 'content', content: message.content } : { kind: 'empty' }
}

class ResponseLimitError extends Error {}

async function readLimitedBody(response: Response, controller: AbortController): Promise<string> {
  if (!response.body) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > REVIEW_RESPONSE_BYTE_LIMIT) throw new ResponseLimitError()
    return text
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > REVIEW_RESPONSE_BYTE_LIMIT) {
        controller.abort()
        throw new ResponseLimitError()
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

export async function requestOpenAiCompatibleCompletion(input: {
  endpoint: string
  apiKey: string
  model: string
  messages: ReviewMessage[]
  timeoutMs: number
  pageProtocol: string
  signal?: AbortSignal
  onStage?: (stage: RequestStage) => void
}): Promise<ReviewTransportResult> {
  const endpointResult = validateReviewEndpoint(input.endpoint)
  if (!endpointResult.ok) return endpointResult
  if (!input.apiKey || !input.model.trim() || !input.messages.length) return { ok: false, code: 'invalid-configuration' }
  if (classifyTransport(input.pageProtocol, endpointResult.endpoint.protocol) === 'mixed-content-blocked') {
    return { ok: false, code: 'mixed-content-blocked' }
  }

  const controller = new AbortController()
  let timedOut = false
  const abortFromCaller = () => controller.abort()
  input.signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timeout = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, input.timeoutMs)

  try {
    input.onStage?.('connecting')
    input.onStage?.('sending')
    const response = await fetch(input.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({ model: input.model, messages: input.messages, stream: false }),
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    })
    if (!response.ok) return { ok: false, code: errorForStatus(response.status) }
    input.onStage?.('waiting')
    input.onStage?.('validating')
    const content = contentFromResponse(await readLimitedBody(response, controller))
    return content.kind === 'content' ? { ok: true, content: content.content } : { ok: false, code: content.kind === 'empty' ? 'empty-response' : 'invalid-response' }
  } catch (error) {
    if (error instanceof ResponseLimitError) return { ok: false, code: 'response-too-large' }
    if (timedOut) return { ok: false, code: 'timeout' }
    if (input.signal?.aborted || controller.signal.aborted) return { ok: false, code: 'canceled' }
    return { ok: false, code: 'network' }
  } finally {
    window.clearTimeout(timeout)
    input.signal?.removeEventListener('abort', abortFromCaller)
  }
}

export async function testReviewConnection(input: Omit<Parameters<typeof requestOpenAiCompatibleCompletion>[0], 'messages' | 'timeoutMs'>): Promise<ReviewTransportResult> {
  return requestOpenAiCompatibleCompletion({
    ...input,
    timeoutMs: 60_000,
    messages: [{ role: 'user', content: '请只回复“ok”。' }],
  })
}

export function reviewTransportMessage(code: ReviewTransportError): string {
  const messages: Record<ReviewTransportError, string> = {
    'invalid-url': '请输入完整的 HTTP 或 HTTPS 请求地址。',
    'unsupported-protocol': '请求地址只支持 HTTP 或 HTTPS。',
    'userinfo-not-allowed': '请求地址不能包含用户名或密码。',
    'fragment-not-allowed': '请求地址不能包含未编码的 # 片段。',
    'mixed-content-blocked': '当前 HTTPS 页面不能向 HTTP 地址发送请求，浏览器无法绕过这项限制。',
    'invalid-configuration': '请补全请求地址、模型名和 API Key。',
    canceled: '浏览器已停止等待；服务商仍可能继续处理并产生费用。',
    timeout: '等待超时。你可以检查服务商状态后再次尝试。',
    network: '浏览器无法访问该服务。请检查网络、CORS 和服务兼容性。',
    unauthorized: '服务拒绝了认证。请检查 API Key、模型名或权限。',
    'rate-limited': '服务暂时限制了请求。请稍后重试。',
    'not-found': '服务返回 404。请确认填写的是服务商提供的完整 Chat Completions 请求地址，而不是服务根地址。',
    'server-error': '服务暂时出错。请稍后重试。',
    'http-error': '服务返回了无法完成审查的状态。',
    'empty-response': '服务没有返回可读取的内容。',
    'invalid-response': '服务返回的内容不符合兼容接口要求。',
    'response-too-large': '返回内容超过本地安全读取上限，浏览器已停止读取。',
  }
  return messages[code]
}
