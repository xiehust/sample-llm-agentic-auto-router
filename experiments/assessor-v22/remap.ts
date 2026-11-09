// Re-maps stored calls (assess.ts rows) under another pack's mapping, with no model call: the model's judgements
// (matched rule ids, task facts, confidence) are kept and only the deterministic mapping (map.ts + the pack's
// `mapping` block) is re-applied. Valid only when the target pack has the same enabled rules and the same prompt as
// the calls' pack (otherwise the model would have answered differently): the prompt hash is checked.
//
//   node experiments/assessor-v22/remap.ts --from <calls label> --to <new label> --pack <name|dir> [--mapping '<json>']
//
// --mapping overrides keys of the pack's mapping block (a quick variant without a pack dir). Writes
// results/calls/<to>/ with the same r*.jsonl files and a meta.json naming the source label.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { FACT_SIGNALS, isPackName, loadPack, mapTier, packDirs, renderSystem, validatePack, type Assessment, type Pack } from '../../packages/assessor/src/index.ts'

const THRESHOLD = 0.8
const DEADLINE_MS = 5000
const HERE = new URL('./', import.meta.url)
const { values } = parseArgs({ options: { from: { type: 'string' }, to: { type: 'string' }, pack: { type: 'string' }, mapping: { type: 'string' } } })
const die = (m: string): never => { process.stderr.write(`${m}\n`); process.exit(2) }
if (!values.from || !values.to || !values.pack) die('usage: remap.ts --from <label> --to <label> --pack <name|dir> [--mapping <json>]')
if (!/^[a-z0-9][a-z0-9.-]{0,39}$/.test(values.to as string)) die('--to must be a short lowercase name')

const arg = values.pack as string
let pack: Pack = isPackName(arg) ? loadPack(packDirs[arg]) : loadPack(arg.endsWith('/') ? arg : `${arg}/`)
if (values.mapping) {
  const extra = JSON.parse(values.mapping) as Record<string, unknown>
  pack = validatePack({ ...pack, mapping: { ...(pack.mapping ?? {}), ...extra } }) // re-validates (examples self-check too)
}
const rules = pack.rules.map((r) => ({ ...r, auto: r.enabled }))
const srcDir = new URL(`results/calls/${values.from}/`, HERE)
const meta = JSON.parse(readFileSync(new URL('meta.json', srcDir), 'utf8')) as { packVersion: string; pack: string }
const srcPack = isPackName(meta.pack) ? loadPack(packDirs[meta.pack]) : loadPack(meta.pack.endsWith('/') ? meta.pack : `${meta.pack}/`)
if (renderSystem(srcPack).system !== renderSystem(pack).system) die(`the prompt of ${arg} differs from the prompt the calls were made with (${meta.packVersion}); a prompt change needs new calls`)
const dstDir = new URL(`results/calls/${values.to}/`, HERE)
if (existsSync(dstDir)) die(`${values.to} exists`)
mkdirSync(dstDir, { recursive: true })

const ids = rules.filter((r) => r.enabled).map((r) => r.id)
let n = 0
const outcomes: Record<string, number> = {}
for (const f of readdirSync(srcDir).filter((x) => /^r\d+-[a-z]+\.jsonl$/.test(x)).sort()) {
  const lines: string[] = []
  for (const line of readFileSync(new URL(f, srcDir), 'utf8').split('\n')) {
    if (!line.trim()) continue
    const r = JSON.parse(line) as Record<string, unknown>
    if (r.status === 'ok' && Array.isArray(r.matched) && r.facts && typeof r.confidence === 'number') {
      const matched = new Set(r.matched as string[])
      const a = { rule_assessments: ids.map((rule_id) => ({ rule_id, matched: matched.has(rule_id), reason: 'x' })),
        task_facts: r.facts, confidence: r.confidence, reason: 'x' } as Assessment
      const m = mapTier(a, rules, { threshold: THRESHOLD, autoFacts: [...FACT_SIGNALS], ...(pack.mapping ? { mapping: pack.mapping } : {}) })
      const at0 = mapTier(a, rules, { threshold: 0, ...(pack.mapping ? { mapping: pack.mapping } : {}) }).proposedTier
      const opinion = m.proposedTier ?? 'none'
      Object.assign(r, { proposed: m.proposedTier ?? null, tier_at0: at0 ?? null, outcome: m.outcome, basis: m.basis,
        pred_untimed: opinion, pred: (r.latency_ms as number) <= DEADLINE_MS ? opinion : 'none' })
      outcomes[m.outcome] = (outcomes[m.outcome] ?? 0) + 1
    }
    r.label = values.to
    lines.push(JSON.stringify(r))
    n++
  }
  writeFileSync(new URL(f, dstDir), lines.join('\n') + '\n')
}
writeFileSync(new URL('meta.json', dstDir), JSON.stringify({ label: values.to, remapped_from: values.from, pack: arg,
  packVersion: renderSystem(pack).packVersion, callsPackVersion: meta.packVersion, mapping: pack.mapping ?? null }, null, 1) + '\n')
process.stdout.write(JSON.stringify({ rows: n, outcomes, packVersion: renderSystem(pack).packVersion }) + '\n')
