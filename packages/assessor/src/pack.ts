// Versioned prompt pack (design §4): load, validate, render. Rendering is a pure function of (pack, card) with a
// stable order (instructions → rules → examples → card last) so the system prefix is cacheable.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { taskCardIssue } from './card.ts'
import { TIERS, type Tier } from './contract.ts'
import { DEFAULT_THRESHOLD, mapTier } from './map.ts'
import { validateAssessment, type Assessment } from './validate.ts'

export interface PackRule { id: string; tier: Tier; enabled: boolean; auto: boolean; instruction: string }
/** One few-shot example: a (mini) card, its full output and the tier the output must map to (self-check only). */
export interface PackExample { tier: Tier; card: unknown; output: Assessment }

export interface Pack {
  id: string // 'assessor/v2.1'
  card: string // 'card/v1'
  output: string // 'assessment/v1'
  instructions: string
  rules: PackRule[]
  examples: PackExample[]
}

export interface RenderedPrompt { system: string; user: string; packVersion: string }

export class PackError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(`invalid prompt pack: ${issues.join('; ')}`)
    this.name = 'PackError'
    this.issues = issues
  }
}

/** The default pack: v2.1 (v2's fast-side tightening with v1's frontier and `deep` definitions; every rule auto:false). */
export const defaultPackDir: string = fileURLToPath(new URL('../prompts/assessor/v2.1/', import.meta.url))
/**
 * Shipped pack versions. v1 is the original pack; v2 tightens the fast boundary and widens `deep` (over-upgrades to
 * frontier on held-out data); v2.1 is the default.
 */
export type PackName = 'v1' | 'v2' | 'v2.1'
export const packDirs: Readonly<Record<PackName, string>> = {
  v1: fileURLToPath(new URL('../prompts/assessor/v1/', import.meta.url)),
  v2: fileURLToPath(new URL('../prompts/assessor/v2/', import.meta.url)),
  'v2.1': fileURLToPath(new URL('../prompts/assessor/v2.1/', import.meta.url)),
}
export const isPackName = (s: string): s is PackName => Object.hasOwn(packDirs, s)

export const PACK_LIMITS = { ruleIdPattern: /^[a-z0-9-]{1,40}$/, instructionChars: 600 } as const

/** Reads pack.json, instructions.md, rules.json and examples.json from `dir` and validates them. */
export function loadPack(dir: string = defaultPackDir): Pack {
  const read = (name: string) => readFileSync(join(dir, name), 'utf8')
  const meta: unknown = JSON.parse(read('pack.json'))
  return validatePack({
    ...(isObj(meta) ? meta : {}),
    instructions: read('instructions.md'),
    rules: JSON.parse(read('rules.json')) as unknown,
    examples: JSON.parse(read('examples.json')) as unknown,
  })
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isTier = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v)

