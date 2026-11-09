// Bounded task card (design §3, research D §3). The request body is untrusted: only plain objects, arrays and
// strings are walked with type guards; nothing is evaluated. The card never carries the full transcript.
import { templateFamilyOf, type RequestSummary } from '@auto-router/core'
import { TIERS, type CardContext, type Tier } from './contract.ts'

export const CARD_LIMITS = {
  latestUserChars: 4000,
  firstUserChars: 1200,
  systemHeadChars: 600,
  roleLabelChars: 80,
  toolNames: 40,
  toolNameChars: 48,
  modelChars: 120,
} as const

export interface CutText { text: string; chars?: number }

export interface TaskCard {
  v: 'card/v1'
  latestUser: { text: string; chars?: number; images: number } // ≤ 4,000 chars; chars = full length if cut
  firstUser?: { text: string; chars?: number } // ≤ 1,200; omitted when it is the latest
  role: { label: string } | { systemHead: string; chars?: number } // label from config map, else system ≤ 600
  tools: { names: string[]; total: number } // ≤ 40 names, no schemas
  lineage: { kind: 'root' | 'subagent'; parentTier?: Tier }
  stats: { turnIndex: number; estPromptTokens: number; prevTurnToolCalls: number; prevTurnToolErrors: number; compactions?: number }
  current?: { model: string; tier?: Tier }
}

export type CardBuildContext = Partial<CardContext> & { roleLabels?: Record<string, string> }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const isTier = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v)

// C0 controls except \t (0x09) and \n (0x0a).
const C0 = /[\u0000-\u0008\u000b-\u001f]/g
const CLOSE_TAG = /<\/(task_card)/gi

/** NFC, C0 controls removed (except \n, \t), closing card delimiter defanged. */
export function sanitize(text: string): string {
  return text.normalize('NFC').replace(C0, '').replace(CLOSE_TAG, '<\\/$1')
}

/** dsh-style cut: keeps `{text}` when it fits, else `{text: head + '…', chars: full length}`; result ≤ limit chars. */
export function cut(text: string, limit: number): CutText {
  if (text.length <= limit) return { text }
  let head = text.slice(0, Math.max(0, limit - 1))
  // Do not leave half of a surrogate pair at the cut.
  const last = head.charCodeAt(head.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1)
  return { text: `${head}…`, chars: text.length }
}

const clean = (text: string, limit: number): CutText => cut(sanitize(text).trim(), limit)

/** One conversation message reduced to what the card needs. */
interface Msg {
  kind: 'user-text' | 'tool-result' | 'assistant' | 'other'
  text: string
  images: number
  toolCalls: number
  toolErrors: number
  /** Anthropic user message whose text was only `<system-reminder>` elements (client context, not a user turn). */
  reminderOnly?: boolean
}

interface Extracted { messages: Msg[]; system: string; tools: string[] }

/**
 * Client-injected context sent as a user message (Codex: `<environment_context>` with cwd/shell/sandbox, and
 * `<user_instructions>` from AGENTS.md). Not something the user asked: a message whose whole text is exactly one
 * such block (no images) is not a user turn, so it is neither firstUser nor counted in turnIndex.
 */
const CLIENT_CONTEXT = /^<(environment_context|user_instructions)>([\s\S]*)<\/\1>$/
export function isClientContext(text: string): boolean {
  const m = CLIENT_CONTEXT.exec(text.trim())
  return m !== null && !(m[2] as string).includes(`<${m[1]}>`) && !(m[2] as string).includes(`</${m[1]}>`)
}

/**
 * Client-injected context inside an Anthropic user message (Claude Code: `<system-reminder>` text blocks with the
 * date, CLAUDE.md / memory and reminders, sent next to the user's prompt in the same message). Complete
 * `<system-reminder>…</system-reminder>` elements are removed from the start and the end of a text, never from the
 * middle; an element with a nested open or close tag is left alone, and so is everything after it.
 */
const SR_OPEN = '<system-reminder>'
const SR_CLOSE = '</system-reminder>'
export function stripSystemReminders(text: string): string {
  let t = text.trim()
  for (;;) {
    if (t.startsWith(SR_OPEN)) {
      const end = t.indexOf(SR_CLOSE)
      if (end < 0 || t.slice(SR_OPEN.length, end).includes(SR_OPEN)) break
      t = t.slice(end + SR_CLOSE.length).trim()
    } else if (t.endsWith(SR_CLOSE)) {
      const start = t.lastIndexOf(SR_OPEN)
      if (start < 0 || t.slice(start + SR_OPEN.length, t.length - SR_CLOSE.length).includes(SR_CLOSE)) break
      t = t.slice(0, start).trim()
    } else break
  }
  return t
}

