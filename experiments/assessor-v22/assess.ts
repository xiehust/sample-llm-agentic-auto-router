// Assessor v2.2 harness, live side: rebuilds the session-start cards of the Harbor tier passes (DeepSWE v1.1, TB 2.1)
// from their stored bodies with the router's own requestCard, and runs one assessor pack over them with the deployed
// experiment config (Luna, threshold 0.8, every rule and fact signal auto, 5 s router deadline recorded).
//
//   node experiments/assessor-v22/assess.ts --split <split.jsonl> --subset tune|heldout|all --datasets deepswe,tb21 \
//     --pack v2.1|v2.2|<pack dir> --label <name> --rep <n> --region <r> [--live] [--cap-usd 5] [--concurrency 3]
//
// Without --live: builds and checks the cards and prints counts (no model call, no network). With --live: the caller
// account must equal LLMAR_SPIKE_ACCOUNT (packages/assessor eval live transport), and every call is reserved at its
// worst case on this task's ledger (results/ledger.json, cap $5) before it is made. Rows hold codes and numbers only
// (rule ids, task facts, confidence, tier, basis, latency, cost): no card or body text is written.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { createEngine, InMemoryStateStore, validatePolicy } from '../../packages/core/src/index.ts'
import { FACT_SIGNALS, isPackName, loadPack, packDirs, renderSystem, type Pack, type TaskCard } from '../../packages/assessor/src/index.ts'
import type { EvalItem } from '../../packages/assessor/src/eval/datasets.ts'
import { runEval, type EvalResult } from '../../packages/assessor/src/eval/harness.ts'
import { Ledger } from '../../packages/assessor/src/eval/scrub.ts'
import { loadCatalog } from '../../packages/pricing/src/index.ts'
import { requestCard } from '../../packages/router/src/index.ts'

const MODEL = 'global.openai.gpt-6-luna'
const THRESHOLD = 0.8
const DEADLINE_MS = 5000          // deployed ROUTER_ASSESSOR_TIMEOUT_MS: a later answer is "none" for the router
const COVERAGE_TIMEOUT_MS = 15_000 // the call itself may run longer, so latency past the deadline is measured
const CAP_USD = 5                  // this task's ledger cap (PRD); --cap-usd may lower it, never raise it
const HERE = new URL('./', import.meta.url)
const REPO = new URL('../../', import.meta.url)
const LEDGER = new URL('results/ledger.json', HERE)
const BODIES: Record<string, URL> = {
  deepswe: new URL('experiments/deepswe-harbor/results/tierpass/bodies.jsonl', REPO),
  tb21: new URL('experiments/tbench-harbor/results/tierpass/bodies.jsonl', REPO),
}

const { values } = parseArgs({ options: {
  split: { type: 'string' }, subset: { type: 'string', default: 'tune' }, datasets: { type: 'string', default: 'deepswe,tb21' },
  pack: { type: 'string' }, label: { type: 'string' }, rep: { type: 'string' }, region: { type: 'string' },
  live: { type: 'boolean', default: false }, 'cap-usd': { type: 'string', default: String(CAP_USD) },
  concurrency: { type: 'string', default: '3' },
} })
const die = (m: string): never => { process.stderr.write(`${m}\n`); process.exit(2) }
if (!values.split || !values.pack || !values.region) die('usage: assess.ts --split <split.jsonl> --pack <name|dir> --region <r> [--subset tune|heldout|all] [--datasets ..] [--live --label <name> --rep <n>]')
const subset = values.subset as string
if (!['tune', 'heldout', 'all'].includes(subset)) die('--subset must be tune|heldout|all')
const datasets = (values.datasets as string).split(',').map((s) => s.trim()).filter(Boolean)
for (const d of datasets) if (!BODIES[d]) die(`unknown dataset ${d} (deepswe|tb21)`)

// ---- the pack, as the experiment router runs it: every enabled rule auto, every fact signal auto
const packArg = values.pack as string
const base: Pack = isPackName(packArg) ? loadPack(packDirs[packArg]) : loadPack(packArg.endsWith('/') ? packArg : `${packArg}/`)
const pack: Pack = { ...base, rules: base.rules.map((r) => ({ ...r, auto: r.enabled })) }
const packVersion = renderSystem(pack).packVersion

// ---- cards (the router's own card builder, as in the tier passes; experiment policy for the region)
const region = values.region as string
const catalog = loadCatalog(region)
const policy = validatePolicy(JSON.parse(readFileSync(new URL(`packages/router/config/policy.experiment.${region}.json`, REPO), 'utf8')))
const engine = createEngine({ policy, catalog, store: new InMemoryStateStore() })

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

/** Session start: the instruction is the first and only user turn (the tier passes' check). */
function checkCard(id: string, card: TaskCard, body: unknown): void {
  if (card.stats.turnIndex !== 0) throw new Error(`${id}: card.stats.turnIndex is ${card.stats.turnIndex}, expected 0`)
  if (card.firstUser !== undefined) throw new Error(`${id}: card.firstUser is present at session start`)
  const head = lastUserText(body).normalize('NFC').trim().slice(0, 60)
  if (head.length === 0 || !card.latestUser.text.startsWith(head)) throw new Error(`${id}: card.latestUser is not the task instruction`)
}

