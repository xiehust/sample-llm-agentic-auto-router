# Admin console: bilingual (en/zh) management UI

## Source request (user, 2026-11-08, verbatim intent)
1. Cognito user pool as the IdP.
2. Admins create member users and manage the model mapping, the gateway configuration, the assessor mode and
   version, and see decision records with their basis.
3. Members sign in and use their own account as the credential to obtain a router API token, with setup guidance.
4. Admins and members see statistics: real per-model token usage and its list price, plus a cost-saving model
   (e.g. requests the router sent to `fast` instead of `standard`); better approaches welcome.
5. Fill in what the user did not think of.
6. Use the idle peer Claude Code sessions to go faster.

UI language: English and Simplified Chinese, switchable at runtime. Task docs in English.

## Requirements

### R1 Identity and roles
- One Cognito user pool is the IdP for the console and for router tokens (the existing pool, extended).
- Two roles from Cognito groups: `admin`, `member`. No self sign-up. An admin creates users (invite e-mail with
  a temporary password); No MFA (user decision 2026-11-08); the docs recommend enabling TOTP MFA for production.
- Every console API call is authorized per action on the server (group claim from a verified token), not only by
  hiding UI.

### R2 Member router tokens (self-service)
- A member gets router tokens with their own account, not a shared client secret and not AWS credentials.
- Works for Claude Code (`apiKeyHelper`), Codex, the Anthropic / OpenAI SDKs and curl, including sessions longer
  than the 60-minute access-token lifetime.
- The router attributes every request to a verified principal (member `sub` or service-client id), so usage,
  cost and decisions are per principal. Client-asserted headers are never the source of identity.
- An admin can disable a member; the router stops serving that member within a bounded time (target ≤ 2 min,
  not "when the token expires").

### R3 Admin configuration
- **Routing policy (model mapping):** mode (observe/auto), per-dialect pools and tiers, default tier, observe
  defaults, aliases, rules, failover. Form editor plus JSON view; validated with the router's own validators
  (`validatePolicy`, `checkPolicyAgainstCatalog`) before it can be saved.
- **Assessor:** mode (off/observe/auto), pack version (one of the packs bundled in the deployed image), model,
  threshold, timeout, autoRules. Shows each pack's rules (id, tier, instruction) so a decision basis can be read.
- **Gateway:** read-only view of the deployed gateway (URL, authorizer, allowed clients, targets, fallback chain,
  forwarded headers, status). Edits limited to what the design marks safe; everything else stays a CDK deploy.
- Every config change is a new immutable version with author, time, diff and comment; one-click rollback.
- Changes reach the router without a CDK deploy, bounded time (target ≤ 1 min), and a bad config can never take
  the router down (validated before activation; the router keeps the last good config).

### R4 Decision records
- Per request: time, principal, session label, dialect, requested model/alias, decision (action, point, mode,
  model, reason, wouldChoose, estimate), served model, usage by token class, list-price cost, cache hit rate,
  failover, assessor (tier, proposedTier, confidence, basis → rule text, outcome, guard, applied, latency, cost).
- Session timeline view (one lineage's requests in order).
- Admins see all records; members see only their own. No prompt, card or output text is ever stored (the router's
  existing log hygiene, design §2.8).

### R5 Usage, cost and savings
- Real token usage per model, by class (uncached input, cache read, cache write by TTL, output), from the router's
  `usage`; list-price cost from the region's versioned price catalog (catalog version shown).
- Group/filter by principal, model, tier, dialect, day; members see their own; CSV export.
- Cost-saving model (design §5): counterfactual against an admin-chosen baseline, decomposed into routing effect,
  switch (cold-cache) penalty and assessor overhead; negative savings shown as such. In observe mode, a
  "projected if auto" view from `wouldChoose`. Every saving figure is labelled list price, not invoice.

### R6 Member setup guidance
- A "Get started" page filled with this deployment's values (gateway URL, token endpoint, client id, scope):
  login helper install, Claude Code, Codex, SDK and curl snippets with copy buttons, in both languages.
  Content consistent with README "Connecting clients" (verified 2026-11-08).

### R7 Additions (proposed by 0c; user to confirm in review)
- **Budgets:** optional monthly list-price budget per member (and a default); soft alert at a threshold, optional
  hard stop (router 429 `budget-exceeded`) within the R2 disable bound.
- **Service clients:** admins create machine (client-credentials) principals for CI/agents; secret shown once,
  rotate, disable.
- **Per-principal tier limits:** optional cap (e.g. members may not use `frontier`/pins outside a list).
- **Audit log:** every admin action (user, config, gateway) with actor, time, before/after.
- **Health panel:** router task count, request rate, 4xx/5xx, failovers, gateway fallback, overhead p50/p99, from
  the existing EMF metrics.
- **What-if:** replay recent decisions under a draft policy before activating it (packages/replay), later phase.
- **Data retention:** request records expire (TTL, default 90 days, admin setting); rollups kept.

## Constraints
- N5 publishable: region/account/prefix are deploy parameters; no account ids, internal references or personal
  defaults in code or docs; no third-party task text.
- Security (builder-security): Cognito-native mechanisms only (no home-made API keys or token formats); SigV4/IAM
  service-to-service; least-privilege IAM for the console backend; no credentials or tokens logged; anything
  internet-reachable is auth-gated and its anonymous denial verified before content is uploaded.
- The data plane keeps its properties: no extra synchronous dependency on the request path that can fail a
  request; router overhead p99 stays within a few ms; no request bodies leave the router.
- Cost: the console adds near-zero idle cost (serverless, on-demand); estimate in design.
- Only 0c deploys and commits; independent review (0d) of every infra/router change before deploy.

## User decisions (2026-11-08)
- D1 Exposure: **option A** — internet-reachable behind Cognito sign-in (CloudFront + private S3 + same-origin
  `/api` with a JWT authorizer); anonymous denial verified before content is uploaded. No WAF for now.
- D2 First release includes **budgets, service clients and per-principal tier limits**; audit log and health
  panel included; what-if replay deferred to a later release.

## Acceptance criteria (first release)
- [ ] Admin creates a member; the member signs in, runs the login helper, and Claude Code and Codex calls are
      attributed to that member in records and usage.
- [ ] Disabling the member stops their calls within the R2 bound; anonymous and wrong-scope calls still 401/403.
- [ ] Policy and assessor edits validate, version, activate on the running router within the R3 bound, roll
      back; an invalid config is refused and never reaches the router.
- [ ] Decision record and session views match the router log lines for the same requests.
- [ ] Usage/cost per member and model reconcile with the router's `costUsd` (exact) and the savings figures with
      a hand calculation on a fixture.
- [ ] Every page in en and zh; language switch persists.
- [ ] Member cannot read another member's records or call admin APIs (tested).
- [ ] N5 scan, leakscan and tests pass; the stack destroys cleanly.
