// Eval report (design §10.3). Aggregates only: item ids appear, no item text.
import type { Tier } from '../contract.ts'
import type { EvalResult } from './harness.ts'

export const PRED = ['fast', 'standard', 'frontier', 'none', 'unavailable'] as const
export type Pred = (typeof PRED)[number]
const GOLD: Tier[] = ['fast', 'standard', 'frontier']

export const SWE_LICENCE_NOTE = 'SWE-bench Verified (princeton-nlp/SWE-bench_Verified): no licence declared on the dataset card; SWE-bench code is MIT; '
  + 'issue texts come from 12 upstream projects. Used for offline evaluation only; no issue text is reproduced here (instance ids and aggregates only).'

export interface GroupMetrics {
  n: number
  called: number
  skipped: number
  unavailable: number
  unavailableByCode: Record<string, number>
  confusion: Record<Tier, Record<Pred, number>>
  coverage: number           // share with a tier opinion
  accuracyOnOpinions: number // correct / opinions
  fastPredicted: number
  fastPrecision: number | null
  frontierRecall: number | null
  noOpinionRate: number
  latencyP50: number | null
  latencyP95: number | null
  over1500ms: number         // share of called assessments slower than the production budget
  costMeanUsd: number | null
  costP95Usd: number | null
  costTotalUsd: number
  cachedInputShare: number | null
  meanInputTokens: number | null
  meanOutputTokens: number | null
  fastOnSwe15min?: number    // soft signal: fast predictions on '<15 min fix'
  fastFalsePositives: string[]
}

export interface SweepRow { threshold: number; coverage: number; fastPredicted: number; fastPrecision: number | null; frontierRecall: number | null; accuracyOnOpinions: number }

export interface ReportGroup { model: string; variant: string; dataset: string; metrics: GroupMetrics; byCategory?: Record<string, { n: number; correct: number; none: number }>; sweep: SweepRow[]; stability?: Stability }
export interface EvalReport { schema: 'assessor-eval/v1'; packVersions: string[]; licence: string; groups: ReportGroup[]; recommendation: Record<string, { threshold: number; why: string }> }

const q = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] as number
}
const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null)

export function predOf(r: EvalResult, threshold?: number): Pred {
  if (r.status === 'unavailable') return 'unavailable'
  if (threshold === undefined) return r.proposedTier ?? 'none'
  if (r.tierAt0 === undefined || r.confidence === undefined || r.confidence < threshold) return 'none'
  return r.tierAt0
}

export function metrics(rs: EvalResult[], threshold?: number): GroupMetrics {
  const confusion = Object.fromEntries(GOLD.map((g) => [g, Object.fromEntries(PRED.map((p) => [p, 0]))])) as Record<Tier, Record<Pred, number>>
  const unavailableByCode: Record<string, number> = {}
  let opinions = 0
  let correct = 0
  const fastFalsePositives: string[] = []
  for (const r of rs) {
    const p = predOf(r, threshold)
    confusion[r.gold][p]++
    if (p === 'unavailable') {
      const code = (r.reason ?? 'unknown').split(':')[0] as string
      unavailableByCode[code] = (unavailableByCode[code] ?? 0) + 1
    }
    if (p === 'fast' || p === 'standard' || p === 'frontier') {
      opinions++
      if (p === r.gold) correct++
      if (p === 'fast' && r.gold !== 'fast') fastFalsePositives.push(r.itemId)
    }
  }
  const fastPredicted = GOLD.reduce((a, g) => a + confusion[g].fast, 0)
  const goldFrontier = PRED.reduce((a, p) => a + confusion.frontier[p], 0)
  const called = rs.filter((r) => r.called)
  const lat = called.map((r) => r.latencyMs)
  const cost = called.map((r) => r.costUsd).filter((c): c is number => c !== undefined)
  const inTok = called.map((r) => r.inputTokens).filter((x): x is number => x !== undefined)
  const cached = called.map((r) => r.cachedTokens ?? 0)
  const outTok = called.map((r) => r.outputTokens).filter((x): x is number => x !== undefined)
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
  const swe15 = rs.filter((r) => r.dataset === 'swebench' && r.category === '<15 min fix')
  return {
    n: rs.length,
    called: called.length,
    skipped: rs.filter((r) => r.skipped).length,
    unavailable: rs.filter((r) => r.status === 'unavailable').length,
    unavailableByCode,
    confusion,
    coverage: rs.length ? opinions / rs.length : 0,
    accuracyOnOpinions: opinions ? correct / opinions : 0,
    fastPredicted,
    fastPrecision: ratio(confusion.fast.fast, fastPredicted),
    frontierRecall: ratio(confusion.frontier.frontier, goldFrontier),
    noOpinionRate: rs.length ? GOLD.reduce((a, g) => a + confusion[g].none, 0) / rs.length : 0,
    latencyP50: q(lat, 0.5),
    latencyP95: q(lat, 0.95),
    over1500ms: called.length ? lat.filter((x) => x > 1500).length / called.length : 0,
    costMeanUsd: cost.length ? sum(cost) / cost.length : null,
    costP95Usd: q(cost, 0.95),
    costTotalUsd: sum(cost),
    cachedInputShare: ratio(sum(cached), sum(inTok)),
    meanInputTokens: inTok.length ? sum(inTok) / inTok.length : null,
    meanOutputTokens: outTok.length ? sum(outTok) / outTok.length : null,
    ...(swe15.length ? { fastOnSwe15min: swe15.filter((r) => predOf(r, threshold) === 'fast').length } : {}),
    fastFalsePositives,
  }
}

