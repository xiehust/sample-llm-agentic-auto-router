// Regression check for the Anthropic <system-reminder> card filter (design-assessor.md §1.3): every recorded Codex
// request body must give a byte-identical card with this tree's card builder and with a baseline checkout that does
// not have the change (e.g. the main worktree at the commit before it). Offline: no model call, no network.
//
//   node experiments/claude-code-harbor/cardcheck.ts --baseline <path to the baseline repo root> \
//     --bodies <bodies.jsonl> [--bodies <bodies.jsonl> ...] [--dialect openai-responses]
//
// <bodies.jsonl>: one {"task_id", "body"} per line (the tier-pass bodies files). Prints, per file, the number of
// cards and the sha256 over the sorted card JSON for each tree, and exits 1 on the first difference (task id only;
// no card text is printed).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  baseline: { type: 'string' }, bodies: { type: 'string', multiple: true }, dialect: { type: 'string', default: 'openai-responses' },
  region: { type: 'string', default: 'ap-southeast-1' },
} })
if (!values.baseline || !values.bodies?.length) {
  process.stderr.write('usage: cardcheck.ts --baseline <repo> --bodies <bodies.jsonl> [--bodies ...] [--dialect d]\n')
  process.exit(2)
}
const dialect = values.dialect as 'openai-responses' | 'openai-chat' | 'anthropic-messages'
const here = new URL('../../', import.meta.url)
const base = pathToFileURL(`${resolve(values.baseline)}/`)

type CardFn = (body: unknown, id: string) => unknown
async function cardFn(root: URL): Promise<CardFn> {
  const core = await import(new URL('packages/core/src/index.ts', root).href)
  const pricing = await import(new URL('packages/pricing/src/index.ts', root).href)
  const router = await import(new URL('packages/router/src/index.ts', root).href)
  const policy = core.validatePolicy(JSON.parse(readFileSync(new URL(`packages/router/config/policy.experiment.${values.region}.json`, here), 'utf8')))
  const engine = core.createEngine({ policy, catalog: pricing.loadCatalog(values.region), store: new core.InMemoryStateStore() })
  return (body, id) => router.requestCard(engine, dialect, body, { 'x-router-session': `cardcheck-${id}` })
}

const sha = (xs: string[]): string => createHash('sha256').update([...xs].sort().join('\n')).digest('hex').slice(0, 16)
const [mine, theirs] = [await cardFn(here), await cardFn(base)]
let bad = 0
for (const f of values.bodies) {
  const rows = readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as { task_id: string; body: unknown })
  const a: string[] = []
  const b: string[] = []
  for (const r of rows) {
    const x = JSON.stringify(mine(r.body, r.task_id))
    const y = JSON.stringify(theirs(r.body, r.task_id))
    a.push(x); b.push(y)
    if (x !== y) { bad++; process.stderr.write(`DIFF ${f}: ${r.task_id}\n`) }
  }
  console.log(JSON.stringify({ file: f, cards: rows.length, sha_this: sha(a), sha_baseline: sha(b), identical: sha(a) === sha(b) }))
}
process.exit(bad === 0 ? 0 : 1)
