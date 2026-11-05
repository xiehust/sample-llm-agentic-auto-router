'use strict'
// Echo stub for the AgentCore Gateway front-door spike. It never calls a model and holds no
// model permissions: it records what the gateway forwarded and answers in the shape of the API
// that was called (Anthropic Messages, OpenAI Chat Completions, OpenAI Responses).
const crypto = require('crypto')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const sse = (event, data) => (event ? `event: ${event}\n` : '') + `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`

const SECRET_HEADERS = new Set(['authorization', 'x-amz-security-token', 'x-api-key', 'cookie'])
// Never log or echo credentials: keep the header name, drop the value.
const redact = headers => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, SECRET_HEADERS.has(k.toLowerCase()) ? '<redacted>' : v]))

function dialectOf(path) {
  if (/\/v1\/messages$/.test(path)) return 'messages'
  if (/\/v1\/chat\/completions$/.test(path)) return 'chat'
  if (/\/v1\/responses(\/|$)/.test(path)) return 'responses'
  return 'other'
}

function fullBody(dialect, model, text, id) {
  if (dialect === 'messages') {
    return { id: 'msg_stub', type: 'message', role: 'assistant', model, content: [{ type: 'text', text }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
  }
  if (dialect === 'chat') {
    return { id: 'chatcmpl_stub', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
  }
  if (dialect === 'responses') {
    return { id: id || 'resp_stub', object: 'response', status: 'completed', model,
      output: [{ type: 'message', id: 'msg_stub', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
  }
  return { echo: JSON.parse(text) }
}

// Yields strings, or functions that render a chunk at send time (so it carries the send timestamp).
function* streamEvents(dialect, model, text, chunks) {
  const tick = i => JSON.stringify({ i, ts: Date.now() })
  if (dialect === 'messages') {
    yield sse('message_start', { type: 'message_start', message: { id: 'msg_stub', type: 'message', role: 'assistant',
      model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
    yield sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    yield sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
    for (let i = 0; i < chunks; i++) {
      yield () => sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: tick(i) } })
    }
    yield sse('content_block_stop', { type: 'content_block_stop', index: 0 })
    yield sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: chunks + 1 } })
    yield sse('message_stop', { type: 'message_stop' })
    return
  }
  if (dialect === 'chat') {
    const chunk = content => ({ id: 'chatcmpl_stub', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }] })
    yield sse(null, chunk(text))
    for (let i = 0; i < chunks; i++) yield () => sse(null, chunk(tick(i)))
    yield sse(null, { id: 'chatcmpl_stub', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: chunks + 1, total_tokens: chunks + 2 } })
    yield sse(null, '[DONE]')
    return
  }
  yield sse('response.created', { type: 'response.created', response: { id: 'resp_stub', object: 'response', status: 'in_progress', model } })
  yield sse('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text })
  for (let i = 0; i < chunks; i++) {
    yield () => sse('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: tick(i) })
  }
  yield sse('response.completed', { type: 'response.completed', response: fullBody('responses', model, text) })
}

exports.handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const http = (event.requestContext && event.requestContext.http) || {}
  const method = http.method || 'POST'
  const path = event.rawPath || '/'
  const raw = event.body ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8') : Buffer.alloc(0)
  const sha256 = crypto.createHash('sha256').update(raw).digest('hex')
  let body = {}
  try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {} } catch (e) { body = { parseError: String(e) } }
  const model = typeof body.model === 'string' ? body.model : ''
  const meta = {
    method, path, query: event.rawQueryString || '', len: raw.length, sha256, model,
    bodyKeys: Object.keys(body), headers: redact(event.headers || {}),
    caller: (event.requestContext && event.requestContext.authorizer) || null,
    receivedAt: Date.now(),
  }
  console.log(JSON.stringify({ kind: 'request', ...meta }))

  const dialect = dialectOf(path)
  const streaming = method === 'POST' && body.stream === true
  const failing = model.includes('503')
  const out = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: failing ? 503 : 200,
    headers: {
      'content-type': streaming && !failing ? 'text/event-stream' : 'application/json',
      'x-router-decision': 'retain', 'x-router-model': model || 'none',
      'x-stub-sha256': sha256, 'x-stub-unlisted': 'yes',
    },
  })
  const text = JSON.stringify(meta)
  if (failing) {
    out.write(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'stub forced 503' } }))
  } else if (method === 'DELETE') {
    out.write(JSON.stringify({ id: path.split('/').pop(), object: 'response.deleted', deleted: true, echo: meta }))
  } else if (method === 'GET') {
    out.write(JSON.stringify(fullBody(dialect, model, text, path.split('/').pop())))
  } else if (!streaming) {
    out.write(JSON.stringify(fullBody(dialect, model, text)))
  } else {
    for (const ev of streamEvents(dialect, model, text, 10)) {
      if (typeof ev === 'function') { await sleep(100); out.write(ev()) } else out.write(ev)
    }
  }
  out.end()
})
