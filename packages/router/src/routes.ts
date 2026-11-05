// Path -> dialect (design §2.1 routes.ts). Responses GET/DELETE/cancel are out of the MVP and return 404.
// GET /v1/models answers the gateway's model discovery for inference provider targets (V9 finding), behind hop auth.
import type { Dialect } from '@auto-router/pricing'

export type Route =
  | { kind: 'health' }
  | { kind: 'models' }
  | { kind: 'model'; dialect: Dialect; upstreamPath: string }
  | { kind: 'not-found' }

const MODEL_ROUTES: Record<string, { dialect: Dialect; upstreamPath: string }> = {
  '/v1/messages': { dialect: 'anthropic-messages', upstreamPath: '/anthropic/v1/messages' },
  '/v1/chat/completions': { dialect: 'openai-chat', upstreamPath: '/openai/v1/chat/completions' },
  '/v1/responses': { dialect: 'openai-responses', upstreamPath: '/openai/v1/responses' },
}

export function routeOf(method: string | undefined, url: string | undefined): Route {
  const path = (url ?? '/').split('?', 1)[0] as string
  if (method === 'GET' && path === '/healthz') return { kind: 'health' }
  if (method === 'GET' && path === '/v1/models') return { kind: 'models' }
  const r = method === 'POST' ? MODEL_ROUTES[path] : undefined
  return r ? { kind: 'model', ...r } : { kind: 'not-found' }
}
