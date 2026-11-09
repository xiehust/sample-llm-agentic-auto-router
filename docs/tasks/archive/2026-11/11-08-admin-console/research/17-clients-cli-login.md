# 17: Client token headers (design §2 S3) and the member CLI login helper (child task cli-login)

Research note, 2026-11-08, peer 17 for 0c. Local only: no AWS calls, no real tokens, no commits.

**Method.** A capture server written for this note (Python stdlib, bound to `127.0.0.1:47817` only) recorded
method, path and header names and values for each request, with credential values redacted, and never a body.
It answered with minimal Anthropic Messages / OpenAI Responses / Chat Completions replies, plus a fake OAuth
`authorize`/`token` pair for the Codex `gateway_oauth` test. A mode file made it return 401, 403 or 500, return a
tool call, return a 404 for `/v1/models`, or fail or omit the refresh token. Every client ran under `env -i` with
a temporary `HOME` / `CODEX_HOME`. Tokens were dummy strings `llmar-dummy-<label>-<n>`, printed by a counting
helper; below they appear as `<dummy:label-n>`. Afterwards the server was stopped, no listener remained on 47817
or 47818 (`ss -ltn`), and the scratch directory was deleted.

Versions: Claude Code 2.1.318, Codex CLI 0.167.0, `anthropic` 2.6.0 (and 0.125.0 for comparison), `openai`
3.46.0, Python 3.9 (system) / 3.12 (venv).

Notation: [obs] observed here; [doc] vendor documentation (sources in §5); [infer] reasoning, not verified.

## 0. Findings

