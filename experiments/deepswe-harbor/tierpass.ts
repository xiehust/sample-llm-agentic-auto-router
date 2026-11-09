// Step 1 tier pass (design §3): the session-start card the router would build for each DeepSWE task, and (with
// --live) the assessor's opinion on it, run with the deployed experiment config (pack v2.1, Luna, threshold 0.8,
// ROUTER_ASSESSOR_AUTO_RULES=all). Adapted from experiments/codex-deepswe/tierpass.ts (duplicated rather than shared:
// that file's card check is R2E-specific and its owner keeps it frozen for the R2E report).
//
//   node experiments/deepswe-harbor/tierpass.ts --region <r> --deadline-ms 5000 --bodies <bodies.jsonl> --out <tiers.jsonl> \
//     [--live --expect-account-env LLMAR_SPIKE_ACCOUNT] [--cap-usd 0.45]
//
// <bodies.jsonl>: one {"task_id", "body"} per line, written by `tierpass.py bodies`. Every card is built and checked
// before any model call. Offline (default): nothing is called. --live: first checks with STS that the caller's
// credentials belong to the account named by the env var (the id is never printed), then calls the assessor model on
// bedrock-runtime (SigV4), one task at a time; no new call starts once the spend so far (every billed call, invalid
// outputs included) has reached --cap-usd, so the total passes the cap by at most one call. Each row carries its own
// cost_usd, so the caller charges the ledger from the file even if this process dies. Rows hold codes and numbers only.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'
// Relative imports: experiments/ is not a workspace package, so the packages' own node_modules resolve their deps.
import { createEngine, InMemoryStateStore, validatePolicy } from '../../packages/core/src/index.ts'
import { createAssessor, FACT_SIGNALS, loadPack, packDirs, type TaskCard } from '../../packages/assessor/src/index.ts'
import { loadCatalog } from '../../packages/pricing/src/index.ts'
import { bedrockTransport, createSigV4Signer, requestCard } from '../../packages/router/src/index.ts'

// The deployed experiment assessor (infra context: assessorMode=auto, assessorAutoRules=all, assessorTimeoutMs=5000).
// The call itself gets a longer coverage timeout so the latency distribution past the router's deadline is measured;
// pred_tier applies the deadline. Latency is measured from the dev box, not from the router's task.
const ASSESSOR = { model: 'global.openai.gpt-6-luna', pack: 'v2.1' as const, threshold: 0.8, coverageTimeoutMs: 15_000 }

const { values } = parseArgs({ options: {
  region: { type: 'string' }, bodies: { type: 'string' }, out: { type: 'string' }, live: { type: 'boolean', default: false },
  'cap-usd': { type: 'string', default: '0.45' }, limit: { type: 'string' }, 'deadline-ms': { type: 'string' },
  'expect-account-env': { type: 'string' },
} })
if (!values.region || !values.bodies || !values.out || !values['deadline-ms']) {
  process.stderr.write('usage: tierpass.ts --region <r> --deadline-ms <ms> --bodies <in.jsonl> --out <out.jsonl> [--live --expect-account-env VAR] [--cap-usd N]\n')
  process.exit(2)
}
const ROUTER_DEADLINE_MS = Number(values['deadline-ms'])
if (!Number.isFinite(ROUTER_DEADLINE_MS) || ROUTER_DEADLINE_MS <= 0) { process.stderr.write('--deadline-ms must be > 0\n'); process.exit(2) }
const region = values.region
const policyFile = new URL(`../../packages/router/config/policy.experiment.${region}.json`, import.meta.url)
const catalog = loadCatalog(region)
const policy = validatePolicy(JSON.parse(readFileSync(policyFile, 'utf8')))
const engine = createEngine({ policy, catalog, store: new InMemoryStateStore() })

/** The text of the last user message in a Responses body (Harbor's Codex sends the instruction as that message). */
function lastUserText(body: unknown): string {
  const input = (body as { input?: unknown }).input
  if (!Array.isArray(input)) throw new Error('body.input is not an array')
  for (let i = input.length - 1; i >= 0; i--) {
    const it = input[i] as { type?: unknown; role?: unknown; content?: unknown }
    if (it.type === 'message' && it.role === 'user' && Array.isArray(it.content)) {
      return it.content.map((c) => (c as { text?: unknown }).text).filter((t): t is string => typeof t === 'string').join('\n')
    }
  }
  throw new Error('body has no user message')
}

/** At session start the card must see the task instruction as the first and only user turn (client context filtered). */
function checkCard(id: string, card: TaskCard, body: unknown): void {
  if (card.stats.turnIndex !== 0) throw new Error(`${id}: card.stats.turnIndex is ${card.stats.turnIndex}, expected 0 (a client-context block counted as a user turn?)`)
  if (card.firstUser !== undefined) throw new Error(`${id}: card.firstUser is present; expected only latestUser at session start`)
  const head = lastUserText(body).normalize('NFC').trim().slice(0, 60)
  if (head.length === 0 || !card.latestUser.text.startsWith(head)) throw new Error(`${id}: card.latestUser is not the task instruction`)
}

