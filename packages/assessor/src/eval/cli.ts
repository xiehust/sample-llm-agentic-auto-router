#!/usr/bin/env node
// Eval CLI (design §10.2). Live commands call bedrock-runtime in one region (--region, else the catalog's region) only,
// after the account check, and
// every call is reserved against the budget ledger. Data under data/ is parsed only.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCatalog, validateCatalog, type PriceCatalog } from '@auto-router/pricing'
import type { Transport } from '../transport.ts'
import { handItems, parseSwebench, sweSplit, trajectoryItems, type EvalItem } from './datasets.ts'
import { isPackName, loadPack, packDirs } from '../pack.ts'
import { runEval, type EvalResult } from './harness.ts'
import { buildReport, renderReport } from './report.ts'
import { resampleHints } from './hints.ts'
import { Ledger, scrub, scrubText } from './scrub.ts'

const PKG = fileURLToPath(new URL('../../', import.meta.url))
const DATA = join(PKG, 'data')
const LEDGER = join(DATA, 'eval-runs', 'ledger.json')
const SWE = join(DATA, 'swebench-verified', 'rows.jsonl')
const HAND = join(PKG, 'eval', 'handlabelled.v1.jsonl')
const TRAJ = join(PKG, 'eval', 'trajectories.v1.jsonl')
export const MODELS: Record<string, string> = { luna: 'global.openai.gpt-6-luna', haiku: 'global.anthropic.claude-haiku-5-5' }
const CAP_USD = 1.8

function args(argv: string[]): { pos: string[]; flags: Record<string, string> } {
  const pos: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) flags[k] = 'true'
      else { flags[k] = v; i++ }
    } else pos.push(a)
  }
  return { pos, flags }
}

function modelOf(name: string): string {
  const m = MODELS[name] ?? (name.includes('.') ? name : undefined)
  if (!m) throw new Error(`unknown model ${name} (use ${Object.keys(MODELS).join('|')} or a full id)`)
  return m
}

/** Wraps the live transport to keep the last error body (scrubbed, bounded) for diagnostics. */
function diagnosing(t: Transport, sink: string[]): Transport {
  return async (req) => {
    const r = await t(req)
    if (r.status < 200 || r.status > 299) sink.push(`${req.path} HTTP ${r.status}: ${scrubText(r.body).slice(0, 600)}`)
    return r
  }
}

async function live(region: string): Promise<Transport> {
  const { createLiveTransport } = await import('./live-transport.ts')
  return createLiveTransport(region)
}

/** The price catalog (--catalog file, else the bundled one) and the region to call (--region, else the catalog's). */
function catalogAndRegion(flags: Record<string, string>): { catalog: PriceCatalog; region: string } {
  const catalog = flags.catalog ? validateCatalog(JSON.parse(readFileSync(flags.catalog, 'utf8'))) : loadCatalog()
  const region = flags.region ?? catalog.region
  if (region !== catalog.region) throw new Error(`--region ${region} does not match the catalog's region ${catalog.region}; pass --catalog priced for ${region}`)
  return { catalog, region }
}

function splitOf(flag: string | undefined): 'dev' | 'test' | undefined {
  if (flag === undefined) return undefined
  if (flag !== 'dev' && flag !== 'test') throw new Error('--swe-split must be dev|test')
  return flag
}

function loadItems(datasets: string[], limit?: number, seed = 1, split?: 'dev' | 'test'): EvalItem[] {
  let items: EvalItem[] = []
  if (datasets.includes('hand')) items.push(...handItems(HAND))
  if (datasets.includes('swebench')) items.push(...parseSwebench(SWE).filter((it) => split === undefined || sweSplit(it) === split))
  if (datasets.includes('traj')) items.push(...trajectoryItems(TRAJ))
  if (limit !== undefined && limit < items.length) {
    // Deterministic stratified subsample by (dataset, gold).
    const groups = new Map<string, EvalItem[]>()
    for (const it of items) groups.set(`${it.dataset}:${it.category}`, [...(groups.get(`${it.dataset}:${it.category}`) ?? []), it])
    const share = limit / items.length
    items = [...groups.values()].flatMap((g) => g.filter((_, i) => ((i * 2654435761 + seed) >>> 0) % 1000 < share * 1000 || g.length * share < 1 && i === 0))
  }
  return items
}

