import type { LastTurn } from '../types.ts'

/** What a dialect extractor pulls out of a request body; the common code hashes and counts it. */
export interface Extracted {
  /** Cache-relevant request params folded into the chain seed (a change ⇒ prefix reset). */
  params: unknown[]
  tools: unknown
  system: unknown
  /** Remaining message / input items, in order; one chain block each. */
  messages: unknown[]
  /** Index into `messages` of the first user message (fingerprint), or -1. */
  firstUserIndex: number
  lastTurn: LastTurn
  nonPortableState: string[]
  previousResponseId?: string
  promptCacheKey?: string
  /** Requested output cap, if the body names one (finite, ≥ 0). */
  maxOutputTokens?: number
}

export type Obj = Record<string, unknown>
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
export const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
/** First argument that is a finite non-negative number. */
export const count = (...vs: unknown[]): number | undefined => {
  for (const v of vs) if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  return undefined
}
