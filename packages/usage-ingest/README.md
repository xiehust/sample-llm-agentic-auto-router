# @auto-router/usage-ingest

A Lambda behind a CloudWatch Logs subscription on the router log group, for admin-console child task C5. It turns
the router's request lines into usage records, daily rollups, savings figures and budget hard stops. The design
sources are:
- design v1 §2.2–2.3 and 0.3c / 0.11 / 0.15 / 0.16;
- a3 §3 (tables, idempotency, failure handling);
- 0d §1 (savings methodology and fixtures).

```
pnpm -C packages/usage-ingest typecheck && pnpm -C packages/usage-ingest test    # no AWS: in-memory ports, fake `send`
pnpm -C packages/usage-ingest check:strip    # plain node: the Lambda entry and every runtime file under strip-only types
```

The Lambda runs these sources under Node's type stripping, which vitest does not, so runtime files use only
erasable syntax (no parameter properties, enums, runtime namespaces, `import =`). `erasableSyntaxOnly` in
tsconfig.json makes `tsc` reject the rest, and `src/node-strip.test.ts` runs `scripts/node-strip-check.mjs` on the
entry.

## Flow

1. **Decode.** The `awslogs.data` payload is base64(gzip(JSON)). `CONTROL_MESSAGE` is ignored.
2. **Parse.** Lines of `kind` model, error, rejected and config are kept; anything else is skipped and counted.
   A malformed line is skipped and counted, never stored. An unknown `schemaVersion` throws, so the event goes to
   the DLQ and is replayed after an upgrade.
3. **Figures.** Each line gets its figures (`savings.ts`) under the policy it was decided with (`PolicySource`,
   resolved by `configVersion`) and the bundled price catalog.
4. **Write.** Requests go in chunks of 20, one `TransactWriteItems` per chunk, so the record put and its rollup ADDs
   commit together:
   - each record put carries the condition `attribute_not_exists(pk)`;
   - ADDs of the same key are merged inside the chunk;
   - a re-delivered line fails its condition and is dropped, and the rest of the chunk is retried, so nothing is
     counted twice;
   - conflicts and throttling are retried with jittered backoff, up to 8 attempts, after which the handler throws.
5. **State.** The router's state lines (`kind: "config"`, source `state`, written every 5 min and on every change)
   don't go to `C#config`. The batch's latest one becomes the task's `C#state` item through a PutItem conditioned on
   `attribute_not_exists(ts) OR ts < :ts`, so a late batch never rolls it back. `ts` is stored in canonical ISO
   form, and `identityKeys` is stored only if `configured` and `loaded` are booleans: the console's require gate
   reads it (0d effective-config §7).
6. **Budgets** (if enabled). Every principal the batch touched is evaluated, plus every principal already listed in
   `identity/budget-blocks.json`. The file is rewritten only when the set changes, with a conditional PUT.

One JSON log line per invocation, with counts only.

## Money

Every figure is **integer nano-USD** (1 USD = 10⁹), rounded once per component. Sums over records and rollups are
therefore exact, and the identities hold in integers:
- `R = B − A*`
- `S = A − A*`
- `N = B − A − X = R − S − X`

`spend` is Σ `costUsd.total`, rounded per line. The per-class counters `cIn`, `cRead`, `cWrite` and `cOut` are
rounded per class, so their sum can differ from `spend` by a few nano-USD.

## Items (`usage` table, pk/sk strings)

| Item | pk | sk | TTL |
|---|---|---|---|
| Request record | `P#<principal>` | `T#<ts>#<reqId>` | `RECORD_RETENTION_DAYS` (default 90) |
| — GSI1 (by day) | `gsi1pk = D#<yyyy-mm-dd>` | `gsi1sk = <ts>#<reqId>` | |
| — GSI2 (session, sparse) | `gsi2pk = S#<principal>#<session>` | `gsi2sk = <ts>#<reqId>` | |
| Daily rollup per principal | `U#<principal>#<yyyy-mm>` | `<dd>#<dialect>#<servedModel>#<baselineTier>` | 400 days |
| Daily rollup, admin | `A#<yyyy-mm>` | `<dd>#<principal>#<dialect>#<servedModel>#<baselineTier>` | 400 days |
| Budget total | `B#<principal>#<yyyy-mm>` | `TOTAL` | 400 days |
| Router config line | `C#config` | `<ts>#<task>#<source>` | as records |
| Router state line (source `state`), latest per task | `C#state` | `<task>` | 1 day |

- `<principal>` is `user:<sub>`, `client:<client_id>` or `none` (unattributed, or an id the key layout cannot
  carry).
- `<baselineTier>` is the static baseline's tier, `-` when the line is not routable, so the tier matrix is a
  rollup read.
