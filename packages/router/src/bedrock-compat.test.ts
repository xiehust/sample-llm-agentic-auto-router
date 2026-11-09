// Bedrock compatibility for Claude Code requests (bedrock-compat.ts; 0c's shape probe 2026-11-07).
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { BEDROCK_BETA_STRIP, sanitizeMetadata, stripBetas, USER_ID_SAFE } from './bedrock-compat.ts'
import { fixture, HAIKU, hopHeaders, LUNA, startFakeBedrock, startRouter, waitForLogs } from './test-helpers.ts'

const CC_BETAS = 'claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,per-turn-control-2026-07-01,'
  + 'mid-conversation-tool-changes-2026-07-01,thinking-token-count-2026-05-13,advanced-tool-use-2025-11-20,effort-2025-11-24,thinking-display-updates-2026-08-18'
const CC_USER_ID = JSON.stringify({ device_id: 'ab'.repeat(32), account_uuid: '', session_id: '00000000-0000-4000-8000-000000000000' })
const TOOLS = '[{"name":"Bash","description":"Runs a command.  ☕","input_schema":{"type":"object","properties":{"command":{"type":"string"}}},"defer_loading":true}]'
const ccBody = (userId: string | null, model = 'auto') =>
  `{"model":"${model}", "max_tokens":128000,"tools":${TOOLS},"messages":[{"role":"user","content":"caf\\u00e9"}]`
  + (userId === null ? '' : `,"metadata":{"user_id":${JSON.stringify(userId)}}`) + `,"stream":false}`

describe('stripBetas / sanitizeMetadata (unit)', () => {
  it('strips only listed betas, keeps the order of the rest, and returns the same string when nothing is listed', () => {
    const r = stripBetas(CC_BETAS)
    expect(r.stripped).toEqual(['advanced-tool-use-2025-11-20'])
    expect(r.header).toBe(CC_BETAS.split(',').filter((b) => b !== 'advanced-tool-use-2025-11-20').join(','))
    const clean = 'claude-code-20250219, interleaved-thinking-2025-05-14'
    expect(stripBetas(clean)).toEqual({ header: clean, stripped: [] })
    expect(stripBetas('advanced-tool-use-2025-11-20')).toEqual({ header: undefined, stripped: ['advanced-tool-use-2025-11-20'] })
    expect(stripBetas(undefined)).toEqual({ header: undefined, stripped: [] })
    expect(BEDROCK_BETA_STRIP).toContain('advanced-tool-use-2025-11-20')
  })

  it('replaces an unsafe user_id by its sha256 hex, re-splicing only metadata; a safe one is the same buffer', () => {
    const raw = Buffer.from(ccBody(CC_USER_ID))
    const r = sanitizeMetadata(raw, JSON.parse(raw.toString()))
    expect(r.edited).toBe(true)
    const out = JSON.parse(r.body.toString())
    expect(out.metadata.user_id).toBe(createHash('sha256').update(CC_USER_ID, 'utf8').digest('hex'))
    expect(USER_ID_SAFE.test(out.metadata.user_id)).toBe(true)
    // every byte before "metadata" is unchanged (tools and messages untouched)
    const cut = raw.indexOf('"metadata"')
    expect(r.body.subarray(0, cut).equals(raw.subarray(0, cut))).toBe(true)
    for (const safe of ['user-123', 'ab'.repeat(32)]) {
      const b = Buffer.from(ccBody(safe))
      expect(sanitizeMetadata(b, JSON.parse(b.toString())).body).toBe(b)
    }
    const none = Buffer.from(ccBody(null))
    expect(sanitizeMetadata(none, JSON.parse(none.toString())).body).toBe(none)
  })
})

describe('router: Bedrock compatibility on /v1/messages', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { while (cleanups.length) await (cleanups.pop() as () => Promise<void>)() })
  async function setup() {
    const text = fixture('anthropic-messages/nonstream-read.json')
    const fake = await startFakeBedrock(() => ({ chunks: [text] }))
    const router = await startRouter(fake.url)
    cleanups.push(fake.close, router.close)
    return { fake, router }
  }
  const post = (url: string, path: string, body: string, headers: Record<string, string>) =>
    fetch(url + path, { method: 'POST', body, headers: { 'content-type': 'application/json', ...hopHeaders(), ...headers } })

  it("Claude Code 2.1.318's request: the beta is dropped from the header, user_id hashed, tools bytes unchanged, logged", async () => {
    const { fake, router } = await setup()
    const sent = ccBody(CC_USER_ID, HAIKU)
    const res = await post(router.url, '/v1/messages?beta=true', sent, { 'anthropic-beta': CC_BETAS, 'anthropic-version': '2023-06-01' })
    expect(res.status).toBe(200)
    const up = fake.requests[0]!
    expect(up.path).toBe('/anthropic/v1/messages')
    expect(up.headers['anthropic-beta']).toBe(stripBetas(CC_BETAS).header)
    expect(up.body).toContain(`"tools":${TOOLS}`)
    expect(up.json.metadata).toEqual({ user_id: createHash('sha256').update(CC_USER_ID, 'utf8').digest('hex') })
    await waitForLogs(router, 1)
    expect(router.logs[0]?.sanitized).toEqual(['user_id', 'beta:advanced-tool-use-2025-11-20'])
  })

  it('a request with nothing to fix is forwarded byte-identical (body and anthropic-beta), with no sanitized field', async () => {
    const { fake, router } = await setup()
    const betas = 'claude-code-20250219,interleaved-thinking-2025-05-14'
    const sent = ccBody('ab'.repeat(32), HAIKU)
    await (await post(router.url, '/v1/messages', sent, { 'anthropic-beta': betas })).text()
    expect(fake.requests[0]?.body).toBe(sent)
    expect(fake.requests[0]?.headers['anthropic-beta']).toBe(betas)
    await waitForLogs(router, 1)
    expect(router.logs[0]?.sanitized).toBeUndefined()
  })

  it('OpenAI paths are untouched: no beta strip, no metadata edit', async () => {
    const text = fixture('openai-responses/nonstream-read.json')
    const fake = await startFakeBedrock(() => ({ chunks: [text] }))
    const router = await startRouter(fake.url)
    cleanups.push(fake.close, router.close)
    const sent = `{"input":"hi","model":"${LUNA}","metadata":{"user_id":${JSON.stringify(CC_USER_ID)}},"store":false}`
    await (await post(router.url, '/v1/responses', sent, { 'openai-beta': 'advanced-tool-use-2025-11-20' })).text()
    expect(fake.requests[0]?.body).toBe(sent)
    expect(fake.requests[0]?.headers['openai-beta']).toBe('advanced-tool-use-2025-11-20')
    await waitForLogs(router, 1)
    expect(router.logs[0]?.sanitized).toBeUndefined()
  })
})
