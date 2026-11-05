import { describe, expect, it } from 'vitest'
import { TRACELAB_ATTRIBUTION } from './adapters/tracelab.ts'
import { allPolicies } from './policies/index.ts'
import { DEFAULT_POOLS } from './pools.ts'
import { runReplay } from './replayer.ts'
import { buildReport, renderMarkdown } from './report.ts'
import { agentSessions } from './synth.ts'
import { catalog } from './test-helpers.ts'

describe('report', async () => {
  const run = await runReplay(agentSessions({ sessions: 3 }), allPolicies(['recorded', 'classifier'], { catalog, hints: 'none' }), { catalog, pools: DEFAULT_POOLS })
  const rep = buildReport(run, { tracePath: 'x.jsonl', catalog, sim: {}, pools: DEFAULT_POOLS, attribution: TRACELAB_ATTRIBUTION, notes: ['n1'], now: new Date(0) })
  it('has schema, meta and one result per policy', () => {
    expect(rep.schema).toBe('replay-report/v1')
    expect(rep.meta.catalog.version).toBe(catalog.version)
    expect(rep.policies.map((p) => p.policy)).toEqual(['recorded', 'classifier'])
    expect(rep.meta.modelMap['anthropic-messages:claude-opus-4-8']).toMatch(/global\.anthropic\.claude-opus-4-8/)
  })
  it('renders a markdown table with attribution and notes', () => {
    const md = renderMarkdown(rep)
    expect(md).toContain('| Policy | Cost $ |')
    expect(md).toMatch(/\| classifier \|/)
    expect(md).toContain('CC BY 4.0')
    expect(md).toContain('- n1')
  })
})

describe('selectCatalog', () => {
  it('uses the bundled catalog by default and checks the region', async () => {
    const { selectCatalog } = await import('./catalog-select.ts')
    const { loadCatalog } = await import('./deps.ts')
    const bundled = loadCatalog()
    expect(selectCatalog({}).region).toBe(bundled.region)
    expect(selectCatalog({ region: bundled.region }).version).toBe(bundled.version)
    expect(() => selectCatalog({ region: 'eu-west-1' })).toThrow(/pass --catalog/)
    const other = { ...structuredClone(bundled), region: 'eu-west-1', version: 'x' }
    expect(selectCatalog({ region: 'eu-west-1', catalogJson: other }).region).toBe('eu-west-1')
    expect(() => selectCatalog({ region: 'us-east-1', catalogJson: other })).toThrow(/not us-east-1/)
  })
})