const split = new Map<string, string>()
for (const line of readFileSync(values.split as string, 'utf8').split('\n')) {
  if (!line.trim()) continue
  const r = JSON.parse(line) as { dataset: string; task_id: string; split: string }
  split.set(`${r.dataset}:${r.task_id}`, r.split)
}

const items: EvalItem[] = []
const counts: Record<string, number> = {}
for (const ds of datasets) {
  for (const line of readFileSync(BODIES[ds] as URL, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const { task_id: tid, body } = JSON.parse(line) as { task_id: string; body: unknown }
    const s = split.get(`${ds}:${tid}`)
    if (s === undefined) continue // not in the analysis set (excluded by the experiment's own rules)
    if (subset !== 'all' && s !== subset) continue
    const card = requestCard(engine, 'openai-responses', body, { 'x-router-session': `v22-${ds}-${tid}` })
    checkCard(`${ds}:${tid}`, card, body)
    // EvalItem's dataset/gold are the eval suite's own fields; here they carry nothing (no labels in this file).
    items.push({ id: `${ds}:${tid}`, dataset: 'hand', category: ds, gold: 'standard', card })
    counts[`${ds}:${s}`] = (counts[`${ds}:${s}`] ?? 0) + 1
  }
}
if (items.length === 0) die('no cards selected')

if (!values.live) {
  process.stdout.write(JSON.stringify({ cards: items.length, by: counts, pack: packVersion, live: false }) + '\n')
  process.exit(0)
}

// ---- live
if (!values.label || !/^[a-z0-9][a-z0-9.-]{0,39}$/.test(values.label)) die('--live needs --label <short lowercase name>')
const rep = Number(values.rep)
if (!Number.isInteger(rep) || rep < 1) die('--live needs --rep <n ≥ 1>')
const out = new URL(`results/calls/${values.label}/r${rep}-${subset}.jsonl`, HERE)
if (existsSync(out)) die(`${out.pathname} exists; pick another --rep`)
mkdirSync(dirname(out.pathname), { recursive: true })
const metaPath = new URL(`results/calls/${values.label}/meta.json`, HERE)
if (existsSync(metaPath)) {
  const m = JSON.parse(readFileSync(metaPath, 'utf8')) as { packVersion: string }
  if (m.packVersion !== packVersion) die(`label ${values.label} holds calls of ${m.packVersion}, not ${packVersion}; use a new label`)
} else {
  writeFileSync(metaPath, JSON.stringify({ label: values.label, pack: packArg, packVersion, model: MODEL, threshold: THRESHOLD,
    deadlineMs: DEADLINE_MS, autoRules: 'all', autoFacts: [...FACT_SIGNALS], mapping: pack.mapping ?? null }, null, 1) + '\n')
}
const cap = Math.min(CAP_USD, Number(values['cap-usd']))
if (!(cap > 0)) die('--cap-usd must be > 0')
const ledger = new Ledger(LEDGER.pathname, cap)
const { createLiveTransport } = await import('../../packages/assessor/src/eval/live-transport.ts')
const transport = await createLiveTransport(region) // refuses unless the caller account is LLMAR_SPIKE_ACCOUNT
writeFileSync(out, '')

const row = (r: EvalResult): Record<string, unknown> => {
  const [ds, tid] = r.itemId.split(':', 2)
  const opinion = r.status === 'ok' && r.proposedTier ? r.proposedTier : 'none'
  return {
    dataset: ds, task_id: tid, rep, label: values.label, packVersion: r.packVersion, status: r.status,
    ...(r.reason ? { reason: r.reason.split(':', 1)[0] } : {}),
    matched: r.matched ?? null, facts: r.facts ?? null, confidence: r.confidence ?? null,
    proposed: r.proposedTier ?? null, tier_at0: r.tierAt0 ?? null, outcome: r.outcome ?? null, basis: r.basis ?? [],
    latency_ms: r.latencyMs, within_deadline: r.latencyMs <= DEADLINE_MS,
    pred_untimed: opinion, pred: r.latencyMs <= DEADLINE_MS ? opinion : 'none',
    cost_usd: r.costUsd ?? null, input_tokens: r.inputTokens ?? null, cached_tokens: r.cachedTokens ?? null, output_tokens: r.outputTokens ?? null,
  }
}
const summary = await runEval({
  pack, items, model: MODEL, variant: values.label, transport, catalog, ledger,
  concurrency: Math.max(1, Math.min(8, Number(values.concurrency))), timeoutMs: COVERAGE_TIMEOUT_MS,
  config: { threshold: THRESHOLD, autoFacts: [...FACT_SIGNALS] },
  onResult: (r) => appendFileSync(out, JSON.stringify(row(r)) + '\n'),
})
ledger.flush(`v2.2 harness: ${values.label} r${rep} ${subset} (${datasets.join('+')})`)
process.stdout.write(JSON.stringify({ calls: summary.results.length, stoppedByBudget: summary.stoppedByBudget, pack: packVersion,
  out: out.pathname.split('/experiments/')[1], spentUsd: Number(ledger.spentUsd.toFixed(6)), capUsd: cap }) + '\n')
if (summary.stoppedByBudget > 0) process.exit(4)
