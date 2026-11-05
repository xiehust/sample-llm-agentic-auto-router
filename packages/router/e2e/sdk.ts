// E2E client-compatibility calls through the deployed gateway with the official SDKs (run by e2e/run.py).
//   echo '{"gateway":"https://<gw-host>","token":"<bearer>"}' | node packages/router/e2e/sdk.ts <e1|e2|e3|messages>
// The gateway URL and the access token arrive on stdin (never argv or env). Prints one JSON line per call: status,
// x-router-* headers, served model, usage and stream facts; never the token. Prompts are our own short test prompts.
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

const input = JSON.parse(await new Response(process.stdin as unknown as ReadableStream).text() || '{}') as { gateway?: string; token?: string }
const base = input.gateway ?? ''
const token = input.token ?? ''
if (!base || !token) { console.error('stdin must carry {"gateway": ..., "token": ...}'); process.exit(2) }
const openai = new OpenAI({ apiKey: token, baseURL: `${base}/inference/v1`, maxRetries: 0, timeout: 120_000 })
const anthropic = new Anthropic({ authToken: token, apiKey: null, baseURL: `${base}/inference`, maxRetries: 0, timeout: 120_000 })
const PROMPT = 'E2E-PROMPT-MARKER: reply with the single word ok.'
const routerHeaders = (h: Headers) => Object.fromEntries([...h.entries()].filter(([k]) => k.startsWith('x-router-')))
const out = (o: Record<string, unknown>) => console.log(JSON.stringify(o))

async function guard(name: string, fn: () => Promise<Record<string, unknown>>) {
  try { out({ name, ...(await fn()) }) } catch (e) {
    const err = e as { status?: number; message?: string }
    out({ name, status: err.status ?? null, error: String(err.message ?? e).slice(0, 300) })
  }
}

async function e1() {
  await guard('chat-json', async () => {
    const { data, response } = await openai.chat.completions.create({ model: 'auto', messages: [{ role: 'user', content: PROMPT }], max_completion_tokens: 16 }).withResponse()
    return { status: response.status, headers: routerHeaders(response.headers), model: data.model, usage: data.usage }
  })
  await guard('chat-stream', async () => {
    const { data: stream, response } = await openai.chat.completions.create({ model: 'auto', messages: [{ role: 'user', content: PROMPT }], max_completion_tokens: 16, stream: true }).withResponse()
    let chunks = 0; let usageKey = false; let model = ''
    for await (const c of stream) { chunks++; model ||= c.model; if ('usage' in c && c.usage !== undefined) usageKey = true }
    return { status: response.status, headers: routerHeaders(response.headers), model, chunks, streamHasUsageKey: usageKey }
  })
}

async function e2() {
  await guard('responses-json', async () => {
    const { data, response } = await openai.responses.create({ model: 'auto', input: PROMPT, max_output_tokens: 16, store: false }).withResponse()
    return { status: response.status, headers: routerHeaders(response.headers), model: data.model, usage: data.usage }
  })
  await guard('responses-stream', async () => {
    const { data: stream, response } = await openai.responses.create({ model: 'auto', input: PROMPT, max_output_tokens: 16, store: false, stream: true }).withResponse()
    let events = 0; let usage: unknown
    for await (const ev of stream) { events++; if (ev.type === 'response.completed') usage = ev.response.usage }
    return { status: response.status, headers: routerHeaders(response.headers), events, usage }
  })
  await guard('responses-chain', async () => {
    const { data: first, response: r1 } = await openai.responses.create({ model: 'auto', input: PROMPT, max_output_tokens: 16, store: true }).withResponse()
    out({ name: 'responses-chain-first', status: r1.status, headers: routerHeaders(r1.headers), model: first.model, usage: first.usage, storedId: first.id })
    const { data, response } = await openai.responses.create({ model: 'auto', input: 'E2E-PROMPT-MARKER: again, one word.', max_output_tokens: 16, store: true, previous_response_id: first.id }).withResponse()
    return { status: response.status, headers: routerHeaders(response.headers), firstModel: first.model, model: data.model, usage: data.usage, storedId: data.id }
  })
}