/** STS GetCallerIdentity with the default credential chain (the one the assessor transport uses); true on a match. */
async function accountMatches(envName: string): Promise<boolean> {
  const want = process.env[envName]
  if (!want || !/^\d{12}$/.test(want)) throw new Error(`${envName} is not set to an account id`)
  const req = createRequire(new URL('../../packages/router/package.json', import.meta.url))
  const { SignatureV4 } = req('@smithy/signature-v4') as typeof import('@smithy/signature-v4')
  const { HttpRequest } = req('@smithy/protocol-http') as typeof import('@smithy/protocol-http')
  const { Sha256 } = req('@aws-crypto/sha256-js') as typeof import('@aws-crypto/sha256-js')
  const { defaultProvider } = req('@aws-sdk/credential-provider-node') as typeof import('@aws-sdk/credential-provider-node')
  const host = `sts.${region}.amazonaws.com`
  const body = 'Action=GetCallerIdentity&Version=2011-06-15'
  const sig = new SignatureV4({ service: 'sts', region, credentials: defaultProvider(), sha256: Sha256 })
  const signed = await sig.sign(new HttpRequest({ method: 'POST', protocol: 'https:', hostname: host, path: '/',
    headers: { host, 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, body }))
  const res = await fetch(`https://${host}/`, { method: 'POST', headers: signed.headers as Record<string, string>, body })
  if (!res.ok) throw new Error(`STS GetCallerIdentity failed: HTTP ${res.status}`)
  const m = /<Account>(\d{12})<\/Account>/.exec(await res.text())
  return m !== null && m[1] === want
}

// 1. Build and check every card first: a bad card fails the pass before anything is billed.
const lines = readFileSync(values.bodies, 'utf8').split('\n').filter((l) => l.trim())
const limit = values.limit ? Number(values.limit) : lines.length
const cards: { id: string; card: TaskCard }[] = []
for (const line of lines.slice(0, limit)) {
  const { task_id: id, body } = JSON.parse(line) as { task_id: string; body: unknown }
  const card = requestCard(engine, 'openai-responses', body, { 'x-router-session': `tierpass-${id}` })
  checkCard(id, card, body)
  cards.push({ id, card })
}

if (values.live) {
  if (!values['expect-account-env']) { process.stderr.write('--live needs --expect-account-env\n'); process.exit(2) }
  if (!(await accountMatches(values['expect-account-env']))) {
    process.stderr.write(`refusing: the caller's credentials are not in the account named by ${values['expect-account-env']}\n`)
    process.exit(3)
  }
}

const cap = Number(values['cap-usd'])
writeFileSync(values.out, '')
const pack = loadPack(packDirs[ASSESSOR.pack])
// ROUTER_ASSESSOR_AUTO_RULES=all, as in the experiment deployment: every enabled rule and fact signal may act.
const allPack = { ...pack, rules: pack.rules.map((r) => ({ ...r, auto: r.enabled })) }
// Spend is counted from onCall, which also reports calls whose output was invalid (billed, but no 'ok' result).
let spent = 0
let callCost = 0
const assessor = values.live
  ? createAssessor({
      model: ASSESSOR.model, catalog, pack: allPack, threshold: ASSESSOR.threshold, timeoutMs: ASSESSOR.coverageTimeoutMs,
      autoFacts: [...FACT_SIGNALS],
      transport: bedrockTransport(new URL(`https://bedrock-runtime.${region}.amazonaws.com`), createSigV4Signer(region)),
      onCall: (info) => { callCost += info.costUsd ?? 0 },
    })
  : undefined

// 2. Assess (live) or just record the card stats (offline).
let n = 0
let stopped: string | undefined
for (const { id, card } of cards) {
  const row: Record<string, unknown> = {
    task_id: id, latest_chars: card.latestUser.chars ?? card.latestUser.text.length, latest_truncated: card.latestUser.chars !== undefined,
    est_prompt_tokens: card.stats.estPromptTokens, tools: card.tools.total,
  }
  if (assessor) {
    if (spent >= cap) { stopped = `assessor spend $${spent.toFixed(4)} reached the $${cap} cap after ${n} tasks`; break }
    callCost = 0
    const r = await assessor.assess(card, AbortSignal.timeout(ASSESSOR.coverageTimeoutMs + 5_000))
    spent += callCost
    row.cost_usd = Number(callCost.toFixed(8))
    row.latency_ms = r.latencyMs
    if (r.status === 'ok') {
      const a = r.audit as Record<string, unknown>
      Object.assign(row, {
        status: 'ok', tier: r.tier ?? null, confidence: r.confidence, proposed: typeof a.proposedTier === 'string' ? a.proposedTier : null,
        outcome: typeof a.outcome === 'string' ? a.outcome : null,
        basis: Array.isArray(a.basis) ? a.basis.filter((b): b is string => typeof b === 'string' && /^[a-z0-9][a-z0-9:+_.-]{0,59}$/.test(b)) : [],
      })
    } else {
      Object.assign(row, { status: 'unavailable', reason: r.reason.split(':', 1)[0] })
    }
    // The opinion core would act on: a tier with confidence ≥ threshold. pred_tier also requires the answer within
    // the router's deadline; pred_tier_untimed is the same opinion without that limit.
    const opinion = row.status === 'ok' && row.tier && (row.confidence as number) >= ASSESSOR.threshold ? row.tier : 'none'
    row.pred_tier_untimed = opinion
    row.pred_tier = r.latencyMs <= ROUTER_DEADLINE_MS ? opinion : 'none'
    row.within_router_deadline = r.latencyMs <= ROUTER_DEADLINE_MS
    row.deadline_ms = ROUTER_DEADLINE_MS
  }
  appendFileSync(values.out, JSON.stringify(row) + '\n')
  n++
}
if (stopped) process.stderr.write(`stopping: ${stopped}\n`)
process.stdout.write(JSON.stringify({ tasks: n, cards: cards.length, live: !!assessor, spent_usd: Number(spent.toFixed(6)),
  router_deadline_ms: ROUTER_DEADLINE_MS, stopped: stopped ?? null }) + '\n')
