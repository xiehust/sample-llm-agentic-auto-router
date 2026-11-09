# Design: cache-aware agentic LLM auto router

## 1. Why this shape (decision summary)

Facts that drive the design (sources in `research/`):

- Prompt cache never crosses models, versions or regions. Bedrock keeps a cache entry on the server that
  served the request; there is no affinity key. Global profiles are 10% cheaper and may raise cache writes.
- Agent traffic: 90–98% hit rate inside a turn (gaps ~1 s), ~55% across turns (cliff at the 5-minute
  TTL), ~8% right after a switch to a new model. Most real switches come from failover.
- Switching to model B costs one cold write of the context on B; A's cache stays warm until its TTL, so a
  switch back only rewrites what was appended meanwhile (fragmentation).
- On Claude, changing tools invalidates everything; changing thinking/effort invalidates the messages
  layer (on Bedrock; Anthropic 1P exempts Claude 5.5 effort changes).
- Pass-through pools on Bedrock (A2): Messages = Claude only; Chat Completions / Responses = GPT, Kimi and
  other OpenAI-compatible models (no Claude, no Nova). Responses is stateful (`store` defaults to true).
- Production products switch only at cache boundaries (Copilot: first turn and after compaction;
  Cognition: at compaction); harness-side routers (Factory, Augment) price cache loss explicitly.

Break-even of a first switch (Bedrock global prices 2026-11-04; per step +1K new tokens, 250 output):

| Switch | 50K context | 150K context |
|---|---|---|
| Same family one tier down (Opus 5.5→Sonnet 5.5, GPT-6.1 Sol→Terra) | 11 steps | 17 steps |
| Down to floor tier (Haiku 5.5, GPT-6 Luna) | cheaper from the first step | Luna immediately; Haiku 2–7 steps (×5 above 100K) |
| Up (Sonnet 5.5→Opus 5.5) | +$0.25 one-time, never recovered | +$0.74, never recovered |

## 2. Topology

```
Agent (Anthropic / OpenAI SDK)
  │  https://{gw}.gateway.bedrock-agentcore.ap-northeast-1.amazonaws.com/inference/v1/...
  ▼
AgentCore Gateway        inbound auth (IAM/JWT) · rate limits · Policy · Guardrails · routing logs
  │  rule: matchModels → staticRoute "router" (fallback → bedrock-runtime target, pinned model)
  ▼  inference provider target "router" (pass-through), outbound SigV4 (to be proven by spike V0)
@auto-router/router      summarize → decide → forward → account (uses core + pricing)
  │  only the model field changes (+ opt-in cache hints); SigV4 with its own role
  ▼
Bedrock runtime          /anthropic/v1/messages · /openai/v1/chat/completions · /openai/v1/responses
```

The gateway owns identity, governance and coarse failover. The router owns everything cache-related:
lineage, break points, per-model cache state, switch economics, TTL/breakpoint hints, usage feedback.
Gateway weighted routes and model-changing fallback are never used for model selection.

## 3. Contracts between packages

Owners: `@auto-router/pricing` → pricing-usage; `@auto-router/core` → router-core;
`@auto-router/replay` → replay-evaluator. Changing a contract needs a note in the parent task first.

