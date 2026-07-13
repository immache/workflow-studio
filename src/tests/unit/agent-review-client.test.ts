import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyTransport,
  requestOpenAiCompatibleCompletion,
  reviewTransportMessage,
  testReviewConnection,
  validateReviewEndpoint,
} from '../../domain/agent-review-client'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('agent review transport', () => {
  it('keeps valid complete endpoints unchanged and rejects unsafe URL forms', () => {
    expect(validateReviewEndpoint('https://api.example.test/v1/chat/completions?key=opaque').ok).toBe(true)
    expect(validateReviewEndpoint('https://user:pass@example.test/v1')).toEqual({ ok: false, code: 'userinfo-not-allowed' })
    expect(validateReviewEndpoint('https://example.test/v1#fragment')).toEqual({ ok: false, code: 'fragment-not-allowed' })
    expect(validateReviewEndpoint('ftp://example.test/v1')).toEqual({ ok: false, code: 'unsupported-protocol' })
    expect(classifyTransport('https:', 'http:')).toBe('mixed-content-blocked')
    expect(classifyTransport('http:', 'http:')).toBe('allowed')
  })

  it('uses only the compatible body and privacy-preserving fetch options', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' } }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await requestOpenAiCompatibleCompletion({
      endpoint: 'https://api.example.test/custom/chat',
      apiKey: 'test-key',
      model: 'review-model',
      messages: [{ role: 'user', content: 'material' }],
      timeoutMs: 1_000,
      pageProtocol: 'https:',
    })

    expect(result).toEqual({ ok: true, content: '{"ok":true}' })
    const [endpoint, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(endpoint).toBe('https://api.example.test/custom/chat')
    expect(options.credentials).toBe('omit')
    expect(options.redirect).toBe('error')
    expect(options.referrerPolicy).toBe('no-referrer')
    expect(options.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer test-key' })
    expect(JSON.parse(String(options.body))).toEqual({ model: 'review-model', messages: [{ role: 'user', content: 'material' }], stream: false })
  })

  it('does not send a request for mixed content and keeps connection testing separate from review materials', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const blocked = await requestOpenAiCompatibleCompletion({
      endpoint: 'http://api.example.test/v1/chat/completions',
      apiKey: 'test-key',
      model: 'review-model',
      messages: [{ role: 'user', content: 'secret workflow material' }],
      timeoutMs: 1_000,
      pageProtocol: 'https:',
    })
    expect(blocked).toEqual({ ok: false, code: 'mixed-content-blocked' })
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }))
    await testReviewConnection({ endpoint: 'https://api.example.test/v1/chat/completions', apiKey: 'test-key', model: 'review-model', pageProtocol: 'https:' })
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).messages).toEqual([{ role: 'user', content: '请只回复“ok”。' }])
  })

  it('returns a distinct empty-response error without rendering raw content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '   ' } }] }), { status: 200 })))
    await expect(requestOpenAiCompatibleCompletion({
      endpoint: 'https://api.example.test/v1/chat/completions',
      apiKey: 'test-key',
      model: 'review-model',
      messages: [{ role: 'user', content: 'material' }],
      timeoutMs: 1_000,
      pageProtocol: 'https:',
    })).resolves.toEqual({ ok: false, code: 'empty-response' })
  })

  it('explains a 404 as a likely missing final request path', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    await expect(requestOpenAiCompatibleCompletion({
      endpoint: 'https://api.example.test',
      apiKey: 'test-key',
      model: 'review-model',
      messages: [{ role: 'user', content: 'material' }],
      timeoutMs: 1_000,
      pageProtocol: 'https:',
    })).resolves.toEqual({ ok: false, code: 'not-found' })
    expect(reviewTransportMessage('not-found')).toContain('完整 Chat Completions 请求地址')
  })
})
