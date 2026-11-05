import type { Segment } from './schema.ts'

/** Tokens shared by two prompts under the run-length segment rule (design §2.1). */
export function sharedPrefix(a: readonly Segment[], b: readonly Segment[]): number {
  let shared = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i]!
    const y = b[i]!
    if (x.id !== y.id) break
    shared += Math.min(x.tokens, y.tokens)
    if (x.tokens !== y.tokens) break
  }
  return shared
}

/** Keeps the first `tokens` tokens of a prompt. */
export function truncateSegments(segs: readonly Segment[], tokens: number): Segment[] {
  const out: Segment[] = []
  let left = tokens
  for (const s of segs) {
    if (left <= 0) break
    const t = Math.min(s.tokens, left)
    out.push({ id: s.id, tokens: t })
    left -= t
  }
  return out
}

export const totalTokens = (segs: readonly Segment[]): number => segs.reduce((n, s) => n + s.tokens, 0)

/** 64-bit FNV-1a over a string, as 16 hex chars (two 32-bit lanes; deterministic, not cryptographic). */
export function fnv1a64(text: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0xcbf29ce4
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c ^ (h1 >>> 7), 0x01000193) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

/**
 * Derives chained block hashes for RequestSummary.prefix.blockHashes. A block's identity is the list of
 * (segment id, offset, length) pieces it covers, chained with the previous block hash; the trailing
 * partial block is dropped. Memoized per lineage so append-only calls hash only their new blocks.
 */
export class BlockHasher {
  private readonly memo = new Map<string, { segs: Segment[]; hashes: string[] }>()
  readonly blockTokens: number
  constructor(blockTokens = 4096) {
    this.blockTokens = blockTokens
  }

  hashes(lineage: string, segs: readonly Segment[]): string[] {
    const B = this.blockTokens
    const prev = this.memo.get(lineage)
    const keep = prev ? Math.min(prev.hashes.length, Math.floor(sharedPrefix(prev.segs, segs) / B)) : 0
    const hashes = prev ? prev.hashes.slice(0, keep) : []
    const full = Math.floor(totalTokens(segs) / B)
    if (full > keep) {
      // walk segments to the start of block `keep`
      let si = 0
      let off = 0 // offset inside segs[si]
      let skip = keep * B
      while (skip > 0) {
        const s = segs[si]!
        const take = Math.min(s.tokens - off, skip)
        skip -= take
        off += take
        if (off === s.tokens) {
          si++
          off = 0
        }
      }
      for (let b = keep; b < full; b++) {
        let need = B
        let desc = hashes[b - 1] ?? 'root'
        while (need > 0) {
          const s = segs[si]!
          const take = Math.min(s.tokens - off, need)
          desc += `|${s.id}@${off}+${take}`
          need -= take
          off += take
          if (off === s.tokens) {
            si++
            off = 0
          }
        }
        hashes.push(fnv1a64(desc))
      }
    }
    this.memo.set(lineage, { segs: segs.map((s) => ({ ...s })), hashes })
    return hashes
  }

  forget(lineage: string): void {
    this.memo.delete(lineage)
  }
}