- Rollups also carry `servedTier`: SET, last writer wins, from the line's policy (pool override), else the catalog.
- **Partitions:** `A#<month>` is one partition per month. That is fine at team scale; shard it by day
  (`A#<month>#<dd>`) if write rates approach about 1k WCU/s.
- **Rejected lines** (401/403/429/400 from identity, blocks, budgets and caps) are records too, `kind: "rejected"`
  with the error code in `reason`. Their record put is their idempotency key, like any other request.
- **Config lines** store the frozen fields (design §2.3a): `source` (boot|config|principals, and the identity
  watches jwks|blocks|budget-blocks; the source is also the sk suffix, so lines from one task in one millisecond
  never collide), `outcome`
  (applied|rejected|ignored|absent|error|active), `attempted`, `from`, `configVersion`, `principalsVersion`,
  `policyVersion`, `mode`, `catalogVersion`, `issues`, `warnings`.
  - Every other key passes through, bounded: lineFields such as the blocks etag, `packs` and `drift`, and details
    such as `code`, `origin` and `principals`.
  - Bounds: names `[A-Za-z][A-Za-z0-9_]*`, at most 20 keys, strings up to 300 characters, objects up to 4 KB as
    JSON (larger ones become `{truncated, bytes}`).
  - Key attributes can never be overwritten.

**Record attributes:**
- **The request:** `ts`, `reqId`, `kind`, `status`, `principal`, `principalGroup`, `identity`, `dialect`,
  `requested`, `session`, `lineage`, `configVersion`, `catalogVersion`.
- **Serving:** `servedModel`, `servedTier`, `servedDiffers`, `stream`, `usage`, `hitRate`, `failover`,
  `switchedFrom`, `miss{reason, expectedTokens, readTokens}`, `hints`, `sanitized`, `betaVeto`.
- **Sizes and timings:** `requestedLength`, `bodyBytes`, `bodyReadMs`, `overheadMs`, `decideMs`, `upstreamTtfbMs`,
  `durationMs`.
- **Errors:** `error`, `reason`, `clientAborted`.
- **`decision`:** `{action, point, mode, model, reason, policyVersion, wouldChoose, estimate, projected,
  reasonParsed}`. `reasonParsed` is core's `parseReason`: `{code, prefix?, family?, est?, gate?, accessCap?}`.
- **`assessor`:** `{id, autoRules, called, tier, proposedTier, confidence, basis, outcome, guard, applied,
  latencyMs, status, mode, cached, packVersion, costNano, threshold}`. `threshold` comes from the configuration
  document resolved by `configVersion`.
- **`tierLimit`:** `{to, maxTier}` when the reason carries `access-cap:<tier>`. The uncapped choice (`from`) is not
  in any decision field, only in the reason's free text, so it is absent.
- **Lineage kind:** not stored. A lineage is a subagent lineage when its start record has `decision.point`
  `subagent-start`; the API derives it from the session's records.
- **`cost`:**
  - `cls{input, cacheRead, cacheWrite, output, total, tier}`;
  - `a`, `aStar`, `x`, `cNet`, `coldOther`;
  - `excluded`, `unmetered`, `bound`, `boundPartial`, `routingSwitch`, `costMismatch`;
  - `b{<K>: {model, tier, nano | excluded}}` for K ∈ static, tier:standard, tier:frontier, observe-default;
  - `projection{model, tier, switch, aHat, aPen}`.

No prompt, body or output text is ever stored.

**Rollup counters (ADD):**
- **Requests:**
  - `req`, `err`;
  - status classes `s2xx` / `s3xx` / `s4xx` / `s5xx` / `s499` / `sOther` (model and error lines);
  - rejected lines: `rej`, `rej401`, `rej403`, `rej429`, `rejOther`.
- **Tokens:** `tUnc`, `tRead`, `tW5m`/`tW1h`/`tW30m`/`tW12h`, `tOut`, `tReason`, `tPrompt`.
- **Spend:**
  - `spend` (ΣA), `cIn`, `cRead`, `cWrite`, `cOut`, `long` (long-context requests), `asr` (ΣX);
  - unmetered calls (0.3c, never in spend or savings): `unm`, `bound` (Σ`costBoundUsd`), `boundPartial`.
- **Savings, per baseline tag t ∈ st, ts, tf, od** (static, tier:standard, tier:frontier, observe-default), over
  the lines in K's set:
  - `n_t` (lines), `b_t` (ΣB), `r_t` (ΣR), `s_t` (ΣS), `x_t` (ΣX);
  - `N_K = r_t − s_t − x_t`. X of a failed request without usage is in `x_t` too (0d §1.3).
