#!/usr/bin/env node
// @auto-router/replay CLI. Runs on Node 24 with native TS type stripping (no build step).
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { convertTraceLab, isTraceLabSession, TRACELAB_ATTRIBUTION } from './adapters/tracelab.ts'
import { CORE_IS_STUB, type PriceCatalog } from './deps.ts'
import { selectCatalog } from './catalog-select.ts'
import { allPolicies, POLICY_NAMES } from './policies/index.ts'
import { DEFAULT_POOLS, type Pools } from './pools.ts'
import { runReplay } from './replayer.ts'
import { buildReport, renderMarkdown } from './report.ts'
import type { SimConfig } from './sim.ts'
import { agentSessions, breakEvenCalls, SYNTH_SOURCES } from './synth.ts'
import { renderSweep, runSweep } from './sweep.ts'
import { readTrace, writeJsonLines } from './trace-io.ts'

const USAGE = `usage:
  replay replay  --trace <file> [--policy <name|all>[,<name>...]] [--region <r>] [--catalog <file>] [--sim <file>] [--pools <file>]
                 [--hints none|cooperative] [--provider claude|codex] [--sessions N] [--out <report.json>] [--md <report.md>]
  replay convert tracelab <in.jsonl.gz> <out.replay.jsonl>
  replay synth   agent|breakeven <out.replay.jsonl> [--sessions N] [--seed N] [--alt-share 0..1 --pair standard-fast]
  replay sweep   [--region <r>] [--catalog <file>] [--sessions N] [--seed N] [--hints none|cooperative] [--out <sweep.json>] [--md <sweep.md>]
policies: ${POLICY_NAMES.join(', ')}`

const readJson = async (p: string): Promise<unknown> => JSON.parse(await readFile(p, 'utf8'))

async function sha256(path: string): Promise<string> {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer)
  return h.digest('hex')
}

