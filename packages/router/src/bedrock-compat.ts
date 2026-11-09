// Bedrock compatibility for anthropic-messages requests (task 11-07-claude-code-harbor-eval; 0c's shape probe,
// 2026-11-07, Claude Code 2.1.318 against bedrock-runtime /anthropic/v1/messages on all three Claude 5.5 models).
// Default on; a request with nothing to fix is forwarded byte-identical (body and headers).
//
// 1. anthropic-beta: values Bedrock answers with 400 "Unexpected value(s) ... for the anthropic-beta header" are
//    removed from the header (names logged). Header only: tools and the rest of the body are never touched, and a
//    tool feature that needed a stripped beta surfaces as an upstream 400 (stop and look; never rewrite tools).
// 2. metadata.user_id: Bedrock rejects some values with 400 "Request metadata contains a value that violates the
//    regular expression". The pattern is not in the Bedrock user guide (Request and Response; Inference using
//    Anthropic Messages API), so the check is a conservative allowlist: an id of 1–256 characters from
//    [A-Za-z0-9_-] is kept as sent (a sha256 hex id was accepted in the probe); any other string is replaced by the
//    sha256 hex of its UTF-8 bytes (stable per client session). Only the top-level `metadata` member is re-spliced.
// 3. openai-chat to a GPT model: Bedrock answers 400 "Unsupported parameter: 'max_tokens' is not supported with this
//    model" (live, 2026-11-08, global.openai.gpt-6.1-sol); max_completion_tokens is accepted. Clients cannot know
//    that `auto` picks a GPT model, so the router renames the key per attempt (chatTokenLimit).
import { createHash } from 'node:crypto'
import { findModel, type PriceCatalog } from '@auto-router/pricing'
import { deleteTopLevel, renameTopLevel, spliceTopLevel, topLevelMembers } from './body.ts'

/** Observed rejected by Bedrock for every Claude 5.5 model (extend only with observed rejections). */
export const BEDROCK_BETA_STRIP: readonly string[] = ['advanced-tool-use-2025-11-20']

export const USER_ID_SAFE = /^[A-Za-z0-9_-]{1,256}$/

/** The header without stripped values (undefined: drop the header), and the names stripped; unchanged when none. */
export function stripBetas(header: string | undefined, strip: readonly string[] = BEDROCK_BETA_STRIP): { header: string | undefined; stripped: string[] } {
  if (header === undefined) return { header, stripped: [] }
  const parts = header.split(',')
  const stripped = parts.map((p) => p.trim()).filter((p) => strip.includes(p))
  if (!stripped.length) return { header, stripped }
  const kept = parts.filter((p) => !strip.includes(p.trim())).map((p) => p.trim()).filter(Boolean)
  return { header: kept.length ? kept.join(',') : undefined, stripped }
}

/** Replaces an unsafe metadata.user_id with its sha256 hex; returns the input buffer itself when nothing changes. */
export function sanitizeMetadata(raw: Buffer, body: Record<string, unknown>): { body: Buffer; edited: boolean } {
  const m = body.metadata
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return { body: raw, edited: false }
  const id = (m as Record<string, unknown>).user_id
  if (typeof id !== 'string' || USER_ID_SAFE.test(id)) return { body: raw, edited: false }
  const fixed = { ...(m as Record<string, unknown>), user_id: createHash('sha256').update(id, 'utf8').digest('hex') }
  return { body: spliceTopLevel(raw, 'metadata', JSON.stringify(fixed)), edited: true }
}

/** Code logged in RequestLog.bodyEdits for each chatTokenLimit edit. */
export type BodyEdit = 'max_tokens->max_completion_tokens' | 'max_tokens-dropped'

/**
 * A GPT model on Bedrock's Chat Completions. The catalog's `family` is the source of truth: it covers every id form
 * (global./geo profiles, base ids, a deploy's own catalog) and only the GPT family, where the 400 was observed (other
 * OpenAI-compatible families such as Kimi accept max_tokens). Ids missing from the catalog fall back to the id
 * shape `[<geo>.]openai.gpt-…`.
 */
export function isGptModel(catalog: PriceCatalog, model: string): boolean {
  const price = findModel(catalog, model)
  return price ? price.family === 'gpt' : /^(?:[a-z]+\.)?openai\.gpt-/.test(model)
}

/**
 * openai-chat to a GPT model: `max_tokens` → `max_completion_tokens` (key bytes only; the value bytes are kept), or
 * dropped when `max_completion_tokens` is also present (it wins, as in the client's own reading). Any other request
 * or target is returned as is. Duplicate members: no edit (the body goes as sent).
 */
export function chatTokenLimit(b: Buffer, model: string, catalog: PriceCatalog): { body: Buffer; edits: BodyEdit[] } {
  if (!isGptModel(catalog, model)) return { body: b, edits: [] }
  const keys = topLevelMembers(b).members.map((m) => m.key)
  const n = (k: string) => keys.filter((x) => x === k).length
  if (n('max_tokens') !== 1 || n('max_completion_tokens') > 1) return { body: b, edits: [] }
  if (n('max_completion_tokens') === 1) return { body: deleteTopLevel(b, 'max_tokens'), edits: ['max_tokens-dropped'] }
  return { body: renameTopLevel(b, 'max_tokens', 'max_completion_tokens'), edits: ['max_tokens->max_completion_tokens'] }
}