export function buildCard(summary: RequestSummary, body: unknown, ctx: CardBuildContext = {}): TaskCard {
  const b = isObj(body) ? body : {}
  const raw = summary.dialect === 'anthropic-messages' ? fromAnthropic(b) : summary.dialect === 'openai-chat' ? fromChat(b) : fromResponses(b)
  const ex: Extracted = {
    ...raw,
    messages: raw.messages.filter((m) => !(m.kind === 'user-text' && m.images === 0 && (m.reminderOnly === true || isClientContext(m.text)))),
  }

  const userIdx: number[] = []
  ex.messages.forEach((m, i) => { if (m.kind === 'user-text') userIdx.push(i) })
  const lastIdx = ex.messages.length - 1
  const latestIdx = lastIdx >= 0 && ex.messages[lastIdx]?.kind === 'user-text' ? lastIdx : -1
  const latest = latestIdx >= 0 ? ex.messages[latestIdx] : undefined

  // Previous turn: between the last-but-one user text and the latest one (or after the last user text when the
  // latest message is not user text).
  const [from, to] = latestIdx >= 0 ? [userIdx.at(-2) ?? -1, latestIdx] : [userIdx.at(-1) ?? -1, ex.messages.length]
  let prevTurnToolCalls = 0
  let prevTurnToolErrors = 0
  if (from >= 0) {
    for (let i = from + 1; i < to; i++) {
      const m = ex.messages[i]
      if (!m) continue
      prevTurnToolCalls += m.toolCalls
      prevTurnToolErrors += m.toolErrors
    }
  }

  const latestCut = clean(latest?.text ?? '', CARD_LIMITS.latestUserChars)
  const card: TaskCard = {
    v: 'card/v1',
    latestUser: { ...latestCut, images: latest?.images ?? 0 },
    role: { label: '' },
    tools: {
      names: ex.tools.slice(0, CARD_LIMITS.toolNames).map((n) => clean(n, CARD_LIMITS.toolNameChars).text),
      total: ex.tools.length,
    },
    lineage: { kind: 'root' },
    stats: {
      turnIndex: Math.max(0, userIdx.length - 1),
      estPromptTokens: nonNegInt(summary.prefix.estPromptTokens),
      prevTurnToolCalls,
      prevTurnToolErrors,
    },
  }

  const firstIdx = userIdx[0]
  if (firstIdx !== undefined && firstIdx !== latestIdx) {
    card.firstUser = clean(ex.messages[firstIdx]?.text ?? '', CARD_LIMITS.firstUserChars)
  }

  const label = ctx.roleLabels?.[templateFamilyOf(summary)]
  if (typeof label === 'string' && label.trim() !== '') card.role = { label: clean(label, CARD_LIMITS.roleLabelChars).text }
  else {
    const head = clean(ex.system, CARD_LIMITS.systemHeadChars)
    card.role = head.chars === undefined ? { systemHead: head.text } : { systemHead: head.text, chars: head.chars }
  }

  const sub = summary.hints.boundary === 'subagent-start' || Boolean(summary.hints.parentSession) || ctx.lineageKind === 'subagent'
  card.lineage = sub ? { kind: 'subagent' } : { kind: 'root' }
  if (isTier(ctx.parentTier)) card.lineage.parentTier = ctx.parentTier
  if (typeof ctx.compactions === 'number') card.stats.compactions = nonNegInt(ctx.compactions)
  if (typeof ctx.currentModel === 'string' && ctx.currentModel !== '') {
    card.current = { model: clean(ctx.currentModel, CARD_LIMITS.modelChars).text }
    if (isTier(ctx.currentTier)) card.current.tier = ctx.currentTier
  }
  return card
}

function nonNegInt(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

const joinTexts = (parts: string[]): string => parts.map((p) => p.trim()).filter((p) => p !== '').join('\n')

/** Text of a string or a block array, taking only blocks whose `type` is in `textTypes`. */
function textOf(content: unknown, textTypes: ReadonlySet<string>): string {
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const p of arr(content)) {
    if (isObj(p) && typeof p.type === 'string' && textTypes.has(p.type) && typeof p.text === 'string') parts.push(p.text)
  }
  return joinTexts(parts)
}