```ts
// ---------- @auto-router/pricing ----------
export type Dialect = 'anthropic-messages' | 'openai-chat' | 'openai-responses'
export type CacheTtl = '5m' | '1h' | '30m' | '12h'

export interface NormalizedUsage {
  uncachedInputTokens: number                         // billed at base input price
  cacheReadTokens: number
  cacheWriteTokens: Partial<Record<CacheTtl, number>> // by TTL
  outputTokens: number                                // billed output, reasoning included
  reasoningTokens?: number
  promptTokens: number                                // uncached + read + written (tier selection)
}

export interface UsdPerMTok { input: number; output: number; cacheRead: number; cacheWrite: Partial<Record<CacheTtl, number>> }

export interface ModelPrice {
  modelId: string                    // Bedrock model or inference profile id
  family: 'claude' | 'gpt' | 'kimi' | 'nova' | 'other'
  tier: 'frontier' | 'standard' | 'fast'
  dialects: Dialect[]                // APIs that reach it on bedrock-runtime
  endpointScope: 'global' | 'geo' | 'in-region'
  contextWindow: number
  price: UsdPerMTok
  longContext?: { aboveTokens: number; price: UsdPerMTok }   // whole request re-priced above threshold
  cache: { mode: 'explicit' | 'implicit' | 'both' | 'none'; minTokens: number; ttls: CacheTtl[]; defaultTtl: CacheTtl }
}

export interface PriceCatalog { version: string; asOf: string; source: string; region: string; models: ModelPrice[] }
export interface CostBreakdown { input: number; cacheRead: number; cacheWrite: number; output: number; total: number; tier: 'base' | 'long' }

export function loadCatalog(): PriceCatalog
export function normalizeUsage(dialect: Dialect, responseBody: unknown): NormalizedUsage
export interface StreamUsageAccumulator { push(event: { event?: string; data: string }): void; result(): NormalizedUsage | undefined }
export function createStreamUsageAccumulator(dialect: Dialect): StreamUsageAccumulator
export function costOf(usage: NormalizedUsage, price: ModelPrice): CostBreakdown

// ---------- @auto-router/core ----------
export interface SessionKey { root: string; lineage: string; source: 'header' | 'cooperative' | 'fingerprint' }
export type LastTurn = 'user-text' | 'tool-result' | 'assistant' | 'other'

export interface RequestSummary {
  dialect: Dialect
  requestedModel: string
  session: SessionKey
  lastTurn: LastTurn
  previousResponseId?: string
  nonPortableState: string[]         // e.g. 'anthropic-thinking-signature', 'openai-encrypted-reasoning'
  prefix: { toolsHash: string; systemHash: string; blockHashes: string[]; estPromptTokens: number; messageCount: number }
  hints: { pin?: string; tier?: string; boundary?: 'compaction' | 'subagent-start' | 'task-start'; parentSession?: string; agentId?: string }
  receivedAt: number                 // epoch ms
}

export type DecisionPoint =
  | 'pinned' | 'hard-lock-tool-loop' | 'hard-lock-response-chain' | 'hard-lock-state'
  | 'session-start' | 'subagent-start' | 'idle-expired' | 'compaction' | 'user-turn' | 'failover'

export interface Decision {
  action: 'initialize' | 'retain' | 'switch' | 'pin'
  model: string                      // concrete Bedrock id to call
  point: DecisionPoint
  reason: string                     // '<code>: <text>'
  policyVersion: string
  mode: 'observe' | 'auto'
  wouldChoose?: string               // observe mode: what auto would have picked
  estimate?: { stayUsd: number; switchUsd: number; horizonCalls: number }
}

export interface CacheState { model: string; cachedPrefixHash?: string; cachedTokens: number; lastTouchMs: number; ttlMs: number }
export interface SessionState { key: SessionKey; current?: string; perModel: Record<string, CacheState>; turns: number; switches: number; lastSeenMs: number; lastPrefixHash?: string }
export interface StateStore { get(lineage: string): Promise<SessionState | undefined>; put(state: SessionState): Promise<void> }

export interface Engine {
  summarize(dialect: Dialect, body: unknown, headers: Record<string, string | undefined>, nowMs: number): RequestSummary
  decide(summary: RequestSummary): Promise<Decision>
  record(summary: RequestSummary, decision: Decision, outcome: { servedModel: string; status: number; usage?: NormalizedUsage; responseId?: string }): Promise<RecordResult>
}
export function createEngine(opts: { policy: Policy; catalog: PriceCatalog; store: StateStore; now?: () => number; estimateTokens?: (text: string) => number }): Engine
// Policy and RecordResult (miss attribution) shapes are owned by router-core and documented in its design.md.
// Approved additive changes (2026-11-04, router-core C1–C5): estimateTokens option; DecisionPoint adds
// 'task-start' | 'prefix-reset'; outcome.responseId; record returns RecordResult; SessionState gains optional
// calls / lastSwitchTurn / costSwitches / lastFailure / lastMiss.
// Per-call cost always goes through @auto-router/pricing costOf (single source of tier/TTL rules).
// Approved 2026-11-04 (router-core round 2): StateStore gains a root index (noteRoot or equivalent) so a new
// lineage under a seen root is 'subagent-start'; x-claude-code-parent-agent-id is a parentSession hint;
// previous_response_id without router state locks to the dialect default ('chain-state-missing'); per
// (lineage, model) up to 4 prefix records (LRU) so forks do not evict the parent.

// ---------- tier assessor hook (approved 2026-11-04; interface in core, implementation in @auto-router/assessor) ----------
export interface TierAssessor {
  readonly id: string                                   // e.g. 'assessor/v1@global.openai.gpt-6-luna'
  assess(card: unknown, signal: AbortSignal): Promise<AssessorResult>   // card is opaque to core
}
export type AssessorResult =
  | { status: 'ok'; tier?: Tier; confidence: number; audit: Record<string, unknown>; latencyMs: number; costUsd?: number }
  | { status: 'unavailable'; reason: string; latencyMs: number }
// createEngine opts: assessor?: TierAssessor; assessorMode?: 'off' | 'observe' | 'auto' (default 'observe');
//   assessorTimeoutMs?: number (default 5000; 1500 until 2026-11-05); assessorMinConfidence?: number (default 0.8)
//   assessorDowngradeFrom?: Tier[] (default ['standard']; added 2026-11-04 after the assessor eval: 0/45 frontier on
//   SWE-bench) — an assessor-driven downgrade applies only from a listed tier ("from" = current model tier, else the
//   pool default at a start point); otherwise the opinion is clamped to "from" (retain), applied=false,
//   Assessment.guard = 'assessor-downgrade-guarded'. Upgrades and client/alias/rule tiers are unaffected.
// Engine.decide(summary, extras?: { card?: (ctx: CardContext) => unknown })   // amended 2026-11-04: core passes
//   CardContext { currentModel?, currentTier?, parentTier?, compactions, lineageKind } into the thunk
//   // lazy: core builds the card only when it consults
//   the assessor (session start, sub-agent start, user turn, after hint/alias/rules found nothing), caches the
//   result per (lineage, user turn), and treats timeout/unavailable as "no opinion".
// Decision gains optional assessment?: { assessorId; status: 'ok'|'unavailable'|'timeout'|'error'|'invalid'; tier?;
//   confidence?; latencyMs; applied: boolean; cached?: true; costUsd?: number }
//   amended 2026-11-04: costUsd copies AssessorResult.costUsd (finite ≥ 0) for router spend accounting; set only on
//   the decision that called the assessor (never with cached), so spend is counted once. `audit` is deliberately
//   NOT carried: it can quote untrusted prompt text; the assessor logs it through its own sink.
// @auto-router/assessor exports buildCard(summary, body) and createAssessor({ model, transport, pack }); the
// default model is global.openai.gpt-6-luna; Claude lite models (global.anthropic.claude-haiku-5-5) use the
// Messages forced-tool adapter. The data plane injects the SigV4 transport.
```