async function cmdRun(flags: Record<string, string>, smoke: boolean): Promise<void> {
  const { catalog, region } = catalogAndRegion(flags)
  const ledger = new Ledger(LEDGER, Math.min(CAP_USD, Number(flags['budget-usd'] ?? CAP_USD)))
  const errors: string[] = []
  const transport = diagnosing(await live(region), errors)
  const out = flags.out ?? join(DATA, 'eval-runs', `${smoke ? 'smoke' : 'run'}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
  mkdirSync(dirname(out), { recursive: true })
  const models = (flags.models ?? 'luna,haiku').split(',').map(modelOf)
  const datasets = (flags.dataset ?? 'hand,swebench').split(',')
  let items = loadItems(datasets, flags.limit ? Number(flags.limit) : undefined, 1, splitOf(flags['swe-split']))
  const packName = flags.pack ?? 'v2.1' // the library default (defaultPackDir)
  if (!isPackName(packName)) throw new Error(`--pack must be one of ${Object.keys(packDirs).join('|')}`)
  const pack = loadPack(packDirs[packName])
  if (smoke) items = items.filter((it) => ['hl-001', 'hl-021', 'hl-036', 'hl-056', 'hl-079'].includes(it.id))
  const api = flags.api === 'chat' ? 'chat' as const : flags.api === 'responses' ? 'responses' as const : undefined
  const effort = flags.effort === 'omit' ? null : flags.effort
  // Variant label: v1 runs keep the historical label 'default' (existing v1 result files use it); other packs use their name.
  const variant = flags.variant ?? ([packName === 'v1' ? undefined : packName, api, effort].filter(Boolean).join('-') || 'default')
  for (const model of models) {
    const t0 = Date.now()
    const { results, stoppedByBudget } = await runEval({
      items, model, variant: variant || 'default', pack, transport, catalog, ledger, concurrency: Number(flags.concurrency ?? 4),
      config: { ...(api ? { api } : {}), ...(effort !== undefined ? { reasoningEffort: effort } : {}) },
      onResult: (r, done, total) => { appendFileSync(out, JSON.stringify(r) + '\n'); if (done % 25 === 0 || done === total) process.stderr.write(`${model} ${done}/${total} spent $${ledger.spentUsd.toFixed(4)}\n`) },
    })
    ledger.flush(`${smoke ? 'smoke' : 'run'} ${model} ${variant || 'default'} n=${results.length}`)
    const ok = results.filter((r) => r.status === 'ok').length
    console.log(JSON.stringify({ model, variant: variant || 'default', n: results.length, ok, stoppedByBudget, seconds: Math.round((Date.now() - t0) / 1000), spentUsd: Number(ledger.spentUsd.toFixed(5)) }))
    if (smoke) for (const r of results) console.log(JSON.stringify(scrub({ id: r.itemId, gold: r.gold, status: r.status, reason: r.reason, proposed: r.proposedTier, outcome: r.outcome, conf: r.confidence, ms: r.latencyMs, in: r.inputTokens, cached: r.cachedTokens, out: r.outputTokens, usd: r.costUsd })))
  }
  for (const e of [...new Set(errors)].slice(0, 5)) console.log('error-body', e)
  console.log('results', out)
}

async function cmdFetchSwebench(): Promise<void> {
  const rows: Array<Record<string, string>> = []
  for (let off = 0; off < 500; off += 100) {
    const url = `https://datasets-server.huggingface.co/rows?dataset=princeton-nlp/SWE-bench_Verified&config=default&split=test&offset=${off}&length=100`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`fetch ${off}: HTTP ${res.status}`)
    const j = JSON.parse(await res.text()) as { rows?: Array<{ row?: Record<string, unknown> }> }
    for (const r of j.rows ?? []) {
      const x = r.row ?? {}
      const keep: Record<string, string> = {}
      for (const k of ['instance_id', 'repo', 'problem_statement', 'difficulty']) {
        if (typeof x[k] !== 'string') throw new Error(`row missing ${k}`)
        keep[k] = x[k] as string
      }
      rows.push(keep)
    }
  }
  if (rows.length !== 500 || new Set(rows.map((r) => r.instance_id)).size !== 500) throw new Error(`expected 500 unique rows, got ${rows.length}`)
  mkdirSync(dirname(SWE), { recursive: true })
  writeFileSync(SWE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  console.log(`wrote ${rows.length} rows to ${SWE}`)
}

function readResults(paths: string[]): EvalResult[] {
  return paths.flatMap((p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as EvalResult))
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  const { pos, flags } = args(rest)
  switch (cmd) {
    case 'fetch':
      if (pos[0] !== 'swebench') throw new Error('usage: fetch swebench')
      return cmdFetchSwebench()
    case 'smoke':
      return cmdRun({ ...flags, dataset: 'hand' }, true)
    case 'run':
      return cmdRun(flags, false)
    case 'dry-run': {
      const items = loadItems((flags.dataset ?? 'hand,swebench').split(','), flags.limit ? Number(flags.limit) : undefined, 1, splitOf(flags['swe-split']))
      const by = new Map<string, number>()
      for (const it of items) by.set(`${it.dataset}/${it.gold}`, (by.get(`${it.dataset}/${it.gold}`) ?? 0) + 1)
      console.log(JSON.stringify({ n: items.length, by: Object.fromEntries(by) }))
      return
    }
    case 'report': {
      if (pos.length === 0) throw new Error('usage: report <results.jsonl...> --out <dir> [--name <base>]')
      const split = splitOf(flags['swe-split'])
      const all = readResults(pos)
      const report = buildReport(split ? all.filter((r) => r.dataset !== 'swebench' || sweSplit({ id: r.itemId, gold: r.gold }) === split) : all)
      const dir = flags.out ?? '.'
      const base = flags.name ?? 'assessor-eval'
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${base}.json`), JSON.stringify(scrub(report), null, 2) + '\n')
      writeFileSync(join(dir, `${base}.md`), scrubText(renderReport(report)))
      console.log(`wrote ${join(dir, base)}.{json,md}`)
      return
    }
    case 'hints': {
      if (!flags.trace || !flags.run || !flags.out) throw new Error('usage: hints --trace in.jsonl --run results.jsonl --model <id> [--variant v] --out out.jsonl [--seed n]')
      const stats = resampleHints({
        tracePath: flags.trace, results: readResults(flags.run.split(',')), model: modelOf(flags.model ?? 'luna'),
        ...(flags.variant ? { variant: flags.variant } : {}), outPath: flags.out, seed: Number(flags.seed ?? 1),
      })
      console.log(JSON.stringify(stats))
      return
    }
    default:
      console.error('usage: cli.ts fetch swebench | smoke [--models luna,haiku] [--api chat] | run [--models] [--dataset hand,swebench] [--limit N] [--effort none|low] [--api responses|chat] [--budget-usd 1.8] | dry-run | report <files> --out dir | hints ...')
      process.exitCode = 2
  }
}

main().catch((e: unknown) => { console.error(scrubText(e instanceof Error ? e.message : String(e))); process.exitCode = 1 })
