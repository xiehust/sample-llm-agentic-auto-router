// Claude Code × Harbor: offline tier pass (design-assessor.md §3). Rebuilds the session-start card the router builds
// from Claude Code's first main-loop request (Anthropic Messages) for every analysis task, checks it, and (with --live,
// run by the parent session only) calls the assessor with the arm-B experiment config: Luna, threshold 0.8, every rule
// and fact signal auto (ROUTER_ASSESSOR_AUTO_RULES=all), 5 s router deadline recorded.
//
//   node experiments/claude-code-harbor/tierpass.ts --bodies <bodies.jsonl> [--bodies ...] --split <split.jsonl> --pack v2.2|v2.1 \
//     --region <r> [--cards-out <cards.jsonl>] [--live --label <name> --rep <n> [--cap-usd 0.60] [--concurrency 3]]
//
// <bodies.jsonl>: one {"dataset", "task_id", "instruction_head", "body"} per line (tierpass.py bodies). Only tasks in
// <split.jsonl> (the 112 DeepSWE + 84 TB analysis tasks) are used. Every card is built and checked before any model
// call; a failing check stops the pass. Without --live nothing is called. --cards-out writes the cards (they carry task
// text: results/ only, never committed). With --live the caller account must equal LLMAR_SPIKE_ACCOUNT (the assessor
// eval live transport), and every call is reserved at its worst case on this experiment's ledger (results/ledger.json,
// cap $0.30; --cap-usd may lower it, never raise it). Call rows hold codes and numbers only, in the same schema as the
// v2.2 harness (experiments/assessor-v22/assess.ts), so they compare directly with the Codex-card calls.
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
const DEADLINE_MS = 5000           // ROUTER_ASSESSOR_TIMEOUT_MS: a later answer is "none" for the router
const COVERAGE_TIMEOUT_MS = 15_000 // the call itself may run longer, so latency past the deadline is measured
const CAP_USD = 0.3                // this experiment's tier-pass cap (0c, 2026-11-07: v2.2 only)
const PACKS = new Set(['v2.2', 'v2.1'])
const HERE = new URL('./', import.meta.url)
const REPO = new URL('../../', import.meta.url)
const LEDGER = new URL('results/ledger.json', HERE)

const { values } = parseArgs({ options: {
  bodies: { type: 'string', multiple: true }, split: { type: 'string' }, pack: { type: 'string' }, region: { type: 'string' },
  'cards-out': { type: 'string' }, live: { type: 'boolean', default: false }, label: { type: 'string' }, rep: { type: 'string' },
  'cap-usd': { type: 'string', default: String(CAP_USD) }, concurrency: { type: 'string', default: '3' },
} })
const die = (m: string): never => { process.stderr.write(`${m}\n`); process.exit(2) }
if (!values.bodies?.length || !values.split || !values.pack || !values.region) {
  die('usage: tierpass.ts --bodies <f> [--bodies ..] --split <split.jsonl> --pack v2.2|v2.1 --region <r> [--cards-out f] [--live --label <name> --rep <n>]')
}
const packArg = values.pack as string
if (!PACKS.has(packArg) || !isPackName(packArg)) die('--pack must be v2.2 or v2.1')

// ---- the pack, as the experiment router runs it: every enabled rule auto, every fact signal auto
const base: Pack = loadPack(packDirs[packArg as 'v2.2' | 'v2.1'])
const pack: Pack = { ...base, rules: base.rules.map((r) => ({ ...r, auto: r.enabled })) }
const packVersion = renderSystem(pack).packVersion

const region = values.region as string
const catalog = loadCatalog(region)
const policy = validatePolicy(JSON.parse(readFileSync(new URL(`packages/router/config/policy.experiment.${region}.json`, REPO), 'utf8')))
const engine = createEngine({ policy, catalog, store: new InMemoryStateStore() })

