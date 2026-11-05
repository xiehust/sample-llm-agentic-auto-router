// Strict validation of the model output (design §6). A schema is not proof: everything is re-checked in code, and the
// host, not the model, decides which rules matched. Returns trimmed copies; never throws.
import { REASONING_DEPTHS, SCOPES, SPECIFICATIONS } from './schema.ts'

export interface RuleAssessment { rule_id: string; matched: boolean; reason: string }
export interface TaskFacts {
  edits_code: boolean
  scope: (typeof SCOPES)[number]
  specification: (typeof SPECIFICATIONS)[number]
  reasoning_depth: (typeof REASONING_DEPTHS)[number]
  prior_failures: number
}
export interface Assessment { rule_assessments: RuleAssessment[]; task_facts: TaskFacts; confidence: number; reason: string }

export type ValidationResult = { ok: true; value: Assessment } | { ok: false; issues: string[] }

export const VALIDATION_LIMITS = { ruleReasonChars: 300, reasonChars: 300, reasonWords: 30, maxPriorFailures: 20 } as const

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function exactKeys(o: Obj, keys: readonly string[], at: string, issues: string[]): void {
  for (const k of keys) if (!(k in o)) issues.push(`${at}: missing ${k}`)
  for (const k of Object.keys(o)) if (!keys.includes(k)) issues.push(`${at}: unexpected key ${k}`)
}

function text(v: unknown, max: number, at: string, issues: string[]): string {
  if (typeof v !== 'string') { issues.push(`${at}: string required`); return '' }
  const t = v.trim()
  if (t.length < 1 || t.length > max) issues.push(`${at}: 1-${max} chars after trim (got ${t.length})`)
  return t
}

function oneOf<T extends string>(v: unknown, values: readonly T[], at: string, issues: string[]): T {
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) issues.push(`${at}: one of ${values.join('|')}`)
  return v as T
}

/**
 * Validates `raw` against the output contract for `rules`: exactly one `rule_assessments` entry per enabled rule
 * (missing, unknown, disabled or duplicate ids are rejected). A rule counts as disabled when `enabled === false`.
 */
export function validateAssessment(raw: unknown, rules: ReadonlyArray<{ id: string; enabled?: boolean }>): ValidationResult {
  const issues: string[] = []
  if (!isObj(raw)) return { ok: false, issues: ['output: object required'] }
  exactKeys(raw, ['rule_assessments', 'task_facts', 'confidence', 'reason'], 'output', issues)

  const enabled = new Set(rules.filter((r) => r.enabled !== false).map((r) => r.id))
  const disabled = new Set(rules.filter((r) => r.enabled === false).map((r) => r.id))
  const seen = new Set<string>()
  const assessments: RuleAssessment[] = []
  if (!Array.isArray(raw.rule_assessments)) issues.push('rule_assessments: array required')
  else {
    raw.rule_assessments.forEach((item: unknown, i) => {
      const at = `rule_assessments[${i}]`
      if (!isObj(item)) { issues.push(`${at}: object required`); return }
      exactKeys(item, ['rule_id', 'matched', 'reason'], at, issues)
      const id = item.rule_id
      if (typeof id !== 'string') { issues.push(`${at}.rule_id: string required`); return }
      if (disabled.has(id)) issues.push(`${at}.rule_id: disabled rule ${id}`)
      else if (!enabled.has(id)) issues.push(`${at}.rule_id: unknown rule ${id}`)
      else if (seen.has(id)) issues.push(`${at}.rule_id: duplicate rule ${id}`)
      seen.add(id)
      if (typeof item.matched !== 'boolean') issues.push(`${at}.matched: boolean required`)
      const reason = text(item.reason, VALIDATION_LIMITS.ruleReasonChars, `${at}.reason`, issues)
      assessments.push({ rule_id: id, matched: item.matched === true, reason })
    })
    for (const id of enabled) if (!seen.has(id)) issues.push(`rule_assessments: missing rule ${id}`)
  }

  let facts: TaskFacts | undefined
  const f = raw.task_facts
  if (!isObj(f)) issues.push('task_facts: object required')
  else {
    exactKeys(f, ['edits_code', 'scope', 'specification', 'reasoning_depth', 'prior_failures'], 'task_facts', issues)
    if (typeof f.edits_code !== 'boolean') issues.push('task_facts.edits_code: boolean required')
    const pf = f.prior_failures
    if (typeof pf !== 'number' || !Number.isInteger(pf) || pf < 0 || pf > VALIDATION_LIMITS.maxPriorFailures) {
      issues.push(`task_facts.prior_failures: integer 0-${VALIDATION_LIMITS.maxPriorFailures}`)
    }
    facts = {
      edits_code: f.edits_code === true,
      scope: oneOf(f.scope, SCOPES, 'task_facts.scope', issues),
      specification: oneOf(f.specification, SPECIFICATIONS, 'task_facts.specification', issues),
      reasoning_depth: oneOf(f.reasoning_depth, REASONING_DEPTHS, 'task_facts.reasoning_depth', issues),
      prior_failures: pf as number,
    }
  }

  const c = raw.confidence
  if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1) issues.push('confidence: finite number in [0, 1]')

  const reason = text(raw.reason, VALIDATION_LIMITS.reasonChars, 'reason', issues)
  const words = reason === '' ? 0 : reason.split(/\s+/).length
  if (reason !== '' && words > VALIDATION_LIMITS.reasonWords) issues.push(`reason: at most ${VALIDATION_LIMITS.reasonWords} words (got ${words})`)

  if (issues.length > 0 || !facts) return { ok: false, issues }
  return { ok: true, value: { rule_assessments: assessments, task_facts: facts, confidence: c as number, reason } }
}