function countTypes(content: unknown, types: ReadonlySet<string>): number {
  let n = 0
  for (const p of arr(content)) if (isObj(p) && typeof p.type === 'string' && types.has(p.type)) n++
  return n
}

function names(tools: unknown, pick: (t: Obj) => unknown): string[] {
  const out: string[] = []
  for (const t of arr(tools)) {
    if (!isObj(t)) continue
    const n = pick(t)
    if (typeof n === 'string' && n !== '') out.push(n)
  }
  return out
}

const msg = (kind: Msg['kind'], extra: Partial<Msg> = {}): Msg => ({ kind, text: '', images: 0, toolCalls: 0, toolErrors: 0, ...extra })

// ---------- Anthropic Messages ----------
const A_TEXT = new Set(['text'])
const A_IMAGES = new Set(['image', 'document'])

function fromAnthropic(b: Obj): Extracted {
  const messages: Msg[] = []
  // Claude Code 2.1.x sends its environment block as a `system`-role message after the prompt: system text, as in
  // Chat's system/developer roles, not a conversation step (else the prompt would stop being the latest user turn).
  const extraSystem: string[] = []
  for (const m of arr(b.messages)) {
    if (!isObj(m)) { messages.push(msg('other')); continue }
    if (m.role === 'system') {
      extraSystem.push(textOf(m.content, A_TEXT))
    } else if (m.role === 'assistant') {
      messages.push(msg('assistant', { toolCalls: countTypes(m.content, new Set(['tool_use'])) }))
    } else if (m.role === 'user') {
      const blocks = arr(m.content)
      const results = blocks.filter((p) => isObj(p) && p.type === 'tool_result')
      // Same rule as core's lastTurn: any tool_result block makes it a tool-result step, not user text.
      if (results.length > 0) {
        messages.push(msg('tool-result', { toolErrors: results.filter((p) => isObj(p) && p.is_error === true).length }))
      } else {
        const text = anthropicUserText(m.content)
        const images = countTypes(m.content, A_IMAGES)
        messages.push(msg('user-text', text.reminderOnly ? { text: '', images, reminderOnly: true } : { text: text.text, images }))
      }
    } else messages.push(msg('other'))
  }
  return { messages, system: joinTexts([textOf(b.system, A_TEXT), ...extraSystem]), tools: names(b.tools, (t) => t.name) }
}

/** User text without `<system-reminder>` elements at the edges of each text block (see stripSystemReminders). */
function anthropicUserText(content: unknown): { text: string; reminderOnly: boolean } {
  if (typeof content === 'string') {
    const t = stripSystemReminders(content)
    return { text: t, reminderOnly: t === '' && content.trim() !== '' }
  }
  const parts: string[] = []
  let removed = false
  for (const p of arr(content)) {
    if (!isObj(p) || typeof p.type !== 'string' || !A_TEXT.has(p.type) || typeof p.text !== 'string') continue
    const t = stripSystemReminders(p.text)
    if (t !== p.text.trim()) removed = true
    parts.push(t)
  }
  const text = joinTexts(parts)
  return { text, reminderOnly: removed && text === '' }
}

// ---------- OpenAI Chat Completions ----------
const C_TEXT = new Set(['text'])
const C_IMAGES = new Set(['image_url', 'file'])
const SYSTEM_ROLES = new Set(['system', 'developer'])

function fromChat(b: Obj): Extracted {
  const messages: Msg[] = []
  const system: string[] = []
  for (const m of arr(b.messages)) {
    if (!isObj(m)) { messages.push(msg('other')); continue }
    if (typeof m.role === 'string' && SYSTEM_ROLES.has(m.role)) system.push(textOf(m.content, C_TEXT))
    else if (m.role === 'user') messages.push(msg('user-text', { text: textOf(m.content, C_TEXT), images: countTypes(m.content, C_IMAGES) }))
    else if (m.role === 'assistant') messages.push(msg('assistant', { toolCalls: arr(m.tool_calls).length }))
    else if (m.role === 'tool' || m.role === 'function') messages.push(msg('tool-result')) // no error flag
    else messages.push(msg('other'))
  }
  return {
    messages,
    system: joinTexts(system),
    tools: names(b.tools, (t) => (isObj(t.function) ? t.function.name : isObj(t.custom) ? t.custom.name : t.name)),
  }
}

// ---------- OpenAI Responses ----------
const R_TEXT = new Set(['input_text'])
const R_IMAGES = new Set(['input_image', 'input_file'])