- **Projection (observe):** `pn_t`, `pb_t`, `pr_t`, `ps_t`, `px_t`, with `N̂_K = pr_t − ps_t − px_t`.
  - `pdiff`: lines whose projected model differs from the served one.
  - Projected tier matrix: `pmn_<t>_<tier>` (n) and `pmr_<t>_<tier>` (R̂) by projected tier. The cell's sk gives the
    baseline tier.
- **Cap row (design 0.16):** `cap_n`, `cap_a`, `cap_b`, `cap_r` (static), kept apart from routing savings.
- **Other:** `cnet`, `cold` (non-routing switch cold cost), `sw`, `swOther`, `miss`, `fo`, `costMismatch`.
- **Exclusion counts:** `ex_<reason>` (pin, no-decision, unpriced, catalog-mismatch, policy-unknown, access-cap,
  projection-unpriced) and `ex_no-baseline_<t>` / `ex_baseline-infeasible_<t>`.

## Budgets

Spend is ΣA plus ΣX for the UTC calendar month, from `B#…#<month>` `TOTAL`. The unmetered bound never counts.

Settings come from the `console` table (design §2.3a): pk `MEMBER#<kind:id>` and `MEMBER#default`, sk `PROFILE`.
Ingest reads only these flat attributes:
- `budgetMonthlyUsd` (N; NULL means "no budget" and overrides the default);
- `budgetHardStop` (BOOL).

`status`, `role`, `budgetAlertAt` and `cap` are the console's.

A principal is blocked when `hardStop` is on and spend ≥ the limit. `identity/budget-blocks.json` has the same
top-level shape as `blocks.json`:

```json
{ "schemaVersion": 1, "generatedAt": "<iso>",
  "principals": [{ "kind": "user", "id": "<sub>", "reason": "budget", "month": "2026-11", "at": "<iso>", "spentUsd": 0.03, "limitUsd": 0.02 }] }
```

- Listed principals are re-evaluated on every batch, so a raised budget or a new month lifts the block on the next
  ingest run.
- The router may also ignore entries whose `month` is not the current one.

## Policy resolution

A line is resolved by `configVersion`: the `console` item pk `CONFIG`, attribute `doc` (JSON string), at sk:
- `v#<n>` for `<n>-<suffix>` (n is the integer before the first `-`);
- `v#0#<sha8>` for the baked document of a deploy, `0-baked.<sha8>` (0d effective-config §5; console-api seeds it);
- `v#0` for lines logged with the legacy `0-baked`. The document also supplies the
assessor `threshold`.
- The document's `version` must equal the line's `configVersion`, and `policy.version` must equal
  `decision.policyVersion`.
- Otherwise the line is `policy-unknown`: excluded from savings, still in spend.
- Documents are cached per container; misses are retried after 60 s.

## Environment

| Variable | Notes |
|---|---|
| `USAGE_TABLE`, `CONSOLE_TABLE` | required |
| `CATALOG_REGION` | price catalog region (default `AWS_REGION`); must be bundled in `@auto-router/pricing` |
| `RECORD_RETENTION_DAYS` | 1–3650, default 90 (new records only) |
| `BUDGETS` | `on` enables budget evaluation (then `CONFIG_BUCKET` is required) |

IAM needed by the adapters:
- `usage`: `TransactWriteItems` (`PutItem` / `UpdateItem` / `ConditionCheckItem` on the table) and
  `BatchGetItem`.
- `console`: `GetItem` on `CONFIG` and `BatchGetItem` on `MEMBER#*` (LeadingKeys).
- S3, `identity/budget-blocks.json` only: `GetObject` and `PutObject`.

## Failures and replay

Asynchronous invokes are retried twice, then the invocation record goes to the `usage-ingest-dlq` queue (an
on-failure destination). The message body is the record, not the event: the original subscription event is its
`requestPayload` (`{"awslogs": {"data": ...}}`), next to `requestContext.condition` and the error in
`responsePayload`.

Replay is safe while the records' TTL hasn't passed. Each record put and its rollup ADDs commit in one transaction
under `attribute_not_exists(pk)`, and the record key comes from the line itself (principal, timestamp, `reqId`), so
a line that already landed is dropped with its ADDs. Lines keep their own timestamps and roll up into their own day
and month. Budgets are evaluated against the month in which the replay runs.

1. Deploy the fix first. A synchronous invoke skips the destination, so a message whose replay fails stays in the
   queue.
2. For each message, invoke the function synchronously (`RequestResponse`) with `requestPayload` as the payload.
3. Delete the message only when the invoke returns no `FunctionError`.
4. Never print the payloads: they hold router lines.

