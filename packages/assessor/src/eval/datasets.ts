// Eval datasets (design §10.1). Data files are untrusted: parsed with JSON.parse only, fields allowlisted.
// Every item is turned into a realistic Anthropic Messages request and goes through the real buildCard() path.
import { readFileSync } from 'node:fs'
import { templateFamilyOf, type RequestSummary } from '@auto-router/core'
import { buildCard, type TaskCard } from '../card.ts'
import type { Tier } from '../contract.ts'

export interface EvalItem {
  id: string
  dataset: 'swebench' | 'hand' | 'traj'
  category: string
  gold: Tier
  card: TaskCard
}

const TIERS = new Set<Tier>(['fast', 'standard', 'frontier'])
const SYSTEM = 'You are an autonomous coding agent working in the user\'s repository. Use the tools to read, edit and test code.'
const TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'Task', 'TodoWrite', 'NotebookEdit']
const SUMMARY_BASE: RequestSummary = {
  dialect: 'anthropic-messages',
  requestedModel: 'auto',
  session: { root: 'eval', lineage: 'eval', source: 'header' },
  lastTurn: 'user-text',
  nonPortableState: [],
  prefix: { toolsHash: 'eval-tools', systemHash: 'eval-system', blockHashes: [], estPromptTokens: 0, messageCount: 0 },
  hints: {},
  receivedAt: 0,
}
const ROLE_LABELS = { [templateFamilyOf(SUMMARY_BASE)]: 'coding-agent' }
const CURRENT = 'global.anthropic.claude-sonnet-5-5'

export interface Scenario {
  latest: string
  first?: string
  lineage: 'root' | 'subagent'
  turnIndex: number
  prevTurnToolCalls?: number
  prevTurnToolErrors?: number
}

/** Builds the Messages body for a scenario and runs it through buildCard (the production card path). */
export function scenarioCard(s: Scenario): TaskCard {
  const messages: unknown[] = []
  const first = s.first ?? s.latest
  if (s.turnIndex > 0) {
    messages.push({ role: 'user', content: first })
    // Earlier turns (beyond the previous one) collapse to a text exchange.
    for (let t = 1; t < s.turnIndex; t++) {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Done.' }] })
      messages.push({ role: 'user', content: 'ok, next step' })
    }
    const calls = s.prevTurnToolCalls ?? 0
    const errs = Math.min(calls, s.prevTurnToolErrors ?? 0)
    if (calls > 0) {
      messages.push({ role: 'assistant', content: Array.from({ length: calls }, (_, i) => ({ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'npm test' } })) })
      messages.push({ role: 'user', content: Array.from({ length: calls }, (_, i) => ({ type: 'tool_result', tool_use_id: `t${i}`, is_error: i < errs, content: i < errs ? 'Error: test failed' : 'ok' })) })
    }
    messages.push({ role: 'assistant', content: [{ type: 'text', text: 'I made the change and ran the tests.' }] })
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: s.latest }] })
  const body = { model: 'auto', system: SYSTEM, tools: TOOLS.map((name) => ({ name, input_schema: { type: 'object' } })), messages, max_tokens: 8000 }
  const summary: RequestSummary = {
    ...SUMMARY_BASE,
    prefix: { ...SUMMARY_BASE.prefix, estPromptTokens: 14_000 + Math.round(JSON.stringify(messages).length / 4), messageCount: messages.length },
    hints: s.lineage === 'subagent' ? { boundary: 'subagent-start', parentSession: 'eval-parent' } : {},
  }
  return buildCard(summary, body, {
    roleLabels: ROLE_LABELS,
    lineageKind: s.lineage,
    compactions: 0,
    ...(s.lineage === 'subagent' ? { parentTier: 'standard' as const } : {}),
    ...(s.turnIndex > 0 || s.lineage === 'subagent' ? { currentModel: CURRENT, currentTier: 'standard' as const } : {}),
  })
}

const str = (o: Record<string, unknown>, k: string): string => {
  const v = o[k]
  if (typeof v !== 'string' || v.length === 0) throw new Error(`field ${k} must be a non-empty string`)
  return v
}
const int = (o: Record<string, unknown>, k: string, dflt: number): number => {
  const v = o[k]
  if (v === undefined) return dflt
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1000) throw new Error(`field ${k} must be an integer 0..1000`)
  return v
}

