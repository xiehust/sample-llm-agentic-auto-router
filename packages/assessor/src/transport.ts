// Injected HTTP transport (design §5). The data plane supplies SigV4 HTTP to bedrock-runtime; tests use fakeTransport.

export interface TransportRequest { path: string; body: string; headers: Record<string, string>; signal: AbortSignal }
export interface TransportResponse { status: number; body: string }
export type Transport = (req: TransportRequest) => Promise<TransportResponse>

/** One scripted reply: a response (body objects are JSON-encoded), or an error; optionally after a delay. */
export type FakeStep =
  | { status?: number; body: unknown; delayMs?: number }
  | { error: unknown; delayMs?: number }

export type FakeTransport = Transport & { readonly calls: TransportRequest[] }

/**
 * A scripted transport. `script` is a list consumed in order (the last step repeats when exhausted), or a function of
 * the request and its call index. Delays use setTimeout (so fake timers work) and reject with the signal's reason
 * when it aborts.
 */
export function fakeTransport(script: FakeStep[] | ((req: TransportRequest, index: number) => FakeStep)): FakeTransport {
  const calls: TransportRequest[] = []
  const fn = async (req: TransportRequest): Promise<TransportResponse> => {
    const index = calls.length
    calls.push(req)
    const step = typeof script === 'function' ? script(req, index) : script[Math.min(index, script.length - 1)]
    if (!step) throw new Error('fakeTransport: empty script')
    if (req.signal.aborted) throw req.signal.reason
    if (step.delayMs !== undefined && step.delayMs > 0) await delay(step.delayMs, req.signal)
    if ('error' in step) throw step.error
    return { status: step.status ?? 200, body: typeof step.body === 'string' ? step.body : JSON.stringify(step.body) }
  }
  return Object.assign(fn, { calls })
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