async function cmdReplay(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      trace: { type: 'string' }, policy: { type: 'string', default: 'all' }, catalog: { type: 'string' }, region: { type: 'string' }, sim: { type: 'string' },
      pools: { type: 'string' }, hints: { type: 'string', default: 'none' }, provider: { type: 'string' }, sessions: { type: 'string' },
      out: { type: 'string' }, md: { type: 'string' },
    },
  })
  if (!values.trace) throw new Error(USAGE)
  const catalog: PriceCatalog = selectCatalog({ ...(values.region ? { region: values.region } : {}), ...(values.catalog ? { catalogJson: await readJson(values.catalog) } : {}) })
  const sim = (values.sim ? await readJson(values.sim) : {}) as SimConfig
  const pools = (values.pools ? await readJson(values.pools) : DEFAULT_POOLS) as Pools
  if (values.hints !== 'none' && values.hints !== 'cooperative') throw new Error(`--hints: none|cooperative, got '${values.hints}'`)
  const hints = values.hints
  const names = values.policy === 'all' ? POLICY_NAMES : values.policy!.split(',')
  const policies = allPolicies(names, { catalog, hints })
  const dialect = values.provider === 'claude' ? 'anthropic-messages' : values.provider === 'codex' ? 'openai-responses' : undefined
  const maxSessions = values.sessions ? Number(values.sessions) : undefined
  if (maxSessions !== undefined && !(Number.isInteger(maxSessions) && maxSessions > 0)) throw new Error(`--sessions: positive integer, got '${values.sessions}'`)
  let traceLabRows = false
  const seen = new Set<string>()
  const filter = (c: { dialect: string; session: string }) => {
    if (!traceLabRows && isTraceLabSession(c.session)) traceLabRows = true
    if (dialect && c.dialect !== dialect) return false
    if (maxSessions !== undefined && !seen.has(c.session)) {
      if (seen.size >= maxSessions) return false
      seen.add(c.session)
    }
    return true
  }
  const t0 = Date.now()
  const run = await runReplay(readTrace(values.trace), policies, {
    catalog, pools, sim, filter, onProgress: (n) => process.stderr.write(`  ${n} calls, ${((Date.now() - t0) / 1000).toFixed(0)} s\n`),
  })
  // CC BY 4.0: attribute whenever TraceLab-derived rows were read, whatever the file is called.
  const isTraceLab = traceLabRows || values.trace.includes('tracelab')
  const notes = [
    'Simulator: exact-prefix cache per (model, shard); TTL from request start, refreshed on hit; full-prompt write each call; no early eviction, no failures/failover, no latency.',
    'Cost per call via @auto-router/pricing costOf; quality is not measured (tier mix is the only proxy).',
    ...(isTraceLab ? ['TraceLab prefix identity is reconstructed (task design §3.1): drops → compaction/rewrite; Claude same-model misses within 240 s → rewrite; otherwise append-only. No sub-agent lineages in this trace.'] : []),
    ...(CORE_IS_STUB && names.some((n) => n.startsWith('core')) ? ['core-* rows use a temporary stub engine (default tier, then retain) until @auto-router/core lands — not representative.'] : []),
  ]
  const report = buildReport(run, {
    tracePath: values.trace, sha256: await sha256(values.trace), catalog, sim, pools,
    ...(dialect || maxSessions ? { filter: [dialect && `dialect=${dialect}`, maxSessions && `sessions<=${maxSessions}`].filter(Boolean).join(',') } : {}),
    ...(isTraceLab ? { attribution: TRACELAB_ATTRIBUTION } : {}),
    notes,
  })
  const md = renderMarkdown(report)
  process.stdout.write(md + '\n')
  if (values.out) await writeFile(values.out, JSON.stringify(report, null, 2) + '\n')
  if (values.md) await writeFile(values.md, md + '\n')
  process.stderr.write(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`)
}

async function cmdConvert(argv: string[]): Promise<void> {
  const [source, input, output] = argv
  if (source !== 'tracelab' || !input || !output) throw new Error(USAGE)
  const { calls, stats } = await convertTraceLab(input)
  const n = await writeJsonLines(output, calls)
  process.stderr.write(`${JSON.stringify({ ...stats, written: n })}\n`)
}

async function cmdSynth(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { sessions: { type: 'string' }, seed: { type: 'string' }, 'alt-share': { type: 'string' }, pair: { type: 'string' } } })
  const [kind, output] = positionals
  if (!output) throw new Error(USAGE)
  const TIER = new Set(['frontier', 'standard', 'fast'])
  const [main, alt] = (values.pair ?? 'standard-fast').split('-')
  if (!main || !alt || !TIER.has(main) || !TIER.has(alt)) throw new Error(`--pair must be <main>-<alt> tiers, e.g. standard-fast\n${USAGE}`)
  const altShare = values['alt-share'] === undefined ? 0 : Number(values['alt-share'])
  if (!(altShare >= 0 && altShare <= 1)) throw new Error(`--alt-share must be in [0, 1]\n${USAGE}`)
  const calls = kind === 'breakeven' ? breakEvenCalls({ contextTokens: 50_000, steps: 30 })
    : kind === 'agent' ? agentSessions({
      ...(values.sessions ? { sessions: Number(values.sessions) } : {}), ...(values.seed ? { seed: Number(values.seed) } : {}),
      ...(altShare > 0 ? { altTurnShare: altShare, turnTiers: { main: main as 'standard', alt: alt as 'fast' } } : {}),
    })
    : undefined
  if (!calls) throw new Error(USAGE)
  process.stderr.write(`${await writeJsonLines(output, calls)} calls\n`)
}

async function cmdSweep(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { sessions: { type: 'string' }, seed: { type: 'string' }, hints: { type: 'string', default: 'cooperative' }, out: { type: 'string' }, md: { type: 'string' }, region: { type: 'string' }, catalog: { type: 'string' } } })
  if (values.hints !== 'none' && values.hints !== 'cooperative') throw new Error(`--hints must be none|cooperative\n${USAGE}`)
  const catalog = selectCatalog({ ...(values.region ? { region: values.region } : {}), ...(values.catalog ? { catalogJson: await readJson(values.catalog) } : {}) })
  const cells = await runSweep({ catalog, pools: DEFAULT_POOLS, hints: values.hints, ...(values.sessions ? { sessions: Number(values.sessions) } : {}), ...(values.seed ? { seed: Number(values.seed) } : {}) })
  const md = renderSweep(cells)
  process.stdout.write(md + '\n')
  if (values.out) await writeFile(values.out, JSON.stringify({ schema: 'replay-sweep/v1', generatedAt: new Date().toISOString(), catalog: catalog.version, sources: SYNTH_SOURCES, cells }, null, 2) + '\n')
  if (values.md) await writeFile(values.md, md + '\n')
}

const [cmd, ...rest] = process.argv.slice(2)
const run = cmd === 'replay' ? cmdReplay : cmd === 'convert' ? cmdConvert : cmd === 'synth' ? cmdSynth : cmd === 'sweep' ? cmdSweep : undefined
if (!run) {
  process.stderr.write(USAGE + '\n')
  process.exit(2)
}
run(rest).catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
