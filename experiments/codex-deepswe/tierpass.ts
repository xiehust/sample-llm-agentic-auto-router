// D2 tier pass: the session-start card the router would build for each candidate task, and (with --live) the
// assessor's observe-only opinion on it, exactly as the experiment deployment's assessor runs it.
//
//   node experiments/codex-deepswe/tierpass.ts --region <r> --bodies <bodies.jsonl> --out <tiers.jsonl> [--live] [--cap-usd 0.6]
//
// <bodies.jsonl>: one {"task_id", "body"} per line, written by `cli.py tierpass-bodies` from the captured first
// Codex request (capture.py). Every card is built and checked before any model call. Offline (default): nothing is
// called. --live: calls the assessor model on bedrock-runtime with the caller's AWS credentials (SigV4), one task at a
// time; it starts no new call once the spend so far (every billed call, invalid outputs included) has reached
// --cap-usd, so the total can pass the cap by at most one call. Each output row carries its own cost_usd, so the
// caller can charge the ledger from the file even if this process dies. Rows hold codes and numbers only.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
// Relative imports: experiments/ is not a workspace package, so the packages' own node_modules resolve their deps.
import { createEngine, InMemoryStateStore, validatePolicy } from '../../packages/core/src/index.ts'
import { createAssessor, FACT_SIGNALS, loadPack, packDirs, type TaskCard } from '../../packages/assessor/src/index.ts'
import { loadCatalog } from '../../packages/pricing/src/index.ts'
import { bedrockTransport, createSigV4Signer, requestCard } from '../../packages/router/src/index.ts'

// The router's assessor timeout to judge against (design §13: 1500 ms for the D2 pass, 5000 ms in the main run). It is
// a parameter and recorded in every row, never read from the router's code default, which changes over time. A slower
// answer is no opinion in the router. Latency here is measured from the dev box, not from the router's task.
const ASSESSOR = { model: 'global.openai.gpt-6-luna', pack: 'v2.1' as const, threshold: 0.8, coverageTimeoutMs: 15_000 }

const { values } = parseArgs({ options: {
  region: { type: 'string' }, bodies: { type: 'string' }, out: { type: 'string' }, live: { type: 'boolean', default: false },
  'cap-usd': { type: 'string', default: '0.6' }, limit: { type: 'string' }, 'deadline-ms': { type: 'string' },
} })
if (!values.region || !values.bodies || !values.out || !values['deadline-ms']) {
  process.stderr.write('usage: tierpass.ts --region <r> --deadline-ms <router assessor timeout> --bodies <in.jsonl> --out <out.jsonl> [--live] [--cap-usd N]\n')
  process.exit(2)
}
const ROUTER_DEADLINE_MS = Number(values['deadline-ms'])
if (!Number.isFinite(ROUTER_DEADLINE_MS) || ROUTER_DEADLINE_MS <= 0) { process.stderr.write('--deadline-ms must be > 0\n'); process.exit(2) }
const region = values.region
const policyFile = new URL(`../../packages/router/config/policy.experiment.${region}.json`, import.meta.url)
const catalog = loadCatalog(region)
const policy = validatePolicy(JSON.parse(readFileSync(policyFile, 'utf8')))
const engine = createEngine({ policy, catalog, store: new InMemoryStateStore() })

/** Review F/D2: for the pinned Codex the card must see our prompt as the first and only user turn. */
function checkCard(id: string, card: TaskCard): void {
  if (card.stats.turnIndex !== 0) throw new Error(`${id}: card.stats.turnIndex is ${card.stats.turnIndex}, expected 0 (a client-context block counted as a user turn?)`)
  if (card.firstUser !== undefined) throw new Error(`${id}: card.firstUser is present; expected only latestUser at session start`)
  if (!card.latestUser.text.startsWith('<issue>')) throw new Error(`${id}: card.latestUser is not the task prompt`)
}

// 1. Build and check every card first: a bad card fails the pass before anything is billed.
const lines = readFileSync(values.bodies, 'utf8').split('\n').filter((l) => l.trim())
const limit = values.limit ? Number(values.limit) : lines.length
const cards: { id: string; card: TaskCard }[] = []
for (const line of lines.slice(0, limit)) {
  const { task_id: id, body } = JSON.parse(line) as { task_id: string; body: unknown }
  const card = requestCard(engine, 'openai-responses', body, { 'x-router-session': `tierpass-${id}` })
  checkCard(id, card)
  cards.push({ id, card })
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
    task_id: id, latest_chars: card.latestUser.chars ?? card.latestUser.text.length, est_prompt_tokens: card.stats.estPromptTokens,
    tools: card.tools.total,
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
      })
    } else {
      Object.assign(row, { status: 'unavailable', reason: r.reason.split(':', 1)[0] })
    }
    // The opinion core would act on: a tier with confidence ≥ threshold. pred_tier also requires the answer within
    // the router's deadline (T1); pred_tier_untimed is the same opinion without that limit.
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
