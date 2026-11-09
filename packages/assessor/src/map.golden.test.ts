// Golden for the tier mapping of the packs without a `mapping` block (v1, v2, v2.1: the deployed router's packs).
// The full truth table (every task_facts combination × every subset of matched rules × confidences around the
// threshold × auto settings) is mapped and hashed; the hash was taken before the pack `mapping` block existed, so any
// change to the no-block behaviour fails here. Synthetic inputs only.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DEFAULT_MAPPING, FACT_SIGNALS, mapTier, type FactSignal, type PackMapping } from './map.ts'
import { loadPack, packDirs, renderSystem, type PackRule } from './pack.ts'
import { REASONING_DEPTHS, SCOPES, SPECIFICATIONS } from './schema.ts'
import type { Assessment } from './validate.ts'

const CONFIDENCES = [0.5, 0.79, 0.8, 0.95]
const PRIOR = [0, 1, 2, 3]

function* table(rules: readonly PackRule[]): Generator<Assessment> {
  const ids = rules.map((r) => r.id)
  for (const edits_code of [false, true]) for (const scope of SCOPES) for (const specification of SPECIFICATIONS)
    for (const reasoning_depth of REASONING_DEPTHS) for (const prior_failures of PRIOR)
      for (let mask = 0; mask < 1 << ids.length; mask++) for (const confidence of CONFIDENCES) {
        yield {
          rule_assessments: ids.map((rule_id, i) => ({ rule_id, matched: (mask & (1 << i)) !== 0, reason: 'x' })),
          task_facts: { edits_code, scope, specification, reasoning_depth, prior_failures },
          confidence, reason: 'x',
        }
      }
}

/** sha256 over every mapping (JSON, one per line) under the given rule auto flags and auto facts, plus outcome counts. */
function digest(rules: readonly PackRule[], autoFacts: readonly FactSignal[], mapping?: PackMapping): { sha: string; n: number; outcomes: Record<string, number> } {
  const h = createHash('sha256')
  const outcomes: Record<string, number> = {}
  let n = 0
  for (const a of table(rules)) {
    const m = mapTier(a, rules, { autoFacts, ...(mapping ? { mapping } : {}) })
    h.update(JSON.stringify(m) + '\n')
    outcomes[m.outcome] = (outcomes[m.outcome] ?? 0) + 1
    n++
  }
  return { sha: h.digest('hex'), n, outcomes }
}

// Taken from the mapping before pack-level `mapping` existed (2026-11-07). v1, v2 and v2.1 share these rules.
const GOLDEN = {
  shipped: { sha: '7334d087291bd5e1e29441dace539427bc376a0e8842ee311b8957c07aecc79d', n: 18432 },
  autoAll: { sha: 'bfe81f19b408026ac8d06721d8ee1d961240f1bea0c8dddf26889b368423d2bb', n: 18432 },
}

// The shipped packs' prompt versions (system prompt hash), also from before the mapping block existed.
const PACK_VERSIONS = { v1: 'assessor/v1+ee49d3c06e8d', v2: 'assessor/v2+3893290b1a13', 'v2.1': 'assessor/v2.1+2696c56a9c6c' }

describe('mapTier golden (packs without a mapping block)', () => {
  for (const name of ['v1', 'v2', 'v2.1'] as const) {
    const pack = loadPack(packDirs[name])
    it(`${name}: no mapping block, prompt version unchanged`, () => {
      expect(pack.mapping).toBeUndefined()
      expect(renderSystem(pack).packVersion).toBe(PACK_VERSIONS[name])
    })
    it(`${name}: shipped auto flags, no auto facts`, () => {
      const d = digest(pack.rules, [])
      expect({ sha: d.sha, n: d.n }).toEqual(GOLDEN.shipped)
    })
    it(`${name}: every rule auto and every fact signal auto (the experiment router)`, () => {
      const d = digest(pack.rules.map((r) => ({ ...r, auto: r.enabled })), FACT_SIGNALS)
      expect({ sha: d.sha, n: d.n }).toEqual(GOLDEN.autoAll)
    })
  }
})

describe('mapTier golden: a mapping block equal to DEFAULT_MAPPING', () => {
  const rules = loadPack(packDirs['v2.1']).rules
  it('maps exactly like no block', () => {
    expect({ ...digest(rules, [], { ...DEFAULT_MAPPING }), outcomes: undefined }).toEqual({ ...GOLDEN.shipped, outcomes: undefined })
    const all = rules.map((r) => ({ ...r, auto: r.enabled }))
    expect({ ...digest(all, FACT_SIGNALS, { ...DEFAULT_MAPPING }), outcomes: undefined }).toEqual({ ...GOLDEN.autoAll, outcomes: undefined })
  })
})
