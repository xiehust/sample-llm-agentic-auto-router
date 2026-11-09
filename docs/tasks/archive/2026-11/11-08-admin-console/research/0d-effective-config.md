# 0d: effective runtime settings without (or with a partial) active document — contract (design §2.1 addendum)

Owner 0d, 2026-11-08. Trigger: E2E c1 showed `GET /api/me/profile → identityMode "off"` while the router ran
`observe` from its deploy env (console-api `doc?.identity?.mode ?? 'off'`). The console guessed a default the
router does not use.

## 1. Rule (what the router does; normative for everyone)

Per section, `effective(section) = activeDoc?.[section] ?? baked[section]`. There is no other default.

| Section | From the active document | Baked (deploy-time) value |
|---|---|---|
| policy | `doc.policy` (always present in a valid document) | the CDK policy file (`ROUTER_POLICY_JSON`) |
| identity | `doc.identity.mode` | `ROUTER_IDENTITY_MODE` (infra default `observe`); `off` only when identity is not configured |
| assessor | `doc.assessor` (full block or `{mode:'off'}`) | `ROUTER_ASSESSOR_*` (C4: no block ⇒ env assessor; env unset ⇒ `{mode:'off'}`) |
| access | `doc.access` | `{ groups: {} }` (no caps) |

No active document ⇔ every section is baked.

## 2. The baked document: one artifact, built by one function

- `bakedConfigDocument(inputs)` in `@auto-router/router/settings` (pure, browser-safe) returns a **complete**
  ConfigDocument: `{ schemaVersion: 1, version, policy, assessor: <full env block | {mode:'off'}>, identity: { mode },
  access: { groups: {} } }`. Inputs: the validated policy, the identity mode and the assessor env settings — the
  same values RouterStack puts into the router env.
- `version = "0-baked." + sha256(canonicalJson(doc without version))[:8]`. It changes whenever the baked content
  changes, so records from an older baked period never resolve to a newer baked document. It is still a valid
  `"<n>-<suffix>"` with n = 0. `canonicalJson` (sorted keys) is exported next to it. Hashing is done by the caller
  with node:crypto: router `main.ts`, infra synth.
- The router builds generation 0 from this function at boot. It replaces `bakedDocument(policy)` and the fixed
  `"0-baked"`, which stays readable as a legacy alias. So the router's baked values and the published artifact are
  byte-identical by construction.

## 3. Delivery and reporting

- **Configured, deploy-time (a3):** RouterStack writes the baked document at synth with the same function and
  inputs, to the config bucket as `config/baked.json` plus an immutable copy `config/baked/<version>.json`. It goes
  through the existing PacksArchive BucketDeployment (prune off). Extend the handler's Deny guard to allow writes to
  `packs/*` and `config/baked*` only. Grant console-api `s3:GetObject` on `config/baked.json` and
  `config/baked/*`. Test: the router env (`ROUTER_IDENTITY_MODE`, `ROUTER_ASSESSOR_*`, the policy version) equals
  the fields of the staged `baked.json`.