export const SWEEP_THRESHOLDS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]

export function sweep(rs: EvalResult[]): SweepRow[] {
  return SWEEP_THRESHOLDS.map((t) => {
    const m = metrics(rs, t)
    return { threshold: t, coverage: m.coverage, fastPredicted: m.fastPredicted, fastPrecision: m.fastPrecision, frontierRecall: m.frontierRecall, accuracyOnOpinions: m.accuracyOnOpinions }
  })
}

/** Lowest threshold (highest coverage) whose fast precision is ≥ 0.95 with at least 5 fast predictions. */
export function recommend(rows: SweepRow[]): { threshold: number; why: string } {
  const ok = rows.filter((r) => r.fastPrecision !== null && r.fastPrecision >= 0.95 && r.fastPredicted >= 5)
  const best = ok[0]
  if (best) return { threshold: best.threshold, why: `lowest threshold with fast precision ≥ 0.95 (${(best.fastPrecision! * 100).toFixed(1)}% on ${best.fastPredicted} fast calls), coverage ${(best.coverage * 100).toFixed(1)}%` }
  return { threshold: 0.95, why: 'no threshold reaches fast precision ≥ 0.95 with ≥ 5 fast predictions; keep fast rules in observe' }
}

export function buildReport(results: EvalResult[]): EvalReport {
  const keys = [...new Set(results.map((r) => `${r.model}\u0000${r.variant}`))]
  const groups: ReportGroup[] = []
  const recommendation: EvalReport['recommendation'] = {}
  for (const k of keys) {
    const [model, variant] = k.split('\u0000') as [string, string]
    const mine = results.filter((r) => r.model === model && r.variant === variant)
    const datasets = [...new Set(mine.map((r) => r.dataset))]
    for (const ds of [...datasets, ...(datasets.length > 1 ? ['all'] : [])]) {
      const rs = ds === 'all' ? mine : mine.filter((r) => r.dataset === ds)
      const g: ReportGroup = { model, variant, dataset: ds, metrics: metrics(rs), sweep: sweep(rs) }
      if (ds === 'traj') g.stability = stability(rs)
      if (ds === 'hand') {
        const byCategory: NonNullable<ReportGroup['byCategory']> = {}
        for (const r of rs) {
          const c = (byCategory[r.category] ??= { n: 0, correct: 0, none: 0 })
          c.n++
          const p = predOf(r)
          if (p === r.gold) c.correct++
          if (p === 'none') c.none++
        }
        g.byCategory = byCategory
      }
      groups.push(g)
    }
    const all = groups.find((g) => g.model === model && g.variant === variant && g.dataset === (datasets.length > 1 ? 'all' : datasets[0]))
    if (all) recommendation[`${model} ${variant}`] = recommend(all.sweep)
  }
  return { schema: 'assessor-eval/v1', packVersions: [...new Set(results.map((r) => r.packVersion))], licence: SWE_LICENCE_NOTE, groups, recommendation }
}

const RANK: Record<Tier, number> = { fast: 0, standard: 1, frontier: 2 }
const isTier = (p: Pred): p is Tier => p === 'fast' || p === 'standard' || p === 'frontier'

