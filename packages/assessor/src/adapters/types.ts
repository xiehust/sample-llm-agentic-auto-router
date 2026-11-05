import type { Dialect } from '@auto-router/pricing'
import type { JsonSchema } from '../schema.ts'

export interface AdapterCfg {
  maxOutputTokens: number
  /** OpenAI shapes: reasoning effort; null omits the field. */
  reasoningEffort: string | null
  /** Responses: send prompt_cache_key; Messages: cache_control breakpoint on the system block. */
  cache: boolean
  packVersion: string
}

export interface BuildParams { model: string; system: string; user: string; schema: JsonSchema; cfg: AdapterCfg }

/** `reason` starts with one of the assessor status codes: 'refusal', 'incomplete' or 'parse'. */
export type ParseResult = { ok: true; raw: unknown } | { ok: false; reason: string }

export interface ModelAdapter {
  readonly dialect: Dialect
  buildRequest(p: BuildParams): { path: string; body: unknown }
  parse(body: unknown): ParseResult
}

export const SCHEMA_NAME = 'tier_assessment'
export const TOOL_NAME = 'record_tier_assessment'

export type Obj = Record<string, unknown>
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export function parseJsonText(text: string): ParseResult {
  try {
    return { ok: true, raw: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, reason: 'parse: output text is not JSON' }
  }
}