- **Reported, runtime (0d):** every router `kind:"config"` line (boot, applied, rejected, ignored, absent) also
  carries `effective: { identityMode, assessorMode, policyVersion, mode }` and
  `sources: { policy, identity, assessor, access }`, each source `'document' | 'baked'`. The C4 `assessor{…}`
  lineFields stay as they are.
  - This is what the running tasks really do; it covers rolling deploys and env drift.
  - Ingest already stores config lines (C#config), so no ingest change is needed for this part.

## 4. Console-api (73)

1. Effective settings for profile, setup and config pages: `active?.document[section] ?? baked[section]` with
   `baked` = `config/baked.json` (cache by ETag). Return `source: 'document' | 'baked'` per section.
   - If `baked.json` is missing or unreadable, return `'unknown'` for baked-sourced sections. **Never default to
     `'off'`.**
2. When `/api/admin/config` is first read, or `baked.json`'s ETag changes, seed the console table with the baked
   document: conditional put on `CONFIG` / `v#0#<sha8>` `{doc}`, idempotent and immutable, at the same key the
   ingest uses.
3. A new draft starts from the effective document (all four sections filled), so console-written versions are
   always complete and "document present but section missing" stops occurring for v#≥1. Keep the rule in §1 for
   hand-written or old documents.
4. Config page: show the router-reported `effective`/`sources` from the latest `C#config` lines per task next to the
   configured values. On a mismatch, show a warning (e.g. a task still on an old image or env).

## 5. Ingest (17)

- `configVersion "0-baked.<sha8>"` resolves to `CONFIG` / `v#0#<sha8>`.
- Legacy `"0-baked"` keeps today's `v#0` mapping (lines logged before this change).
- `policy.version` is still checked against `decision.policyVersion`.

## 6. Who does what (ships with the phase 3 deploy)

| Owner | Change |
|---|---|
| 0d | settings.ts `bakedConfigDocument` + `canonicalJson`; router main builds gen 0 with it (version `0-baked.<sha8>`); `effective` + `sources` on config lines; tests |
| a3 | RouterStack: stage `config/baked.json` + `config/baked/<version>.json` via the existing BucketDeployment; Deny guard allows `packs/*` + `config/baked*`; console-api read grant; env↔artifact equality test |
| 73 | console-api §4 (no `'off'` default; source per section; v#0#<sha8> seed; complete drafts; reported vs configured) |
| 17 | ingest §5 (`0-baked.<sha8>` → `v#0#<sha8>`; legacy alias) |
| 18 / 4f | UI: a source badge per setting ("from config v#n" / "deploy default"), an "unknown" state, a mismatch warning; i18n keys |

## 7. Router state line and the require gate (addendum, 2026-11-08 after live E2E `id`)

Problem: jwks `config` lines appear only at boot or on a key change. The router booted before the log subscription
existed, so the console never saw "keys applied", and older lines age out of the 200-line scan.

**Router (0d).** A state line is written right after boot, after every change of config/active.json,
identity/principals.json or an identity object (jwks, blocks, budget-blocks), and every 5 min (`STATE_INTERVAL_MS`):

```
{ kind: "config", source: "state", outcome: "active", ts, configVersion, principalsVersion, policyVersion, mode, catalogVersion,
  effective: { identityMode, assessorMode, policyVersion, mode }, sources: { policy, identity, assessor, access },
  identityKeys: { configured: bool, loaded: bool, kids: <count>, versions: { jwks?, blocks?, budgetBlocks? } },
  assessor: {…}, packs: [...], drift? }              // C4 lineFields, as on every config line
```

It carries codes, versions and counts only. The task is not in the line: ingest takes it from the log stream, as it
does for every C#config item.

**Ingest (17).** Keep only the latest state line per task, so they never flood: `pk = "C#state"`, `sk = <task>`,
PutItem with the condition `attribute_not_exists(ts) OR ts < :ts`, TTL 1 day. Other config lines stay unchanged
(C#config `<ts>#<task>#<source>`).

**Console-api (73).**
- `fresh` = state items with `ts` ≥ now − 15 min (3 periods).
- `running` = ECS DescribeServices runningCount (console-api already has the grant).
- `identityKeysLoaded` = fresh.length ≥ 1 ∧ fresh.length ≥ running ∧ every fresh item has `identityKeys.configured`
  ∧ `identityKeys.loaded`. Set `RouterConfigState.identityKeysLoaded` from it, and drive `reported` from the fresh
  state items. This replaces the 200-line scan.
- Require gate: refuse (422 `identity-keys-not-loaded`) unless identityKeysLoaded. The message names the case:
  no fresh state line from any task; fewer reporting tasks than running ones; identity not configured; or keys not
  loaded on task X. Never unknown → allowed.