async function messages() {
  await guard('messages-json', async () => {
    const { data, response } = await anthropic.messages.create({ model: 'auto', max_tokens: 16, messages: [{ role: 'user', content: PROMPT }] }).withResponse()
    return { status: response.status, headers: routerHeaders(response.headers), model: data.model, usage: data.usage }
  })
  await guard('messages-stream', async () => {
    const { data: stream, response } = await anthropic.messages.create({ model: 'auto', max_tokens: 16, messages: [{ role: 'user', content: PROMPT }], stream: true }).withResponse()
    let events = 0; let usage: unknown
    for await (const ev of stream) { events++; if (ev.type === 'message_delta') usage = ev.usage }
    return { status: response.status, headers: routerHeaders(response.headers), events, usage }
  })
}

/**
 * E3: an agent loop shaped like Claude Code: its default betas and session header, a tools array, and a transcript we
 * write ourselves. Every request carries our own synthetic assistant tool_use blocks (fixed ids and inputs) followed
 * by the user's tool_result, as a real Claude Code history looks to the router; the model's replies are recorded but
 * never fed back. So each request's turn type, and the router's decision, depends only on the request. No local tools
 * run, tool_choice stays auto (forced tool_choice is rejected with these betas), and one failed call doesn't stop the rest.
 */
const CLAUDE_CODE_BETAS = 'claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14'
const TOOLS: Anthropic.Tool[] = [
  { name: 'read_file', description: 'Read a file from the repository.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'run_tests', description: 'Run the test suite.', input_schema: { type: 'object', properties: {} } },
]
const SYSTEM = 'E2E-PROMPT-MARKER: you are a coding agent. Use one tool per turn, or answer in one short sentence.'

/** One synthetic tool round: our assistant tool_use, then the user's scripted tool_result for it. */
function toolRound(k: number): Anthropic.MessageParam[] {
  const id = `toolu_e3_${String(k).padStart(2, '0')}`
  const read = k % 2 === 0
  return [
    { role: 'assistant', content: [
      { type: 'text', text: read ? 'Reading calc.py.' : 'Running the tests.' },
      { type: 'tool_use', id, name: read ? 'read_file' : 'run_tests', input: read ? { path: 'calc.py' } : {} },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id,
      content: read ? 'def add(a, b):\n    return a - b\n' : '1 failed, 1 passed (test_add)' }] },
  ]
}

async function e3() {
  const headers = { 'anthropic-beta': CLAUDE_CODE_BETAS, 'x-claude-code-session-id': `e3-${Date.now()}` }
  const history: Anthropic.MessageParam[] = [{ role: 'user', content: 'E2E-PROMPT-MARKER: find and fix the failing test in calc.py.' }]
  // 1 session start, 5 tool-result turns, 1 user turn, 5 tool-result turns: 12 calls.
  const plan: Array<'start' | 'tool' | 'user'> = ['start', 'tool', 'tool', 'tool', 'tool', 'tool', 'user', 'tool', 'tool', 'tool', 'tool', 'tool']
  let round = 0
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i]
    if (step === 'tool') history.push(...toolRound(round++))
    if (step === 'user') history.push({ role: 'assistant', content: 'add() subtracted; changed it to return a + b, and the test passes.' },
      { role: 'user', content: 'E2E-PROMPT-MARKER: now also check mul() and keep going.' })
    const turn = step === 'tool' ? 'tool-result' : 'user'
    try {
      const { data, response } = await anthropic.messages.create({
        model: 'auto', max_tokens: 64, system: SYSTEM, tools: TOOLS, tool_choice: { type: 'auto' }, messages: history,
      }, { headers }).withResponse()
      out({ name: `e3-${i}`, turn, status: response.status, headers: routerHeaders(response.headers), model: data.model, usage: data.usage, stop: data.stop_reason })
    } catch (e) {
      const err = e as { status?: number; message?: string }
      out({ name: `e3-${i}`, turn, status: err.status ?? null, error: String(err.message ?? e).slice(0, 300) })
    }
  }
}

const which = process.argv[2]
if (which === 'e1') await e1()
else if (which === 'e2') await e2()
else if (which === 'e3') await e3()
else if (which === 'messages') await messages()
else { console.error('usage: sdk.ts <e1|e2|e3|messages>'); process.exit(2) }