## 4. Repository layout and conventions

```
package.json, pnpm-workspace.yaml, tsconfig.base.json   (root, created by the parent; peers do not edit)
packages/pricing   @auto-router/pricing   (no runtime deps)
packages/core      @auto-router/core      (no runtime deps; depends on pricing types)
packages/replay    @auto-router/replay    (CLI; trace adapters)
packages/router    @auto-router/router    (later)
infra/             CDK app                (later)
spikes/agentcore-gateway/                 (spike scripts, template, findings)
```

- ESM, TypeScript strict, Node 24; relative imports with `.ts` extensions; tests with vitest next to
  sources (`src/**/*.test.ts`); build output in `lib/` (gitignored).
- Root dev dependencies are installed once by the parent. A child that needs a new dependency asks the
  parent session first to avoid lockfile conflicts between parallel sessions.
- No commits from child sessions; the parent integrates and commits after review.

## 5. Decision logic (summary; detail in router-core design)

| Request | Detected by | Action |
|---|---|---|
| Pinned | concrete model id or `x-router-pin` | forward as is, account only |
| Hard lock | last message is a tool result; `previous_response_id`; non-portable state | keep current model |
| Free break point | first request of lineage; new system/tools fingerprint or sub-agent hint; idle > TTL; prefix no longer extends the last one (compaction) | full decision, no switch cost |
| User turn | last message is user text | switch only if `cost(stay, H) − cost(switch, H) > max(minUsd, (k−1)·cost(switch, H))` |
| Failover | 429/5xx from Bedrock | same model other profile first; stay there until the next break point |

`cost(m, H)` sums over the expected remaining calls H: warm prefix × read, cold prefix × write (per model,
fragmentation included), new tokens × write, output × output price, using the long-context tier when the
prompt crosses it. Upgrades are quality-driven (tier hint, failure signals), not cost-driven.

## 6. Spike outcomes (2026-11-04, see `../11-04-gateway-frontdoor-spike/research/spike-findings.md`)

- V0: gateway → router SigV4 works with an explicit `iamCredentialProvider {service, region}` (inferred
  signing fails); router sees the gateway role session and `x-amz-source-arn`.
- V1: `privateEndpoint` accepted on inference and HTTP passthrough targets; end-to-end private path is MVP step 1.
- V2/V3/V4: byte-exact pass-through, incremental SSE, header allowlist works (≤ 10 each way), `target/model`
  prefix stripped.
- V5: gateway passes ≥ 12 MB; a Lambda URL router caps bodies at ~4.5 MB → router runs in a container.
- V6/V7: rule fallback (router 5xx → Bedrock pinned model) works; Responses GET/DELETE only via HTTP passthrough.
- V8: `cache_control` and 1h TTL survive the gateway; `anthropic-beta` is forwarded and validated by Bedrock.
- Open for MVP: auth on the gateway → container hop (Lattice IAM / JWT passthrough / mTLS), inbound auth for
  agent clients (AWS_IAM vs CUSTOM_JWT).
