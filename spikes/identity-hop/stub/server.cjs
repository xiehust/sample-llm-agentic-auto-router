'use strict'
// Identity spike (C1) echo stub, derived from the V9d stub: Fargate behind an internal NLB <- private REST API
// (AWS_IAM) <- AgentCore Gateway (CUSTOM_JWT). It never calls a model and holds no AWS permissions. It answers in
// the shape of the API that was called and echoes what arrived: body length and sha256, header NAMES, the values of
// x-amz*/x-amzn*/x-router-* headers with 12-digit numbers masked, and for the identity headers (x-api-key, and
// x-router-identity from the integration mapping) only {present, length, sha256_12, bearer}: never the value.
// The caller compares sha256_12 with the digest of what it sent. Nothing about the identity headers is logged.
// The model id selects the behaviour: id-echo | id-sse | id-503 (any other id, e.g. a Bedrock id routed here by a
// catch-all rule, is echoed like id-echo).
const http = require('http')
const crypto = require('crypto')

const PORT = Number(process.env.PORT || 8080)
// Loopback by default; the task definition sets HOST=0.0.0.0 (awsvpc, no published port, SG admits only the NLB SG).
const HOST = process.env.HOST || '127.0.0.1'
const SECRET = new Set(['authorization', 'x-amz-security-token', 'x-api-key', 'x-router-identity', 'cookie'])
/** Digest only: the caller already holds the value; the response carries 12 hex chars of sha256 and the length. */
/** The Authorization scheme only (e.g. AWS4-HMAC-SHA256 for the hop's SigV4, or Bearer): never credentials or signature. */
const scheme = v => typeof v === 'string' ? (/^[A-Za-z0-9-]{1,32}(?= |$)/.exec(v) || ['other'])[0] : undefined
const digest = v => v === undefined ? { present: false }
  : Array.isArray(v) ? { present: true, repeated: v.length }
  : { present: true, length: Buffer.byteLength(v), sha256_12: crypto.createHash('sha256').update(v).digest('hex').slice(0, 12), bearer: /^Bearer /i.test(v) }
const mask = v => String(v).replace(/\d{12}/g, '<acct>')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const sse = (event, data) => (event ? `event: ${event}\n` : '') + `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`

function dialectOf(path) {
  if (path.endsWith('/v1/messages')) return 'messages'
  if (path.endsWith('/v1/chat/completions')) return 'chat'
  return 'responses'
}

function full(dialect, model, text) {
  if (dialect === 'messages') return { id: 'msg_stub', type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
  if (dialect === 'chat') return { id: 'chatcmpl_stub', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
  return { id: 'resp_stub', object: 'response', status: 'completed', model, output: [{ type: 'message', id: 'msg_stub', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
}

function delta(dialect, model, text) {
  if (dialect === 'messages') return sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
  if (dialect === 'chat') return sse(null, { id: 'chatcmpl_stub', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })
  return sse('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text })
}

function last(dialect, model, text) {
  if (dialect === 'messages') return sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }) + sse('message_stop', { type: 'message_stop' })
  if (dialect === 'chat') return sse(null, { id: 'chatcmpl_stub', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + sse(null, '[DONE]')
  return sse('response.completed', { type: 'response.completed', response: full('responses', model, text) })
}

// Ticks as [delay ms before the tick]: sse = 30 x 100 ms; gapN = one tick, N s silence, one tick; longN = every 15 s for N s.
function schedule(model) {
  let m
  if ((m = /gap(\d+)/.exec(model))) return [0, Number(m[1]) * 1000]
  if ((m = /long(\d+)/.exec(model))) return Array.from({ length: Math.ceil(Number(m[1]) / 15) + 1 }, (_, i) => (i ? 15000 : 0))
  return Array.from({ length: 30 }, () => 100)
}

const echoed = n => (n.startsWith('x-amz') || n.startsWith('x-router-')) && !SECRET.has(n)
const MODELS = () => {
  const created = Math.floor(Date.now() / 1000)
  const m = { id: 'id-echo', object: 'model', type: 'model', created, created_at: new Date(created * 1000).toISOString(), display_name: 'id-echo', owned_by: 'llmar' }
  return { object: 'list', data: [m], has_more: false, first_id: m.id, last_id: m.id }
}

// Plain HTTP inside the VPC only: callers reach it through API Gateway (SigV4) -> VPC link -> internal NLB; TLS and auth end at the hop.
const server = http.createServer((req, res) => { // nosemgrep: problem-based-packs.insecure-transport.js-node.using-http-server, problem-based-packs.insecure-transport.js-node.using-http-server.using-http-server
  const t0 = Date.now()
  const path = (req.url || '/').split('?', 1)[0]
  if (req.method === 'GET' && path === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return }
  if (req.method === 'GET' && path.endsWith('/models')) {
    const names = Object.keys(req.headers).sort()
    console.log(JSON.stringify({ kind: 'models', path: req.url, headerNames: names,
      amz: Object.fromEntries(names.filter(echoed).map(n => [n, mask(req.headers[n])])), authorizationPresent: 'authorization' in req.headers }))
    req.resume()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(MODELS()))
    return
  }
  const hash = crypto.createHash('sha256')
  let len = 0
  const parts = []
  req.on('data', c => { hash.update(c); len += c.length; if (len <= 65536) parts.push(c) })
  req.on('end', async () => {
    let model = ''
    let stream = false
    try { const b = JSON.parse(Buffer.concat(parts).toString('utf8')); model = String(b.model || ''); stream = b.stream === true } catch {
      const mm = /"model"\s*:\s*"([^"]*)"/.exec(Buffer.concat(parts).toString('utf8')); model = mm ? mm[1] : ''
    }
    const names = Object.keys(req.headers).sort()
    const amz = Object.fromEntries(names.filter(echoed).map(n => [n, mask(req.headers[n])]))
    const echo = { method: req.method, path: req.url, model, len, sha256: hash.digest('hex'), headerNames: names, amz,
      authorizationPresent: 'authorization' in req.headers, authorizationScheme: scheme(req.headers.authorization), xApiKey: digest(req.headers['x-api-key']),
      xRouterIdentity: digest(req.headers['x-router-identity']), receivedAt: t0 }
    const dialect = dialectOf(req.url)
    const text = JSON.stringify(echo)
    console.log(JSON.stringify({ kind: 'request', path: req.url, model, len, stream }))
    if (model.includes('503')) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"overloaded_error","message":"stub forced 503"}}'); return }
    const headers = { 'x-router-decision': 'retain', 'x-router-model': model || 'none', 'x-stub-sha256': echo.sha256 }
    if (!stream) { res.writeHead(200, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(full(dialect, model, text))); return }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...headers })
    res.write(delta(dialect, model, text))
    let i = 0
    for (const wait of schedule(model)) {
      await sleep(wait)
      if (res.destroyed) { console.log(JSON.stringify({ kind: 'client-gone', model, tick: i, afterMs: Date.now() - t0 })); return }
      res.write(delta(dialect, model, JSON.stringify({ i: i++, ts: Date.now() })))
    }
    res.end(last(dialect, model, text))
  })
})
server.requestTimeout = 0 // long streams are the point of check 4
server.listen(PORT, HOST, () => console.log(JSON.stringify({ kind: 'listening', host: HOST, port: PORT })))