/** Validates a pack (throws PackError listing every issue) and returns it typed. */
export function validatePack(value: unknown): Pack {
  const issues: string[] = []
  if (!isObj(value)) throw new PackError(['pack: object required'])
  for (const k of ['id', 'card', 'output', 'instructions'] as const) {
    if (typeof value[k] !== 'string' || (value[k] as string).trim() === '') issues.push(`${k}: non-empty string required`)
  }
  if (value.card !== undefined && value.card !== 'card/v1') issues.push(`card: unsupported card version ${String(value.card)}`)

  const rules: PackRule[] = []
  const ids = new Set<string>()
  if (!Array.isArray(value.rules)) issues.push('rules: array required')
  else {
    value.rules.forEach((r: unknown, i) => {
      const at = `rules[${i}]`
      if (!isObj(r)) { issues.push(`${at}: object required`); return }
      for (const k of Object.keys(r)) if (!['id', 'tier', 'enabled', 'auto', 'instruction'].includes(k)) issues.push(`${at}: unexpected key ${k}`)
      if (typeof r.id !== 'string' || !PACK_LIMITS.ruleIdPattern.test(r.id)) issues.push(`${at}.id: must match ${PACK_LIMITS.ruleIdPattern}`)
      else if (ids.has(r.id)) issues.push(`${at}.id: duplicate ${r.id}`)
      else ids.add(r.id)
      if (!isTier(r.tier)) issues.push(`${at}.tier: one of ${TIERS.join('|')}`)
      if (typeof r.enabled !== 'boolean') issues.push(`${at}.enabled: boolean required`)
      if (r.auto !== undefined && typeof r.auto !== 'boolean') issues.push(`${at}.auto: boolean required`)
      const ins = typeof r.instruction === 'string' ? r.instruction.trim() : ''
      if (ins === '' || ins.length > PACK_LIMITS.instructionChars) issues.push(`${at}.instruction: 1-${PACK_LIMITS.instructionChars} chars`)
      if (/[\r\n]/.test(ins)) issues.push(`${at}.instruction: single line required`)
      rules.push({ id: String(r.id), tier: r.tier as Tier, enabled: r.enabled === true, auto: r.auto === true, instruction: ins })
    })
  }

  const examples: PackExample[] = []
  if (!Array.isArray(value.examples)) issues.push('examples: array required')
  else {
    value.examples.forEach((e: unknown, i) => {
      const at = `examples[${i}]`
      if (!isObj(e)) { issues.push(`${at}: object required`); return }
      if (!isTier(e.tier)) issues.push(`${at}.tier: one of ${TIERS.join('|')}`)
      const cardIssue = taskCardIssue(e.card)
      if (cardIssue) issues.push(`${at}.card: ${cardIssue}`)
      const checked = validateAssessment(exampleOutput(e.output, rules), rules)
      if (!checked.ok) issues.push(`${at}.output: ${checked.issues[0]}`)
      else {
        const mapped = mapTier(checked.value, rules, { threshold: DEFAULT_THRESHOLD })
        if (mapped.proposedTier !== e.tier) issues.push(`${at}: output maps to ${mapped.proposedTier ?? mapped.outcome}, labelled ${String(e.tier)}`)
      }
      examples.push({ tier: e.tier as Tier, card: e.card, output: e.output as Assessment })
    })
  }

  if (issues.length > 0) throw new PackError(issues)
  return {
    id: (value.id as string).trim(),
    card: value.card as string,
    output: value.output as string,
    instructions: value.instructions as string,
    rules,
    examples,
  }
}

/** An example output restricted to the enabled rules (entries for disabled rules are not rendered). */
function exampleOutput(output: unknown, rules: readonly PackRule[]): unknown {
  if (!isObj(output) || !Array.isArray(output.rule_assessments)) return output
  const disabled = new Set(rules.filter((r) => !r.enabled).map((r) => r.id))
  return { ...output, rule_assessments: output.rule_assessments.filter((a: unknown) => !(isObj(a) && disabled.has(a.rule_id as string))) }
}

/** Card JSON for the prompt: JSON.stringify, with the closing delimiter escaped (`<\/task_card`, still valid JSON). */
export function cardJson(card: unknown): string {
  return JSON.stringify(card).replace(/<\/(task_card)/gi, '<\\/$1')
}

/** The stable system prefix and its version (`<pack id>+<sha256(system)[:12]>`). */
export function renderSystem(pack: Pack): { system: string; packVersion: string } {
  const enabled = pack.rules.filter((r) => r.enabled)
  const parts = [
    pack.instructions.trimEnd(),
    '',
    '## Rules (judge every enabled rule exactly once; order has no priority)',
    ...enabled.map((r) => `- ${r.id} [${r.tier}]: ${r.instruction}`),
    '',
    '## Examples (format only)',
  ]
  for (const e of pack.examples) {
    parts.push('', `<task_card>${cardJson(e.card)}</task_card>`, `→ ${JSON.stringify(exampleOutput(e.output, pack.rules))}`)
  }
  const system = `${parts.join('\n')}\n`
  const packVersion = `${pack.id}+${createHash('sha256').update(system).digest('hex').slice(0, 12)}`
  return { system, packVersion }
}

/** Renders the prompt: system = instructions → rules → examples; user = the card (always last). */
export function renderPrompt(pack: Pack, card: unknown): RenderedPrompt {
  const { system, packVersion } = renderSystem(pack)
  return { system, user: `<task_card>${cardJson(card)}</task_card>`, packVersion }
}
