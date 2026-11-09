// Live-vs-step-1 card check: builds the router's session-start card from a captured Harbor/Codex first request and
// from the step 1 body for the same task, and prints a text-free structural diff (equal flags, lengths, hashes, tool
// names, estimated tokens). Tool names are Codex's own, not task text. No model call, no network.
//
//   node experiments/deepswe-harbor/carddiff.ts --region <r> --captured <first-body.json> --bodies <bodies.jsonl> --task <id>
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { createEngine, InMemoryStateStore, templateFamilyOf, validatePolicy } from '../../packages/core/src/index.ts'
import type { TaskCard } from '../../packages/assessor/src/index.ts'
import { loadCatalog } from '../../packages/pricing/src/index.ts'
import { requestCard } from '../../packages/router/src/index.ts'

const { values } = parseArgs({ options: {
  region: { type: 'string' }, captured: { type: 'string' }, bodies: { type: 'string' }, task: { type: 'string' },
} })
if (!values.region || !values.captured || !values.bodies || !values.task) {
  process.stderr.write('usage: carddiff.ts --region <r> --captured <body.json> --bodies <bodies.jsonl> --task <id>\n')
  process.exit(2)
}
const policy = validatePolicy(JSON.parse(readFileSync(new URL(`../../packages/router/config/policy.experiment.${values.region}.json`, import.meta.url), 'utf8')))
const engine = createEngine({ policy, catalog: loadCatalog(values.region), store: new InMemoryStateStore() })

const h = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12)
type Body = { input?: unknown[]; tools?: unknown[]; instructions?: unknown; [k: string]: unknown }

/** Text-free shape of a Responses body: keys, per-item role and text lengths, the leading XML tag of each block. */
function shape(b: Body): unknown {
  const items = Array.isArray(b.input) ? b.input : []
  return {
    keys: Object.keys(b).sort(),
    instructions_chars: typeof b.instructions === 'string' ? b.instructions.length : null,
    input: items.map((it) => {
      const o = it as { type?: string; role?: string; content?: unknown }
      const parts = Array.isArray(o.content) ? o.content as { type?: string; text?: string }[] : []
      return { item: `${o.type}:${o.role}`, parts: parts.map((p) => ({ type: p.type, chars: (p.text ?? '').length,
        tag: /^\s*<([a-z_]{1,40})>/.exec(p.text ?? '')?.[1] ?? null })) }
    }),
    tools: (Array.isArray(b.tools) ? b.tools : []).map((t) => (t as { name?: string; type?: string }).name ?? (t as { type?: string }).type),
    body_chars: JSON.stringify(b).length,
  }
}

function cardShape(c: TaskCard, b: Body): Record<string, unknown> {
  const role = 'label' in c.role ? { label: c.role.label } : { systemHead_sha: h(c.role.systemHead), systemHead_chars: c.role.chars ?? c.role.systemHead.length }
  return {
    latestUser_sha: h(c.latestUser.text), latestUser_chars: c.latestUser.chars ?? c.latestUser.text.length, firstUser: c.firstUser !== undefined,
    role, tools: c.tools, lineage: c.lineage, stats: c.stats,
    templateFamily: templateFamilyOf(engine.summarize('openai-responses', b, {}, Date.now())),
  }
}

const captured = JSON.parse(readFileSync(values.captured, 'utf8')) as Body
const line = readFileSync(values.bodies, 'utf8').split('\n').find((l) => l.includes(`"task_id": "${values.task}"`) || l.includes(`"task_id":"${values.task}"`))
if (!line) { process.stderr.write(`task ${values.task} not in ${values.bodies}\n`); process.exit(2) }
const step1 = (JSON.parse(line) as { body: Body }).body

const hdr = { 'x-router-session': `carddiff-${values.task}` }
const live = cardShape(requestCard(engine, 'openai-responses', captured, hdr), captured)
const off = cardShape(requestCard(engine, 'openai-responses', step1, hdr), step1)
const diff: Record<string, { live: unknown; step1: unknown }> = {}
for (const k of new Set([...Object.keys(live), ...Object.keys(off)])) {
  if (JSON.stringify(live[k]) !== JSON.stringify(off[k])) diff[k] = { live: live[k], step1: off[k] }
}
process.stdout.write(JSON.stringify({ task: values.task, card_equal: Object.keys(diff).length === 0, card_diff: diff,
  body_shape: { live: shape(captured), step1: shape(step1) } }, null, 1) + '\n')
