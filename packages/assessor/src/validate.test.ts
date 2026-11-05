import { describe, expect, it } from 'vitest'
import { output, RULE_IDS } from './__fixtures__/fixtures.ts'
import { outputSchema, type JsonSchema } from './schema.ts'
import { validateAssessment } from './validate.ts'

const rules = RULE_IDS.map((id) => ({ id, enabled: true }))
type Raw = Record<string, unknown> & { rule_assessments: Record<string, unknown>[]; task_facts: Record<string, unknown> }
const raw = (): Raw => structuredClone(output(['explore-readonly'])) as unknown as Raw
const firstIssue = (v: unknown, r: ReadonlyArray<{ id: string; enabled?: boolean }> = rules): string => {
  const res = validateAssessment(v, r)
  expect(res.ok).toBe(false)
  return res.ok ? '' : (res.issues[0] ?? '')
}

describe('outputSchema', () => {
  const schema = outputSchema(rules)

  it('uses only the portable strict subset', () => {
    const allowed = new Set(['type', 'enum', 'properties', 'required', 'additionalProperties', 'items'])
    const walk = (s: JsonSchema) => {
      for (const k of Object.keys(s)) expect(allowed.has(k)).toBe(true)
      if (s.type === 'object') {
        expect(s.additionalProperties).toBe(false)
        expect(s.required).toEqual(Object.keys(s.properties ?? {}))
        for (const p of Object.values(s.properties ?? {})) walk(p)
      }
      if (s.items) walk(s.items)
    }
    walk(schema)
  })

  it('enumerates the enabled rule ids and the fact enums', () => {
    expect(schema.properties?.rule_assessments?.items?.properties?.rule_id).toEqual({ type: 'string', enum: [...RULE_IDS] })
    expect(schema.properties?.task_facts?.properties?.scope?.enum).toEqual(['none', 'single-file', 'multi-file', 'cross-module'])
    expect(schema.properties?.task_facts?.properties?.prior_failures).toEqual({ type: 'integer' })
    expect(outputSchema([]).properties?.rule_assessments?.items?.properties?.rule_id).toEqual({ type: 'string' })
  })
})

describe('validateAssessment', () => {
  it('accepts a valid output and returns trimmed copies', () => {
    const r = raw()
    r.reason = '  Lookup of a setting.  '
    r.rule_assessments[0]!.reason = '  where is X  '
    const res = validateAssessment(r, rules)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value.reason).toBe('Lookup of a setting.')
      expect(res.value.rule_assessments[0]!.reason).toBe('where is X')
    }
  })

  it('requires exactly one entry per enabled rule', () => {
    const missing = raw()
    missing.rule_assessments.pop()
    expect(firstIssue(missing)).toMatch(/missing rule deep-investigation/)

    const unknown = raw()
    unknown.rule_assessments[0]!.rule_id = 'made-up'
    expect(firstIssue(unknown)).toMatch(/unknown rule made-up/)

    const dup = raw()
    dup.rule_assessments[1]!.rule_id = 'explore-readonly'
    expect(firstIssue(dup)).toMatch(/duplicate rule explore-readonly/)

    const withDisabled = rules.map((r) => (r.id === 'mechanical-edit' ? { ...r, enabled: false } : r))
    expect(firstIssue(raw(), withDisabled)).toMatch(/disabled rule mechanical-edit/)
    const ok = raw()
    ok.rule_assessments.splice(1, 1)
    expect(validateAssessment(ok, withDisabled).ok).toBe(true)
  })

  it('rejects extra and missing keys at every level', () => {
    const top = raw()
    top.extra = 1
    expect(firstIssue(top)).toMatch(/output: unexpected key extra/)
    const noReason = raw()
    delete noReason.reason
    expect(firstIssue(noReason)).toMatch(/output: missing reason/)
    const item = raw()
    item.rule_assessments[0]!.tier = 'fast'
    expect(firstIssue(item)).toMatch(/rule_assessments\[0\]: unexpected key tier/)
    const facts = raw()
    facts.task_facts.tier = 'fast'
    expect(firstIssue(facts)).toMatch(/task_facts: unexpected key tier/)
    expect(firstIssue('not json object')).toMatch(/object required/)
    expect(firstIssue([])).toMatch(/object required/)
  })

  it.each<[string, (r: Raw) => void, RegExp]>([
    ['scope enum', (r) => { r.task_facts.scope = 'huge' }, /task_facts\.scope/],
    ['specification enum', (r) => { r.task_facts.specification = 'vague' }, /task_facts\.specification/],
    ['reasoning_depth enum', (r) => { r.task_facts.reasoning_depth = 'medium' }, /task_facts\.reasoning_depth/],
    ['edits_code type', (r) => { r.task_facts.edits_code = 'yes' }, /edits_code/],
    ['prior_failures fraction', (r) => { r.task_facts.prior_failures = 1.5 }, /prior_failures/],
    ['prior_failures negative', (r) => { r.task_facts.prior_failures = -1 }, /prior_failures/],
    ['prior_failures > 20', (r) => { r.task_facts.prior_failures = 21 }, /prior_failures/],
    ['matched type', (r) => { r.rule_assessments[0]!.matched = 'true' }, /matched: boolean/],
    ['rule reason empty', (r) => { r.rule_assessments[0]!.reason = '   ' }, /rule_assessments\[0\]\.reason/],
    ['rule reason > 300', (r) => { r.rule_assessments[0]!.reason = 'x'.repeat(301) }, /rule_assessments\[0\]\.reason/],
    ['confidence NaN', (r) => { r.confidence = Number.NaN }, /confidence/],
    ['confidence Infinity', (r) => { r.confidence = Number.POSITIVE_INFINITY }, /confidence/],
    ['confidence < 0', (r) => { r.confidence = -0.01 }, /confidence/],
    ['confidence > 1', (r) => { r.confidence = 1.01 }, /confidence/],
    ['confidence string', (r) => { r.confidence = '0.9' }, /confidence/],
    ['reason 31 words', (r) => { r.reason = Array.from({ length: 31 }, () => 'w').join(' ') }, /at most 30 words/],
    ['reason empty', (r) => { r.reason = '' }, /reason: 1-300/],
    ['reason > 300 chars', (r) => { r.reason = 'x'.repeat(301) }, /reason: 1-300/],
  ])('rejects %s', (_, mutate, pattern) => {
    const r = raw()
    mutate(r)
    expect(firstIssue(r)).toMatch(pattern)
  })

  it('accepts the bounds exactly', () => {
    const r = raw()
    r.reason = Array.from({ length: 30 }, () => 'w').join(' ')
    r.confidence = 1
    r.task_facts.prior_failures = 20
    r.rule_assessments[0]!.reason = 'x'.repeat(300)
    expect(validateAssessment(r, rules).ok).toBe(true)
    r.confidence = 0
    expect(validateAssessment(r, rules).ok).toBe(true)
  })
})