| # | Finding | Basis |
|---|---|---|
| F1 | Claude Code `apiKeyHelper`: one helper call is sent as **both** `authorization: Bearer <t>` and `x-api-key: <t>`. Design §2's assumption holds. | [obs] [doc] |
| F2 | Claude Code re-runs the helper and retries on **401 and on 403** alike. If the error persists it retries about 10 times over about 2.5 min (0, 1, 2, 5, 9, 18, 35, 70, 105, 145 s), with one helper call per attempt. | [obs] |
| F3 | Codex `env_key` + `env_http_headers = { "x-api-key" = "LLMAR_TOKEN" }` (the same variable) sends the same value in both headers. It is static: read once at start. | [obs] |
| F4 | **Codex has a command-backed bearer token**: `[model_providers.<id>.auth]` with `command`, `args`, `timeout_ms`, `refresh_interval_ms` (default 300 000) and `cwd` (upstream PR #16288). Codex re-runs the command before a turn once the interval has passed, and after a **401** (not after a 403). This fixes sessions longer than 60 min **without a proxy**. | [obs] [doc] |
| F5 | With `auth.command`, the refreshed token goes only into `authorization`; an `env_http_headers` x-api-key stays the static value read at start. So **Codex cannot send one refreshing token in both headers**. | [obs] |
| F6 | **Codex native `gateway_oauth`** (0.166+): auth code + PKCE S256 + `state`, a public client, a loopback callback at `http://127.0.0.1:<redirect_port>/callback`, refresh (with or without rotation), and a new sign-in after `invalid_grant`. Credentials go to the keyring by default, or to `$CODEX_HOME/secrets/gateway_oauth.json` (0600, plaintext JSON) with `credentials_store = "file"`. Verified end to end against the fake IdP. | [obs] [doc] |
| F7 | `auth.command` (→ `authorization`) and `gateway_oauth` with `delivery = { kind = "header", name = "x-api-key" }` together are a valid config. Codex then sends two independently refreshing tokens, but the `x-api-key` value is **`Bearer <t>`** (default scheme). | [obs] |
| F8 | **Anthropic SDK 2.x changed its auth headers.** `api_key=` is sent as `authorization: Bearer` (0.125.0 sent `x-api-key`); `auth_token=` is also `authorization: Bearer`; passing both raises `ValueError`. `x-api-key` now comes only from `default_headers` (static). Design §2's "SDK with `api_key=` sends `x-api-key`" holds only for 0.x. | [obs] |
| F9 | Anthropic SDK 2.x `credentials=` (an `AccessTokenProvider` returning `AccessToken(token, expires_at)`) caches the token and calls the provider again with `force_refresh=True` after a 401. Verified. It also adds **`anthropic-beta: oauth-2025-04-20`**, which the router does not strip (`BEDROCK_BETA_STRIP` contains only `advanced-tool-use-2025-11-20`). Whether Bedrock rejects it is unverified. | [obs] [code] |
| F10 | OpenAI SDK 3.46: `api_key` may be a `Callable[[], str]`, called **once per request**. On 401 the SDK raises `AuthenticationError`, with no retry and no second call. `default_headers` adds `x-api-key` (static). | [obs] |
| F11 | A small `httpx2.Auth` (`httpx.Auth` in older SDKs) passed as `http_client` sets **both** headers from a refreshing token on every request, in both SDKs. Verified. | [obs] |
| F12 | Cognito accepts loopback HTTP callback URLs (`http://localhost`, `http://127.0.0.1`, `http://[::1]`) with custom ports, up to 100 callback URLs per client. AWS labels them "for testing purposes only". Matching is exact, so ports must be registered. The token endpoint's `refresh_token` grant works with and without rotation (rotation returns a new refresh token). A revoked refresh token returns `invalid_grant`. | [doc] |

**Consequence for design §2 (for 0c and a3).** Only Claude Code sends the duplicated token natively and with
refresh. Everything else needs per-client configuration (§2.5):

| Client | Both headers | Refreshes |
|---|---|---|
| Codex | env (F3) | no (≤ 60-min sessions) |
| Codex | `auth.command` + `gateway_oauth` on `x-api-key` | yes, but two grants and two sign-ins (F7) |
| Anthropic / OpenAI SDKs | `default_headers` | no |
| Anthropic / OpenAI SDKs | an `Auth` class | yes (F11) |

`x-api-key` duplication stays the right mechanism (a3 rejected the interceptor). The router must accept a raw
JWT or `Bearer <jwt>` (a3 §2 already strips an optional `Bearer `). The docs must give each client its exact
recipe, and `identity: require` should wait until those recipes are in the Get started page.

## 1. Captured headers (credential-bearing ones in full; others by name)

### 1.1 Claude Code 2.1.318 (README settings, `apiKeyHelper` = counting helper)

`POST /inference/v1/messages?beta=true`, stream:

```
authorization: Bearer <dummy:cc-1>
x-api-key: <dummy:cc-1>
anthropic-version: 2023-06-01
anthropic-beta: claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,…
x-claude-code-session-id: <uuid>        user-agent: claude-cli/2.1.318 (external, sdk-cli)
x-app: cli   anthropic-dangerous-direct-browser-access: true   x-stainless-* (arch, lang, os, package-version
0.128.0, retry-count, runtime, runtime-version, timeout)   accept, content-type, accept-encoding, connection, host
```

| Case | Requests (status, token) | Helper calls |
|---|---|---|
| normal | 200 cc-1 | 1 |
| first call 401 | 401 cc-1 → 200 cc-2 | 2 |
| first call 403 | 403 cc-1 → 200 cc-2 | 2 |
| always 401 / always 403 | 10 attempts in 145 s, cc-1 … cc-10 (killed at 150 s) | 10 |

The vendor docs add [doc]: the helper's output is cached 5 min by default (`CLAUDE_CODE_API_KEY_HELPER_TTL_MS`).
Since v2.1.227, any extra stdout line (a banner or a log line) makes the helper fail. Subagent requests carry
`x-claude-code-agent-id` / `x-claude-code-parent-agent-id` (not in the gateway allowlist today; see §4).

### 1.2 Codex CLI 0.167.0

| Config | `authorization` | `x-api-key` | Other |
|---|---|---|---|
| A: README + `env_http_headers` `x-api-key = LLMAR_TOKEN` | `Bearer <dummy:cx-env>` | `<dummy:cx-env>` | No `GET /v1/models` |
| B: `auth.command` (no `env_key`), `refresh_interval_ms = 0` | `Bearer <dummy:cx-n>` | static env value | `GET /v1/models` ×1–2 at start; command runs 2–3× at start (catalog + session) |
| B, first call 401 | 401 cx-2 → 200 **cx-3** (command re-run) | | |
| B, first call 403 | 403 cx-2 → 200 **cx-2** (no re-run) | | |
| B, two 500s, interval 1 ms | cx-5, cx-5, cx-5 (transport retries reuse the token) | | |
| B, tool call then a 2nd turn 2.6 s later, interval 1 000 ms | turn 1 cx-2, **turn 2 cx-3** (proactive refresh) | | |
| C: `gateway_oauth` (fake IdP) | `Bearer <dummy:oauth-at-n>` | (none) | See §1.3 |
| D: `auth.command` + `gateway_oauth` delivery `x-api-key` | `Bearer <dummy:cx-n>` | **`Bearer <dummy:oauth-at-7>`** | Accepted config |

Other Codex request headers: `session-id`, `thread-id`, `x-client-request-id`, `x-codex-window-id`,
`x-codex-turn-metadata` (JSON: installation, session and thread ids), `x-codex-beta-features`, `originator:
codex_exec`, `user-agent: codex_exec/0.167.0 (…)`, `accept: text/event-stream`. With `auth.command`, a 404 on
`GET /v1/models` only logs two `ERROR codex_models_manager … failed to refresh available models` lines; the turn
completes [obs].

### 1.3 Codex `gateway_oauth` flow (fake IdP on the capture server)

- With no browser (`env -i`), Codex prints `Authorize the model provider by opening this URL:` plus the URL, then
  `Browser launch failed; open the URL above manually.`
- Authorize query: `response_type=code`, `client_id`, `redirect_uri=http://127.0.0.1:47818/callback`,
  `code_challenge` (43 chars), `code_challenge_method=S256`, `state` (43 chars), `scope=openid llmar/invoke`. No
  `nonce`.
- The callback listener exists only during sign-in, bound to `127.0.0.1:47818` (`ss`).
- Token exchange: `grant_type=authorization_code`, `client_id`, `code`, `redirect_uri`, `code_verifier`. No client
  secret.
- `expires_in = 1`: Codex refreshes at once (`grant_type=refresh_token`) and again on the next start.
- **No rotation** (the refresh response has no `refresh_token`): Codex keeps and reuses the original refresh
  token. **With rotation**, it stores and uses the new one.
- `invalid_grant` on refresh → a new browser sign-in in the same run.
- The file store is keyed by a hash of the provider config: `{access_token, refresh_token, authorization_id,
  expires_at}`.

### 1.4 Anthropic Python SDK

| Construction | 2.6.0 | 0.125.0 |
|---|---|---|
| `api_key=t` | `authorization: Bearer t` | `x-api-key: t` |
| `auth_token=t` | `authorization: Bearer t` | `authorization: Bearer t` |
| both | `ValueError: Pass at most one of api_key=, auth_token=, credentials=, …` | both headers |
| `auth_token=t, default_headers={'x-api-key': t}` | both headers | (not run) |
| `credentials=provider` | `authorization: Bearer t` + `anthropic-beta: oauth-2025-04-20`. One provider call for 2 requests; after a 401 a call with `force_refresh=True` and a successful retry | n/a |

### 1.5 OpenAI Python SDK 3.46.0

| Construction | Headers |
|---|---|
| `api_key=t` | `authorization: Bearer t` |
| `api_key=t, default_headers={'x-api-key': t}` | both |
| `api_key=callable` | `authorization: Bearer <callable()>`. Called per request (3 calls for 3 requests); a 401 raises with no second call |

### 1.6 Both SDKs, refreshing, both headers (verified)

```python
import httpx2 as httpx   # anthropic>=2 / openai>=3 ship httpx2; older releases use httpx

class RouterAuth(httpx.Auth):
    def auth_flow(self, request):
        t = router_token()                       # cached token, see §3.5 (`llmar token --json`)
        request.headers['authorization'] = f'Bearer {t}'
        request.headers['x-api-key'] = t
        yield request

claude = anthropic.Anthropic(base_url=f'{GW}/inference', auth_token='unused', http_client=httpx.Client(auth=RouterAuth()))
oai = openai.OpenAI(base_url=f'{GW}/inference/v1', api_key='unused', http_client=httpx.Client(auth=RouterAuth()))
```

## 2. Implications

### 2.1 Design §2 (identity header)
- The router accepts `x-api-key` as a raw JWT or `Bearer <jwt>` (F7). a3 §2 already strips an optional `Bearer `.
- Return **403** for a blocked principal (`identity-blocked`) and 401 only for missing or invalid identity.
  Claude Code retries both (F2), but Codex `auth.command` and the Anthropic `credentials=` provider force a
  token refresh only on 401 (F4, F9), so a 403 does not cause pointless Cognito refreshes.
- A per-client matrix for the "Get started" page and README (R6):

| Client | Both headers, refreshing | Recipe |
|---|---|---|
| Claude Code | yes, native | `apiKeyHelper: llmar-token` |
| Codex, sessions ≤ 60 min | yes, static | `env_key` + `env_http_headers` x-api-key, same variable |
| Codex, long sessions, attributed | yes, two grants | `auth.command = llmar-token` + `gateway_oauth` delivery `x-api-key` (two sign-ins: `llmar login` and Codex's browser sign-in) |
| Codex, long sessions, unattributed | Authorization only | `auth.command = llmar-token` (`principal: none` in observe; 401 in require) |
| Anthropic / OpenAI SDK | yes | `RouterAuth` (§1.6) |
| curl | yes | `-H "Authorization: Bearer $T" -H "x-api-key: $T"` |

- Options for Codex long sessions with identity, to decide:
  - (a) Accept the double sign-in (D). Codex holds its own grant; disable and revoke cover it like any other
    grant.
  - (b) A small loopback proxy that adds `x-api-key`. **Not recommended.** A credential-injecting listener on
    127.0.0.1 can be used by every local user on a shared host. Gating it with a secret we mint ourselves would
    be home-made auth (PRD constraints).
  - (c) Ask the Codex project for a "same token in a second header" delivery. Out of our control.
  - Recommendation: (a) documented, plus "unattributed" while `identity` is `observe`.
- Rejected: letting the router accept expired `x-api-key` tokens. Any token ever leaked would then misattribute
  cost or dodge a block.

### 2.2 Anthropic beta header (F9)
If the docs show `credentials=`, either add `oauth-2025-04-20` to `BEDROCK_BETA_STRIP`
(`packages/router/src/bedrock-compat.ts`), or verify with a live call that Bedrock accepts it. Until then, the
docs use `RouterAuth` or `auth_token=`, which send no extra beta.

### 2.3 README "Connecting clients" (after cli-login ships)
- Claude Code: drop `CLAUDE_CODE_API_KEY_HELPER_TTL_MS=3000000`. It existed because the current client-credentials
  helper mints a token on every call. With `llmar-token` caching, set **240000** (4 min, see §3.5).
- Codex: replace "a fresh start or a local proxy" with the `auth` table (F4). hproxy stays an experiments-only
  tool.
- SDKs: `api_key=` is `Authorization` in Anthropic SDK 2.x (the current README comment "auth_token sends
  Authorization: Bearer" stays true). Add the `RouterAuth` recipe for long-running processes.

## 3. CLI login helper design (child task cli-login)

### 3.1 Shape
- One file, `llmar` (Python ≥ 3.9, stdlib only), with subcommands `configure`, `login`, `token`, `status` and
  `logout`. `llmar-login` and `llmar-token` are argv[0] aliases (symlinks), so `apiKeyHelper` and the Codex
  `auth.command` take a bare path with no arguments.
- Profiles (`--profile`, `LLMAR_PROFILE`) cover more than one deployment.
- Config, which is not secret: `~/.config/llmar/config.json` (honours `XDG_CONFIG_HOME`). Contents: Cognito
  domain, `client_id`, scope, registered redirect ports, gateway URL. `llmar configure --from '<json>'` takes the
  block the console's Get started page shows.
- Service clients (R7, client credentials) keep the README's machine helper. `llmar` is for members.

### 3.2 Cognito app client `cli` (RouterStack, consistent with a3 §4.1)
- Public client (no secret). `AllowedOAuthFlows = [code]`, `AllowedOAuthFlowsUserPoolClient = true`, scopes
  `openid <prefix>/invoke`.
- **Not** `aws.cognito.signin.user.admin`: least privilege, so the token cannot drive Cognito self-service
  APIs.
- Callback URLs: `http://127.0.0.1:<p>/callback` for `cliRedirectPorts` (deploy parameter, default 3 ports, e.g.
  52817–52819), plus one port for Codex `gateway_oauth` (e.g. 52820). Optionally an HTTPS console page for paste
  mode (§3.3).
- Token revocation on (the default for new clients). Refresh-token rotation **on**, grace 30 s: the docs
  recommend it, and both Codex and `llmar` handle rotation.
- Access token 15–30 min (a3 A6; any value works with §3.5). Refresh token 30 days. Rotation does not extend that
  window, so members sign in again monthly.

### 3.3 `llmar login`
1. Generate a PKCE `code_verifier` (`secrets.token_urlsafe(64)`), its S256 challenge, `state` and `nonce`
   (`secrets.token_urlsafe(32)` each).
2. Bind **`127.0.0.1`** (not `localhost`: the browser may resolve that to `::1`; not `0.0.0.0`) on the first free
   registered port. If all are busy, exit with a message naming them.
3. Open `https://<domain>/oauth2/authorize?response_type=code&client_id&redirect_uri&scope&state&nonce&code_challenge&code_challenge_method=S256`
   with `webbrowser.open`, and always print the URL too. `--no-browser` only prints. Over SSH, print the
   `ssh -L <p>:127.0.0.1:<p>` hint, the same one Codex documents.
4. Callback handler:
   - Accept one `GET /callback`; answer 404 to everything else (favicon).
   - Compare `state` with `hmac.compare_digest`; on a mismatch, keep waiting until the timeout.
   - Report `error` / `error_description`.
   - Reply with a static en + zh page ("Signed in. You can close this tab. / 已登录，可以关闭此页。") with
     `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, and no token data.
   - Close the listener after the first valid callback, or after a 300 s timeout.
   - Never log the query string.
5. Exchange the code at `/oauth2/token`: `grant_type=authorization_code`, `client_id`, `code`, `redirect_uri`,
   `code_verifier`.
6. Check `nonce` in the ID token. The token came straight from the token endpoint over TLS, so no signature check
   is needed (OIDC Core §3.1.3.7). Use the ID token's claims only to show "signed in as …". Do not store the ID
   token.
7. Store the credentials (§3.4) and print `signed in as <username>; token valid until <time>`.

Fallbacks:
- **Paste mode** (`--paste`): `redirect_uri` is a registered static HTTPS page of the console that shows code +
  state to copy. The CLI holds the verifier, so a code someone else sees is useless (PKCE). Needs D1 option A.
  CloudFront access logs record query strings, so keep the page's logging off or accept single-use codes.
- Cognito has no device-code grant, and Codex's `gateway_oauth` has no device fallback either [doc].

Threats (RFC 8252 §8):
- Another local user who squats the port and receives the code cannot redeem it without the verifier.
- A forged callback fails the `state` check.

### 3.4 Refresh-token storage: file 0600 (recommended) vs OS keychain

| | File (default) | OS keychain (later, opt-in) |
|---|---|---|
| Where | `~/.config/llmar/credentials-<profile>.json`. Dir 0700, file 0600, written to a temp file with `os.open(…, 0o600)` then `os.replace` (atomic). Refuse to read if group- or world-readable (like ssh). | macOS `security`; Linux Secret Service (`secret-tool`); Windows Credential Manager |
| Works on SSH / headless dev hosts | yes | Linux needs a D-Bus session and an unlocked keyring, usually absent |
| Stdlib only | yes | Shells out (macOS `security add-generic-password -w <secret>` puts the secret on argv, visible in `ps`); Windows needs ctypes |
| Same-user malware | reads the file | can usually read the keychain too (macOS may prompt) |
| Precedent | AWS CLI SSO cache, Codex `credentials_store = "file"` (observed: plaintext 0600) | Codex default `keyring`, gh |

Stored: `refresh_token`, `access_token`, `expires_at` (local clock at receipt + `expires_in`, so no clock skew
against JWT `exp`), `client_id`, issuer, `sub`, `username`, `obtained_at`. Hold a `fcntl.flock` on
`credentials-<profile>.lock` (`msvcrt.locking` on Windows): shared to read, exclusive to refresh.

### 3.5 `llmar token` (the apiKeyHelper / auth.command contract)
- **Stdout is exactly the token plus `\n`**, or nothing. Every message goes to stderr (Claude Code ≥ 2.1.227
  fails on extra stdout).
- `--json` prints `{"access_token", "expires_at"}` for SDK providers.
- It never opens a browser or reads stdin: it runs with no TTY under Claude Code and Codex.
- Fast path: shared lock, read, and if `expires_at − now > M`, print with no network call (24 ms measured,
  including Python start). This matters because Claude Code calls the helper on every retry (F2) and Codex calls
  it 2–3× at start (§1.2).
- Refresh path:
  - Take the exclusive lock, then **re-read** the file (another process may have refreshed already).
  - `POST /oauth2/token` with `grant_type=refresh_token`, `client_id`, `refresh_token`.
  - Store the new access token and the new refresh token if one is returned (rotation); otherwise keep the old
    one.
  - Write atomically, then print.
- Margin: **M = 5 min, with client caches set to 4 min**: Claude Code `CLAUDE_CODE_API_KEY_HELPER_TTL_MS=240000`,
  Codex `refresh_interval_ms = 240000`. A client never holds a token with less than about 1 min left at the
  gateway check. The 401 path (re-run on 401, verified for both) is the fallback. With a 15-min access token,
  that means about 3 Cognito refreshes an hour per member.
- Exit codes:

| Code | Meaning | Handling |
|---|---|---|
| 0 | token printed | |
| 2 | sign-in required: not signed in, or the refresh got `invalid_grant` / `unauthorized_client` / `invalid_client` | Delete the cached access token; message `session expired or revoked: run "llmar login" (if it keeps failing, your account may be disabled; contact your admin)` |
| 3 | IdP unreachable or 5xx | If the cached token has not expired yet, print it anyway (exit 0, stderr warning); otherwise exit 3 |
| 4 | bad config or unsafe file permissions | |

- `llmar logout`: `POST /oauth2/revoke` (`token=<refresh>`, `client_id`), which also revokes the access tokens
  issued from it [doc]. Then delete the file. No global sign-out from the CLI: it would need the
  `aws.cognito.signin.user.admin` scope. The console has "sign out everywhere" through the admin API.
- `llmar status`: who, which profile, access-token expiry, sign-in date plus the refresh-validity estimate. No
  token values.

### 3.6 Revoked / disabled member, end to end
1. The admin disables the member in the console, which calls `AdminDisableUser` + `AdminUserGlobalSignOut`
   (revokes refresh tokens) and writes the block list.
2. The router returns 403 `identity-blocked` within about 35 s in `require` mode (a3 §1.2). The gateway still
   accepts the member's access token until `exp` [doc]. **The block list is what enforces R2**, not Cognito.
3. Claude Code: about 10 retries over about 2.5 min (F2). Each runs `llmar token`, which answers from its cache
   with no Cognito call. Once the token is within M of expiry, the refresh gets `invalid_grant` → exit 2 →
   Claude Code reports the helper failure.
4. Codex `auth.command`: a 403 does not re-run the command (F4). The provider retries (`request_max_retries`,
   default 4), then the turn errors. Codex `gateway_oauth`: at the next refresh, `invalid_grant` starts a new
   browser sign-in (F6), which a disabled user cannot complete.
5. Re-enabled: the member runs `llmar login` again (the refresh tokens were revoked).

Unverified [infer]: the exact token-endpoint error for a disabled user's refresh token (expected `invalid_grant`).
`llmar` treats every 4xx from a refresh as "sign-in required", so the outcome does not depend on it. 0c can
record it in a3's S4.

### 3.7 Long sessions per client (config the docs give)

```json
{ "apiKeyHelper": "/home/<you>/bin/llmar-token",
  "env": { "ANTHROPIC_BASE_URL": "<GatewayUrl>/inference", "CLAUDE_CODE_API_KEY_HELPER_TTL_MS": "240000", "…": "…" } }
```

```toml
[model_providers.llmar]            # base_url, wire_api, requires_openai_auth = false, supports_websockets = false as today
env_http_headers = { "x-router-session" = "LLMAR_SESSION" }   # no env_key with an auth table

[model_providers.llmar.auth]
command = "/home/<you>/bin/llmar-token"   # absolute path [doc]
timeout_ms = 15000                         # a refresh is one HTTPS round trip; the default is 5 000
refresh_interval_ms = 240000

# optional, for attribution of long sessions (§2.1): Codex's own sign-in, token in x-api-key
[model_providers.llmar.gateway_oauth]
authorization_url = "https://<domain>.auth.<region>.amazoncognito.com/oauth2/authorize"
token_url = "https://<domain>.auth.<region>.amazoncognito.com/oauth2/token"
client_id = "<CliClientId>"
scopes = ["openid", "<prefix>/invoke"]
redirect_port = 52820                      # must be a registered callback
delivery = { kind = "header", name = "x-api-key" }
```

### 3.8 Language: Python stdlib (recommended) vs Node
- Python 3.9+ stdlib covers everything: `urllib.request` (honours `HTTPS_PROXY` and `SSL_CERT_FILE`),
  `http.server`, `secrets`, `hashlib`, `base64`, `hmac`, `webbrowser`, `fcntl`, `json`. It ships with Linux dev
  hosts and comes with the Xcode Command Line Tools on macOS. The repo's tooling and the current README helper
  are Python.
- Node ≥ 18 could do the same with no dependencies (`fetch`, `crypto`, `http`). But neither the native Claude
  Code installer nor the Codex binary needs Node, so it is no more likely to be present.
- Start-up cost is equal: Python fast path 24 ms, `node -e ""` 23 ms (measured).
- Windows is best effort: `msvcrt` locking and profile ACLs instead of mode bits.
- python.org macOS builds may need "Install Certificates" for TLS: one line in the docs.
- Distribution: the file lives in the public repo (e.g. `tools/llmar/llmar`), so installing is
  `curl -fsSLo ~/bin/llmar <raw URL> && chmod +x ~/bin/llmar && ln -s llmar ~/bin/llmar-token && ln -s llmar ~/bin/llmar-login`.
  The console prints the `configure` block and does not serve the script, so the gated console stays data-only.

### 3.9 Tests for cli-login (no AWS)
Use a fake IdP like this note's capture server (authorize 302, token, revoke, failure knobs) on 127.0.0.1:
- PKCE: the S256 test vector from RFC 7636 Appendix B.
- Login: `state` mismatch rejected, port fallback when the first port is busy, timeout, `error` param, `nonce`
  check.
- File: perms 0600 / 0700, refusal when group-readable, atomic write.
- Refresh: with and without rotation; `invalid_grant` → exit 2 with **empty stdout**; IdP down + a valid cached
  token → token printed.
- Concurrency: 20 parallel `llmar token` processes at the margin → exactly one refresh.
- Hygiene: stdout is exactly one line; no token in any stderr message.

Live acceptance (0c, a3 spike S4 or the deployed stack):
- Managed login with MFA, then the token passes the gateway.
- Claude Code and Codex logged with `principal.kind=user`.
- Disable → 403 within the bound, and `llmar token` exits 2 after the margin.
- Record the real disabled-user refresh error.

## 4. Open items
- **0c / a3:** the x-api-key matrix in §2.1. Decide whether a Codex user sees one sign-in (`auth.command` only,
  unattributed under `observe`) or two (attributed). Align the spike S4 callback with what the CLI will use:
  a3 §1.4 plans `http://localhost:8976/callback`; this note recommends `127.0.0.1` and registered ports.
- **a3 S2:** the AgentCore inference guide's Anthropic SDK `api_key=` example sends `Authorization` with SDK 2.x
  and `x-api-key` with 0.x (F8). Precedence when both headers are present is still for the spike.
- **0c:** F9 (`oauth-2025-04-20`), strip or verify, if `credentials=` is documented.
- **Side observation:** Claude Code subagent headers `x-claude-code-agent-id` / `x-claude-code-parent-agent-id`
  and Codex `session-id` / `thread-id` are not in the gateway's 10-header allowlist (which will be full once
  `x-api-key` is added). Lineage keeps relying on `x-router-session` / `x-claude-code-session-id`.
- **User:** AWS calls loopback HTTP callbacks "for testing purposes only". This design uses the RFC 8252
  native-app pattern, which Codex uses as well. The alternative is paste mode (§3.3).

## 5. Sources
- Codex: config reference, `model_providers.<id>.auth.*` (learn.chatgpt.com/docs/config-file/config-reference);
  "Connect to a gateway", native gateway OAuth, `delivery`, SSH forwarding, no device fallback
  (learn.chatgpt.com/docs/enterprise/connect-to-a-gateway); openai/codex PR #16288 (dynamic provider auth
  tokens) and #16480 (`refresh_interval_ms = 0`); `codex-rs/model-provider-info/src/gateway_oauth.rs`.
- Claude Code: "Connect Claude Code to an LLM gateway" (code.claude.com/docs/en/llm-gateway-connect), helper in
  both headers, 5-min cache, v2.1.227 stdout rule; "Gateway compatibility guide" (…/llm-gateway-protocol).
- Cognito: CreateUserPoolClient `CallbackURLs` (loopback HTTP, custom ports, 100 URLs); "Refresh tokens"
  (rotation, token-endpoint refresh, revocation, global sign-out); "The token endpoint" (PKCE exchange,
  `invalid_grant`).
- Repo: `packages/router/src/bedrock-compat.ts:17` (`BEDROCK_BETA_STRIP`), README "Connecting clients",
  `experiments/deepswe-harbor/hproxy.py` (SharedToken: re-mint 2 min before expiry and after a 401).
- RFC 7636 (PKCE), RFC 8252 §7.3 and §8 (loopback redirects for native apps), OIDC Core §3.1.3.7.