function fromResponses(b: Obj): Extracted {
  const messages: Msg[] = []
  const system: string[] = []
  if (typeof b.instructions === 'string') system.push(b.instructions)
  const items: unknown[] = typeof b.input === 'string' ? [{ role: 'user', content: b.input }] : arr(b.input)
  for (const it of items) {
    if (!isObj(it)) { messages.push(msg('other')); continue }
    const type = typeof it.type === 'string' ? it.type : 'message'
    if (type === 'message' && typeof it.role === 'string' && SYSTEM_ROLES.has(it.role)) system.push(textOf(it.content, R_TEXT))
    else if (type === 'message' && it.role === 'user') {
      messages.push(msg('user-text', { text: textOf(it.content, R_TEXT), images: countTypes(it.content, R_IMAGES) }))
    } else if (type === 'message' && it.role === 'assistant') messages.push(msg('assistant'))
    else if (type.endsWith('_call_output')) messages.push(msg('tool-result')) // no error flag
    else if (type.endsWith('_call')) messages.push(msg('assistant', { toolCalls: 1 }))
    else messages.push(msg('other'))
  }
  return { messages, system: joinTexts(system), tools: names(b.tools, (t) => (typeof t.name === 'string' && t.name !== '' ? t.name : t.type)) }
}

// ---------- structural check ----------

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const fits = (v: unknown, limit: number): v is string => typeof v === 'string' && v.length <= limit
const okChars = (v: unknown): boolean => v === undefined || isCount(v)

/** Structural and bound check of an opaque card (core passes it through as `unknown`). */
export function isTaskCard(x: unknown): x is TaskCard {
  return taskCardIssue(x) === undefined
}

// The whole card is serialized into the prompt, so unknown keys would bypass the bounds: reject them at every level.
const onlyKeys = (o: Obj, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k))

/** First problem with a card, or undefined when it is a valid card/v1. */
export function taskCardIssue(x: unknown): string | undefined {
  if (!isObj(x)) return 'not an object'
  if (x.v !== 'card/v1') return 'v must be card/v1'
  if (!onlyKeys(x, ['v', 'latestUser', 'firstUser', 'role', 'tools', 'lineage', 'stats', 'current'])) return 'unexpected key'
  const lu = x.latestUser
  if (!isObj(lu) || !onlyKeys(lu, ['text', 'chars', 'images']) || !fits(lu.text, CARD_LIMITS.latestUserChars) || !isCount(lu.images) || !okChars(lu.chars)) return 'latestUser'
  if (x.firstUser !== undefined) {
    const fu = x.firstUser
    if (!isObj(fu) || !onlyKeys(fu, ['text', 'chars']) || !fits(fu.text, CARD_LIMITS.firstUserChars) || !okChars(fu.chars)) return 'firstUser'
  }
  const r = x.role
  if (!isObj(r)) return 'role'
  if ('label' in r) { if (!onlyKeys(r, ['label']) || !fits(r.label, CARD_LIMITS.roleLabelChars)) return 'role.label' }
  else if (!onlyKeys(r, ['systemHead', 'chars']) || !fits(r.systemHead, CARD_LIMITS.systemHeadChars) || !okChars(r.chars)) return 'role.systemHead'
  const t = x.tools
  if (!isObj(t) || !onlyKeys(t, ['names', 'total']) || !Array.isArray(t.names) || t.names.length > CARD_LIMITS.toolNames || !isCount(t.total)) return 'tools'
  if (!t.names.every((n) => fits(n, CARD_LIMITS.toolNameChars))) return 'tools.names'
  const l = x.lineage
  if (!isObj(l) || !onlyKeys(l, ['kind', 'parentTier']) || (l.kind !== 'root' && l.kind !== 'subagent') || (l.parentTier !== undefined && !isTier(l.parentTier))) return 'lineage'
  const s = x.stats
  if (!isObj(s) || !onlyKeys(s, ['turnIndex', 'estPromptTokens', 'prevTurnToolCalls', 'prevTurnToolErrors', 'compactions'])) return 'stats'
  for (const k of ['turnIndex', 'estPromptTokens', 'prevTurnToolCalls', 'prevTurnToolErrors'] as const) if (!isCount(s[k])) return `stats.${k}`
  if (s.compactions !== undefined && !isCount(s.compactions)) return 'stats.compactions'
  if (x.current !== undefined) {
    const c = x.current
    if (!isObj(c) || !onlyKeys(c, ['model', 'tier']) || !fits(c.model, CARD_LIMITS.modelChars) || (c.tier !== undefined && !isTier(c.tier))) return 'current'
  }
  return undefined
}
