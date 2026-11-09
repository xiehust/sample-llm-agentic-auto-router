// Runtime configuration source (admin console design §1, §2.1): the router polls a few small S3 objects through
// the S3 gateway endpoint with If-None-Match, every 30 s. No AWS SDK: one signed GET per object. The fetcher is
// injected, so tests never reach AWS.
import type { Signer } from './forward.ts'

export type FetchResult =
  | { status: 'ok'; body: string; etag: string }
  | { status: 'not-modified' }
  | { status: 'absent' }
  | { status: 'error'; code: string }

/** GET one object; `etag` is the last one seen (sent as If-None-Match). Never throws. */
export type ObjectFetcher = (key: string, etag: string | undefined) => Promise<FetchResult>

/** Largest object accepted (a config document is a few KiB; principals.json grows with members). */
export const MAX_OBJECT_BYTES = 2 * 1024 * 1024
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

export interface S3FetcherOptions {
  bucket: string
  region: string
  /** A signer for service 's3' (createSigV4Signer(region, credentials, 's3')). */
  signer: Signer
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/** Signed S3 GetObject over the regional virtual-hosted endpoint (reached through the VPC gateway endpoint). */
export function s3Fetcher(o: S3FetcherOptions): ObjectFetcher {
  const f = o.fetchImpl ?? fetch
  const base = `https://${o.bucket}.s3.${o.region}.amazonaws.com/`
  return async (key, etag) => {
    try {
      const url = new URL(key.split('/').map(encodeURIComponent).join('/'), base)
      const headers: Record<string, string> = { 'x-amz-content-sha256': EMPTY_SHA256 }
      if (etag) headers['if-none-match'] = etag
      const signed = await o.signer.sign({ method: 'GET', url, headers, body: new Uint8Array() })
      const res = await f(url, { method: 'GET', headers: signed, signal: AbortSignal.timeout(o.timeoutMs ?? 5000) })
      if (res.status === 304) { await res.body?.cancel(); return { status: 'not-modified' } }
      // A missing key is 404 only when the role may ListBucket on the prefix; otherwise S3 answers 403, which stays an
      // error (a missing grant must not look like "no document").
      if (res.status === 404) { await res.body?.cancel(); return { status: 'absent' } }
      if (res.status !== 200) { await res.body?.cancel(); return { status: 'error', code: `s3-${res.status}` } }
      const len = Number(res.headers.get('content-length') ?? '0')
      if (len > MAX_OBJECT_BYTES) { await res.body?.cancel(); return { status: 'error', code: 'too-large' } }
      const body = await res.text()
      if (Buffer.byteLength(body) > MAX_OBJECT_BYTES) return { status: 'error', code: 'too-large' }
      return { status: 'ok', body, etag: res.headers.get('etag') ?? '' }
    } catch (e) {
      return { status: 'error', code: (e as Error).name === 'TimeoutError' ? 'timeout' : 'network' }
    }
  }
}

export interface Watch {
  key: string
  /**
   * A new object version (body + etag). The etag is stored whatever the handler does, so a rejected object is not
   * re-applied (and re-logged) on every poll; the next change gets a new etag.
   */
  onObject(body: string, etag: string): void
  /** The object does not exist (first time per absence only). */
  onAbsent?(): void
  /** A fetch error (first time per error streak only). */
  onError?(code: string): void
}

export interface Poller {
  /** Polls every watch once (sequentially). Boot awaits this before listening. */
  pollOnce(): Promise<void>
  start(): void
  stop(): void
}

/**
 * Polls each watched key every `intervalMs` (+ up to 10 % jitter, so tasks do not align). A rejected document is
 * still remembered by etag, so the same bad object is not re-applied and re-logged every 30 s.
 */
export function createPoller(fetcher: ObjectFetcher, watches: Watch[], intervalMs: number,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void } = {
    set: (fn, ms) => setTimeout(fn, ms).unref(), clear: (t) => clearTimeout(t as NodeJS.Timeout) }): Poller {
  const state = new Map<string, { etag?: string; absent?: boolean; error?: string }>()
  let timer: unknown
  let running = false
  let busy: Promise<void> | undefined
  async function pollOnce(): Promise<void> {
    if (busy) return busy
    busy = (async () => {
      for (const w of watches) {
        const st = state.get(w.key) ?? {}
        const r = await fetcher(w.key, st.etag)
        if (r.status === 'ok') {
          state.set(w.key, { etag: r.etag })
          if (r.etag !== st.etag || st.etag === undefined) {
            try { w.onObject(r.body, r.etag) } catch { /* handlers log their own failures */ }
          }
        } else if (r.status === 'absent') {
          if (!st.absent) { state.set(w.key, { absent: true }); w.onAbsent?.() }
        } else if (r.status === 'error') {
          if (st.error !== r.code) { state.set(w.key, { ...st, error: r.code }); w.onError?.(r.code) }
        } else if (st.error !== undefined || st.absent) {
          state.set(w.key, { ...(st.etag !== undefined ? { etag: st.etag } : {}) })
        }
      }
    })().finally(() => { busy = undefined })
    return busy
  }
  const schedule = (): void => {
    if (!running) return
    timer = timers.set(() => { void pollOnce().finally(schedule) }, intervalMs + Math.floor(Math.random() * intervalMs * 0.1))
  }
  return {
    pollOnce,
    start() { if (!running) { running = true; schedule() } },
    stop() { running = false; if (timer !== undefined) timers.clear(timer) },
  }
}