/** Session start (design-assessor.md §1.4): the instruction is the first and only user turn, with no reminder text. */
function checkCard(id: string, card: TaskCard, head: string): void {
  if (card.stats.turnIndex !== 0) throw new Error(`${id}: card.stats.turnIndex is ${card.stats.turnIndex}, expected 0`)
  if (card.firstUser !== undefined) throw new Error(`${id}: card.firstUser is present at session start`)
  if (card.lineage.kind !== 'root') throw new Error(`${id}: card.lineage.kind is ${card.lineage.kind}, expected root`)
  const h = head.normalize('NFC').trim().slice(0, 60)
  if (h.length === 0 || !card.latestUser.text.startsWith(h)) throw new Error(`${id}: card.latestUser is not the task instruction`)
  if (card.latestUser.text.includes('<system-reminder')) throw new Error(`${id}: card.latestUser still carries <system-reminder> text`)
}

const analysis = new Set<string>()
for (const line of readFileSync(values.split as string, 'utf8').split('\n')) {
  if (!line.trim()) continue
  const r = JSON.parse(line) as { dataset: string; task_id: string }
  analysis.add(`${r.dataset}:${r.task_id}`)
}

const items: EvalItem[] = []
const counts: Record<string, number> = {}
const seen = new Set<string>()
if (values['cards-out']) { mkdirSync(dirname(values['cards-out']), { recursive: true }); writeFileSync(values['cards-out'], '') }
for (const f of values.bodies as string[]) {
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const { dataset: ds, task_id: tid, instruction_head: head, body } = JSON.parse(line) as { dataset: string; task_id: string; instruction_head: string; body: unknown }
    const key = `${ds}:${tid}`
    if (!analysis.has(key)) continue // not in the analysis set (excluded by the experiments' own rules)
    if (seen.has(key)) die(`${key}: duplicate body`)
    seen.add(key)
    const card = requestCard(engine, 'anthropic-messages', body, { 'x-router-session': `cc-${ds}-${tid}` })
    checkCard(key, card, head)
    if (values['cards-out']) appendFileSync(values['cards-out'], JSON.stringify({ dataset: ds, task_id: tid, card }) + '\n')
    items.push({ id: key, dataset: 'hand', category: ds, gold: 'standard', card })
    counts[ds] = (counts[ds] ?? 0) + 1
  }
}
const missing = [...analysis].filter((k) => !seen.has(k))
if (items.length === 0) die('no cards selected')

if (!values.live) {
  process.stdout.write(JSON.stringify({ cards: items.length, by: counts, missing: missing.length, pack: packVersion, live: false }) + '\n')
  process.exit(0)
}

// ---- live (parent session only)
if (missing.length > 0) die(`${missing.length} analysis tasks have no body; build every dataset's bodies first`)
if (!values.label || !/^[a-z0-9][a-z0-9.-]{0,39}$/.test(values.label)) die('--live needs --label <short lowercase name>')
const rep = Number(values.rep)
if (!Number.isInteger(rep) || rep < 1) die('--live needs --rep <n ≥ 1>')
const out = new URL(`results/calls/${values.label}/r${rep}.jsonl`, HERE)
if (existsSync(out)) die(`${out.pathname} exists; pick another --rep`)
mkdirSync(dirname(out.pathname), { recursive: true })
const metaPath = new URL(`results/calls/${values.label}/meta.json`, HERE)
if (existsSync(metaPath)) {
  const m = JSON.parse(readFileSync(metaPath, 'utf8')) as { packVersion: string }
  if (m.packVersion !== packVersion) die(`label ${values.label} holds calls of ${m.packVersion}, not ${packVersion}; use a new label`)
} else {
  writeFileSync(metaPath, JSON.stringify({ label: values.label, pack: packArg, packVersion, model: MODEL, threshold: THRESHOLD,
    deadlineMs: DEADLINE_MS, autoRules: 'all', autoFacts: [...FACT_SIGNALS], dialect: 'anthropic-messages', agent: 'claude-code' }, null, 1) + '\n')
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
ledger.flush(`claude-code-harbor tier pass: ${values.label} r${rep} (${packArg})`)
process.stdout.write(JSON.stringify({ calls: summary.results.length, stoppedByBudget: summary.stoppedByBudget, pack: packVersion,
  out: out.pathname.split('/experiments/')[1], spentUsd: Number(ledger.spentUsd.toFixed(6)), capUsd: cap }) + '\n')
if (summary.stoppedByBudget > 0) process.exit(4)
