# Admin console E2E (deployed stack)

`e2e.py` checks a deployed router and console stack end to end: anonymous denial, identity, console API
authorization, the SPA sign-in, member login with `llmar`, attribution of Claude Code and Codex calls, config
activation, identity `require`, disable and budget stops, and the rollback to the baked default. It talks to AWS and
to the deployment, so only the operator runs it, after the user approves the deploy.

```bash
source scripts/local.env      # LLMAR_SPIKE_ACCOUNT (or LLMAR_E2E_ACCOUNT): refuse any other account
export CLAUDE_BIN=<path to claude> CODEX_BIN=<path to codex>      # for c3
uv run --python 3.12 experiments/console-e2e/e2e.py phase r --region <region> --prefix llmar
# console deploy step 1 (bundle off, ingest off)  → phase c1
# console deploy step 2 (bundle on)               → phase c2
# console deploy step 3 (ingest on)               → phase c3, then phase id
uv run --python 3.12 experiments/console-e2e/e2e.py phase cleanup --region <region>
uv run --python 3.12 experiments/console-e2e/e2e.py status --region <region>   # the check table so far
```

c3 runs Claude Code and Codex with a scratch `HOME` and `PATH=/usr/bin:/bin`, so `CLAUDE_BIN` and `CODEX_BIN` must
name executables that start there. A launcher shim that looks its tools up under your real `HOME` exits at once; a
`--version` preflight in the same environment catches that before any spend and records what the binary said. Point
the variables at the tools' own executables. The token helper (`llmar-token`) runs under `/usr/bin/env python3`,
which must be Python 3.9 or later.

Cleanup restores first: the baked default, identity observe and no member budget. If that fails, it aborts before
deleting anything, so the test admin's session can retry (`ABORT: restore failed: fix and rerun cleanup`). For a
stack that is already gone, or that was restored by hand, `phase cleanup --skip-restore` deletes the test users and
local files without the restore.

`phase all` runs r, c1, c2, c3 and id against a fully deployed console, then cleanup. It stops at the first failing
phase, without cleaning up, so the state can be inspected.

Offline checks of the driver itself (fake clients; no AWS, no network):

```bash
uv run --python 3.12 --with pytest==8.4.2 --with boto3==1.40.70 --with requests==2.34.2 --with playwright==1.64.1 \
    pytest -q experiments/console-e2e/tests
```

## Phases