/** Hint stability over multi-turn trajectories (consecutive turns of one session). */
export interface Stability {
  trajectories: number
  transitions: number
  /** Raw: consecutive pairs where both turns have a tier opinion. */
  bothOpinion: number
  rawFlips: number
  rawFlipRate: number | null
  /** Held: core keeps the current tier on no opinion / unavailable / precheck skip, so the served hint is the last opinion. */
  heldTransitions: number
  heldFlips: number
  heldFlipRate: number | null
  heldDownFlips: number
  /** A held downgrade reversed by an upgrade on the very next turn (oscillation). */
  heldDownThenUp: number
  /** Held flips on transitions where the gold tier did not change (spurious) vs did change. */
  spuriousFlips: number
  goldSameTransitions: number
  spuriousFlipRate: number | null
  goldChangeTransitions: number
  goldChangeFollowed: number
  goldChangeFollowRate: number | null
  /** Where flips happen: at gold-change ("boundary") transitions vs elsewhere, and by turn index (t1..tn). */
  flipsAtGoldChange: number
  flipShareAtGoldChange: number | null
  goldChangeShareOfTransitions: number | null
  flipsByTurn: number[]
  transitionsByTurn: number[]
}

export function stability(rs: EvalResult[]): Stability {
  const by = new Map<string, EvalResult[]>()
  for (const r of rs) {
    const [traj, turn] = r.itemId.split('#t')
    if (turn === undefined) continue
    by.set(traj!, [...(by.get(traj!) ?? []), r])
  }
  const st: Stability = { trajectories: by.size, transitions: 0, bothOpinion: 0, rawFlips: 0, rawFlipRate: null, heldTransitions: 0, heldFlips: 0, heldFlipRate: null,
    heldDownFlips: 0, heldDownThenUp: 0, spuriousFlips: 0, goldSameTransitions: 0, spuriousFlipRate: null, goldChangeTransitions: 0, goldChangeFollowed: 0, goldChangeFollowRate: null,
    flipsAtGoldChange: 0, flipShareAtGoldChange: null, goldChangeShareOfTransitions: null, flipsByTurn: [], transitionsByTurn: [] }
  for (const list of by.values()) {
    list.sort((a, b) => Number(a.itemId.split('#t')[1]) - Number(b.itemId.split('#t')[1]))
    const preds = list.map((r) => predOf(r))
    let held: Tier | undefined
    let lastFlipDown = false
    for (let k = 0; k < list.length; k++) {
      const p = preds[k] as Pred
      if (k > 0) {
        st.transitions++
        const prev = preds[k - 1] as Pred
        if (isTier(prev) && isTier(p)) { st.bothOpinion++; if (prev !== p) st.rawFlips++ }
      }
      const next: Tier | undefined = isTier(p) ? p : held
      if (k > 0 && held !== undefined && next !== undefined) {
        st.heldTransitions++
        st.transitionsByTurn[k] = (st.transitionsByTurn[k] ?? 0) + 1
        const goldSame = list[k]!.gold === list[k - 1]!.gold
        if (goldSame) st.goldSameTransitions++
        else st.goldChangeTransitions++
        if (next !== held) {
          st.heldFlips++
          st.flipsByTurn[k] = (st.flipsByTurn[k] ?? 0) + 1
          if (goldSame) st.spuriousFlips++
          else st.flipsAtGoldChange++
          const down = RANK[next] < RANK[held]
          if (down) st.heldDownFlips++
          if (!down && lastFlipDown) st.heldDownThenUp++
          lastFlipDown = down
        } else lastFlipDown = false
        if (!goldSame && next === list[k]!.gold) st.goldChangeFollowed++
      }
      held = next
    }
  }
  st.rawFlipRate = ratio(st.rawFlips, st.bothOpinion)
  st.heldFlipRate = ratio(st.heldFlips, st.heldTransitions)
  st.spuriousFlipRate = ratio(st.spuriousFlips, st.goldSameTransitions)
  st.goldChangeFollowRate = ratio(st.goldChangeFollowed, st.goldChangeTransitions)
  st.flipShareAtGoldChange = ratio(st.flipsAtGoldChange, st.heldFlips)
  st.goldChangeShareOfTransitions = ratio(st.goldChangeTransitions, st.heldTransitions)
  st.flipsByTurn = Array.from(st.transitionsByTurn, (_, k) => st.flipsByTurn[k] ?? 0)
  st.transitionsByTurn = Array.from(st.transitionsByTurn, (x) => x ?? 0)
  return st
}