function lines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l, i) => {
    const v: unknown = JSON.parse(l)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${path}:${i + 1}: not an object`)
    return v as Record<string, unknown>
  })
}

export const SWE_DIFFICULTY: Record<string, Tier> = {
  '<15 min fix': 'standard',
  '15 min - 1 hour': 'standard',
  '1-4 hours': 'frontier',
  '>4 hours': 'frontier',
}

/** SWE-bench Verified rows (data/swebench-verified/rows.jsonl): problem statement as a turn-0 root request. */
export function parseSwebench(path: string): EvalItem[] {
  return lines(path).map((o, i) => {
    try {
      const difficulty = str(o, 'difficulty')
      const gold = SWE_DIFFICULTY[difficulty]
      if (!gold) throw new Error(`unknown difficulty ${difficulty.slice(0, 40)}`)
      const statement = str(o, 'problem_statement')
      return { id: `swe:${str(o, 'instance_id')}`, dataset: 'swebench' as const, category: difficulty, gold, card: scenarioCard({ latest: statement, lineage: 'root', turnIndex: 0 }) }
    } catch (e) {
      throw new Error(`${path}:${i + 1}: ${(e as Error).message}`)
    }
  })
}

export interface HandItem extends Scenario { id: string; category: string; gold: Tier }

export function parseHandItems(path: string): HandItem[] {
  return lines(path).map((o, i) => {
    try {
      const gold = str(o, 'gold') as Tier
      if (!TIERS.has(gold)) throw new Error(`bad gold ${gold}`)
      const lineage = o.lineage === undefined ? 'root' : str(o, 'lineage')
      if (lineage !== 'root' && lineage !== 'subagent') throw new Error(`bad lineage ${lineage}`)
      const first = o.first === undefined ? undefined : str(o, 'first')
      return {
        id: str(o, 'id'), category: str(o, 'category'), gold, latest: str(o, 'latest'), lineage,
        turnIndex: int(o, 'turnIndex', 0), prevTurnToolCalls: int(o, 'prevTurnToolCalls', 0), prevTurnToolErrors: int(o, 'prevTurnToolErrors', 0),
        ...(first !== undefined ? { first } : {}),
      }
    } catch (e) {
      throw new Error(`${path}:${i + 1}: ${(e as Error).message}`)
    }
  })
}

export function handItems(path: string): EvalItem[] {
  return parseHandItems(path).map((h) => ({ id: h.id, dataset: 'hand' as const, category: h.category, gold: h.gold, card: scenarioCard(h) }))
}

/**
 * Multi-turn trajectories (eval/trajectories.v1.jsonl) for hint stability: each turn becomes a card with the
 * trajectory's first request as task framing and the turn index set. Ids are `<trajectory>#t<turn>`.
 */
export function trajectoryItems(path: string): EvalItem[] {
  return lines(path).flatMap((o, i) => {
    try {
      const id = str(o, 'id')
      const turns = o.turns
      if (!Array.isArray(turns) || turns.length < 2 || turns.length > 20) throw new Error('turns must be an array of 2..20')
      const parsed = turns.map((t: unknown) => {
        if (typeof t !== 'object' || t === null) throw new Error('turn is not an object')
        const tt = t as Record<string, unknown>
        const gold = str(tt, 'gold') as Tier
        if (!TIERS.has(gold)) throw new Error(`bad gold ${gold}`)
        return { latest: str(tt, 'latest'), gold }
      })
      const first = parsed[0]!.latest
      return parsed.map((t, k) => ({
        id: `${id}#t${k}`, dataset: 'traj' as const, category: id, gold: t.gold,
        card: scenarioCard({ latest: t.latest, ...(k > 0 ? { first } : {}), lineage: 'root', turnIndex: k, prevTurnToolCalls: k > 0 ? 5 : 0 }),
      }))
    } catch (e) {
      throw new Error(`${path}:${i + 1}: ${(e as Error).message}`)
    }
  })
}

/**
 * Deterministic SWE-bench split for prompt iteration: 'dev' items may be looked at while tuning a pack, 'test' items
 * are held out. About half of the 45 frontier-gold items and a sixth of the standard-gold items are dev.
 */
export function sweSplit(item: Pick<EvalItem, 'id' | 'gold'>): 'dev' | 'test' {
  let h = 2166136261
  for (let i = 0; i < item.id.length; i++) h = Math.imul(h ^ item.id.charCodeAt(i), 16777619) >>> 0
  return h % (item.gold === 'frontier' ? 2 : 6) === 0 ? 'dev' : 'test'
}