| Phase | Checks |
|---|---|
| r | gateway: anonymous → 401, bad token → 401; M2M token; `auto` on Messages, Chat and Responses with both headers → 200; router log shows `principal` client and `identity: verified`; a concrete id still goes through the router (pin); `identity/jwks.json` and `packs/current.json` in the config bucket; a `config` line with source `jwks` outcome `applied` |
| c1 | stack outputs; every `/api/*` route (parsed from `packages/console-contract/src/routes.ts`), anonymous and with a junk bearer, via CloudFront and via execute-api → the JWT authorizer's own 401 (body `{"message":"Unauthorized"}` and an `apigw-requestid` header; anything else fails with status, body shape and header names; `www-authenticate` shape recorded); control: execute-api `/e2e-not-a-route` → 404 `{"message":"Not Found"}`; site bucket direct → 403 (pre-check only: no objects yet); console client registers the SPA's `/auth/callback` and `/signed-out`; test admin (SUPPRESS, permanent password, admin group, `MEMBER#user:<sub>` PROFILE); headless managed login; `/api/me/profile` and `/api/admin/members` → 200; the profile and `/api/me/setup` report the effective identity mode with its source (no console version active: `observe` from `baked` at `config/baked.json`'s version; otherwise `document` at the active version; never a guessed `off`); console token on the gateway → 403 (wrong scope); a member token on an admin route → 403 |
| c2 | SPA index and security headers; `config.json` without secrets; with the bundle uploaded, `index.html` and `config.json` direct from S3 → 403 `<Code>AccessDenied</Code>` while CloudFront serves them (200); headless sign-in through the SPA's Sign in button lands on Overview; no token in `localStorage` |
| c3 | member invited through the API (then a permanent password); `llmar configure` from `/api/me/setup`; `llmar login --no-browser` driven headless (127.0.0.1 callback); member calls with both headers; an M2M call; one Claude Code run (`apiKeyHelper` = `llmar-token`) and one Codex run (`auth.command` + static `x-api-key`), each recording exit, duration, version and masked stderr/stdout tails (last 15 lines); records and usage attributed to the member within 7 minutes; admin sees them; the member gets 404 for another principal's record; the ingest DLQ is empty |
| id | (everything after the first activation runs under try/finally → restore) a tuning edit activates on every task within 60 s, then rolls back; the precondition of `require`: `ConfigState.router.identityKeysLoaded` (every running task's state line reports its signing keys loaded), polled for up to 6 min, otherwise the detail records the reason code (`no-fresh-task`, `partial`, `not-configured`, `task-without-keys`), the counts and a digest of the task; a refused activation records the status, error code, reason and each issue's path, code and rule, never messages; `require`: no `x-api-key` → 401 `identity-missing`, with it → 200; disable → 403 `identity-blocked` within 40 s; enable → served again (and `llmar login` again: disable revoked the refresh token); a tiny hard-stop budget → 429 `budget-exceeded`, removed → served; restore the baked default (`config/baked.json`, version `0-baked.<sha8>` or legacy `0-baked`), identity observe, no budget |
| cleanup | restore first (idempotent: no activation and no PATCH when the baked default, identity observe and no budget are in place); `llmar logout`; test users signed out and deleted, their `MEMBER` items deleted (identity objects republished first); the secrets file and the work directory |

## Safety

- **Secrets:** no token, password or client secret is printed or written to `results/`. Test-user passwords are
  random and live in memory, plus a 0600 file outside the repository (`$XDG_RUNTIME_DIR` or `~/.cache`) that cleanup
  deletes.
- **Files:** state (check outcomes, test usernames and subs, versions, spend) is a 0600 file in
  `~/.cache/llmar-e2e-<prefix>-<region>/`. `results/<phase>.json` (gitignored) holds the masked outcomes: statuses,
  codes, counts, durations and sha256[:12] digests, with 12-digit runs and token shapes masked.
- **Test users:** e-mail usernames at `example.com`. The console invite sends a Cognito e-mail, which RFC 2606
  addresses never deliver.
- **Spend:**
  - Calls use `max_tokens` ≤ 16 and are pinned to the fast models (`--haiku`, `--luna`; default: the haiku and luna
    ids in `model-universe`). The exceptions are the `auto` checks, which need the default tier.
  - A conservative estimate per call, above every routed model's list price, plus $0.25 per CLI run, is reconciled
    with the router's `costUsd` after each phase.
  - The run aborts before a call that could take the spend above `--cap`, which defaults to $4.50 and can't be set
    higher.
- **Reruns:** every check is resumable; a passed check is skipped unless you pass `--force`.

## AWS calls (the operator's credentials)

| Service | Calls |
|---|---|
| STS | `GetCallerIdentity` (account guard) |
| SSM | `GetParametersByPath /<prefix>/router/` |
| CloudFormation | `DescribeStacks <prefix>-router`, `<prefix>-console` |
| Cognito | `DescribeUserPoolClient` (agent secret, console callbacks); `AdminCreateUser` (SUPPRESS), `AdminSetUserPassword`, `AdminAddUserToGroup`, `AdminGetUser`, `ListUsers`, `AdminUserGlobalSignOut`, `AdminDeleteUser` (test users only) |
| DynamoDB | `PutItem` / `DeleteItem` of the test users' `MEMBER#user:<sub>` PROFILE items |
| S3 | `HeadObject` on the config bucket |
| CloudWatch Logs | `FilterLogEvents` on the router log group |
| ECS | `DescribeServices` (running task count) |
| SQS | `GetQueueAttributes` on the ingest DLQ |

## Not covered, and what stays behind

- "Require is refused without JWKS" can't be reproduced on a healthy stack; console-api's tests cover it.
- The managed-login form selectors (`input[name=username]`, password, submit; one page or username → Next) were
  tested against a local fake, not against Cognito's managed login v2. A failure records the page origin and title.
- Left in the deployment by design:
  - The config versions and audit items that phase id writes. They are immutable history; the active document ends
    equal to `config/baked.json`.
  - The test principals' usage records and daily rollups, until their TTL (records 90 days, rollups 400).
  - Nothing of the test admin, though one shortcut is by design: its `MEMBER#user:<sub>` PROFILE item is seeded
    directly in DynamoDB, like the seed-admin custom resource, so it bypasses the console audit. Cleanup deletes the
    user and the item. The E2E creates no service clients and deletes none.