const pct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`)
const usd = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `$${x.toFixed(6)}`)

export function renderReport(r: EvalReport): string {
  const L: string[] = ['# Tier assessor offline eval', '', `Pack: ${r.packVersions.join(', ')}`, '', `> ${r.licence}`, '']
  L.push('## Summary', '', '| model | variant | dataset | n | coverage | acc. on opinions | fast pred | **fast precision** | frontier recall | no opinion | unavailable | p50 ms | p95 ms | >1.5 s | mean $/assess | cached in |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const g of r.groups) {
    const m = g.metrics
    L.push(`| ${g.model} | ${g.variant} | ${g.dataset} | ${m.n} | ${pct(m.coverage)} | ${pct(m.accuracyOnOpinions)} | ${m.fastPredicted} | **${pct(m.fastPrecision)}** | ${pct(m.frontierRecall)} | ${pct(m.noOpinionRate)} | ${m.unavailable} | ${m.latencyP50 ?? '—'} | ${m.latencyP95 ?? '—'} | ${pct(m.over1500ms)} | ${usd(m.costMeanUsd)} | ${pct(m.cachedInputShare)} |`)
  }
  L.push('', '## Threshold recommendation', '')
  for (const [k, v] of Object.entries(r.recommendation)) L.push(`- **${k}**: ${v.threshold} — ${v.why}`)
  for (const g of r.groups) {
    const m = g.metrics
    L.push('', `## ${g.model} · ${g.variant} · ${g.dataset}`, '', '| gold \\ predicted | ' + PRED.join(' | ') + ' |', '|---|' + PRED.map(() => '---|').join(''))
    for (const gold of GOLD) L.push(`| ${gold} | ` + PRED.map((p) => m.confusion[gold][p]).join(' | ') + ' |')
    L.push('', `Cost: total ${usd(m.costTotalUsd)}, mean ${usd(m.costMeanUsd)}, p95 ${usd(m.costP95Usd)}; mean tokens in ${m.meanInputTokens?.toFixed(0) ?? '—'} / out ${m.meanOutputTokens?.toFixed(0) ?? '—'}.`)
    if (Object.keys(m.unavailableByCode).length) L.push(`Unavailable by code: ${Object.entries(m.unavailableByCode).map(([c, n]) => `${c} ${n}`).join(', ')}.`)
    if (m.fastOnSwe15min !== undefined) L.push(`Soft signal: ${m.fastOnSwe15min} fast predictions on SWE-bench '<15 min fix' items.`)
    if (m.fastFalsePositives.length) L.push(`Fast false positives: ${m.fastFalsePositives.slice(0, 30).join(', ')}${m.fastFalsePositives.length > 30 ? ', …' : ''}`)
    if (g.stability) {
      const t = g.stability
      L.push('', `Hint stability over ${t.trajectories} trajectories (${t.transitions} consecutive-turn transitions):`, '',
        '| measure | value |', '|---|---|',
        `| raw flip rate (both turns have an opinion) | ${pct(t.rawFlipRate)} (${t.rawFlips}/${t.bothOpinion}) |`,
        `| held flip rate (served hint; no opinion keeps the current tier) | ${pct(t.heldFlipRate)} (${t.heldFlips}/${t.heldTransitions}) |`,
        `| held downgrade flips | ${t.heldDownFlips} |`,
        `| downgrade reversed by an upgrade on the next turn | ${t.heldDownThenUp} |`,
        `| spurious flips (gold unchanged) | ${pct(t.spuriousFlipRate)} (${t.spuriousFlips}/${t.goldSameTransitions}) |`,
        `| gold changes followed on that turn | ${pct(t.goldChangeFollowRate)} (${t.goldChangeFollowed}/${t.goldChangeTransitions}) |`,
        `| flips at gold-change (boundary) transitions | ${pct(t.flipShareAtGoldChange)} of flips (${t.flipsAtGoldChange}/${t.heldFlips}); boundary transitions are ${pct(t.goldChangeShareOfTransitions)} of all |`,
        `| held flips by turn index (t1..t${t.transitionsByTurn.length - 1}) | ${t.transitionsByTurn.map((n, k) => (k === 0 ? null : `t${k} ${t.flipsByTurn[k] ?? 0}/${n}`)).filter(Boolean).join(', ')} |`)
    }
    if (g.byCategory) {
      L.push('', '| category | n | correct | no opinion |', '|---|---|---|---|')
      for (const [c, v] of Object.entries(g.byCategory)) L.push(`| ${c} | ${v.n} | ${v.correct} | ${v.none} |`)
    }
    L.push('', '| threshold | coverage | fast pred | fast precision | frontier recall | acc. on opinions |', '|---|---|---|---|---|---|')
    for (const s of g.sweep) L.push(`| ${s.threshold} | ${pct(s.coverage)} | ${s.fastPredicted} | ${pct(s.fastPrecision)} | ${pct(s.frontierRecall)} | ${pct(s.accuracyOnOpinions)} |`)
  }
  return L.join('\n') + '\n'
}
