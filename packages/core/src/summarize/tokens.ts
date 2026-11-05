// Default token estimator and media handling (core design.md §3.3).

/** Default estimator: ceil(chars / 4). Pluggable via createEngine({ estimateTokens }). */
export const defaultEstimateTokens = (text: string): number => Math.ceil(text.length / 4)

/** Flat token cost of one base64 image/document/audio payload (instead of counting its length). */
export const MEDIA_TOKENS = 1600

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/**
 * Collects inline media payload strings (base64 / data: URLs) in a message's content parts, one nesting
 * level deep (tool_result / function_call_output content arrays). Shallow on purpose: it runs per message.
 */
export function collectMedia(message: unknown, out: Set<string>): void {
  if (!isObj(message)) return
  const content = (message as { content?: unknown }).content ?? (message as { output?: unknown }).output
  if (!Array.isArray(content)) return
  for (const part of content) {
    mediaOfPart(part, out)
    if (isObj(part)) {
      const nested = (part as { content?: unknown }).content ?? (part as { output?: unknown }).output
      if (Array.isArray(nested)) for (const n of nested) mediaOfPart(n, out)
    }
  }
}

function mediaOfPart(part: unknown, out: Set<string>): void {
  if (!isObj(part)) return
  const p = part as Record<string, unknown>
  // Anthropic: { type: 'image'|'document', source: { type: 'base64', data } }
  const src = p.source
  if (isObj(src) && src.type === 'base64' && typeof src.data === 'string') out.add(src.data)
  // Chat: { image_url: { url: 'data:...' } }; Responses: { image_url: 'data:...' }
  const img = p.image_url
  if (typeof img === 'string' && img.startsWith('data:')) out.add(img)
  else if (isObj(img) && typeof img.url === 'string' && img.url.startsWith('data:')) out.add(img.url)
  // Responses input_file: { file_data }; Chat file part: { file: { file_data } }; audio: { input_audio: { data } }
  if (typeof p.file_data === 'string') out.add(p.file_data)
  if (isObj(p.file) && typeof p.file.file_data === 'string') out.add(p.file.file_data)
  if (isObj(p.input_audio) && typeof p.input_audio.data === 'string') out.add(p.input_audio.data)
}

/**
 * Tokens of one serialized block. Blocks with inline media are re-serialized with the payloads blanked
 * (only those blocks pay the second stringify), then each payload adds MEDIA_TOKENS.
 */
export function blockTokens(block: unknown, json: string, estimate: (text: string) => number): number {
  const media = new Set<string>()
  collectMedia(block, media)
  if (media.size === 0) return estimate(json)
  const stripped = JSON.stringify(block, (_k, v: unknown) => (typeof v === 'string' && media.has(v) ? '' : v))
  return estimate(stripped) + media.size * MEDIA_TOKENS
}
